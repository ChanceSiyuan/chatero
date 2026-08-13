#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startCore } from "../supervisor/core-supervisor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_GECKO = join(ROOT, "app", "staging", "Chatero.app", "Contents", "MacOS", "zotero");
const PDF = join(ROOT, "test", "tests", "data", "test.pdf");

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["annotationKey", "attachmentKey", "dateCreated", "dateModified", "itemKey", "noteKey", "occurredAt", "revision", "version"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, normalized(child)]));
}

async function request(client, method, params) {
	try {
		return await client.request(method, params, { timeoutMs: 60_000 });
	}
	catch (error) {
		error.message = `${method}: ${error.message}`;
		throw error;
	}
}

async function uploadPdf(client, parentItemKey, bytes) {
  const opened = await request(client, "attachment.upload-open", { byteCount: bytes.length, contentType: "application/pdf", filename: "stage-4.pdf" });
  for (let offset = 0; offset < bytes.length;) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024));
    const written = await request(client, "attachment.upload-write", { bytesBase64url: chunk.toString("base64url"), offset, uploadId: opened.uploadId });
    offset = written.nextOffset;
  }
  return request(client, "attachment.upload-commit", {
    expectedRevision: 0, idempotencyKey: `stage4-upload-${randomUUID()}`, libraryId: 1, parentItemKey, title: "Stage 4 PDF", uploadId: opened.uploadId,
  });
}

async function oneRun(geckoExecutable, run) {
  const temporary = await mkdtemp(join(tmpdir(), `chatero-stage-4-real-${run}-`));
  const profileDirectory = join(temporary, "profile");
  await mkdir(profileDirectory, { mode: 0o700 });
  let core;
  try {
    core = await startCore({ geckoExecutable, profileDirectory, readyTimeoutMs: 60_000 });
    const client = core.client;
    const item = await request(client, "library.item-mutate", {
      action: "create", collectionKeys: [], expectedRevision: 0,
      fields: [{ field: "title", value: "Stage 4 acceptance paper" }, { field: "date", value: "2026" }],
      idempotencyKey: `stage4-item-${randomUUID()}`, itemType: "journalArticle", libraryId: 1,
    });
    const bytes = await readFile(PDF);
    const attachment = await uploadPdf(client, item.itemKey, bytes);
    const note = await request(client, "library.note-mutate", {
      action: "create", expectedRevision: 0, html: "<p><strong>Stage 4</strong> note round trip.</p>",
      idempotencyKey: `stage4-note-${randomUUID()}`, libraryId: 1, parentItemKey: item.itemKey,
    });
    const annotation = await request(client, "library.annotation-mutate", {
      action: "create", attachmentKey: attachment.attachmentKey, color: "#ffd400", comment: "Accepted",
      expectedRevision: 0, idempotencyKey: `stage4-annotation-${randomUUID()}`, libraryId: 1,
      pageLabel: "1", positionJson: '{"pageIndex":0,"rects":[[10,10,60,25]]}', sortIndex: "00000|000001|00000",
      tags: ["stage-4"], text: "Acceptance evidence", type: "highlight",
    });
    await request(client, "library.annotations-update", {
      attachmentKey: attachment.attachmentKey, expectedRevision: annotation.revision,
      idempotencyKey: `stage4-annotation-update-${randomUUID()}`, libraryId: 1,
      updates: [{ annotationKey: annotation.annotation.annotationKey, color: "#2ea8e5", comment: "Reviewed", expectedVersion: annotation.annotation.version, tags: ["reviewed", "stage-4"] }],
    });
    await request(client, "reader.state-update", {
      attachmentKey: attachment.attachmentKey, expectedRevision: 0, expectedVersion: attachment.version,
      idempotencyKey: `stage4-reader-${randomUUID()}`, libraryId: 1, pageIndex: 0,
    });
		const styles = await request(client, "citation.styles", {});
		if (!styles.styles.length) throw new Error("real Zotero profile has no visible citation style");
		const citation = await request(client, "citation.render", { identities: [{ itemKey: item.itemKey, libraryId: 1 }], mode: "citation", styleId: styles.styles[0].styleId });
    const first = {
      annotations: await request(client, "library.annotations", { attachmentKey: attachment.attachmentKey, libraryId: 1 }),
      citation,
      note: await request(client, "library.note", { libraryId: 1, noteKey: note.noteKey }),
      reader: await request(client, "reader.state", { attachmentKey: attachment.attachmentKey, libraryId: 1 }),
      events: await request(client, "core.events", { afterSequence: 0, limit: 100 }),
    };
    await core.stop();
    core = null;
    core = await startCore({ geckoExecutable, profileDirectory, readyTimeoutMs: 60_000 });
    const restarted = {
      annotations: await request(core.client, "library.annotations", { attachmentKey: attachment.attachmentKey, libraryId: 1 }),
      note: await request(core.client, "library.note", { libraryId: 1, noteKey: note.noteKey }),
      reader: await request(core.client, "reader.state", { attachmentKey: attachment.attachmentKey, libraryId: 1 }),
    };
    if (JSON.stringify(normalized(first.annotations)) !== JSON.stringify(normalized(restarted.annotations))
        || JSON.stringify(normalized(first.note)) !== JSON.stringify(normalized(restarted.note))
        || JSON.stringify(normalized(first.reader)) !== JSON.stringify(normalized(restarted.reader))) {
      throw new Error("Reader, Note, or annotation data changed after real Core restart");
    }
    return normalized({ annotations: first.annotations, citation: first.citation, eventTopics: first.events.events.map(value => value.topic), note: first.note, reader: first.reader });
  }
  finally {
    await core?.stop().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

const geckoExecutable = process.env.CHATERO_GECKO_EXECUTABLE || DEFAULT_GECKO;
if (!await stat(geckoExecutable).then(value => value.isFile()).catch(() => false)) throw new Error(`signed Gecko Core executable is unavailable: ${geckoExecutable}`);
const runs = [await oneRun(geckoExecutable, 1), await oneRun(geckoExecutable, 2)];
if (JSON.stringify(runs[0]) !== JSON.stringify(runs[1])) throw new Error("two real disposable profile runs produced different normalized data or events");
process.stdout.write(`${JSON.stringify({ digest: createHash("sha256").update(JSON.stringify(runs[0])).digest("hex"), runs: runs.length, status: "passed" })}\n`);
