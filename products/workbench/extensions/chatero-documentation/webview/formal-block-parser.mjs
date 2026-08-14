function sourceRange(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new TypeError("invalid formal source range");
  }
  return Object.freeze({ from, to });
}

function unsupported(from, to, reason) {
  return Object.freeze({ kind: "unsupported", from, to, reason });
}

function sourceLines(source, from, to) {
  const lines = [];
  let cursor = from;
  while (cursor < to) {
    const newline = source.indexOf("\n", cursor);
    const fullEnd = newline >= 0 && newline < to ? newline + 1 : to;
    let contentEnd = newline >= 0 && newline < to ? newline : to;
    if (contentEnd > cursor && source.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    lines.push(Object.freeze({
      from: cursor,
      contentEnd,
      fullEnd,
      text: source.slice(cursor, contentEnd),
    }));
    cursor = fullEnd;
  }
  return lines;
}

function openerFor(line) {
  const match = line.text.match(/^[\t ]{0,3}(:{3,})[\t ]+(\{.*\})[\t ]*$/u);
  if (!match) return undefined;
  const attributesOffset = line.text.indexOf(match[2]);
  return Object.freeze({
    width: match[1].length,
    attributesSource: match[2],
    attributesFrom: line.from + attributesOffset,
  });
}

function closerWidth(line) {
  return line.text.match(/^[\t ]{0,3}(:{3,})[\t ]*$/u)?.[1].length;
}

function codeFence(line) {
  const match = line.text.match(/^[ ]{0,3}(`{3,}|~{3,})/u);
  return match ? Object.freeze({ marker: match[1][0], width: match[1].length }) : undefined;
}

function readonlyValues(entries) {
  const values = new Map(entries);
  for (const name of ["set", "delete", "clear"]) {
    Object.defineProperty(values, name, {
      value() { throw new TypeError("formal attributes are read-only"); },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return Object.freeze(values);
}

function parseAttributes(raw, from) {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return undefined;
  const ids = [];
  const classes = [];
  const entries = [];
  const seenKeys = new Set();
  let cursor = 1;
  while (cursor < raw.length - 1) {
    while (/[\t ]/u.test(raw[cursor] ?? "")) cursor += 1;
    if (cursor >= raw.length - 1) break;
    if (raw[cursor] === "#" || raw[cursor] === ".") {
      const prefix = raw[cursor];
      const start = ++cursor;
      while (cursor < raw.length - 1 && !/[\t ]/u.test(raw[cursor])) cursor += 1;
      const value = raw.slice(start, cursor);
      if (!/^[A-Za-z0-9_:-]+(?:[A-Za-z0-9_.:-]*[A-Za-z0-9_:-])?$/u.test(value)) return undefined;
      if (prefix === "#") ids.push(value);
      else classes.push(value);
      continue;
    }
    const keyMatch = raw.slice(cursor).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/u);
    if (!keyMatch) return undefined;
    const key = keyMatch[0];
    cursor += key.length;
    if (raw[cursor] !== "=" || seenKeys.has(key)) return undefined;
    seenKeys.add(key);
    cursor += 1;
    let value = "";
    if (raw[cursor] === '"' || raw[cursor] === "'") {
      const quote = raw[cursor++];
      let closed = false;
      while (cursor < raw.length - 1) {
        if (raw[cursor] === "\\" && cursor + 1 < raw.length - 1) {
          value += raw[cursor + 1];
          cursor += 2;
          continue;
        }
        if (raw[cursor] === quote) {
          cursor += 1;
          closed = true;
          break;
        }
        value += raw[cursor++];
      }
      if (!closed) return undefined;
    }
    else {
      const start = cursor;
      while (cursor < raw.length - 1 && !/[\t ]/u.test(raw[cursor])) cursor += 1;
      value = raw.slice(start, cursor);
      if (!value || /[{}"']/u.test(value)) return undefined;
    }
    if (cursor < raw.length - 1 && !/[\t ]/u.test(raw[cursor])) return undefined;
    entries.push([key, value]);
  }
  if (ids.length > 1) return undefined;
  return Object.freeze({
    range: sourceRange(from, from + raw.length),
    raw,
    id: ids[0] ?? null,
    classes: Object.freeze(classes),
    values: readonlyValues(entries),
  });
}

function classifyFormal(attributes) {
  if (attributes.id?.startsWith("thm-")) return "theorem";
  if (attributes.id?.startsWith("lem-")) return "lemma";
  if (attributes.id?.startsWith("prf-") || attributes.id?.startsWith("proof-") || attributes.classes.includes("proof")) return "proof";
  return null;
}

function labelAndBody(lines, openerIndex, closerIndex, closerFrom) {
  let index = openerIndex + 1;
  while (index < closerIndex && lines[index].text.trim() === "") index += 1;
  let label = null;
  let labelLine = null;
  if (index < closerIndex) {
    const match = lines[index].text.match(/^[\t ]{0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/u);
    if (match) {
      const textFrom = lines[index].text.indexOf(match[1]);
      label = sourceRange(lines[index].from + textFrom, lines[index].from + textFrom + match[1].length);
      labelLine = sourceRange(lines[index].from, lines[index].fullEnd);
      index += 1;
      while (index < closerIndex && lines[index].text.trim() === "") index += 1;
    }
  }
  const bodyFrom = index < closerIndex ? lines[index].from : closerFrom;
  return Object.freeze({ label, labelLine, body: sourceRange(bodyFrom, closerFrom) });
}

export function parseFormalBlock(source, from, to) {
  if (typeof source !== "string" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 0 || to < from || to > source.length) {
    throw new TypeError("invalid formal source input");
  }
  const lines = sourceLines(source, from, to);
  const outer = lines[0] && openerFor(lines[0]);
  if (!outer) return unsupported(from, to, "missing-opener");
  const stack = [outer.width];
  let activeCode;
  let closerIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const code = codeFence(lines[index]);
    if (activeCode) {
      if (code?.marker === activeCode.marker && code.width >= activeCode.width) activeCode = undefined;
      continue;
    }
    if (code) {
      activeCode = code;
      continue;
    }
    const nested = openerFor(lines[index]);
    if (nested) {
      stack.push(nested.width);
      continue;
    }
    const close = closerWidth(lines[index]);
    if (close === undefined) continue;
    if (close !== stack.at(-1)) return unsupported(from, to, "mismatched-fence");
    stack.pop();
    if (stack.length === 0) {
      closerIndex = index;
      break;
    }
  }
  if (closerIndex < 0) return unsupported(from, to, "missing-closer");
  if (lines.slice(closerIndex + 1).some(line => line.text.trim() !== "")) return unsupported(from, to, "ambiguous-trailing-source");
  const attributes = parseAttributes(outer.attributesSource, outer.attributesFrom);
  if (!attributes) return unsupported(from, to, "malformed-attributes");
  const kind = classifyFormal(attributes);
  if (!kind) return unsupported(from, to, "not-formal");
  const opener = sourceRange(lines[0].from, lines[0].fullEnd);
  const closer = sourceRange(lines[closerIndex].from, lines[closerIndex].fullEnd);
  const parts = labelAndBody(lines, 0, closerIndex, closer.from);
  return Object.freeze({
    kind,
    from,
    to: closer.to,
    range: sourceRange(from, closer.to),
    opener,
    attributes,
    label: parts.label,
    labelLine: parts.labelLine,
    body: parts.body,
    closer,
  });
}

function scanFencedRanges(source) {
  const lines = sourceLines(source, 0, source.length);
  const stack = [];
  const ranges = [];
  let activeCode;
  for (let index = 0; index < lines.length; index += 1) {
    const code = codeFence(lines[index]);
    if (activeCode) {
      if (code?.marker === activeCode.marker && code.width >= activeCode.width) activeCode = undefined;
      continue;
    }
    if (code) {
      activeCode = code;
      continue;
    }
    const opener = openerFor(lines[index]);
    if (opener) {
      stack.push({ index, width: opener.width });
      continue;
    }
    const close = closerWidth(lines[index]);
    if (close === undefined || stack.length === 0) continue;
    const opened = stack.pop();
    ranges.push(sourceRange(lines[opened.index].from, lines[index].fullEnd));
  }
  for (const opened of stack) ranges.push(sourceRange(lines[opened.index].from, source.length));
  return ranges;
}

function intersectsVisible(value, visibleRanges) {
  return visibleRanges.some(range => value.from <= range.to && value.to >= range.from);
}

// CodeMirror `Text` is immutable and identity-stable for a given document revision, so the
// whole-document scan is memoized against it: keystrokes parse once and selection-only or
// viewport-only updates parse not at all.
const parsedDocuments = new WeakMap();

function parsedDocument(doc) {
  const cached = parsedDocuments.get(doc);
  if (cached) return cached;
  const source = doc.toString();
  const parsed = Object.freeze({
    source,
    blocks: Object.freeze(scanFencedRanges(source).map(range => parseFormalBlock(source, range.from, range.to))),
  });
  parsedDocuments.set(doc, parsed);
  return parsed;
}

export function formalSourceText(state) {
  if (!state?.doc) throw new TypeError("formal source requires an EditorState");
  return parsedDocument(state.doc).source;
}

export function collectFormalBlocks(state, visibleRanges) {
  if (!state?.doc || !Array.isArray(visibleRanges)) throw new TypeError("formal collection requires an EditorState and visible ranges");
  for (const range of visibleRanges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < 0 || range.to < range.from || range.to > state.doc.length) {
      throw new RangeError("invalid formal visible range");
    }
  }
  let blocks = parsedDocument(state.doc).blocks
    .filter(value => intersectsVisible(value, visibleRanges))
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const counts = new Map();
  for (const block of blocks) {
    if (block.kind !== "unsupported" && block.attributes.id) {
      counts.set(block.attributes.id, (counts.get(block.attributes.id) ?? 0) + 1);
    }
  }
  blocks = blocks.map(block => block.kind !== "unsupported" && block.attributes.id && counts.get(block.attributes.id) > 1
    ? unsupported(block.from, block.to, "duplicate-id") : block);
  return Object.freeze(blocks);
}

export { sourceRange };
