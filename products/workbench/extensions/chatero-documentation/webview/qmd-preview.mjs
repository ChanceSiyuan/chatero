import { createQmdLanguage } from "./qmd-language.mjs";
import { createProseDecorations } from "./prose-decorations.mjs";

export function createQmdPreviewExtensions({ postMessage }) {
  if (typeof postMessage !== "function") throw new TypeError("QMD preview requires postMessage");
  return Object.freeze([
    createQmdLanguage(),
    createProseDecorations({ postMessage }),
  ]);
}
