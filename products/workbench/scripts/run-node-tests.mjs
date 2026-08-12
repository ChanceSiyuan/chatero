import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function canonicalTestEnvironment({
  environment = process.env,
  temporaryDirectory = tmpdir(),
  realpath: resolveRealpath = realpath,
} = {}) {
  const canonicalTemporaryDirectory = await resolveRealpath(temporaryDirectory);
  return {
    ...environment,
    TMPDIR: canonicalTemporaryDirectory,
    TMP: canonicalTemporaryDirectory,
    TEMP: canonicalTemporaryDirectory,
  };
}

export async function runNodeTests({
  args = process.argv.slice(2),
  environment,
  executable = process.execPath,
  spawnProcess = spawn,
} = {}) {
  const env = await canonicalTestEnvironment({ environment });
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(executable, ["--test", ...args], {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`node --test exited with signal ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  runNodeTests()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write(`Workbench tests failed to start: ${error.message}\n`);
      process.exitCode = 1;
    });
}
