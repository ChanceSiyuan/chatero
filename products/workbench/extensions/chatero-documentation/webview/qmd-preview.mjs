import katex from "katex";

import { createFormulaDecorations } from "./formula-decorations.mjs";
import { createFormalBlockDecorations } from "./formal-block-decorations.mjs";
import { createQmdLanguage } from "./qmd-language.mjs";
import { createProseDecorations } from "./prose-decorations.mjs";
import { createProofCollapseExtension } from "./proof-collapse.mjs";
import { createTableDecorations } from "./table-decorations.mjs";

export function createQmdPreviewExtensions({ postMessage }) {
  if (typeof postMessage !== "function") throw new TypeError("QMD preview requires postMessage");
  return Object.freeze([
    createQmdLanguage(),
    createProofCollapseExtension(),
    createProseDecorations({ postMessage }),
    createFormulaDecorations({ katex }),
    createTableDecorations(),
    createFormalBlockDecorations(),
  ]);
}
