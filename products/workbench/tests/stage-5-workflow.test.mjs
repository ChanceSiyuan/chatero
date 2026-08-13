import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("Stage 5 CI builds, signs, runs real SSH, and gates both native Linux architectures", async () => {
  const source = await readFile(new URL("../../../.github/workflows/stage-5.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.equal(workflow.name, "Stage 5 IDE and Remote SSH");
  assert.deepEqual(Object.keys(workflow.jobs), ["build-agent", "sign-agent", "real-ssh", "stage-5-gate"]);

  const builds = workflow.jobs["build-agent"].strategy.matrix.include;
  assert.deepEqual(builds, [
    { runner: "ubuntu-24.04", arch: "x64", tuple: "linux-x86_64" },
    { runner: "ubuntu-24.04-arm", arch: "arm64", tuple: "linux-aarch64" },
  ]);
  assert.match(source, /CHATERO_REMOTE_AGENT_SIGNING_KEY_BASE64/u);
  assert.match(source, /cmp - products\/workbench\/remote-agent\/release-public-key\.pem/u);
  assert.match(source, /run-stage-5-real-ssh\.mjs/u);
  assert.match(source, /prepare-stage-5-ci-ssh\.mjs/u);
  const realSshSource = await readFile(new URL("../scripts/run-stage-5-real-ssh.mjs", import.meta.url), "utf8");
  assert.match(realSshSource, /new SshSession\(\{[\s\S]*?installerFactory:/u);
  assert.match(realSshSource, /verifyRelease,\s*selectArtifact,/u);
  assert.match(realSshSource, /\[stage-5 remote\]/u);
  assert.match(realSshSource, /pkill -f '\[\.\]chatero-server\/artifacts-v1/u);
  assert.doesNotMatch(realSshSource, /pkill -f '\/bin\/chatero-server'/u);
  assert.match(realSshSource, /const required=\['chatero-documentation','git','ipynb'\]/u);
  assert.doesNotMatch(realSshSource, /const required=\[[^\]]*chatero-zotero/u);
  const sshFixture = await readFile(new URL("../scripts/prepare-stage-5-ci-ssh.mjs", import.meta.url), "utf8");
  assert.match(sshFixture, /"UsePAM yes"/u);
  assert.match(sshFixture, /"PasswordAuthentication no"/u);
  assert.match(sshFixture, /"KbdInteractiveAuthentication no"/u);
  assert.match(source, /npm run verify:stage-5/u);
  assert.equal((source.match(/npm ci --ignore-scripts --prefix vendor\/code-oss(?:\r?\n|$)/gu) ?? []).length, 2);
  assert.equal((source.match(/npm ci --ignore-scripts --prefix vendor\/code-oss\/build\/npm\/gyp/gu) ?? []).length, 2);
  assert.equal((source.match(/prepare-code-oss-lifecycle\.mjs vendor\/code-oss --prepare/gu) ?? []).length, 2);
  assert.equal((source.match(/prepare-code-oss-lifecycle\.mjs vendor\/code-oss --cleanup/gu) ?? []).length, 2);
  assert.equal((source.match(/CHATERO_NPM_COMMAND=ci npm rebuild --prefix vendor\/code-oss/gu) ?? []).length, 2);
  assert.doesNotMatch(source, /npm_command=ci npm rebuild/gu);
  assert.doesNotMatch(source, /AZURE|NUGET|FOUNDRY.*TOKEN|pkgs\.dev\.azure\.com/iu);
  assert.match(source, /sudo apt-get update && sudo apt-get install -y\s+libkrb5-dev libx11-dev libxkbfile-dev/u);
  assert.doesNotMatch(source, /marketplace\.visualstudio\.com|ms-vscode-remote\.remote-ssh|PRIVATE KEY-----/iu);

  const realSsh = workflow.jobs["real-ssh"];
  assert.equal(realSsh.needs, "sign-agent");
  assert.deepEqual(realSsh.strategy.matrix.include.map(value => value.runner), [
    "ubuntu-24.04", "ubuntu-24.04-arm",
  ]);
  assert.equal(workflow.jobs["stage-5-gate"].needs, "real-ssh");
});
