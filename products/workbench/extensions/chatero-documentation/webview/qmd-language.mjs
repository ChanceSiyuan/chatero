import { Language, LanguageSupport } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";

function escaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes += 1;
  return slashes % 2 === 1;
}

function findInlineClose(cx, from, close) {
  for (let cursor = from; cursor <= cx.end - close.length; cursor += 1) {
    if (cx.slice(cursor, cursor + close.length) !== close || escaped(cx.text, cursor - cx.offset)) continue;
    return cursor;
  }
  return -1;
}

const qmdInlineMath = Object.freeze({
  name: "QmdInlineMath",
  before: "Escape",
  parse(cx, next, pos) {
    if (next === 36) {
      if (cx.char(pos + 1) === 36 || cx.char(pos + 1) <= 32 || cx.char(pos + 1) === 65535) return -1;
      const close = findInlineClose(cx, pos + 1, "$");
      if (close <= pos + 1 || cx.char(close - 1) <= 32 || (cx.char(close + 1) >= 48 && cx.char(close + 1) <= 57)) return -1;
      return cx.addElement(cx.elt("InlineMath", pos, close + 1));
    }
    if (next === 92 && cx.char(pos + 1) === 40) {
      const close = findInlineClose(cx, pos + 2, "\\)");
      if (close < 0) return -1;
      return cx.addElement(cx.elt("InlineMath", pos, close + 2));
    }
    if (next === 92 && cx.char(pos + 1) === 91) {
      const close = findInlineClose(cx, pos + 2, "\\]");
      if (close < 0) return -1;
      return cx.addElement(cx.elt("DisplayMath", pos, close + 2));
    }
    return -1;
  },
});

export const qmdMathExtension = Object.freeze({
  defineNodes: Object.freeze([
    Object.freeze({ name: "InlineMath" }),
    Object.freeze({ name: "DisplayMath" }),
  ]),
  parseInline: Object.freeze([qmdInlineMath]),
});

export const qmdFencedDivExtension = Object.freeze({
  defineNodes: Object.freeze([Object.freeze({ name: "FencedDiv", block: true })]),
});

export function createQmdLanguage() {
  const parser = markdownLanguage.parser.configure([qmdMathExtension, qmdFencedDivExtension]);
  const language = new Language(markdownLanguage.data, parser, [], markdownLanguage.name);
  return new LanguageSupport(language);
}
