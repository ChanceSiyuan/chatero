import {
  documentationAssetPath,
  documentationPagePath,
} from "./documentation-path.mjs";

const REVISION = /^sha256:[0-9a-f]{64}$/u;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareEntries(left, right) {
  const rootOrder = { knowledge: 0, drafts: 1 };
  return rootOrder[left.sourceRoot] - rootOrder[right.sourceRoot]
    || compareUtf8Bytes(left.sourcePath, right.sourcePath);
}

function folded(value) {
  return value.normalize("NFC").toLowerCase();
}

function pathKind(value) {
  return value.toLowerCase().endsWith(".qmd") ? "page" : "asset";
}

function brandedPath(value) {
  return pathKind(value) === "page"
    ? documentationPagePath(value)
    : documentationAssetPath(value);
}

function exactEntry(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "path") || !Object.hasOwn(value, "revision")) {
    throw new TypeError(`${label} migration entry has an invalid schema`);
  }
  const path = brandedPath(value.path).value;
  if (path !== value.path || !REVISION.test(value.revision)) {
    throw new TypeError(`${label} migration entry is invalid`);
  }
  return Object.freeze({ path, revision: value.revision, kind: pathKind(path) });
}

function validateTree(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} migration entries must be an array`);
  const entries = values.map(value => exactEntry(value, label));
  entries.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  const aliases = new Map();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const key = folded(entry.path);
    if (aliases.has(key)) throw new TypeError(`${label} migration entries contain a case-fold alias`);
    aliases.set(key, entry.path);
    for (let candidate = index + 1; candidate < entries.length; candidate++) {
      if (entries[candidate].path.startsWith(`${entry.path}/`)) {
        throw new TypeError(`${label} migration entries contain a file-ancestor collision`);
      }
    }
  }
  return Object.freeze(entries);
}

function conflictsWithRoot(path, root) {
  const candidate = folded(root);
  const value = folded(path);
  return value === candidate || value.startsWith(`${candidate}/`) || candidate.startsWith(`${value}/`);
}

function chooseConflictRoot(occupied) {
  for (let index = 0; ; index++) {
    const root = index === 0 ? "_migrated/drafts" : `_migrated-${index}/drafts`;
    if (!occupied.some(path => conflictsWithRoot(path, root))) return root;
  }
}

function migrationRecord({ sourceRoot, entry, destination, collision }) {
  const common = {
    kind: entry.kind,
    sourceRoot,
    sourcePath: entry.path,
    sourceRevision: entry.revision,
    destination: brandedPath(destination),
  };
  if (entry.kind === "page") {
    return Object.freeze({
      ...common,
      state: sourceRoot === "knowledge" ? "reviewed" : "working",
      reason: sourceRoot === "knowledge"
        ? collision ? "knowledge-precedence" : "knowledge-only"
        : collision ? "draft-preserved" : "draft-only",
    });
  }
  return Object.freeze({
    ...common,
    reason: sourceRoot === "knowledge"
      ? collision ? "knowledge-precedence" : "knowledge-only"
      : collision ? "draft-preserved" : "draft-only",
  });
}

function assertOutputSet(records, documentation) {
  const existing = new Map(documentation.map(entry => [folded(entry.path), entry.path]));
  const outputs = new Map();
  for (const record of records) {
    const path = record.destination.value;
    const key = folded(path);
    if (existing.has(key)) throw new TypeError("migration output collides with pre-existing Documentation");
    if (outputs.has(key)) throw new TypeError("migration output contains a duplicate or case-fold alias");
    outputs.set(key, path);
  }
  const paths = [...outputs.values()].sort(compareUtf8Bytes);
  for (let index = 0; index < paths.length; index++) {
    for (let candidate = index + 1; candidate < paths.length; candidate++) {
      if (paths[candidate].startsWith(`${paths[index]}/`)) {
        throw new TypeError("migration output contains a file-ancestor collision");
      }
    }
  }
}

export function buildLegacyMigrationMapping({ knowledge, drafts, documentation }) {
  const knowledgeEntries = validateTree(knowledge, "Knowledge");
  const draftEntries = validateTree(drafts, "Draft");
  const documentationEntries = validateTree(documentation, "Documentation");
  const knowledgeByPath = new Map(knowledgeEntries.map(entry => [entry.path, entry]));
  const draftByPath = new Map(draftEntries.map(entry => [entry.path, entry]));
  const collidingDrafts = draftEntries.filter(entry => knowledgeByPath.has(entry.path));
  const directOutputs = [
    ...knowledgeEntries.map(entry => entry.path),
    ...draftEntries.filter(entry => !knowledgeByPath.has(entry.path)).map(entry => entry.path),
    ...documentationEntries.map(entry => entry.path),
  ];
  const conflictRoot = collidingDrafts.length > 0 ? chooseConflictRoot(directOutputs) : null;
  const records = [];

  for (const entry of draftEntries) {
    const collision = knowledgeByPath.has(entry.path);
    records.push(migrationRecord({
      sourceRoot: "drafts",
      entry,
      destination: collision ? `${conflictRoot}/${entry.path}` : entry.path,
      collision,
    }));
  }
  for (const entry of knowledgeEntries) {
    records.push(migrationRecord({
      sourceRoot: "knowledge",
      entry,
      destination: entry.path,
      collision: draftByPath.has(entry.path),
    }));
  }
  records.sort(compareEntries);
  assertOutputSet(records, documentationEntries);

  const collisions = collidingDrafts.map(draft => {
    const knowledgeEntry = knowledgeByPath.get(draft.path);
    return Object.freeze({
      kind: "knowledge-draft",
      path: draft.path,
      contentRelation: draft.revision === knowledgeEntry.revision ? "equal" : "different",
      knowledgeRevision: knowledgeEntry.revision,
      draftRevision: draft.revision,
      draftDestination: `${conflictRoot}/${draft.path}`,
    });
  });
  collisions.sort((left, right) => compareUtf8Bytes(left.path, right.path));

  return Object.freeze({
    pages: Object.freeze(records.filter(record => record.kind === "page")),
    assets: Object.freeze(records.filter(record => record.kind === "asset")),
    collisions: Object.freeze(collisions),
    diagnostics: Object.freeze([]),
    conflictRoot,
  });
}
