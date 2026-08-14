import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

export const KATEX_OPTIONS = Object.freeze({
  output: "htmlAndMathml",
  throwOnError: true,
  strict: "error",
  trust: false,
  maxExpand: 1000,
  maxSize: 20,
});

function formulaNode(kind, from, to, contentFrom, contentTo, source) {
  if (contentTo <= contentFrom) return undefined;
  return Object.freeze({
    kind,
    from,
    to,
    contentFrom,
    contentTo,
    source,
    reveal: Object.freeze({ from, to }),
  });
}

function delimitedNode(name, from, source) {
  if (name === "InlineMath" && source.startsWith("$")) {
    return formulaNode("formula-inline", from, from + source.length, from + 1, from + source.length - 1, source);
  }
  if (name === "InlineMath" && source.startsWith("\\(")) {
    return formulaNode("formula-inline", from, from + source.length, from + 2, from + source.length - 2, source);
  }
  if (name === "DisplayMath" && source.startsWith("\\[")) {
    return formulaNode("formula-display", from, from + source.length, from + 2, from + source.length - 2, source);
  }
  return undefined;
}

function dollarDisplayNode(from, source) {
  if (!source.startsWith("$$") || !source.endsWith("$$") || source.length <= 4) return undefined;
  const expression = source.slice(2, -2);
  if (!expression.trim()) return undefined;
  return formulaNode("formula-display", from, from + source.length, from + 2, from + source.length - 2, source);
}

function intersects(node, range) {
  return node.from <= range.to && node.to >= range.from;
}

function compareNodes(left, right) {
  return left.from - right.from || left.to - right.to || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
}

export function collectFormulaNodes(state, visibleRanges) {
  if (!state?.doc || !Array.isArray(visibleRanges)) throw new TypeError("formula collection requires an EditorState and visible ranges");
  const found = new Map();
  for (const range of visibleRanges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < 0 || range.to < range.from || range.to > state.doc.length) {
      throw new RangeError("invalid formula visible range");
    }
    const tree = ensureSyntaxTree(state, range.to, 16) ?? syntaxTree(state);
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        if (cursor.name === "Table") return false;
        const source = state.doc.sliceString(cursor.from, cursor.to, "\n");
        if (cursor.name === "Paragraph") {
          const display = dollarDisplayNode(cursor.from, source);
          if (display && intersects(display, range)) {
            found.set(`${display.from}:${display.to}`, display);
            return false;
          }
        }
        if (cursor.name !== "InlineMath" && cursor.name !== "DisplayMath") return undefined;
        const node = delimitedNode(cursor.name, cursor.from, source);
        if (node && intersects(node, range)) found.set(`${node.from}:${node.to}`, node);
        return undefined;
      },
    });
  }
  return Object.freeze([...found.values()].sort(compareNodes));
}

function intersectsSelection(selection, node) {
  const ranges = selection?.ranges
    ?? (Number.isSafeInteger(selection?.from) && Number.isSafeInteger(selection?.to) ? [selection] : []);
  return ranges.some(range => range.empty
    ? node.from <= range.from && range.from <= node.to
    : range.from < node.to && range.to > node.from);
}

export function formulaRevealRange(node, selection) {
  if (!node || !Number.isSafeInteger(node.from) || !Number.isSafeInteger(node.to) || node.to < node.from) {
    throw new TypeError("invalid formula source range");
  }
  if (selection !== undefined && !intersectsSelection(selection, node)) return null;
  return Object.freeze({ from: node.from, to: node.to });
}

function formulaFallbackElement(container, node) {
  const element = container.ownerDocument.createElement("span");
  element.className = "chatero-qmd-formula-fallback";
  element.setAttribute("role", "note");
  element.dataset.sourceFrom = String(node.from);
  element.dataset.sourceTo = String(node.to);
  element.textContent = "Formula could not be rendered";
  return element;
}

export function renderFormulaInto({ node, source, container, katex }) {
  if (typeof source !== "string" || !container || typeof container.replaceChildren !== "function"
    || !katex || typeof katex.render !== "function") {
    throw new TypeError("formula rendering dependencies are invalid");
  }
  try {
    katex.render(source.slice(node.contentFrom, node.contentTo), container, {
      ...KATEX_OPTIONS,
      displayMode: node.kind === "formula-display",
    });
    return Object.freeze({ kind: "rendered" });
  }
  catch {
    container.replaceChildren(formulaFallbackElement(container, node));
    return Object.freeze({ kind: "fallback", message: "Formula could not be rendered" });
  }
}

class FormulaWidget extends WidgetType {
  constructor(node, source, katex) {
    super();
    this.node = node;
    this.source = source;
    this.katex = katex;
  }

  eq(other) {
    return other.node.kind === this.node.kind
      && other.node.from === this.node.from
      && other.node.to === this.node.to
      && other.node.source === this.node.source;
  }

  toDOM(view) {
    const element = view.dom.ownerDocument.createElement(this.node.kind === "formula-display" ? "div" : "span");
    element.className = `chatero-qmd-${this.node.kind}`;
    element.dataset.sourceFrom = String(this.node.from);
    element.dataset.sourceTo = String(this.node.to);
    renderFormulaInto({ node: this.node, source: this.source, container: element, katex: this.katex });
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

function formulaDecorations(view, katex) {
  const ranges = [];
  // Materialize the document text at most once per rebuild, and not at all when no visible
  // formula needs a widget.
  let source;
  for (const node of collectFormulaNodes(view.state, view.visibleRanges)) {
    if (formulaRevealRange(node, view.state.selection)) continue;
    if (source === undefined) source = view.state.doc.toString();
    ranges.push(Decoration.replace({
      block: node.kind === "formula-display",
      inclusive: false,
      widget: new FormulaWidget(node, source, katex),
    }).range(node.from, node.to));
  }
  return Decoration.set(ranges, true);
}

export function createFormulaDecorations({ katex }) {
  if (!katex || typeof katex.render !== "function") throw new TypeError("KaTeX renderer is required");
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = formulaDecorations(view, katex);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = formulaDecorations(update.view, katex);
      }
    }
  }, { decorations: value => value.decorations });
}
