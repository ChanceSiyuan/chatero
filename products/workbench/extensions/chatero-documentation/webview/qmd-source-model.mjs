import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

const HEADING_NAMES = new Set(Array.from({ length: 6 }, (_, index) => `ATXHeading${index + 1}`));
const UNSUPPORTED_BLOCKS = new Set(["HTMLBlock", "FencedCode", "IndentedCode"]);

function sourceRange(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new TypeError("invalid QMD source range");
  }
  return Object.freeze({ from, to });
}

function freezeNode(node) {
  return Object.freeze({
    ...node,
    reveal: sourceRange(node.reveal.from, node.reveal.to),
    children: Object.freeze(node.children.map(freezeNode)),
  });
}

function displayText(kind, source) {
  if (kind === "heading") return source.replace(/^#{1,6}[\t ]+/u, "").replace(/[\t ]+#+[\t ]*$/u, "");
  if (kind === "emphasis") return source.replace(/^(?:\*|_)+|(?:\*|_)+$/gu, "");
  if (kind === "code-span") return source.replace(/^`+|`+$/gu, "");
  if (kind === "link") return source.match(/^\[([^\]]*)\]/u)?.[1] ?? source;
  return source;
}

function kindForName(name) {
  if (HEADING_NAMES.has(name)) return "heading";
  if (name === "Paragraph") return "prose";
  if (name === "Emphasis" || name === "StrongEmphasis") return "emphasis";
  if (name === "BulletList" || name === "OrderedList") return "list";
  if (name === "Link") return "link";
  if (name === "InlineCode") return "code-span";
  if (name === "InlineMath") return "formula-inline";
  if (name === "DisplayMath") return "formula-display";
  if (name === "Table") return "table";
  if (name === "Image") return "image";
  if (UNSUPPORTED_BLOCKS.has(name)) return "unsupported";
  return undefined;
}

function nestedChildren(state, node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const kind = kindForName(child.name);
    if (["emphasis", "link", "code-span", "formula-inline", "formula-display", "image"].includes(kind)) {
      children.push(nodeRecord(state, child, kind));
    }
    else if (!UNSUPPORTED_BLOCKS.has(child.name)) {
      children.push(...nestedChildren(state, child));
    }
  }
  children.sort((left, right) => left.from - right.from || left.to - right.to
    || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  return children;
}

function nodeRecord(state, node, kind = kindForName(node.name)) {
  const source = state.doc.sliceString(node.from, node.to, "\n");
  return {
    kind: kind ?? "unsupported",
    from: node.from,
    to: node.to,
    source,
    displayText: displayText(kind, source),
    reveal: sourceRange(node.from, node.to),
    children: nestedChildren(state, node),
  };
}

function intersects(from, to, range) {
  return from <= range.to && to >= range.from;
}

function hasHandledAncestor(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["Paragraph", "BulletList", "OrderedList", "Table", ...HEADING_NAMES].includes(parent.name)) return true;
  }
  return false;
}

function visualNodeFromCursor(state, cursor) {
  const kind = kindForName(cursor.name);
  if (!kind || hasHandledAncestor(cursor.node)) return undefined;
  return freezeNode(nodeRecord(state, cursor.node, kind));
}

function compareNodes(left, right) {
  return left.from - right.from || left.to - right.to || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
}

export function collectVisualNodes(state, visibleRanges) {
  if (!state || typeof state.sliceDoc !== "function" || !state.doc) throw new TypeError("EditorState is required");
  if (!Array.isArray(visibleRanges)) throw new TypeError("visibleRanges must be an array");
  const unique = new Map();
  for (const range of visibleRanges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < 0 || range.to < range.from || range.to > state.doc.length) {
      throw new RangeError("invalid visible range");
    }
    const tree = ensureSyntaxTree(state, range.to, 16) ?? syntaxTree(state);
    const beforeSize = unique.size;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        const node = visualNodeFromCursor(state, cursor);
        if (node && intersects(node.from, node.to, range)) unique.set(`${node.kind}:${node.from}:${node.to}`, node);
      },
    });
    if (unique.size === beforeSize && range.from < state.doc.length) {
      const line = state.doc.lineAt(range.from);
      const source = state.sliceDoc(line.from, line.to);
      if (source.trim()) {
        const kind = /^#{1,6}[\t ]/u.test(source) ? "heading"
          : /^[\t ]*(?:[-+*]|\d+[.)])[\t ]+/u.test(source) ? "list"
            : /^</u.test(source.trimStart()) ? "unsupported" : "prose";
        const fallback = freezeNode({
          kind,
          from: line.from,
          to: line.to,
          source,
          displayText: displayText(kind, source),
          reveal: sourceRange(line.from, line.to),
          children: [],
        });
        unique.set(`${fallback.kind}:${fallback.from}:${fallback.to}`, fallback);
      }
    }
  }
  return Object.freeze([...unique.values()].sort(compareNodes));
}

export { sourceRange };
