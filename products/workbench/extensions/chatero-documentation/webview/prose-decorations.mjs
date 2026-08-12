import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

import { collectVisualNodes } from "./qmd-source-model.mjs";
import { sourceRevealRange } from "./source-reveal.mjs";

function stripListMarkup(source) {
  return source.split(/\r?\n/u).map(line => line.replace(/^[\t ]*(?:[-+*]|\d+[.)])[\t ]+/u, "")).join("\n");
}

function presentationText(node) {
  if (node.kind === "list") return stripListMarkup(node.source);
  if (node.displayText !== undefined) return node.displayText;
  if (node.kind === "heading") return node.source.replace(/^#{1,6}[\t ]+/u, "").replace(/[\t ]+#+[\t ]*$/u, "");
  if (node.kind === "code-span") return node.source.replace(/^`+|`+$/gu, "");
  if (node.kind === "link") return node.source.match(/^\[([^\]]*)\]/u)?.[1] ?? node.source;
  return node.source;
}

function appendText(document, parent, value) {
  if (!value) return;
  if (typeof document.createTextNode === "function") {
    parent.append(document.createTextNode(value));
    return;
  }
  const text = document.createElement("span");
  text.textContent = value;
  parent.append(text);
}

function contentRange(node) {
  if (node.kind === "heading") {
    const start = node.source.match(/^#{1,6}[\t ]+/u)?.[0].length ?? 0;
    const end = node.source.match(/[\t ]+#+[\t ]*$/u)?.[0].length ?? 0;
    return { from: node.from + start, to: node.to - end };
  }
  if (node.kind === "emphasis") {
    const width = /^(?:\*\*|__)/u.test(node.source) ? 2 : 1;
    return { from: node.from + width, to: node.to - width };
  }
  if (node.kind === "code-span") {
    const width = node.source.match(/^`+/u)?.[0].length ?? 1;
    return { from: node.from + width, to: node.to - width };
  }
  if (node.kind === "link") {
    const close = node.source.indexOf("]");
    return close < 1 ? { from: node.from, to: node.to } : { from: node.from + 1, to: node.from + close };
  }
  return { from: node.from, to: node.to };
}

function inlineTag(node) {
  if (node.kind === "code-span") return "code";
  if (node.kind === "link") return "span";
  if (node.kind === "emphasis") return /^(?:\*\*|__)/u.test(node.source) ? "strong" : "em";
  return "span";
}

function appendInlineRange(document, parent, node, range = contentRange(node)) {
  let cursor = range.from;
  const children = (node.children ?? []).filter(child => child.from >= range.from && child.to <= range.to);
  for (const child of children) {
    if (child.from < cursor) continue;
    appendText(document, parent, node.source.slice(cursor - node.from, child.from - node.from));
    const element = document.createElement(inlineTag(child));
    element.className = `chatero-qmd-${child.kind}`;
    element.dataset.sourceFrom = String(child.from);
    element.dataset.sourceTo = String(child.to);
    if (child.kind === "link") element.setAttribute("role", "link");
    appendInlineRange(document, element, child);
    parent.append(element);
    cursor = child.to;
  }
  appendText(document, parent, node.source.slice(cursor - node.from, range.to - node.from));
}

function appendList(document, element, node) {
  let offset = node.from;
  for (const line of node.source.split("\n")) {
    const marker = line.match(/^[\t ]*(?:[-+*]|\d+[.)])[\t ]+/u);
    if (marker) {
      const item = document.createElement("li");
      const from = offset + marker[0].length;
      appendInlineRange(document, item, {
        ...node,
        from: offset,
        to: offset + line.length,
        source: line,
        children: node.children.filter(child => child.from >= from && child.to <= offset + line.length),
      }, { from, to: offset + line.length });
      element.append(item);
    }
    offset += line.length + 1;
  }
}

export function createProseElement(document, node) {
  if (!document || typeof document.createElement !== "function") throw new TypeError("DOM document is required");
  const tagName = node.kind === "heading"
    ? `h${Math.max(1, Math.min(6, node.source.match(/^#+/u)?.[0].length ?? 1))}`
    : node.kind === "list" ? (/^[\t ]*\d+[.)]/u.test(node.source) ? "ol" : "ul")
      : inlineTag(node);
  const element = document.createElement(tagName);
  element.className = `chatero-qmd-${node.kind}`;
  element.dataset.sourceFrom = String(node.from);
  element.dataset.sourceTo = String(node.to);
  if (node.kind === "link") element.setAttribute("role", "link");
  if (node.kind === "list") element.setAttribute("role", "list");
  if (node.kind === "unsupported") element.setAttribute("role", "note");
  if (node.kind === "list") appendList(document, element, node);
  else if (["heading", "prose", "emphasis", "link", "code-span"].includes(node.kind)) appendInlineRange(document, element, node);
  else element.textContent = presentationText(node);
  return element;
}

class ProseWidget extends WidgetType {
  constructor(node) {
    super();
    this.node = node;
  }

  eq(other) {
    return other.node.kind === this.node.kind
      && other.node.from === this.node.from
      && other.node.to === this.node.to
      && other.node.source === this.node.source;
  }

  toDOM(view) {
    const element = createProseElement(view.dom.ownerDocument, this.node);
    element.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.node.from } });
      view.focus();
    });
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

function buildDecorations(view) {
  const ranges = [];
  for (const node of collectVisualNodes(view.state, view.visibleRanges)) {
    if (!["heading", "prose", "list"].includes(node.kind)) continue;
    if (sourceRevealRange(node, view.state.selection)) continue;
    ranges.push(Decoration.replace({
      block: true,
      inclusive: false,
      widget: new ProseWidget(node),
    }).range(node.from, node.to));
  }
  return Decoration.set(ranges, true);
}

export function createProseDecorations() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  }, { decorations: value => value.decorations });
}
