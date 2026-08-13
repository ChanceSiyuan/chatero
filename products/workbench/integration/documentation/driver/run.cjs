const path = require("node:path");
const { createRequire } = require("node:module");

async function run() {
  const repositoryRoot = process.env.CHATERO_REPOSITORY_ROOT;
  if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) {
    throw new Error("CHATERO_REPOSITORY_ROOT must identify the pinned source checkout");
  }
  const repositoryRequire = createRequire(path.join(repositoryRoot, "package.json"));
  const Mocha = repositoryRequire("mocha");
  const grep = process.env.CHATERO_DOCUMENTATION_TEST_GREP;
  const mocha = new Mocha({
    color: true,
    failZeroTests: true,
    forbidOnly: true,
    forbidPending: true,
    grep,
    timeout: 60_000,
    ui: "tdd",
  });
  mocha.addFile(path.join(
    repositoryRoot,
    "products",
    "workbench",
    "integration",
    "documentation",
    "text-document-editor.test.mjs",
  ));
  await mocha.loadFilesAsync();
  await new Promise((accept, reject) => {
    mocha.run(failures => failures === 0
      ? accept()
      : reject(new Error(`${failures} Documentation integration scenario(s) failed`)));
  });
}

module.exports = { run };
