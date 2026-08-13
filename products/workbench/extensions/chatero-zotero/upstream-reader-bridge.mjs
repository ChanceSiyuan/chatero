const ALLOWED_TYPES = new Set(["highlight", "image", "ink", "note", "text", "underline"]);
const STRING_LIMITS = Object.freeze({ color: 32, comment: 64 * 1024, pageLabel: 1024, sortIndex: 1024, text: 64 * 1024, type: 64 });

function bounded(value, label, maximum, empty = true) {
  if (typeof value !== "string" || (!empty && !value.length) || new TextEncoder().encode(value).byteLength > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function position(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Reader annotation position is invalid");
  const json = JSON.stringify(value);
  bounded(json, "Reader annotation position", 256 * 1024, false);
  return json;
}

function tagsToReader(tags) {
  if (!Array.isArray(tags) || tags.some(value => typeof value !== "string" || !value.length)) throw new TypeError("Reader annotation tags are invalid");
  return tags.map(name => Object.freeze({ name }));
}

function tagsFromReader(tags) {
  if (!Array.isArray(tags) || tags.length > 100) throw new TypeError("Reader annotation tags are invalid");
  return [...new Set(tags.map(value => bounded(typeof value === "string" ? value : value?.name, "Reader annotation tag", 1024, false)))];
}

export function toUpstreamReaderAnnotation(value) {
  if (!value || typeof value !== "object" || !ALLOWED_TYPES.has(value.type)) throw new TypeError("Core Reader annotation is invalid");
  return Object.freeze({
    authorName: value.authorName ?? "",
    color: bounded(value.color, "Reader annotation color", STRING_LIMITS.color, false),
    comment: bounded(value.comment, "Reader annotation comment", STRING_LIMITS.comment),
    dateCreated: value.dateCreated ?? "1970-01-01T00:00:00.000Z",
    dateModified: value.dateModified ?? value.dateCreated ?? "1970-01-01T00:00:00.000Z",
    id: bounded(value.annotationKey, "Reader annotation key", 128, false),
    pageLabel: bounded(value.pageLabel, "Reader annotation pageLabel", STRING_LIMITS.pageLabel),
    position: JSON.parse(position(JSON.parse(value.positionJson))),
    sortIndex: bounded(value.sortIndex, "Reader annotation sortIndex", STRING_LIMITS.sortIndex, false),
    tags: tagsToReader(value.tags),
    text: bounded(value.text, "Reader annotation text", STRING_LIMITS.text),
    type: value.type,
  });
}

export function fromUpstreamReaderAnnotation(value, current) {
  if (!value || typeof value !== "object" || !ALLOWED_TYPES.has(value.type)) throw new TypeError("Upstream Reader annotation is invalid");
  const normalized = {
    color: bounded(value.color, "Reader annotation color", STRING_LIMITS.color, false),
    comment: bounded(value.comment ?? "", "Reader annotation comment", STRING_LIMITS.comment),
    pageLabel: bounded(value.pageLabel ?? "", "Reader annotation pageLabel", STRING_LIMITS.pageLabel),
    positionJson: position(value.position),
    sortIndex: bounded(value.sortIndex, "Reader annotation sortIndex", STRING_LIMITS.sortIndex, false),
    tags: tagsFromReader(value.tags ?? []),
    text: bounded(value.text ?? "", "Reader annotation text", STRING_LIMITS.text),
    type: value.type,
  };
  if (!current) return Object.freeze({ action: "create", ...normalized });
  const update = { annotationKey: current.annotationKey, expectedVersion: current.version };
  for (const field of ["color", "comment", "pageLabel", "positionJson", "sortIndex", "text", "type"]) {
    if (normalized[field] !== current[field]) update[field] = normalized[field];
  }
  if (JSON.stringify(normalized.tags) !== JSON.stringify(current.tags)) update.tags = normalized.tags;
  return Object.freeze(update);
}

export function readerLocationFromViewState(contentType, state) {
  if (!state || typeof state !== "object") throw new TypeError("Reader view state is invalid");
  if (contentType === "application/epub+zip") {
    return Object.freeze({ cfi: bounded(state.cfi, "Reader CFI", 16 * 1024, false) });
  }
  const value = state.scrollYPercent;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError("Reader scroll location is invalid");
  return Object.freeze({ scrollYPercent: value });
}
