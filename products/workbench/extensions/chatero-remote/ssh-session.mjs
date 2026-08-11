import { spawn as spawnChild } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createManagedConnection, forwardingArguments, redactRemoteLog } from "./managed-connection.mjs";
import { assertConcreteAlias, OPENSSH_EXECUTABLE } from "./openssh-targets.mjs";
import { RemoteAgentInstaller, SshRemoteAgentRuntime } from "./remote-agent-installer.mjs";

const FINGERPRINT = /\bServer host key:\s+\S+\s+(SHA256:[A-Za-z0-9+/]{43}=?)\s*$/u;
const AUTHENTICATING = /\bAuthenticating to\s+(.+):(\d+)\s+as\s+['"]([^'"]+)['"]\s*$/u;
const MAX_MASTER_LOG = 1024 * 1024;
const DEFAULT_MASTER_TIMEOUT = 15_000;

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("SSH connection was cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("SSH connection was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseAuthenticatedFingerprint(log, target) {
  const negotiated = [];
  let authenticating = null;
  for (const line of log.split(/\r?\n/u)) {
    const auth = line.match(AUTHENTICATING);
    if (auth) {
      authenticating = {
        hostname: auth[1].replace(/^\[|\]$/gu, ""),
        port: Number(auth[2]),
        user: auth[3],
      };
      continue;
    }
    const key = line.match(FINGERPRINT);
    if (key) negotiated.push({ fingerprint: key[1], authenticating });
  }
  const targetKeys = target ? negotiated.filter(value => value.authenticating
    && value.authenticating.hostname.toLowerCase() === target.hostname.toLowerCase()
    && value.authenticating.port === target.port
    && value.authenticating.user === target.user) : negotiated;
  const fingerprints = new Set(targetKeys.map(value => value.fingerprint));
  if (fingerprints.size === 0 && negotiated.length) {
    const all = new Set(negotiated.map(value => value.fingerprint));
    if (all.size === 1) return [...all][0];
  }
  if (fingerprints.size !== 1) {
    throw new Error("SSH master did not expose one authenticated host key fingerprint");
  }
  return [...fingerprints][0];
}

async function createDefaultMasterRuntime() {
  const directory = await mkdtemp("/tmp/chatero-ssh-");
  await chmod(directory, 0o700);
  const logPath = join(directory, "master.log");
  await writeFile(logPath, "", { flag: "wx", mode: 0o600 });
  return Object.freeze({
    directory,
    controlPath: join(directory, "master.sock"),
    logPath,
  });
}

async function waitForDefaultMaster({ process, runtime, target, signal, timeout = DEFAULT_MASTER_TIMEOUT }) {
  let exit = null;
  const onExit = (code, closeSignal) => { exit = { code, signal: closeSignal }; };
  process.once("exit", onExit);
  const started = Date.now();
  try {
    while (Date.now() - started < timeout) {
      if (exit) break;
      const metadata = await lstat(runtime.controlPath).catch(error =>
        error?.code === "ENOENT" ? null : Promise.reject(error));
      if (metadata?.isSocket()) {
        const directoryMetadata = await lstat(runtime.directory);
        const logMetadata = await lstat(runtime.logPath);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()
          || (directoryMetadata.mode & 0o777) !== 0o700) {
          throw new Error("SSH master runtime is not an owner-only directory");
        }
        if (!logMetadata.isFile() || logMetadata.isSymbolicLink() || (logMetadata.mode & 0o777) !== 0o600
          || logMetadata.size > MAX_MASTER_LOG) {
          throw new Error("SSH master log is not an owner-only bounded regular file");
        }
        const log = await readFile(runtime.logPath, "utf8");
        return Object.freeze({ hostFingerprint: parseAuthenticatedFingerprint(log, target) });
      }
      await delay(25, signal);
    }
    const log = await readFile(runtime.logPath, "utf8").catch(() => "");
    const error = new Error(exit
      ? `SSH master exited with ${exit.code ?? exit.signal}`
      : "SSH master did not become ready in time");
    error.code = /Permission denied|Host key verification failed|Could not resolve hostname/iu.test(log)
      ? "SSH_AUTHENTICATION"
      : "SSH_TRANSPORT";
    throw error;
  }
  finally {
    process.off("exit", onExit);
  }
}

function masterArguments(runtime, alias) {
  return Object.freeze([
    "-vv",
    "-E", runtime.logPath,
    "-MN",
    "-o", "FingerprintHash=sha256",
    "-o", "ControlMaster=yes",
    "-o", "ControlPersist=no",
    "-o", "BatchMode=yes",
    "-o", `ControlPath=${runtime.controlPath}`,
    "--", alias,
  ]);
}

function processBridgeRemoteCommand(installRelativePath) {
  if (typeof installRelativePath !== "string"
    || !/^\.chatero-server\/bin\/[0-9a-f]{40}\/linux-(?:x86_64|aarch64)$/u.test(installRelativePath)) {
    throw new Error("verified Remote Agent install root is invalid");
  }
  // No user-controlled command, argument, cwd, token, or workspace path appears here.
  return `exec "$HOME/${installRelativePath}/node" "$HOME/${installRelativePath}/bin/chatero-process-bridge.mjs"`;
}

function targetIdentity(target) {
  if (!target || typeof target !== "object") throw new TypeError("resolved SSH target is required");
  return JSON.stringify({
    alias: assertConcreteAlias(target.alias),
    hostname: target.hostname ?? null,
    user: target.user ?? null,
    port: target.port ?? null,
    identityFiles: Array.isArray(target.identityFiles) ? [...target.identityFiles] : [],
    proxyJump: target.proxyJump ?? null,
    proxyCommand: target.proxyCommand ?? null,
  });
}

function makeRawChannel(process, generation, isCurrent, log) {
  let closed = false;
  const closeListeners = new Set();
  const dataListeners = new Set();
  const errorListeners = new Set();
  const emitClose = result => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener(result);
  };
  process.stdout.on("data", bytes => {
    if (isCurrent()) for (const listener of [...dataListeners]) listener(Uint8Array.from(bytes));
  });
  process.stderr.on("data", bytes => {
    if (!isCurrent()) return;
    const value = redactRemoteLog(Buffer.from(bytes).toString("utf8"));
    log(value);
    for (const listener of [...errorListeners]) listener(value);
  });
  process.on("error", error => { if (isCurrent()) emitClose({ code: null, signal: null, error }); });
  process.on("close", (code, signal) => { if (isCurrent()) emitClose({ code, signal, error: null }); });
  const channel = {
    generation,
    write(bytes) {
      if (closed || !isCurrent()) throw new Error("stale remote process bridge channel");
      if (!(bytes instanceof Uint8Array)) throw new TypeError("process bridge accepts Uint8Array frames");
      return process.stdin.write(Buffer.from(bytes));
    },
    end() {
      if (!closed && isCurrent()) process.stdin.end();
    },
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onStderr(listener) {
      errorListeners.add(listener);
      return { dispose: () => errorListeners.delete(listener) };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    close() {
      if (closed) return;
      process.kill?.("SIGTERM");
      emitClose({ code: null, signal: "SIGTERM", error: null });
    },
  };
  return channel;
}

export class SshSession {
  constructor({
    spawn = spawnChild,
    createMasterRuntime = createDefaultMasterRuntime,
    waitForMaster = waitForDefaultMaster,
    installer,
    installerFactory,
    log = () => {},
  } = {}) {
    this.spawn = spawn;
    this.createMasterRuntime = createMasterRuntime;
    this.waitForMaster = waitForMaster;
    this.installer = installer;
    this.installerFactory = installerFactory;
    this.log = value => log(redactRemoteLog(value));
    this.generation = 0;
    this.ready = null;
    this.master = null;
    this.connections = new Set();
    this.processChannels = new Set();
    this.connecting = null;
    this.connectingIdentity = null;
    this.installTransactions = new Map();
  }

  ensureReady(input) {
    const identity = targetIdentity(input.target);
    if (this.ready && this.ready.targetIdentity === identity) {
      return Promise.resolve(this.publicReadyState());
    }
    if (this.connecting) {
      if (this.connectingIdentity === identity) return this.connecting;
      return this.connecting.catch(() => {}).then(() => this.ensureReady(input));
    }
    this.connectingIdentity = identity;
    const connecting = this.#connect(input).finally(() => {
      if (this.connecting === connecting) {
        this.connecting = null;
        this.connectingIdentity = null;
      }
    });
    this.connecting = connecting;
    return connecting;
  }

  async #connect({ target, release, signal }) {
    const alias = assertConcreteAlias(target?.alias);
    const identity = targetIdentity(target);
    if (this.ready || this.master) await this.dispose();
    if (signal?.aborted) throw signal.reason ?? new Error("SSH connection was cancelled");
    const runtime = await this.createMasterRuntime();
    const generation = ++this.generation;
    const process = this.spawn(OPENSSH_EXECUTABLE, masterArguments(runtime, alias), {
      detached: false,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.master = { alias, generation, process, runtime };
    const lost = (code, closeSignal) => this.#invalidate(generation,
      new Error(`SSH master for ${alias} exited with ${code ?? closeSignal ?? "unknown status"}`));
    process.once("exit", lost);
    process.once("error", error => this.#invalidate(generation, error));
    try {
      const authenticated = await this.waitForMaster({ process, runtime, target, signal });
      if (this.generation !== generation || this.master?.generation !== generation) {
        throw new Error("SSH master became stale while connecting");
      }
      const installer = this.installer ?? this.installerFactory?.({
        alias,
        controlPath: runtime.controlPath,
        log: this.log,
        transactionState: this.installTransactions,
      }) ?? new RemoteAgentInstaller({
        remote: new SshRemoteAgentRuntime({
          alias,
          controlPath: runtime.controlPath,
          spawn: this.spawn,
          log: this.log,
        }),
        transactionState: this.installTransactions,
      });
      const installed = await installer.ensureInstalled({
        alias,
        controlPath: runtime.controlPath,
        target,
        release,
        signal,
      });
      this.ready = Object.freeze({
        alias,
        targetIdentity: identity,
        controlPath: runtime.controlPath,
        generation,
        hostFingerprint: authenticated.hostFingerprint,
        ...installed,
      });
      return this.publicReadyState();
    }
    catch (error) {
      this.#invalidate(generation, error);
      throw error;
    }
  }

  publicReadyState() {
    if (!this.ready) throw new Error("SSH session is not ready");
    return Object.freeze({
      hostFingerprint: this.ready.hostFingerprint,
      remotePort: this.ready.remotePort,
      connectionToken: this.ready.connectionToken,
    });
  }

  getPublicSession() {
    if (!this.ready) return null;
    return Object.freeze({
      alias: this.ready.alias,
      generation: this.ready.generation,
      hostFingerprint: this.ready.hostFingerprint,
      remotePort: this.ready.remotePort,
      tuple: this.ready.tuple,
    });
  }

  makeConnection() {
    if (!this.ready) throw new Error("SSH session is not ready");
    const state = this.ready;
    const process = this.spawn(OPENSSH_EXECUTABLE, forwardingArguments(state), {
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = createManagedConnection(process, {
      isCurrent: () => this.ready?.generation === state.generation,
      log: this.log,
    });
    this.connections.add(connection);
    connection.onDidClose(error => {
      this.connections.delete(connection);
      if (error) this.#invalidate(state.generation, error);
    });
    return connection;
  }

  openProcessBridge({ signal } = {}) {
    if (!this.ready) throw new Error("SSH session is not ready");
    if (signal?.aborted) throw signal.reason ?? new Error("remote process was cancelled");
    const state = this.ready;
    const command = processBridgeRemoteCommand(state.installRelativePath);
    const process = this.spawn(OPENSSH_EXECUTABLE, [
      "-T", "-S", state.controlPath,
      "-o", "BatchMode=yes",
      "--", state.alias,
      command,
    ], {
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const channel = makeRawChannel(
      process,
      state.generation,
      () => this.ready?.generation === state.generation,
      this.log,
    );
    this.processChannels.add(channel);
    channel.onClose(() => this.processChannels.delete(channel));
    signal?.addEventListener("abort", () => channel.close(), { once: true });
    return channel;
  }

  #invalidate(generation, error) {
    if (this.generation !== generation) return;
    this.generation++;
    this.ready = null;
    const master = this.master;
    this.master = null;
    for (const connection of [...this.connections]) connection.forceClose(error);
    this.connections.clear();
    for (const channel of [...this.processChannels]) channel.close();
    this.processChannels.clear();
    master?.process.kill?.("SIGTERM");
    if (master?.runtime.directory) {
      void rm(master.runtime.directory, { force: true, recursive: true });
    }
  }

  async dispose() {
    if (!this.master) {
      this.ready = null;
      return;
    }
    const generation = this.generation;
    this.#invalidate(generation, new Error("SSH session was closed"));
  }
}

export { masterArguments, parseAuthenticatedFingerprint, processBridgeRemoteCommand, targetIdentity };
