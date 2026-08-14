import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];
const GIB = 1024 ** 3;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

function contract() {
  return {
    codeOss: {
      version: "1.132.0",
      node: "24.18.0",
      electron: "42.7.1",
    },
  };
}

async function checkoutFixture({ compiled = false } = {}) {
  const checkout = await mkdtemp(join(tmpdir(), "chatero-run-code-oss-"));
  temporaryDirectories.push(checkout);
  await writeFile(join(checkout, ".nvmrc"), "24.18.0\n");
  await writeFile(join(checkout, ".npmrc"), 'target="42.7.1"\nruntime="electron"\n');
  if (compiled) {
    await mkdir(join(checkout, "out"));
    await writeFile(join(checkout, "out", "main.js"), "export {};\n");
  }
  return checkout;
}

function passingPreflight(overrides = {}) {
  return {
    contract: contract(),
    processVersions: { node: "24.18.0" },
    platform: "darwin",
    freeBytes: async () => 21 * GIB,
    findXcrun: async () => "/usr/bin/clang",
    verify: async () => ({ ok: true }),
    ...overrides,
  };
}

test("refuses the wrong Node version before inspecting or changing the checkout", async () => {
  const { preflightRuntime } = await import("../scripts/run-code-oss.mjs");
  const checkout = "/path/that/must/not/be-inspected";
  let verified = false;

  await assert.rejects(
    preflightRuntime(passingPreflight({
      checkout,
      processVersions: { node: "25.3.0" },
      verify: async () => { verified = true; },
    })),
    /Code-OSS 1\.132\.0 requires Node 24\.18\.0; current Node is 25\.3\.0/
  );
  assert.equal(verified, false);
});

test("requires macOS, twenty GiB free, and Xcode command line tools", async () => {
  const { preflightRuntime } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture();

  await assert.rejects(
    preflightRuntime(passingPreflight({ checkout, platform: "linux" })),
    /first Chatero workbench developer target requires macOS/
  );
  await assert.rejects(
    preflightRuntime(passingPreflight({ checkout, freeBytes: async () => 19 * GIB })),
    /requires at least 20 GiB free/
  );
  await assert.rejects(
    preflightRuntime(passingPreflight({ checkout, findXcrun: async () => null })),
    /Xcode command line tools are required/
  );
});

test("reports every unmet checkout precondition in one failure", async () => {
  const { preflightRuntime } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture();
  await writeFile(join(checkout, ".nvmrc"), "24.17.0\n");
  let verified = false;

  await assert.rejects(
    preflightRuntime(passingPreflight({
      checkout,
      freeBytes: async () => 19 * GIB,
      findXcrun: async () => null,
      verify: async () => { verified = true; },
    })),
    error => {
      assert.match(error.message, /requires at least 20 GiB free/);
      assert.match(error.message, /Xcode command line tools are required/);
      assert.match(error.message, /checkout \.nvmrc declares 24\.17\.0, expected 24\.18\.0/);
      return true;
    }
  );
  assert.equal(verified, false);
});

test("rejects checkout runtime files that disagree with the pinned contract", async () => {
  const { preflightRuntime } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture();
  await writeFile(join(checkout, ".nvmrc"), "24.17.0\n");

  await assert.rejects(
    preflightRuntime(passingPreflight({ checkout })),
    /checkout \.nvmrc declares 24\.17\.0, expected 24\.18\.0/
  );
});

test("runs explicit install and compile stages with fixed argv in the checkout", async () => {
  const { runDevelopment } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture();
  const calls = [];

  const result = await runDevelopment({
    checkout,
    install: true,
    compile: true,
    launch: false,
    preflightOptions: passingPreflight(),
    refreshExtensions: async () => ({ refreshed: false, extensions: [] }),
    run: async call => { calls.push(call); },
  });

  assert.deepEqual(calls, [
    { file: "npm", args: ["install"], cwd: checkout },
    { file: "npm", args: ["run", "compile"], cwd: checkout },
  ]);
  assert.deepEqual(result.completed, ["install", "compile"]);
});

test("launches only a compiled checkout and never adds an implicit build stage", async () => {
  const { runDevelopment } = await import("../scripts/run-code-oss.mjs");
  const uncompiled = await checkoutFixture();

  await assert.rejects(
    runDevelopment({
      checkout: uncompiled,
      launch: true,
      preflightOptions: passingPreflight(),
      refreshExtensions: async () => ({ refreshed: false, extensions: [] }),
      run: async () => assert.fail("must not launch an uncompiled checkout"),
    }),
    /compile the workbench before launch/
  );

  const compiled = await checkoutFixture({ compiled: true });
  const calls = [];
  const result = await runDevelopment({
    checkout: compiled,
    launch: true,
    preflightOptions: passingPreflight(),
    refreshExtensions: async () => ({ refreshed: false, extensions: [] }),
    run: async call => { calls.push(call); },
  });
  assert.deepEqual(calls, [{
    file: "bash",
    args: ["./scripts/code.sh"],
    cwd: compiled,
  }]);
  assert.deepEqual(result.completed, ["launch"]);
});

test("requires at least one explicit development action", async () => {
  const { runDevelopment } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture();

  await assert.rejects(
    runDevelopment({
      checkout,
      preflightOptions: passingPreflight(),
      run: async () => assert.fail("no action must execute no child process"),
    }),
    /select at least one of --install, --compile, or --launch/
  );
});

test("refreshes stale first-party extensions after preflight and re-verifies only on change", async () => {
  const { runDevelopment } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture({ compiled: true });
  const refreshCalls = [];
  const verifyCalls = [];

  const order = [];
  const clean = await runDevelopment({
    checkout,
    compile: true,
    preflightOptions: passingPreflight({
      verify: async () => { verifyCalls.push("verify"); order.push("verify"); return { ok: true }; },
    }),
    refreshExtensions: async call => {
      refreshCalls.push(call);
      order.push("refresh");
      return { refreshed: false, extensions: ["chatero.zotero"] };
    },
    run: async () => { order.push("stage"); },
  });
  assert.deepEqual(order, ["verify", "refresh", "stage"], "preflight verification must precede any checkout mutation");
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].checkout, checkout);
  assert.ok(refreshCalls[0].root);
  assert.ok(refreshCalls[0].workbenchRoot.endsWith("workbench"));
  assert.equal(clean.firstPartyRefresh.refreshed, false);
  assert.deepEqual(verifyCalls, ["verify"]);

  const refreshed = await runDevelopment({
    checkout,
    compile: true,
    preflightOptions: passingPreflight({
      verify: async () => { verifyCalls.push("verify"); return { ok: true, round: verifyCalls.length }; },
    }),
    refreshExtensions: async () => ({ refreshed: true, extensions: ["chatero.zotero"] }),
    run: async () => {},
  });
  assert.equal(refreshed.firstPartyRefresh.refreshed, true);
  assert.deepEqual(verifyCalls, ["verify", "verify", "verify"]);
  assert.equal(refreshed.preflight.verification.round, 3, "the returned verification must be the post-refresh one");
});

test("fails the run when post-refresh verification does not pass", async () => {
  const { runDevelopment } = await import("../scripts/run-code-oss.mjs");
  const checkout = await checkoutFixture({ compiled: true });
  let verifications = 0;

  await assert.rejects(runDevelopment({
    checkout,
    compile: true,
    preflightOptions: passingPreflight({
      verify: async () => {
        verifications += 1;
        return verifications === 1 ? { ok: true } : { ok: false };
      },
    }),
    refreshExtensions: async () => ({ refreshed: true, extensions: [] }),
    run: async () => assert.fail("stages must not run after failed post-refresh verification"),
  }), /verification did not pass after refreshing first-party extensions/);
});
