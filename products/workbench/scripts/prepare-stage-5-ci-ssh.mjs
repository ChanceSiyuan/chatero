#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PORT = 2222;
const ALIAS = "stage5-target";

async function main() {
  if (process.platform !== "linux") throw new Error("Stage 5 CI SSH preparation only runs on Linux");
  const home = process.env.HOME;
  const runtime = process.env.RUNNER_TEMP;
  const user = process.env.USER;
  if (!home?.startsWith("/") || !runtime?.startsWith("/") || !user || /[\0\r\n]/u.test(user)) {
    throw new Error("GitHub runner identity is invalid");
  }
  const sshRoot = join(home, ".ssh");
  await mkdir(sshRoot, { recursive: true, mode: 0o700 });
  await chmod(sshRoot, 0o700);
  const key = join(sshRoot, "stage5_ed25519");
  await execFile("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = await readFile(`${key}.pub`, "utf8");
  await writeFile(join(sshRoot, "authorized_keys"), publicKey, { mode: 0o600 });

  const hostKey = join(runtime, "stage5_host_ed25519");
  await execFile("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  const sshdConfig = join(runtime, "stage5_sshd_config");
  const pidFile = join(runtime, "stage5_sshd.pid");
  await writeFile(sshdConfig, [
    `Port ${PORT}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKey}`,
    `PidFile ${pidFile}`,
    `AuthorizedKeysFile ${join(sshRoot, "authorized_keys")}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "PermitRootLogin no",
    "AllowTcpForwarding yes",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "GatewayPorts no",
    "StrictModes no",
    "LogLevel VERBOSE",
    `AllowUsers ${user}`,
    "Subsystem sftp internal-sftp",
    "",
  ].join("\n"), { mode: 0o600 });
  await execFile("/usr/bin/sudo", ["/usr/bin/install", "-d", "-m", "755", "/run/sshd"]);
  const daemon = spawn("/usr/bin/sudo", ["/usr/sbin/sshd", "-D", "-f", sshdConfig, "-E", join(runtime, "stage5_sshd.log")], {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  daemon.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await execFile("/usr/bin/ssh-keyscan", ["-p", String(PORT), "127.0.0.1"], { encoding: "utf8" }).catch(() => null);
    if (result?.stdout) {
      await writeFile(join(sshRoot, "known_hosts"), result.stdout, { mode: 0o600 });
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    if (attempt === 99) throw new Error("localhost sshd did not become ready");
  }
  await writeFile(join(sshRoot, "config"), [
    "Host stage5-jump",
    "  HostName 127.0.0.1",
    `  Port ${PORT}`,
    `  User ${user}`,
    `  IdentityFile ${key}`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking yes",
    `Host ${ALIAS}`,
    "  HostName 127.0.0.1",
    `  Port ${PORT}`,
    `  User ${user}`,
    `  IdentityFile ${key}`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking yes",
    "  ProxyJump stage5-jump",
    "",
  ].join("\n"), { mode: 0o600 });
  await execFile("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "--", ALIAS, "test \"$(uname -s)\" = Linux"]);
  process.stdout.write(`${JSON.stringify({ alias: ALIAS, proxyJump: true, sshd: true })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
