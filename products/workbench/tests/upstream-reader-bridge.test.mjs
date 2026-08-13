import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fromUpstreamReaderAnnotation,
  readerLocationFromViewState,
  toUpstreamReaderAnnotation,
} from "../extensions/chatero-zotero/upstream-reader-bridge.mjs";

const coreAnnotation = Object.freeze({
  annotationKey: "ANN00001",
  authorName: "Researcher",
  color: "#a28ae5",
  comment: "Review",
  dateCreated: "2026-08-13T10:00:00.000Z",
  dateModified: "2026-08-13T10:30:00.000Z",
  libraryId: 7,
  pageLabel: "",
  positionJson: JSON.stringify({ type: "FragmentSelector", conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html", value: "epubcfi(/6/8!/4/2/12,/1:0,/1:8)" }),
  sortIndex: "00003|00001465",
  tags: ["reviewed"],
  text: "Evidence",
  type: "underline",
  version: 4,
});

test("maps complete Core EPUB annotations to the pinned upstream Reader shape", () => {
  const result = toUpstreamReaderAnnotation(coreAnnotation);
  assert.equal(result.id, "ANN00001");
  assert.equal(result.position.value, "epubcfi(/6/8!/4/2/12,/1:0,/1:8)");
  assert.deepEqual(result.tags, [{ name: "reviewed" }]);
  assert.equal(result.authorName, "Researcher");
  assert.equal(result.dateModified, "2026-08-13T10:30:00.000Z");
});

test("maps Reader creates and full selector updates to versioned Core changes", () => {
  const reader = {
    ...toUpstreamReaderAnnotation(coreAnnotation),
    color: "#2ea8e5",
    comment: "Changed",
    position: { type: "CssSelector", value: "#evidence", refinedBy: { type: "TextPositionSelector", start: 1, end: 9 } },
    tags: [{ name: "method" }],
    type: "highlight",
  };
  const update = fromUpstreamReaderAnnotation(reader, coreAnnotation);
  assert.equal(update.expectedVersion, 4);
  assert.equal(update.type, "highlight");
  assert.deepEqual(JSON.parse(update.positionJson), reader.position);
  assert.deepEqual(update.tags, ["method"]);

  const created = fromUpstreamReaderAnnotation({ ...reader, id: "TEMP0001" }, null);
  assert.equal(created.action, "create");
  assert.equal(Object.hasOwn(created, "id"), false);
});

test("extracts exact EPUB and snapshot restore locations and rejects malformed Reader input", () => {
  assert.deepEqual(readerLocationFromViewState("application/epub+zip", { cfi: "epubcfi(/6/2)" }), { cfi: "epubcfi(/6/2)" });
  assert.deepEqual(readerLocationFromViewState("text/html", { scrollYPercent: 37.5 }), { scrollYPercent: 37.5 });
  assert.throws(() => readerLocationFromViewState("text/html", { scrollYPercent: 101 }), /invalid/);
  assert.throws(() => fromUpstreamReaderAnnotation({ ...toUpstreamReaderAnnotation(coreAnnotation), position: null }, coreAnnotation), /position/);
  assert.throws(() => fromUpstreamReaderAnnotation({ ...toUpstreamReaderAnnotation(coreAnnotation), tags: [{ name: "" }] }, coreAnnotation), /tag/);
});
