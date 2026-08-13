import { parseDocument } from "./runtime/yaml-2.9.0.mjs";

const PASSIVE_METADATA = new Set(["title", "subtitle", "author", "date", "abstract", "categories"]);
const ACTIVE_PATTERNS = Object.freeze([
  Object.freeze({ reason: "shortcode", pattern: /\{\{[<%].*?[>%]\}\}/su }),
  Object.freeze({ reason: "raw-block", pattern: /```\s*\{\s*=[^}\n]+\}/iu }),
  Object.freeze({ reason: "executable-code", pattern: /```\s*\{(?!\s*=)[^}\n]+\}/iu }),
  Object.freeze({ reason: "raw-html", pattern: /<(?:script|iframe|object|embed|link|style|form|input|button|video|audio|svg)\b/iu }),
]);

function passiveMetadata(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every(item => item === null || ["string", "number", "boolean"].includes(typeof item))) {
    return Object.freeze([...value]);
  }
  throw new TypeError("metadata value is not passive");
}

export function validatePassiveQuartoInput(source) {
  if (typeof source !== "string") throw new TypeError("Quarto input must be text");
  let body = source;
  let metadata = Object.freeze({});
  if (source.startsWith("---\n") || source.startsWith("---\r\n")) {
    const lineBreak = source.startsWith("---\r\n") ? "\r\n" : "\n";
    const close = source.indexOf(`${lineBreak}---${lineBreak}`, 3 + lineBreak.length);
    if (close < 0) return Object.freeze({ kind: "unsafe-input", reason: "malformed-yaml" });
    const yaml = source.slice(3 + lineBreak.length, close);
    const document = parseDocument(yaml, { maxAliasCount: 0, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return Object.freeze({ kind: "unsafe-input", reason: "malformed-yaml" });
    }
    const parsed = document.toJS({ maxAliasCount: 0 }) ?? {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.freeze({ kind: "unsafe-input", reason: "malformed-yaml" });
    }
    const values = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!PASSIVE_METADATA.has(key)) return Object.freeze({ kind: "unsafe-input", reason: key });
      try { values[key] = passiveMetadata(value); }
      catch { return Object.freeze({ kind: "unsafe-input", reason: key }); }
    }
    metadata = Object.freeze(values);
    body = source.slice(close + lineBreak.length + 3 + lineBreak.length);
  }
  for (const active of ACTIVE_PATTERNS) {
    if (active.pattern.test(body)) return Object.freeze({ kind: "unsafe-input", reason: active.reason });
  }
  if (/^\s*```\s*(?:python|r|julia|bash|sh|javascript|typescript|lua)\b/imu.test(body)) {
    return Object.freeze({ kind: "unsafe-input", reason: "executable-code" });
  }
  return Object.freeze({ kind: "passive-input", metadata, source });
}
