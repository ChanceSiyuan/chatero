import katex from "katex";

import { createFormulaDecorations } from "./formula-decorations.mjs";
import { createFormalBlockDecorations } from "./formal-block-decorations.mjs";
import { createImageDecorations } from "./image-decorations.mjs";
import { createQmdLanguage } from "./qmd-language.mjs";
import { createProseDecorations } from "./prose-decorations.mjs";
import { createProofCollapseExtension } from "./proof-collapse.mjs";
import { createTableDecorations } from "./table-decorations.mjs";

export function createQmdPreviewExtensions({ postMessage, requestImage = async target => ({ kind: "placeholder", target, reason: "unavailable" }) }) {
  if (typeof postMessage !== "function" || typeof requestImage !== "function") throw new TypeError("QMD preview requires messaging dependencies");
  return Object.freeze([
    createQmdLanguage(),
    createProofCollapseExtension(),
    createProseDecorations({ postMessage }),
    createFormulaDecorations({ katex }),
    createImageDecorations({ requestImage }),
    createTableDecorations(),
    createFormalBlockDecorations(),
  ]);
}
