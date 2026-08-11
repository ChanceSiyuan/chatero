const { createReadStream } = require("node:fs");
const { lstat, readFile, realpath } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const vscode = require("vscode");

const MAX_COMMAND_OUTPUT = 1024 * 1024;

async function activate(context) {
  const [authority, targets, sessionModule, managed] = await Promise.all([
    import("./authority.mjs"),
    import("./openssh-targets.mjs"),
    import("./ssh-session.mjs"),
    import("./managed-connection.mjs"),
  ]);
  const output = vscode.window.createOutputChannel("Chatero Remote", { log: true });
  const sessions = new Map();
  let activeAuthority = null;
  let lastAlias = null;
  let releasePromise = null;

  const append = value => output.appendLine(managed.redactRemoteLog(value).trimEnd());
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = destination => chunk => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT) child.kill("SIGTERM");
      else destination.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (bytes > MAX_COMMAND_OUTPUT) {
        reject(new Error("OpenSSH command output exceeded 1 MiB"));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

  const openLoginTerminal = alias => {
    const selected = targets.assertConcreteAlias(alias ?? lastAlias);
    const terminal = vscode.window.createTerminal({
      name: `SSH login: ${selected}`,
      shellPath: targets.OPENSSH_EXECUTABLE,
      shellArgs: [selected, "true"],
    });
    terminal.show();
  };

  const readRelease = async () => {
    const releaseDirectory = process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR
      ? path.resolve(process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR)
      : context.asAbsolutePath("remote-agent");
    const canonicalRoot = await realpath(releaseDirectory);
    const safeFile = async filename => {
      const candidate = path.resolve(canonicalRoot, filename);
      const relative = path.relative(canonicalRoot, candidate);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Remote Agent release file escapes its signed directory");
      }
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Remote Agent release file is unsafe: ${filename}`);
      }
      const canonical = await realpath(candidate);
      if (canonical !== candidate) throw new Error(`Remote Agent release file is indirect: ${filename}`);
      return candidate;
    };
    const manifestPath = await safeFile("manifest.json");
    const signaturePath = await safeFile("manifest.sig");
    const publicKeyPath = context.asAbsolutePath("runtime/release-public-key.pem");
    return Object.freeze({
      manifestText: await readFile(manifestPath, "utf8"),
      signature: await readFile(signaturePath),
      publicKey: await readFile(publicKeyPath),
      readArtifact: async filename => createReadStream(await safeFile(filename)),
    });
  };
  const loadRelease = () => {
    if (!releasePromise) {
      releasePromise = readRelease().catch(error => {
        releasePromise = null;
        throw error;
      });
    }
    return releasePromise;
  };

  const ensureAuthoritySession = async (remoteAuthority, { signal } = {}) => {
    const targetId = authority.decodeAuthority(remoteAuthority);
    if (!targetId.startsWith("profile:")) throw new Error("unknown remote target kind");
    const alias = targets.assertConcreteAlias(targetId.slice("profile:".length));
    try {
      lastAlias = alias;
      append(`Resolving SSH target ${alias}`);
      const target = await targets.resolveSshTarget(alias, run);
      append(`Resolved ${alias} as ${target.user}@${target.hostname}:${target.port}`);
      const release = await loadRelease();
      let sshSession = sessions.get(remoteAuthority);
      if (!sshSession) {
        sshSession = new sessionModule.SshSession({ spawn, log: append });
        sessions.set(remoteAuthority, sshSession);
      }
      const ready = await sshSession.ensureReady({ target, release, signal });
      activeAuthority = remoteAuthority;
      return { alias, ready, session: sshSession, target };
    }
    catch (error) {
      if (error && typeof error === "object" && !Object.hasOwn(error, "chateroAlias")) {
        try { Object.defineProperty(error, "chateroAlias", { value: alias }); }
        catch {}
      }
      throw error;
    }
  };

  const resolver = {
    async resolve(remoteAuthority) {
      let alias;
      try {
        const resolved = await ensureAuthoritySession(remoteAuthority);
        alias = resolved.alias;
        return new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(resolved.session.makeConnection()),
          resolved.ready.connectionToken,
        );
      }
      catch (error) {
        alias ??= error?.chateroAlias;
        append(error?.stack ?? error);
        if (error?.code === "SSH_AUTHENTICATION") {
          const action = "Open SSH Login Terminal";
          const selected = await vscode.window.showWarningMessage(
            `OpenSSH could not authenticate ${alias}. Complete login in a terminal, then reconnect.`,
            action,
          );
          if (selected === action) openLoginTerminal(alias);
          throw vscode.RemoteAuthorityResolverError.NotAvailable("SSH authentication requires user action", true);
        }
        if (error?.code === "SSH_TRANSPORT") {
          throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("The SSH transport is unavailable");
        }
        throw vscode.RemoteAuthorityResolverError.NotAvailable(error?.message ?? "Chatero Remote could not connect", true);
      }
    },
  };

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver("chatero-remote", resolver));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.remote.showLog", () => output.show()));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.remote.openLoginTerminal", () => openLoginTerminal()));
  context.subscriptions.push({
    dispose() {
      for (const value of sessions.values()) void value.dispose();
      sessions.clear();
    },
  });

  const activeSession = requestedAuthority => {
    const key = requestedAuthority ?? activeAuthority;
    const value = key ? sessions.get(key) : null;
    if (!value?.getPublicSession()) throw new Error("No connected Chatero SSH session is active");
    return value;
  };
  const pendingFeature = name => {
    const error = new Error(`${name} is not registered by its feature module`);
    error.code = "CHATERO_REMOTE_FEATURE_UNAVAILABLE";
    throw error;
  };

  return Object.freeze({
    async ensureAuthoritySession(remoteAuthority, options = {}) {
      const resolved = await ensureAuthoritySession(remoteAuthority, options);
      return resolved.session.getPublicSession();
    },
    getActiveSession(requestedAuthority) {
      const value = activeSession(requestedAuthority);
      return value.getPublicSession();
    },
    openProcessBridge(options = {}) {
      return activeSession(options.authority).openProcessBridge(options);
    },
    runProcess(_request, _observer, _signal) {
      return pendingFeature("Remote process service");
    },
    stageEvidence(_request, _signal) {
      return pendingFeature("Remote evidence cache");
    },
    revokeEvidence(_digest, _signal) {
      return pendingFeature("Remote evidence cache");
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
