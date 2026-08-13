import { spawn } from "node:child_process";

export async function launchZoteroCompatibilityMode(plan, {
  acquireLease,
  spawnProcess = spawn,
} = {}) {
  acquireLease ??= await import("./runtime/zotero-core/profile/profile-lease.mjs")
    .then(module => module.acquireProfileLease);
  if (!plan || typeof plan.executable !== "string" || !Array.isArray(plan.args)
      || typeof plan.profileDirectory !== "string" || typeof acquireLease !== "function"
      || typeof spawnProcess !== "function") {
    throw new TypeError("Complete Zotero launch plan is invalid");
  }
  const lease = await acquireLease({
    epoch: `compatibility:${process.pid}`,
    profileDirectory: plan.profileDirectory,
  });
  try {
    const child = spawnProcess(plan.executable, [...plan.args], {
        detached: false,
        stdio: "ignore",
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
      child?.kill?.("SIGTERM");
      throw new Error("Complete Zotero process did not expose a valid pid");
    }
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (Number.isInteger(code) && code !== 0) reject(new Error(`Complete Zotero exited with code ${code}`));
        else if (signal) reject(new Error(`Complete Zotero exited after ${signal}`));
        else resolve(code);
      });
    });
  }
  finally {
    await lease.release();
  }
}
