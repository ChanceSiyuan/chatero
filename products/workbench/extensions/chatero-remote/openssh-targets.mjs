import { realpath as realpathFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SSH = "/usr/bin/ssh";
const MAX_INCLUDE_DEPTH = 16;
const MAX_CONFIG_BYTES = 1024 * 1024;
const CONCRETE_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,253}[A-Za-z0-9])?$/;

export function assertConcreteAlias(alias) {
  if (typeof alias !== "string" || !CONCRETE_ALIAS.test(alias)) {
    throw new TypeError("OpenSSH alias must be one concrete, shell-free identifier");
  }
  return alias;
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function tokenize(line) {
  const values = [];
  let value = "";
  let quote = null;
  let escaping = false;
  const flush = () => {
    if (value) values.push(value);
    value = "";
  };
  for (const character of line) {
    if (escaping) {
      value += character;
      escaping = false;
    }
    else if (character === "\\" && quote !== "'") escaping = true;
    else if (quote) {
      if (character === quote) quote = null;
      else value += character;
    }
    else if (character === "'" || character === '"') quote = character;
    else if (character === "#") break;
    else if (/\s/u.test(character)) flush();
    else value += character;
  }
  if (escaping) value += "\\";
  flush();
  return values;
}

function directive(tokens) {
  if (!tokens[0]) return null;
  const equal = tokens[0].indexOf("=");
  if (equal >= 0) {
    return {
      keyword: tokens[0].slice(0, equal).toLowerCase(),
      values: [tokens[0].slice(equal + 1), ...tokens.slice(1)].filter(Boolean),
    };
  }
  return {
    keyword: tokens[0].toLowerCase(),
    values: tokens[1] === "=" ? tokens.slice(2) : tokens.slice(1),
  };
}

function globPattern(segment) {
  let pattern = "^";
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else if (character === "[") {
      const end = segment.indexOf("]", index + 1);
      if (end > index + 1) {
        pattern += `[${segment.slice(index + 1, end).replace(/^!/u, "^").replace(/\\/gu, "\\\\")}]`;
        index = end;
      }
      else pattern += "\\[";
    }
    else pattern += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${pattern}$`, "u");
}

async function defaultExpandGlob(pattern) {
  const absolute = resolve(pattern);
  const parts = absolute.split(sep).filter(Boolean);
  let candidates = [sep];
  for (const part of parts) {
    const matcher = globPattern(part);
    const magic = /[*?[]/u.test(part);
    const next = [];
    for (const parent of candidates) {
      if (!magic) {
        next.push(join(parent, part));
        continue;
      }
      const entries = await readdir(parent, { withFileTypes: true }).catch(error =>
        error?.code === "ENOENT" ? [] : Promise.reject(error));
      for (const entry of entries) if (matcher.test(entry.name)) next.push(join(parent, entry.name));
    }
    candidates = next;
  }
  return candidates;
}

async function optionalRead(readFile, path) {
  const value = await readFile(path, "utf8").catch(error =>
    error?.code === "ENOENT" ? null : Promise.reject(error));
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`OpenSSH configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  return text;
}

export async function discoverSshTargets({
  home,
  readFile,
  realpath = realpathFile,
  expandGlob = defaultExpandGlob,
}) {
  if (!isAbsolute(home) || /[\0\r\n]/u.test(home)) throw new TypeError("home must be an absolute path");
  if (typeof readFile !== "function") throw new TypeError("readFile must be a function");
  const sshRoot = resolve(home, ".ssh");
  const seenFiles = new Set();
  const seenAliases = new Set();
  const aliases = [];

  const readConfig = async (path, depth) => {
    if (depth > MAX_INCLUDE_DEPTH) throw new Error(`OpenSSH Include depth exceeds ${MAX_INCLUDE_DEPTH}`);
    const normalized = resolve(path);
    if (!inside(sshRoot, normalized)) throw new Error("OpenSSH Include escapes ~/.ssh");
    const text = await optionalRead(readFile, normalized);
    if (text === null) return;
    const canonical = await realpath(normalized).catch(error =>
      error?.code === "ENOENT" ? normalized : Promise.reject(error));
    if (!inside(sshRoot, canonical)) throw new Error("OpenSSH Include resolves outside ~/.ssh");
    if (seenFiles.has(canonical)) return;
    seenFiles.add(canonical);

    for (const line of text.split(/\r?\n/u)) {
      const entry = directive(tokenize(line));
      if (!entry) continue;
      if (entry.keyword === "include") {
        for (const rawPattern of entry.values) {
          const pattern = rawPattern === "~" ? home
            : rawPattern.startsWith("~/") ? resolve(home, rawPattern.slice(2))
              : isAbsolute(rawPattern) ? resolve(rawPattern)
                : resolve(sshRoot, rawPattern);
          if (!inside(sshRoot, pattern.split(/[*?[]/u)[0] || pattern)) {
            throw new Error("OpenSSH Include escapes ~/.ssh");
          }
          const matches = [...await expandGlob(pattern)].map(value => resolve(value)).sort();
          for (const match of matches) await readConfig(match, depth + 1);
        }
      }
      else if (entry.keyword === "host") {
        for (const alias of entry.values) {
          if (!CONCRETE_ALIAS.test(alias) || seenAliases.has(alias)) continue;
          seenAliases.add(alias);
          aliases.push(alias);
        }
      }
    }
  };

  await readConfig(resolve(sshRoot, "config"), 0);
  return Object.freeze(aliases.map(alias => Object.freeze({
    id: `profile:${alias}`,
    alias,
    label: alias,
  })));
}

function parseEffectiveConfiguration(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("ssh -G output is invalid or too large");
  }
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.search(/\s/u);
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    if (!value) continue;
    const entries = values.get(key) ?? [];
    entries.push(value);
    values.set(key, entries);
  }
  return values;
}

export async function resolveSshTarget(alias, runner) {
  assertConcreteAlias(alias);
  if (typeof runner !== "function") throw new TypeError("runner must be a function");
  const result = await runner(SSH, ["-G", "--", alias]);
  const code = result?.code ?? result?.exitCode;
  if (code !== 0) {
    const detail = String(result?.stderr ?? "").trim();
    throw new Error(`ssh -G failed for ${alias}${detail ? `: ${detail}` : ""}`);
  }
  const values = parseEffectiveConfiguration(result.stdout);
  const hostname = values.get("hostname")?.[0];
  const user = values.get("user")?.[0];
  const portText = values.get("port")?.[0];
  const port = Number(portText);
  if (!hostname || /[\0\r\n]/u.test(hostname)) throw new Error("ssh -G omitted the effective hostname");
  if (!user || /[\0\r\n]/u.test(user)) throw new Error("ssh -G omitted the effective user");
  if (!/^\d+$/u.test(portText ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("ssh -G omitted a valid effective port");
  }
  const nullable = key => {
    const value = values.get(key)?.[0];
    return !value || value.toLowerCase() === "none" ? null : value;
  };
  return Object.freeze({
    alias,
    hostname,
    user,
    port,
    identityFiles: Object.freeze([...(values.get("identityfile") ?? [])]),
    proxyJump: nullable("proxyjump"),
    proxyCommand: nullable("proxycommand"),
  });
}

export const OPENSSH_EXECUTABLE = SSH;
