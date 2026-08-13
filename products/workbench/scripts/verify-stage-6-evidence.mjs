#!/usr/bin/env node

import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyStageSixEvidence } from "./run-stage-6-acceptance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

try {
  if (process.argv.length !== 2) throw new TypeError("Stage 6 evidence verification accepts no arguments");
  const result = await verifyStageSixEvidence({ root: ROOT });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
catch (error) {
  process.stderr.write(`Stage 6 evidence verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
