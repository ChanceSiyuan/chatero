import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";

function decodeDisplayEscapes(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, "$1");
}

function trimCell(source, from, to) {
  while (from < to && (source[from] === " " || source[from] === "\t")) from += 1;
  while (to > from && (source[to - 1] === " " || source[to - 1] === "\t")) to -= 1;
  return { from, to };
}

function backtickRun(source, from) {
  let to = from;
  while (source[to] === "`") to += 1;
  return to - from;
}

function parseRow(source, absoluteFrom, header) {
  const segments = [];
  let segmentFrom = 0;
  let codeRun = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "`") {
      const width = backtickRun(source, index);
      if (codeRun === 0) codeRun = width;
      else if (codeRun === width) codeRun = 0;
      index += width - 1;
      continue;
    }
    if (source[index] !== "|" || codeRun !== 0) continue;
    if (index === 0) {
      segmentFrom = 1;
      continue;
    }
    segments.push([segmentFrom, index]);
    segmentFrom = index + 1;
  }
  if (codeRun !== 0) return undefined;
  if (segmentFrom < source.length || source.at(-1) !== "|") segments.push([segmentFrom, source.length]);
  if (segments.length === 0) return undefined;
  const cells = segments.map(([rawFrom, rawTo]) => {
    const range = trimCell(source, rawFrom, rawTo);
    return Object.freeze({
      from: absoluteFrom + range.from,
      to: absoluteFrom + range.to,
      displayText: decodeDisplayEscapes(source.slice(range.from, range.to)),
      header,
    });
  });
  return Object.freeze({
    from: absoluteFrom,
    to: absoluteFrom + source.length,
    header,
    cells: Object.freeze(cells),
  });
}

function alignmentFor(value) {
  const source = value.trim();
  if (!/^:?-{3,}:?$/u.test(source)) return undefined;
  if (source.startsWith(":") && source.endsWith(":")) return "center";
  if (source.endsWith(":")) return "right";
  if (source.startsWith(":")) return "left";
  return "default";
}

function parseTable(source, from) {
  const lines = source.split("\n");
  if (lines.length < 2) return undefined;
  const offsets = [];
  let offset = from;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const header = parseRow(lines[0], offsets[0], true);
  const delimiter = parseRow(lines[1], offsets[1], false);
  if (!header || !delimiter || delimiter.cells.length !== header.cells.length) return undefined;
  const alignments = delimiter.cells.map(cell => alignmentFor(cell.displayText));
  if (alignments.some(value => value === undefined)) return undefined;
  const rows = [header];
  for (let index = 2; index < lines.length; index += 1) {
    const row = parseRow(lines[index], offsets[index], false);
    if (!row || row.cells.length !== header.cells.length) return undefined;
    rows.push(row);
  }
  return Object.freeze({
    kind: "table",
    from,
    to: from + source.length,
    source,
    delimiter: Object.freeze({ from: offsets[1], to: offsets[1] + lines[1].length }),
    alignments: Object.freeze(alignments),
    rows: Object.freeze(rows),
  });
}

export function collectTableNodes(state, visibleRanges) {
  if (!state?.doc || !Array.isArray(visibleRanges)) throw new TypeError("table collection requires an EditorState and visible ranges");
  const found = new Map();
  for (const range of visibleRanges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < 0 || range.to < range.from || range.to > state.doc.length) {
      throw new RangeError("invalid table visible range");
    }
    const tree = ensureSyntaxTree(state, range.to, 16) ?? syntaxTree(state);
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        if (cursor.name !== "Table") return undefined;
        const source = state.doc.sliceString(cursor.from, cursor.to, "\n");
        const table = parseTable(source, cursor.from);
        if (table && table.from <= range.to && table.to >= range.from) found.set(`${table.from}:${table.to}`, table);
        return false;
      },
    });
  }
  return Object.freeze([...found.values()].sort((left, right) => left.from - right.from || left.to - right.to));
}

export function tableRowRevealRange(table, offset) {
  if (!table?.rows || !Number.isSafeInteger(offset)) throw new TypeError("table and source offset are required");
  const row = table.rows.find(value => value.from <= offset && offset <= value.to);
  return row ? Object.freeze({ from: row.from, to: row.to }) : null;
}

export function tableCellSelection(table, rowIndex, columnIndex) {
  if (!Number.isSafeInteger(rowIndex) || !Number.isSafeInteger(columnIndex)
    || rowIndex < 0 || columnIndex < 0 || !table?.rows?.[rowIndex]?.cells?.[columnIndex]) {
    throw new RangeError("table cell does not exist");
  }
  return table.rows[rowIndex].cells[columnIndex].from;
}

export function renderTableRowElement(document, table, row) {
  if (!document || typeof document.createElement !== "function") throw new TypeError("DOM document is required");
  const element = document.createElement("table");
  element.className = "chatero-qmd-table";
  const group = document.createElement(row.header ? "thead" : "tbody");
  const rowElement = document.createElement("tr");
  row.cells.forEach((cell, index) => {
    const cellElement = document.createElement(row.header ? "th" : "td");
    cellElement.className = `chatero-qmd-table-align-${table.alignments[index]}`;
    cellElement.dataset.sourceFrom = String(cell.from);
    cellElement.dataset.sourceTo = String(cell.to);
    if (row.header) cellElement.setAttribute("scope", "col");
    cellElement.textContent = cell.displayText;
    rowElement.append(cellElement);
  });
  group.append(rowElement);
  element.append(group);
  return element;
}

class TableRowWidget extends WidgetType {
  constructor(table, row) {
    super();
    this.table = table;
    this.row = row;
  }

  eq(other) {
    return other.row.from === this.row.from && other.row.to === this.row.to
      && other.table.source === this.table.source;
  }

  toDOM(view) {
    const element = renderTableRowElement(view.dom.ownerDocument, this.table, this.row);
    element.addEventListener("mousedown", event => {
      event.preventDefault();
      let target = event.target;
      while (target && target !== element && !target.dataset?.sourceFrom) target = target.parentElement;
      const anchor = Number(target?.dataset?.sourceFrom ?? this.row.from);
      view.dispatch({ selection: { anchor } });
      view.focus();
    });
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

class TableDelimiterWidget extends WidgetType {
  toDOM(view) {
    const element = view.dom.ownerDocument.createElement("div");
    element.className = "chatero-qmd-table-delimiter";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

function selectionIntersects(selection, range) {
  return selection.ranges.some(value => value.empty
    ? range.from <= value.from && value.from <= range.to
    : value.from < range.to && value.to > range.from);
}

function tableDecorations(view) {
  const ranges = [];
  for (const table of collectTableNodes(view.state, view.visibleRanges)) {
    for (const row of table.rows) {
      if (selectionIntersects(view.state.selection, row)) continue;
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new TableRowWidget(table, row),
      }).range(row.from, row.to));
    }
    if (!selectionIntersects(view.state.selection, table.delimiter)) {
      ranges.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new TableDelimiterWidget(),
      }).range(table.delimiter.from, table.delimiter.to));
    }
  }
  return Decoration.set(ranges, true);
}

export function createTableDecorations() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = tableDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = tableDecorations(update.view);
      }
    }
  }, { decorations: value => value.decorations });
}
