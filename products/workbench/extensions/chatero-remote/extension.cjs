const { createReadStream } = require("node:fs");
const { lstat, readFile, realpath } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { homedir } = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const RECENT_TARGETS_KEY = "chatero.remote.recentTargets.v1";
const SHOW_REMOTE_LOG = "Show Remote Log";

function openCodexLoginTerminal(session, folder) {
  if (folder?.uri?.scheme !== "vscode-remote"
    || typeof folder.uri.authority !== "string"
    || !folder.uri.authority.startsWith("chatero-remote+")) {
    throw new Error("Codex login requires an active Chatero SSH workspace");
  }
  const terminal = vscode.window.createTerminal(
    session.getCodexLoginTerminalOptions(folder.uri),
  );
  terminal.show();
  return terminal;
}

async function activate(context) {
  const [authority, targets, sessionModule, managed, remoteWorkspace, remoteProcess, evidenceModule, evidenceControllerModule] = await Promise.all([
    import("./authority.mjs"),
    import("./openssh-targets.mjs"),
    import("./ssh-session.mjs"),
    import("./managed-connection.mjs"),
    import("./remote-workspace.mjs"),
    import("./remote-process.mjs"),
    import("./evidence-cache.mjs"),
    import("./remote-evidence-controller.mjs"),
  ]);
  const output = vscode.window.createOutputChannel("Chatero Remote", { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "Chatero Remote";
  const sessions = new Map();
  const activeRemoteFolder = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const selected = remoteWorkspace.selectActiveSessionAuthority(undefined, folders);
    return selected ? folders.find(folder =>
      folder?.uri?.scheme === "vscode-remote" && folder.uri.authority === selected) ?? null : null;
  };
  let lastAlias = null;
  let releasePromise = null;
  let evidenceService = null;
  let recentTargets = remoteWorkspace.sanitizeRecentTargets(
    context.globalState.get(RECENT_TARGETS_KEY, []),
  );

  const append = value => output.appendLine(managed.redactRemoteLog(value).trimEnd());
  const setStatus = (state, details = {}) => {
    const value = remoteWorkspace.formatRemoteStatus(state, {
      ...details,
      path: details.path ?? activeRemoteFolder()?.uri.path,
    });
    status.text = value.text;
    status.tooltip = value.tooltip;
    status.command = value.command;
    status.backgroundColor = value.isError
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
    status.show();
  };
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

  // Rewrite older state through the allowlist on every activation so no
  // credential-like or evidence fields survive an extension upgrade.
  await context.globalState.update(RECENT_TARGETS_KEY, recentTargets);

  const persistRecent = async record => {
    recentTargets = remoteWorkspace.sanitizeRecentTargets([record, ...recentTargets]);
    await context.globalState.update(RECENT_TARGETS_KEY, recentTargets);
  };

  const targetForAuthority = remoteAuthority => {
    const targetId = authority.decodeAuthority(remoteAuthority);
    if (!targetId.startsWith("profile:")) throw new Error("unknown remote target kind");
    const alias = targets.assertConcreteAlias(targetId.slice("profile:".length));
    const recent = recentTargets.find(value => value.targetId === targetId);
    return Object.freeze({
      id: targetId,
      alias,
      label: alias,
      lastPath: recent?.lastPath ?? "/",
    });
  };

  const pickTarget = async ({ preferAuthority } = {}) => {
    const discovered = await targets.discoverSshTargets({ home: homedir(), readFile }).catch(error => {
      append(`Could not read OpenSSH aliases: ${error?.message ?? error}`);
      return [];
    });
    const preferredId = (() => {
      try { return preferAuthority ? authority.decodeAuthority(preferAuthority) : null; }
      catch { return null; }
    })();
    const recents = [...recentTargets].sort((left, right) =>
      Number(right.targetId === preferredId) - Number(left.targetId === preferredId));
    const known = new Set(recents.map(value => value.targetId));
    const choices = [
      ...recents.map(value => ({
        label: `$(history) ${value.alias}`,
        description: value.lastPath,
        detail: "Recent Chatero SSH target",
        target: Object.freeze({
          id: value.targetId,
          alias: value.alias,
          label: value.alias,
          lastPath: value.lastPath,
        }),
      })),
      ...discovered.filter(value => !known.has(value.id)).map(value => ({
        label: `$(remote) ${value.alias}`,
        detail: "OpenSSH config",
        target: value,
      })),
      {
        label: "$(add) Add user@host…",
        detail: "Use a direct OpenSSH destination",
        addDirect: true,
      },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: "Chatero: Connect to SSH",
      placeHolder: "Choose an OpenSSH target",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) return null;
    if (!selected.addDirect) return selected.target;
    const alias = await vscode.window.showInputBox({
      title: "Chatero: Add SSH Target",
      prompt: "Enter an OpenSSH destination such as user@host",
      placeHolder: "user@host",
      ignoreFocusOut: true,
      validateInput(value) {
        try {
          targets.assertConcreteAlias(value);
          return null;
        }
        catch (error) {
          return error?.message ?? "Enter one OpenSSH destination";
        }
      },
    });
    if (!alias) return null;
    const selectedAlias = targets.assertConcreteAlias(alias);
    return Object.freeze({
      id: `profile:${selectedAlias}`,
      alias: selectedAlias,
      label: selectedAlias,
      lastPath: "/",
    });
  };

  const ensureAuthoritySession = async (remoteAuthority, {
    signal,
    statusState = "connecting",
    workspacePath,
  } = {}) => {
    const targetId = authority.decodeAuthority(remoteAuthority);
    if (!targetId.startsWith("profile:")) throw new Error("unknown remote target kind");
    const alias = targets.assertConcreteAlias(targetId.slice("profile:".length));
    try {
      lastAlias = alias;
      setStatus(statusState, { alias, path: workspacePath });
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
      if (evidenceService) {
        const publicSession = sshSession.getPublicSession();
        await evidenceService.cleanupSession({
          targetId,
          hostFingerprint: publicSession.hostFingerprint,
          generation: publicSession.generation,
          session: sshSession,
        }, signal);
      }
      setStatus("connected", { alias, path: workspacePath });
      return { alias, ready, session: sshSession, target };
    }
    catch (error) {
      append(error?.stack ?? error);
      // Detailed failures stay in the redacted output channel. The status bar
      // must not surface a token, key path, or other transport detail.
      setStatus("error", { alias });
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
        const resolved = await ensureAuthoritySession(remoteAuthority, {
          statusState: sessions.has(remoteAuthority) ? "reconnecting" : "connecting",
        });
        alias = resolved.alias;
        return new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(resolved.session.makeConnection()),
          resolved.ready.connectionToken,
        );
      }
      catch (error) {
        alias ??= error?.chateroAlias;
        const failure = remoteWorkspace.formatRemoteFailure("resolve", { alias, error });
        if (error?.code === "SSH_AUTHENTICATION") {
          const action = "Open SSH Login Terminal";
          const selected = await vscode.window.showWarningMessage(
            failure.message,
            action, SHOW_REMOTE_LOG,
          );
          if (selected === action) openLoginTerminal(alias);
          if (selected === SHOW_REMOTE_LOG) output.show();
          throw vscode.RemoteAuthorityResolverError.NotAvailable(failure.resolverMessage, true);
        }
        if (error?.code === "SSH_TRANSPORT") {
          const selected = await vscode.window.showWarningMessage(
            failure.message,
            SHOW_REMOTE_LOG,
          );
          if (selected === SHOW_REMOTE_LOG) output.show();
          throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(failure.resolverMessage);
        }
        const selected = await vscode.window.showErrorMessage(
          failure.message,
          SHOW_REMOTE_LOG,
        );
        if (selected === SHOW_REMOTE_LOG) output.show();
        throw vscode.RemoteAuthorityResolverError.NotAvailable(failure.resolverMessage, true);
      }
    },
  };

  const activeSession = requestedAuthority => {
    const key = remoteWorkspace.selectActiveSessionAuthority(
      requestedAuthority,
      vscode.workspace.workspaceFolders,
    );
    const value = key ? sessions.get(key) : null;
    if (!value?.getPublicSession()) throw new Error("No connected Chatero SSH session is active");
    return value;
  };
  const processService = new remoteProcess.RemoteProcessService({
    getSession: requestedAuthority => activeSession(requestedAuthority),
    getWorkspaceFolder: activeRemoteFolder,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    canonicalizeWorkspaceCwd: remoteWorkspace.canonicalizeWorkspaceCwd,
  });
  const evidenceContext = targetId => {
    const remoteAuthority = authority.encodeAuthority(targetId);
    const session = sessions.get(remoteAuthority);
    const publicSession = session?.getPublicSession();
    if (!publicSession) throw new Error("The selected SSH target is unavailable");
    return Object.freeze({
      targetId,
      hostFingerprint: publicSession.hostFingerprint,
      generation: publicSession.generation,
      session,
    });
  };
  const reconnectEvidence = async targetId => {
    const remoteAuthority = authority.encodeAuthority(targetId);
    const existing = sessions.get(remoteAuthority);
    if (existing) await existing.dispose();
    await ensureAuthoritySession(remoteAuthority, { statusState: "reconnecting" });
    return evidenceContext(targetId);
  };
  const getZoteroApi = async () => {
    const extension = vscode.extensions.getExtension("chatero.chatero-zotero");
    if (!extension) throw new Error("Chatero Zotero is unavailable");
    const api = extension.isActive ? extension.exports : await extension.activate();
    if (!api || typeof api.redeemFullPdfGrant !== "function") {
      throw new Error("The authorized PDF source is unavailable");
    }
    return api;
  };
  let evidenceController;
  evidenceService = new evidenceModule.EvidenceCacheService({
    getContext: targetId => evidenceContext(targetId),
    getZoteroApi,
    reconnect: reconnectEvidence,
    onExpired: event => evidenceController?.handleExpired(event),
    onRevoked: event => evidenceController?.handleRevoked(event),
  });
  evidenceController = new evidenceControllerModule.RemoteEvidenceController({
    service: evidenceService,
    attachTextContext: attachment =>
      vscode.commands.executeCommand("chatero.chat.attachTextContext", attachment),
    removeTextContext: attachmentId =>
      vscode.commands.executeCommand("chatero.chat.removeTextContext", attachmentId),
  });
  const openCodexLogin = () => {
    const folder = activeRemoteFolder();
    if (!folder) throw new Error("Codex login requires an active Chatero SSH workspace");
    return openCodexLoginTerminal(activeSession(folder.uri.authority), folder);
  };

  const openFolder = (uri, options) =>
    vscode.commands.executeCommand("vscode.openFolder", uri, options);
  const showActiveWorkspaceStatus = () => {
    const folder = activeRemoteFolder();
    if (!folder) {
      status.hide();
      return;
    }
    const target = targetForAuthority(folder.uri.authority);
    const connected = sessions.get(folder.uri.authority)?.getPublicSession();
    setStatus(connected ? "connected" : "reconnecting", {
      alias: target.alias,
      path: folder.uri.path,
    });
  };
  const chooseWorkspace = async ({ preferActive = false } = {}) => {
    const result = await remoteWorkspace.chooseRemoteWorkspace({
      selectTarget: () => pickTarget({
        preferAuthority: preferActive ? activeRemoteFolder()?.uri.authority : null,
      }),
      promptPath: (initialPath, target) => vscode.window.showInputBox({
        title: `Chatero: Open Remote Folder on ${target.alias}`,
        prompt: "Enter an absolute POSIX folder path",
        value: initialPath,
        ignoreFocusOut: true,
        validateInput(value) {
          try {
            remoteWorkspace.validateRemoteWorkspacePath(value);
            return null;
          }
          catch (error) {
            return error?.message ?? "Enter an absolute POSIX path";
          }
        },
      }),
      ensureAuthoritySession,
      confirmCreate: async ({ alias, path: remotePath }) => {
        const create = "Create Empty Folder";
        const selected = await vscode.window.showWarningMessage(
          `Create empty folder on ${alias}?`,
          { modal: true, detail: remotePath },
          create,
        );
        return selected === create;
      },
      uriFrom: parts => vscode.Uri.from(parts),
      openFolder,
      persistRecent,
    });
    if (!result) showActiveWorkspaceStatus();
    return result;
  };

  const reconnect = async () => {
    const folder = activeRemoteFolder();
    const fallback = recentTargets[0] ?? null;
    if (!folder && !fallback) {
      await vscode.window.showInformationMessage("No recent Chatero SSH target is available to reconnect.");
      return null;
    }
    const remoteAuthority = folder?.uri.authority ?? authority.encodeAuthority(fallback.targetId);
    const target = targetForAuthority(remoteAuthority);
    const remoteUri = folder?.uri ?? vscode.Uri.from({
      scheme: "vscode-remote",
      authority: remoteAuthority,
      path: fallback.lastPath,
    });
    const existing = sessions.get(remoteAuthority);
    if (existing) await existing.dispose();
    const resolved = await ensureAuthoritySession(remoteAuthority, {
      statusState: "reconnecting",
      workspacePath: remoteUri.path,
    });
    await persistRecent({
      targetId: target.id,
      alias: target.alias,
      lastPath: remoteUri.path,
      hostFingerprint: resolved.ready.hostFingerprint,
    });
    await openFolder(remoteUri, { forceReuseWindow: true });
    return remoteUri;
  };

  const commandWithErrorUx = (operation, callback) => async (...args) => {
    try {
      return await callback(...args);
    }
    catch (error) {
      if (!error?.chateroAlias) append(error?.stack ?? error);
      const alias = error?.chateroAlias ?? lastAlias;
      if (alias) setStatus("error", { alias });
      const failure = remoteWorkspace.formatRemoteFailure(operation, { alias, error });
      const selected = await vscode.window.showErrorMessage(
        failure.message,
        SHOW_REMOTE_LOG,
      );
      if (selected === SHOW_REMOTE_LOG) output.show();
      const folder = activeRemoteFolder();
      const activeAlias = folder ? targetForAuthority(folder.uri.authority).alias : null;
      // A failed candidate transaction must not replace the status of an
      // existing workspace. Errors for the active target (or from a local
      // window with no active target) remain visible and clickable.
      if (activeAlias && alias && activeAlias !== alias) showActiveWorkspaceStatus();
      return null;
    }
  };

  context.subscriptions.push(output, status);
  context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver("chatero-remote", resolver));
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.remote.connect",
    commandWithErrorUx("connect", () => chooseWorkspace()),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.remote.openFolder",
    commandWithErrorUx("open-folder", () => chooseWorkspace({ preferActive: true })),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.remote.reconnect",
    commandWithErrorUx("reconnect", reconnect),
  ));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.remote.showLog", () => output.show()));
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.remote.openLoginTerminal",
    commandWithErrorUx("login", () => openLoginTerminal()),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.remote.codexLogin",
    commandWithErrorUx("login", openCodexLogin),
  ));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    showActiveWorkspaceStatus();
  }));
  context.subscriptions.push({
    dispose() {
      void evidenceController.dispose().finally(() => {
        for (const value of sessions.values()) void value.dispose();
        sessions.clear();
      });
    },
  });

  const initialFolder = activeRemoteFolder();
  if (initialFolder) {
    try {
      const target = targetForAuthority(initialFolder.uri.authority);
      lastAlias = target.alias;
      setStatus("reconnecting", { alias: target.alias, path: initialFolder.uri.path });
    }
    catch (error) {
      append(error?.stack ?? error);
    }
  }

  return Object.freeze({
    getActiveSession(requestedAuthority) {
      const value = activeSession(requestedAuthority);
      return value.getPublicSession();
    },
    runProcess(request, observer, signal) {
      return processService.run(request, observer, signal);
    },
    stageEvidence(request, signal) {
      return evidenceController.stageEvidence(request, signal);
    },
    revokeEvidence(request, signal) {
      return evidenceController.revokeEvidence(request, signal);
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate, openCodexLoginTerminal };
