import { posix } from "node:path";

import { decodeAuthority, encodeAuthority } from "./authority.mjs";
import { isPathInside, runFramedBridgeRequest } from "./remote-process.mjs";

const MAX_REMOTE_PATH_BYTES = 16 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const MAX_RECENT_TARGETS = 20;
const HELPER_OPERATIONS = new Set(["probe", "create", "realpath"]);
const SSH_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,253}[A-Za-z0-9])?$/u;
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/u;

// This is constant product-owned source. Workspace paths never appear in this
// argv string; they are canonical base64url fields in the helper's stdin JSON.
export const WORKSPACE_HELPER_SOURCE = String.raw`
import { mkdir, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

const MAX_INPUT = 65536;
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_INPUT) throw new Error("workspace helper input exceeds 64 KiB");
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const operation = process.argv.at(-1);
const decode = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(label + " is not base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error(label + " is not canonical base64url");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!posix.isAbsolute(text) || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(label + " is not an absolute POSIX path");
  return text;
};
const exact = expected => {
  const keys = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new Error("workspace helper input shape is invalid");
};
let output;
if (operation === "probe") {
  exact(["path"]);
  const path = decode(input.path, "path");
  try {
    const metadata = await stat(path);
    output = { state: metadata.isDirectory() ? "directory" : "file" };
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    output = { state: "missing" };
  }
}
else if (operation === "create") {
  exact(["path"]);
  const path = decode(input.path, "path");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error("created workspace path is not a directory");
  output = { created: true };
}
else if (operation === "realpath") {
  exact(["root", "cwd"]);
  const lexicalRoot = decode(input.root, "root");
  const lexicalCwd = decode(input.cwd, "cwd");
  const [root, cwd] = await Promise.all([realpath(lexicalRoot), realpath(lexicalCwd)]);
  const [rootMetadata, cwdMetadata] = await Promise.all([stat(root), stat(cwd)]);
  if (!rootMetadata.isDirectory() || !cwdMetadata.isDirectory()) throw new Error("workspace root and cwd must be directories");
  output = { root, cwd };
}
else throw new Error("workspace helper operation is invalid");
process.stdout.write(JSON.stringify(output) + "\n");
`.trim();

export function validateRemoteWorkspacePath(value) {
  if (typeof value !== "string" || value.length === 0 || !posix.isAbsolute(value)) {
    throw new TypeError("remote workspace path must be an absolute POSIX path");
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("remote workspace path must not contain control characters");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REMOTE_PATH_BYTES) {
    throw new TypeError("remote workspace path exceeds 16 KiB");
  }
  return value;
}

/**
 * Treat extension global state as untrusted input. Only the four fields that
 * are safe to restore are retained; credentials, tokens, and evidence state
 * are discarded even when an older or modified extension wrote them.
 */
export function sanitizeRecentTargets(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const result = [];
  for (const candidate of value) {
    if (result.length >= MAX_RECENT_TARGETS) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const { targetId, alias, lastPath, hostFingerprint } = candidate;
    if (typeof targetId !== "string" || typeof alias !== "string" || !SSH_ALIAS.test(alias)
      || targetId !== `profile:${alias}` || seen.has(targetId)) continue;
    try {
      // Keep persistence and authority parsing on the same opaque-id grammar.
      encodeAuthority(targetId);
      validateRemoteWorkspacePath(lastPath);
    }
    catch {
      continue;
    }
    if (hostFingerprint !== null && hostFingerprint !== undefined
      && (typeof hostFingerprint !== "string" || !HOST_FINGERPRINT.test(hostFingerprint))) continue;
    seen.add(targetId);
    result.push(Object.freeze({
      targetId,
      alias,
      lastPath,
      hostFingerprint: hostFingerprint ?? null,
    }));
  }
  return Object.freeze(result);
}

export function selectActiveSessionAuthority(requestedAuthority, workspaceFolders) {
  if (requestedAuthority !== undefined && requestedAuthority !== null) {
    decodeAuthority(requestedAuthority);
    return requestedAuthority;
  }
  if (!Array.isArray(workspaceFolders)) return null;
  for (const folder of workspaceFolders) {
    const uri = folder?.uri;
    if (uri?.scheme !== "vscode-remote" || typeof uri.authority !== "string") continue;
    try {
      decodeAuthority(uri.authority);
      return uri.authority;
    }
    catch {}
  }
  return null;
}

export function formatRemoteFailure(operation, { alias, error } = {}) {
  if (!["resolve", "connect", "open-folder", "reconnect", "login"].includes(operation)) {
    throw new TypeError("unknown Chatero Remote operation");
  }
  const target = typeof alias === "string" && SSH_ALIAS.test(alias) ? alias : "the SSH target";
  const code = typeof error?.code === "string" ? error.code : null;
  const cancelled = error?.name === "AbortError" || code === "ABORT_ERR";
  let message;
  if (cancelled) message = "The Chatero Remote operation was cancelled.";
  else if (code === "SSH_AUTHENTICATION") {
    message = `OpenSSH authentication requires user action for ${target}.`;
  }
  else if (code === "SSH_TRANSPORT") {
    message = `The SSH transport for ${target} is unavailable.`;
  }
  else if (operation === "open-folder") {
    message = `Chatero Remote could not open the selected folder on ${target}.`;
  }
  else if (operation === "reconnect") {
    message = `Chatero Remote could not reconnect to ${target}.`;
  }
  else if (operation === "login") {
    message = `Chatero Remote could not open the SSH login terminal for ${target}.`;
  }
  else message = `Chatero Remote could not connect to ${target}.`;
  return Object.freeze({ message, resolverMessage: message });
}

export function formatRemoteStatus(state, { alias, path } = {}) {
  const target = typeof alias === "string" && SSH_ALIAS.test(alias) ? alias : "SSH target";
  let workspacePath = null;
  try {
    workspacePath = path === undefined ? null : validateRemoteWorkspacePath(path);
  }
  catch {}
  const pathSuffix = workspacePath ? `\n${workspacePath}` : "";
  const common = { command: "chatero.remote.showLog", isError: false };
  switch (state) {
    case "connecting":
      return Object.freeze({
        text: `$(sync~spin) Connecting to ${target}`,
        tooltip: `Chatero Remote is connecting to ${target}`,
        ...common,
      });
    case "connected":
      return Object.freeze({
        text: `$(remote) ${target}`,
        tooltip: `Chatero Remote is connected to ${target}${pathSuffix}`,
        ...common,
      });
    case "reconnecting":
      return Object.freeze({
        text: `$(sync~spin) Reconnecting to ${target}`,
        tooltip: `Chatero Remote is reconnecting to ${target}${pathSuffix}`,
        ...common,
      });
    case "error":
      return Object.freeze({
        text: `$(error) ${target}`,
        tooltip: `Chatero Remote could not connect to ${target}`,
        command: common.command,
        isError: true,
      });
    default:
      throw new TypeError("unknown Chatero Remote status");
  }
}

function encodePath(value) {
  return Buffer.from(validateRemoteWorkspacePath(value), "utf8").toString("base64url");
}

function sessionGeneration(session) {
  const state = session?.getPublicSession?.() ?? session;
  return Number.isSafeInteger(state?.generation) ? state.generation : null;
}

async function runWorkspaceHelper(session, operation, fields, signal) {
  if (!HELPER_OPERATIONS.has(operation)) throw new TypeError("unknown workspace helper operation");
  if (!session || typeof session.openProcessBridge !== "function") {
    throw new TypeError("connected SSH session is required");
  }
  const generation = sessionGeneration(session);
  const channel = session.openProcessBridge({ signal });
  if (generation !== null && channel.generation !== generation) {
    channel.close?.();
    throw new Error("stale workspace helper channel generation");
  }
  const output = [];
  let outputBytes = 0;
  const result = await runFramedBridgeRequest(channel, {
    protocolVersion: 1,
    command: "/proc/self/exe",
    args: ["--input-type=module", "--eval", WORKSPACE_HELPER_SOURCE, operation],
    cwd: "/",
    env: {},
  }, {
    onStdout(bytes) {
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        throw new Error("workspace helper output exceeds 64 KiB");
      }
      output.push(Buffer.from(bytes));
    },
  }, {
    signal,
    stdin: Buffer.from(`${JSON.stringify(fields)}\n`, "utf8"),
    isGenerationCurrent: () => generation === null || sessionGeneration(session) === generation,
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`workspace helper exited with ${result.code ?? result.signal}`);
  }
  const text = Buffer.concat(output).toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("workspace helper returned malformed JSON output");
  }
  try {
    return JSON.parse(text.slice(0, -1));
  }
  catch (error) {
    throw new Error(`workspace helper returned invalid JSON: ${error.message}`);
  }
}

export async function probeWorkspace(session, path, { signal } = {}) {
  const result = await runWorkspaceHelper(session, "probe", { path: encodePath(path) }, signal);
  if (!result || Object.keys(result).length !== 1
    || !["directory", "missing", "file"].includes(result.state)) {
    throw new Error("workspace probe returned an invalid state");
  }
  return result.state;
}

export async function createWorkspace(session, path, { signal } = {}) {
  const result = await runWorkspaceHelper(session, "create", { path: encodePath(path) }, signal);
  if (!result || Object.keys(result).length !== 1 || result.created !== true) {
    throw new Error("workspace creation returned an invalid result");
  }
}

export async function canonicalizeWorkspaceCwd(session, root, cwd, signal) {
  const result = await runWorkspaceHelper(session, "realpath", {
    root: encodePath(root),
    cwd: encodePath(cwd),
  }, signal);
  if (!result || Object.keys(result).sort().join(",") !== "cwd,root") {
    throw new Error("workspace realpath helper returned an invalid result");
  }
  const canonicalRoot = validateRemoteWorkspacePath(result.root);
  const canonicalCwd = validateRemoteWorkspacePath(result.cwd);
  if (!isPathInside(canonicalRoot, canonicalCwd)) {
    throw new Error("remote process cwd resolves outside the selected workspace root");
  }
  return Object.freeze({ root: canonicalRoot, cwd: canonicalCwd });
}

function safeRecentRecord(target, path, connection) {
  if (!target || typeof target.id !== "string" || typeof target.alias !== "string") {
    throw new TypeError("remote target identity is incomplete");
  }
  const fingerprint = connection?.hostFingerprint
    ?? connection?.ready?.hostFingerprint
    ?? connection?.session?.getPublicSession?.()?.hostFingerprint
    ?? connection?.session?.hostFingerprint
    ?? null;
  if (fingerprint !== null && (typeof fingerprint !== "string"
    || !/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(fingerprint))) {
    throw new TypeError("remote host fingerprint is invalid");
  }
  return Object.freeze({
    targetId: target.id,
    alias: target.alias,
    lastPath: path,
    hostFingerprint: fingerprint,
  });
}

/** A UI-independent picker transaction used by the extension and tests. */
export async function chooseRemoteWorkspace({
  selectTarget,
  promptPath,
  ensureAuthoritySession,
  probe = probeWorkspace,
  confirmCreate,
  create = createWorkspace,
  uriFrom,
  openFolder,
  persistRecent = async () => {},
  signal,
}) {
  for (const [name, dependency] of Object.entries({
    selectTarget, promptPath, ensureAuthoritySession, probe, confirmCreate, create, uriFrom, openFolder, persistRecent,
  })) {
    if (typeof dependency !== "function") throw new TypeError(`${name} must be a function`);
  }
  const target = await selectTarget();
  if (!target) return null;
  const path = await promptPath(target.lastPath ?? "/", target);
  if (path === undefined || path === null) return null;
  const validatedPath = validateRemoteWorkspacePath(path);
  const authority = encodeAuthority(target.id);

  // This is deliberately the same authority-session primitive used by the
  // resolver. There is no second authentication or unauthenticated probe path.
  const connection = await ensureAuthoritySession(authority, {
    signal,
    workspacePath: validatedPath,
  });
  const session = connection?.session ?? connection;
  const state = await probe(session, validatedPath, { signal });
  const created = [];
  if (state === "file") throw new Error(`Remote path is a file, not a folder: ${validatedPath}`);
  if (state === "missing") {
    const confirmed = await confirmCreate({ alias: target.alias, path: validatedPath });
    if (!confirmed) return null;
    await create(session, validatedPath, { signal });
    created.push(validatedPath);
  }
  else if (state !== "directory") throw new Error("Remote workspace probe returned an invalid state");

  const uri = uriFrom({ scheme: "vscode-remote", authority, path: validatedPath });
  await persistRecent(safeRecentRecord(target, validatedPath, connection));
  await openFolder(uri, { forceReuseWindow: true });
  return Object.freeze({
    uri,
    created: Object.freeze(created),
    checkedForQlab: false,
  });
}

export const REMOTE_WORKSPACE_LIMITS = Object.freeze({
  pathBytes: MAX_REMOTE_PATH_BYTES,
  helperOutputBytes: MAX_HELPER_OUTPUT_BYTES,
  recentTargets: MAX_RECENT_TARGETS,
});
