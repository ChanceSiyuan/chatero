import assert from "node:assert/strict";
import test from "node:test";

test("canonicalizes every temporary-directory environment variable before tests start", async () => {
  const { canonicalTestEnvironment } = await import("../scripts/run-node-tests.mjs");
  const environment = Object.freeze({ PATH: "/usr/bin", TMPDIR: "/var/folders/test/T" });

  const result = await canonicalTestEnvironment({
    environment,
    temporaryDirectory: "/var/folders/test/T",
    realpath: async value => {
      assert.equal(value, "/var/folders/test/T");
      return "/private/var/folders/test/T";
    },
  });

  assert.deepEqual(result, {
    PATH: "/usr/bin",
    TMPDIR: "/private/var/folders/test/T",
    TMP: "/private/var/folders/test/T",
    TEMP: "/private/var/folders/test/T",
  });
  assert.equal(environment.TMPDIR, "/var/folders/test/T");
});
