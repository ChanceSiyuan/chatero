import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

import { collectFormalBlocks } from "./formal-block-parser.mjs";

function rangeIntersectsSelection(range, selection) {
  const ranges = selection?.ranges
    ?? (Number.isSafeInteger(selection?.from) && Number.isSafeInteger(selection?.to) ? [selection] : []);
  return ranges.some(value => value.empty
    ? range.from <= value.from && value.from < range.to
    : value.from < range.to && value.to > range.from);
}

export function formalSourceRevealRange(block, selection) {
  if (!block || block.kind === "unsupported" || !selection) return null;
  const ordered = [block.attributes, block.label, block.body, block.closer, block.opener].filter(Boolean);
  const active = ordered.find(range => rangeIntersectsSelection(range.range ?? range, selection));
  return active?.range ?? active ?? null;
}

function formalTitle(block, source) {
  const kind = block.kind[0].toUpperCase() + block.kind.slice(1);
  const label = block.label ? source.slice(block.label.from, block.label.to) : "";
  return label ? `${kind}: ${label}` : kind;
}

export function renderFormalHeaderElement(document, block, source) {
  if (!document || typeof document.createElement !== "function" || typeof source !== "string") {
    throw new TypeError("formal header DOM dependencies are invalid");
  }
  const element = document.createElement("div");
  element.className = `chatero-qmd-formal chatero-qmd-formal-${block.kind}`;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", formalTitle(block, source));
  element.dataset.sourceFrom = String(block.opener.from);
  element.dataset.sourceTo = String(block.opener.to);
  const badge = document.createElement("span");
  badge.className = "chatero-qmd-formal-kind";
  badge.textContent = block.kind[0].toUpperCase() + block.kind.slice(1);
  element.append(badge);
  return element;
}

class FormalHeaderWidget extends WidgetType {
  constructor(block, source) {
    super();
    this.block = block;
    this.source = source;
  }

  eq(other) {
    return other.block.kind === this.block.kind && other.block.from === this.block.from
      && other.block.to === this.block.to && other.source === this.source;
  }

  toDOM(view) {
    const element = renderFormalHeaderElement(view.dom.ownerDocument, this.block, this.source);
    element.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.block.attributes.from ?? this.block.attributes.range.from } });
      view.focus();
    });
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

class FormalCloserWidget extends WidgetType {
  toDOM(view) {
    const element = view.dom.ownerDocument.createElement("div");
    element.className = "chatero-qmd-formal-closer";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

function formalDecorations(view) {
  const ranges = [];
  const source = view.state.doc.toString();
  for (const block of collectFormalBlocks(view.state, view.visibleRanges)) {
    if (block.kind === "unsupported") continue;
    if (!rangeIntersectsSelection(block.opener, view.state.selection)) {
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new FormalHeaderWidget(block, source),
      }).range(block.opener.from, block.opener.to));
    }
    if (!rangeIntersectsSelection(block.closer, view.state.selection)) {
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new FormalCloserWidget(),
      }).range(block.closer.from, block.closer.to));
    }
    let line = view.state.doc.lineAt(block.from);
    while (line.from < block.to) {
      ranges.push(Decoration.line({ class: `chatero-qmd-formal-line chatero-qmd-formal-line-${block.kind}` }).range(line.from));
      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(ranges, true);
}

export function createFormalBlockDecorations() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = formalDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = formalDecorations(update.view);
      }
    }
  }, { decorations: value => value.decorations });
}
