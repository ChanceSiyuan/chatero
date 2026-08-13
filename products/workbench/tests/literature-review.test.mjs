import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createLiteratureReview } from "../extensions/chatero-documentation/literature-review.mjs";

const revision = value => `sha256:${value.repeat(64)}`;
const textRevision = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const record = Object.freeze({ creators: Object.freeze(["Ada"]), itemKey: "ITEM0001", libraryId: 1, revision: revision("a"), title: "Paper", year: 1843 });

function fixture({ current = null, confirmation = "Apply" } = {}) {
  const calls = [];
  const expectedUri = { scheme: "file", authority: "", path: "/repo/literature/ref.bib", toString: () => "file:///repo/literature/ref.bib" };
  const vscode = {
    Uri: { joinPath: (root, ...parts) => ({ ...expectedUri, path: `${root.path}/${parts.join("/")}`.replace(/\/{2,}/gu, "/") }) },
    commands: { async executeCommand(...args) { calls.push(["command", ...args]); } },
    window: {
      async showInformationMessage(message, options, action) { calls.push(["confirm", message, options, action]); return confirmation; },
      async showTextDocument(document, options) { calls.push(["show", document, options]); },
    },
    workspace: {
      fs: {
        async createDirectory() {},
        async readFile() {
          if (current === null) throw Object.assign(new Error("missing"), { code: "FileNotFound" });
          return Buffer.from(current, "utf8");
        },
        async writeFile(uri, bytes) { calls.push(["write", uri, Buffer.from(bytes).toString("utf8")]); },
      },
      async openTextDocument(input) { calls.push(["open", input]); return { input }; },
    },
  };
  return { calls, review: createLiteratureReview({ vscode, workspaceFolderUri: { path: "/repo" } }) };
}

test("Literature refresh shows a diff and writes only after exact user approval", async () => {
  const { calls, review } = fixture({ current: "@article{old}\n" });
  const result = await review({ bibliographyText: "@article{new}\n", current: { revision: textRevision("@article{old}\n"), text: "@article{old}\n" }, records: [record] });
  assert.equal(result.kind, "literature-refreshed");
  assert.deepEqual(calls.map(value => value[0]), ["open", "open", "command", "confirm", "write"]);
  assert.equal(calls[2][1], "vscode.diff");
  assert.equal(calls[4][2], "@article{new}\n");
});

test("Literature refresh cancels without mutation and rejects stale bytes", async () => {
  const cancelled = fixture({ current: "@article{old}\n", confirmation: null });
  assert.deepEqual(await cancelled.review({ bibliographyText: "@article{new}\n", current: { revision: textRevision("@article{old}\n"), text: "@article{old}\n" }, records: [record] }), { kind: "cancelled" });
  assert.equal(cancelled.calls.some(value => value[0] === "write"), false);

  const stale = fixture({ current: "human edit\n" });
  await assert.rejects(() => stale.review({ bibliographyText: "@article{new}\n", current: { revision: revision("b"), text: "@article{old}\n" }, records: [record] }), /changed since Zotero export/u);
  assert.equal(stale.calls.some(value => value[0] === "write"), false);
});

test("new Literature files require approval and create no other path", async () => {
  const { calls, review } = fixture();
  await review({ bibliographyText: "@article{new}\n", current: null, records: [record] });
  const write = calls.find(value => value[0] === "write");
  assert.equal(write[1].path, "/repo/literature/ref.bib");
  assert.doesNotMatch(JSON.stringify(calls), /documentation\/|\.zotero|profile/iu);
});
