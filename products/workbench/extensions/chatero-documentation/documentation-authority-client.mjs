import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import { createWorkspaceTransactionAdapter } from "./documentation-workspace.mjs";

const MAX_FRAME_BYTES = 128 * 1024 * 1024;

function extensionPath(extensionUri) {
  if (extensionUri instanceof URL) {
    if (extensionUri.protocol !== "file:") throw new TypeError("Documentation extension URI must be file-backed");
    return resolve(fileURLToPath(extensionUri));
  }
  if (!extensionUri || typeof extensionUri !== "object" || extensionUri.scheme !== "file") {
    throw new TypeError("Documentation extension URI must be file-backed");
  }
  const value = typeof extensionUri.fsPath === "string" ? extensionUri.fsPath : extensionUri.path;
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError("Documentation extension path must be absolute");
  }
  return resolve(value);
}

function exactFrame(frame) {
  if (typeof frame !== "string" || frame.length === 0
    || Buffer.byteLength(frame, "ascii") > MAX_FRAME_BYTES
    || !/^[A-Za-z0-9_-]+$/u.test(frame)) {
    throw new TypeError("Documentation authority frame is invalid");
  }
  return frame;
}

export function makeFixedHelperInvocation({ processPath, helperPath, frame, electron }) {
  if (typeof processPath !== "string" || !isAbsolute(processPath)
    || typeof helperPath !== "string" || !isAbsolute(helperPath)
    || typeof electron !== "boolean") {
    throw new TypeError("fixed Documentation helper invocation is invalid");
  }
  return Object.freeze({
    command: processPath,
    args: Object.freeze([helperPath]),
    stdin: `${exactFrame(frame)}\n`,
    options: Object.freeze({
      shell: false,
      windowsHide: true,
      env: Object.freeze(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    }),
  });
}

function runInvocation(spawn, invocation) {
  return new Promise((resolveResponse, rejectResponse) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, invocation.options);
    }
    catch (error) {
      rejectResponse(error);
      return;
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr
      || typeof child.once !== "function" || typeof child.kill !== "function") {
      rejectResponse(new TypeError("Documentation helper process is invalid"));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const fail = error => {
      try { child.kill(); }
      catch {}
      finish(rejectResponse, error);
    };
    child.stdout.on("data", chunk => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_FRAME_BYTES + 1) {
        fail(new RangeError("Documentation helper response is too large"));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", chunk => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > 64 * 1024) {
        fail(new RangeError("Documentation helper diagnostics are too large"));
        return;
      }
      stderr.push(bytes);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        fail(new Error(message || "Documentation helper disconnected before a response"));
        return;
      }
      const bytes = Buffer.concat(stdout);
      if (bytes.byteLength < 2 || bytes.at(-1) !== 0x0a
        || bytes.subarray(0, -1).includes(0x0a)) {
        fail(new TypeError("Documentation helper must emit exactly one response frame"));
        return;
      }
      const frame = bytes.subarray(0, -1).toString("ascii");
      try {
        if (!Buffer.from(frame, "ascii").equals(bytes.subarray(0, -1))) {
          throw new TypeError("Documentation helper response is not ASCII");
        }
        finish(resolveResponse, exactFrame(frame));
      }
      catch (error) {
        fail(error);
      }
    });
    child.stdin.once?.("error", fail);
    child.stdin.end(invocation.stdin);
  });
}

export function createFixedAuthorityTransport({
  extensionUri,
  processPath,
  spawn,
  verifyTrustedRuntime,
  electron = process.versions.electron !== undefined,
}) {
  const root = extensionPath(extensionUri);
  const helperPath = join(root, "runtime", "chatero-documentation-authority.mjs");
  if (typeof spawn !== "function" || typeof verifyTrustedRuntime !== "function") {
    throw new TypeError("Documentation authority transport dependencies are invalid");
  }
  return Object.freeze({
    async request(frame) {
      const proof = await verifyTrustedRuntime({ extensionRoot: root, helperPath });
      if (!proof || proof.kind !== "verified" || resolve(proof.canonicalRoot) !== root) {
        throw new Error("Documentation trusted runtime verification failed");
      }
      const invocation = makeFixedHelperInvocation({
        processPath,
        helperPath,
        frame,
        electron,
      });
      return runInvocation(spawn, invocation);
    },
  });
}

export function createDocumentationAuthorityClient({ scope, workspaceView, fixedTransport }) {
  return createWorkspaceTransactionAdapter({
    scope,
    workspaceView,
    transport: fixedTransport,
  });
}
