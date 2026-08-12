import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

const imageRefresh = StateEffect.define();

function decodeMarkdownText(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, "$1");
}

function imageAttributes(state, to) {
  const line = state.doc.lineAt(to);
  const suffix = state.doc.sliceString(to, line.to, "\n");
  const match = suffix.match(/^\{([^}\n]*)\}/u);
  if (!match) return Object.freeze({ to, width: undefined, height: undefined });
  const values = new Map();
  for (const token of match[1].matchAll(/(?:^|[\t ])(width|height)=(?:"([0-9]+)"|'([0-9]+)'|([0-9]+))(?=[\t ]|$)/gu)) {
    if (values.has(token[1])) return Object.freeze({ to, width: undefined, height: undefined });
    const value = Number(token[2] ?? token[3] ?? token[4]);
    if (Number.isSafeInteger(value) && value >= 1 && value <= 10_000) values.set(token[1], value);
  }
  return Object.freeze({
    to: to + match[0].length,
    width: values.get("width"),
    height: values.get("height"),
  });
}

function insideTable(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Table") return true;
  }
  return false;
}

function imageNode(state, node) {
  if (insideTable(node)) return undefined;
  const source = state.doc.sliceString(node.from, node.to, "\n");
  const url = node.getChild("URL");
  if (!url) return undefined;
  let target = state.doc.sliceString(url.from, url.to, "\n");
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const labelEnd = source.indexOf("]");
  if (!source.startsWith("![") || labelEnd < 2) return undefined;
  const attributes = imageAttributes(state, node.to);
  return Object.freeze({
    kind: "image",
    from: node.from,
    to: attributes.to,
    source: state.doc.sliceString(node.from, attributes.to, "\n"),
    target,
    alt: decodeMarkdownText(source.slice(2, labelEnd)),
    targetRange: Object.freeze({ from: url.from, to: url.to }),
    reveal: Object.freeze({ from: node.from, to: attributes.to }),
    width: attributes.width,
    height: attributes.height,
  });
}

export function collectImageNodes(state, visibleRanges) {
  if (!state?.doc || !Array.isArray(visibleRanges)) throw new TypeError("image collection requires an EditorState and visible ranges");
  const found = new Map();
  for (const range of visibleRanges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < 0 || range.to < range.from || range.to > state.doc.length) {
      throw new RangeError("invalid image visible range");
    }
    const tree = ensureSyntaxTree(state, range.to, 16) ?? syntaxTree(state);
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        if (cursor.name === "Table" || cursor.name === "HTMLTag" || cursor.name === "HTMLBlock") return false;
        if (cursor.name !== "Image") return undefined;
        const value = imageNode(state, cursor.node);
        if (value) found.set(`${value.from}:${value.to}`, value);
        return false;
      },
    });
  }
  return Object.freeze([...found.values()].sort((left, right) => left.from - right.from || left.to - right.to));
}

function selectionIntersects(selection, node) {
  const ranges = selection?.ranges
    ?? (Number.isSafeInteger(selection?.from) && Number.isSafeInteger(selection?.to) ? [selection] : []);
  return ranges.some(range => range.empty
    ? node.from <= range.from && range.from < node.to
    : range.from < node.to && range.to > node.from);
}

export function imageRevealRange(node, selection) {
  if (!node || !Number.isSafeInteger(node.from) || !Number.isSafeInteger(node.to)) throw new TypeError("image node is invalid");
  if (selection !== undefined && !selectionIntersects(selection, node)) return null;
  return Object.freeze({ from: node.from, to: node.to });
}

function placeholderText(resolution) {
  return resolution.reason === "missing" ? "Image not found"
    : resolution.reason === "too-large" ? "Image exceeds the preview size limit"
      : resolution.reason === "unsupported-type" ? "Image type is not supported"
        : resolution.reason === "mime-mismatch" ? "Image type does not match its contents"
          : resolution.reason === "unsafe" ? "Image path is not safe"
            : "Image preview unavailable";
}

export function renderImageElement(document, node, resolution) {
  if (!document || typeof document.createElement !== "function") throw new TypeError("DOM document is required");
  if (resolution?.kind === "ready") {
    const image = document.createElement("img");
    image.className = "chatero-qmd-image";
    image.setAttribute("src", resolution.src);
    image.setAttribute("alt", node.alt);
    if (node.width) image.setAttribute("width", String(node.width));
    if (node.height) image.setAttribute("height", String(node.height));
    image.dataset.sourceFrom = String(node.from);
    image.dataset.sourceTo = String(node.to);
    return image;
  }
  const element = document.createElement("span");
  element.className = "chatero-qmd-image-placeholder";
  element.setAttribute("role", "note");
  element.dataset.sourceFrom = String(node.from);
  element.dataset.sourceTo = String(node.to);
  element.textContent = resolution ? placeholderText(resolution) : "Loading image preview";
  return element;
}

class ImageWidget extends WidgetType {
  constructor(node, resolution) {
    super();
    this.node = node;
    this.resolution = resolution;
  }

  eq(other) {
    return other.node.from === this.node.from && other.node.to === this.node.to
      && JSON.stringify(other.resolution) === JSON.stringify(this.resolution);
  }

  toDOM(view) {
    const element = renderImageElement(view.dom.ownerDocument, this.node, this.resolution);
    element.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.node.targetRange.from } });
      view.focus();
    });
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

export function createImageDecorations({ requestImage }) {
  if (typeof requestImage !== "function") throw new TypeError("image request function is required");
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.cache = new Map();
      this.disposed = false;
      this.decorations = this.build(view);
    }

    request(node) {
      if (this.cache.has(node.target)) return;
      this.cache.set(node.target, null);
      Promise.resolve(requestImage(node.target)).then(resolution => {
        if (this.disposed) return;
        this.cache.set(node.target, resolution);
        this.view.dispatch({ effects: imageRefresh.of(node.target) });
      }).catch(() => {
        if (this.disposed) return;
        this.cache.set(node.target, Object.freeze({ kind: "placeholder", target: node.target, reason: "unavailable" }));
        this.view.dispatch({ effects: imageRefresh.of(node.target) });
      });
    }

    build(view) {
      const ranges = [];
      for (const node of collectImageNodes(view.state, view.visibleRanges)) {
        if (imageRevealRange(node, view.state.selection)) continue;
        this.request(node);
        ranges.push(Decoration.replace({
          block: false,
          inclusive: false,
          widget: new ImageWidget(node, this.cache.get(node.target)),
        }).range(node.from, node.to));
      }
      return Decoration.set(ranges, true);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(imageRefresh)))) {
        this.decorations = this.build(update.view);
      }
    }

    destroy() {
      this.disposed = true;
      this.cache.clear();
    }
  }, { decorations: value => value.decorations });
}
