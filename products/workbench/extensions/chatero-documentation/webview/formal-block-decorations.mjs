import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

import { collectFormalBlocks, formalSourceText } from "./formal-block-parser.mjs";
import {
  isProofCollapsed,
  isProofTemporarilyRevealed,
  proofKey,
  setProofCollapsed,
  toggleProof,
} from "./proof-collapse.mjs";

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

export function renderFormalHeaderElement(document, block, source, { collapsed = false, onToggle } = {}) {
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
  if (block.kind === "proof") {
    const button = document.createElement("button");
    button.className = "chatero-qmd-proof-toggle";
    button.setAttribute("type", "button");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-controls", `chatero-proof-${block.opener.from}`);
    button.textContent = collapsed ? "Show proof" : "Hide proof";
    if (typeof button.addEventListener === "function" && typeof onToggle === "function") {
      button.addEventListener("mousedown", event => event.stopPropagation());
      button.addEventListener("click", event => {
        event.preventDefault();
        onToggle();
      });
    }
    element.append(button);
  }
  return element;
}

class FormalHeaderWidget extends WidgetType {
  constructor(block, source, collapsed) {
    super();
    this.block = block;
    this.source = source;
    this.collapsed = collapsed;
  }

  eq(other) {
    return other.block.kind === this.block.kind && other.block.from === this.block.from
      && other.block.to === this.block.to && other.source === this.source
      && other.collapsed === this.collapsed;
  }

  toDOM(view) {
    const element = renderFormalHeaderElement(view.dom.ownerDocument, this.block, this.source, {
      collapsed: this.collapsed,
      onToggle: () => toggleProof(view, this.block),
    });
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

class CollapsedProofWidget extends WidgetType {
  constructor(block) {
    super();
    this.block = block;
  }

  eq(other) {
    return proofKey(other.block) === proofKey(this.block);
  }

  toDOM(view) {
    const element = view.dom.ownerDocument.createElement("div");
    element.id = `chatero-proof-${this.block.opener.from}`;
    element.className = "chatero-qmd-proof-collapsed";
    element.setAttribute("role", "note");
    element.textContent = "Proof collapsed";
    return element;
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
  const source = formalSourceText(view.state);
  for (const block of collectFormalBlocks(view.state, view.visibleRanges)) {
    if (block.kind === "unsupported") continue;
    const collapsed = block.kind === "proof" && isProofCollapsed(view.state, block);
    const temporarilyRevealed = block.kind === "proof" && isProofTemporarilyRevealed(view.state, block);
    if (!rangeIntersectsSelection(block.opener, view.state.selection)) {
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new FormalHeaderWidget(block, source, collapsed),
      }).range(block.opener.from, block.opener.to));
    }
    if (collapsed && !temporarilyRevealed && block.body.from < block.body.to) {
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new CollapsedProofWidget(block),
      }).range(block.body.from, block.body.to));
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
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setProofCollapsed)))) {
        this.decorations = formalDecorations(update.view);
      }
    }
  }, { decorations: value => value.decorations });
}
