import { isAbsolute } from "node:path";

import { assertConcreteAlias } from "./openssh-targets.mjs";

function createEvent() {
  const listeners = new Set();
  return {
    event(listener, thisArg) {
      if (typeof listener !== "function") throw new TypeError("event listener must be a function");
      const bound = thisArg ? listener.bind(thisArg) : listener;
      listeners.add(bound);
      return { dispose: () => listeners.delete(bound) };
    },
    fire(value) {
      for (const listener of [...listeners]) listener(value);
    },
    clear() {
      listeners.clear();
    },
  };
}

export function redactRemoteLog(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[redacted key material]")
    .replace(/\b(connection[-_ ]?token|token|password|passphrase|authorization)\s*[:=]\s*[^\s]+/giu, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]");
}

export function forwardingArguments({ alias, controlPath, remotePort }) {
  assertConcreteAlias(alias);
  if (typeof controlPath !== "string" || !isAbsolute(controlPath) || /[\0\r\n]/u.test(controlPath)) {
    throw new TypeError("SSH control path must be absolute");
  }
  if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new TypeError("remote forwarding port is invalid");
  }
  return Object.freeze([
    "-T",
    "-S", controlPath,
    "-o", "BatchMode=yes",
    "-W", `127.0.0.1:${remotePort}`,
    "--", alias,
  ]);
}

export function createManagedConnection(process, {
  isCurrent = () => true,
  log = () => {},
} = {}) {
  if (!process?.stdin || !process?.stdout || !process?.stderr) {
    throw new TypeError("managed SSH process must expose stdin, stdout, and stderr");
  }
  const dataEvent = createEvent();
  const closeEvent = createEvent();
  const endEvent = createEvent();
  let closed = false;
  let ended = false;
  let waitingForDrain = null;

  const emitClose = error => {
    if (closed) return;
    closed = true;
    closeEvent.fire(error);
  };
  const emitEnd = () => {
    if (ended) return;
    ended = true;
    endEvent.fire(undefined);
  };
  const resolveDrain = () => {
    waitingForDrain?.resolve();
    waitingForDrain = null;
  };

  process.stdout.on("data", bytes => {
    if (!closed && isCurrent()) dataEvent.fire(Uint8Array.from(bytes));
  });
  process.stdout.on("end", () => {
    if (isCurrent()) emitEnd();
  });
  process.stderr.on("data", bytes => {
    if (isCurrent()) log(redactRemoteLog(Buffer.from(bytes).toString("utf8")));
  });
  process.stdin.on?.("drain", resolveDrain);
  process.on("error", error => {
    if (isCurrent()) emitClose(error instanceof Error ? error : new Error(String(error)));
  });
  process.on("close", code => {
    resolveDrain();
    if (isCurrent()) emitClose(code && code !== 0 ? new Error(`SSH channel exited with code ${code}`) : undefined);
  });

  const connection = {
    onDidReceiveMessage: dataEvent.event,
    onDidClose: closeEvent.event,
    onDidEnd: endEvent.event,
    send(data) {
      if (closed || !isCurrent()) return;
      if (!(data instanceof Uint8Array)) throw new TypeError("managed connection sends Uint8Array data");
      if (!process.stdin.write(Buffer.from(data)) && !waitingForDrain) {
        waitingForDrain = {};
        waitingForDrain.promise = new Promise(resolve => { waitingForDrain.resolve = resolve; });
      }
    },
    end() {
      if (closed) return;
      process.stdin.end();
    },
    drain() {
      return waitingForDrain?.promise ?? Promise.resolve();
    },
  };

  Object.defineProperties(connection, {
    forceClose: {
      enumerable: false,
      value(error = new Error("SSH master connection was lost")) {
        if (closed) return;
        process.kill?.("SIGTERM");
        process.stdin.destroy?.();
        process.stdout.destroy?.();
        process.stderr.destroy?.();
        resolveDrain();
        emitClose(error);
      },
    },
    dispose: {
      enumerable: false,
      value() {
        connection.forceClose(new Error("SSH channel disposed"));
        dataEvent.clear();
        closeEvent.clear();
        endEvent.clear();
      },
    },
  });
  return connection;
}
