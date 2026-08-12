function safeOffset(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside the document`);
  }
  return value;
}

function greatestStartAtOrBefore(starts, value) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

function preferredLineBreak(counts) {
  if (counts.crlf >= counts.lf && counts.crlf >= counts.cr && counts.crlf > 0) return "\r\n";
  if (counts.lf >= counts.cr && counts.lf > 0) return "\n";
  if (counts.cr > 0) return "\r";
  return "\n";
}

export function createLineEndingMap(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const sourceStarts = [0];
  const sourceEnds = [];
  const editorStarts = [0];
  const editorParts = [];
  const counts = { crlf: 0, lf: 0, cr: 0 };
  let sourceCursor = 0;
  let editorCursor = 0;
  let partStart = 0;
  while (sourceCursor < source.length) {
    const code = source.charCodeAt(sourceCursor);
    if (code !== 10 && code !== 13) {
      sourceCursor += 1;
      continue;
    }
    editorParts.push(source.slice(partStart, sourceCursor), "\n");
    sourceEnds.push(sourceCursor);
    const width = code === 13 && source.charCodeAt(sourceCursor + 1) === 10 ? 2 : 1;
    if (width === 2) counts.crlf += 1;
    else if (code === 13) counts.cr += 1;
    else counts.lf += 1;
    editorCursor += sourceCursor - partStart + 1;
    sourceCursor += width;
    partStart = sourceCursor;
    sourceStarts.push(sourceCursor);
    editorStarts.push(editorCursor);
  }
  editorParts.push(source.slice(partStart));
  sourceEnds.push(source.length);
  const editorText = editorParts.join("");
  const lineBreak = preferredLineBreak(counts);

  function toSourceOffset(editorOffset) {
    safeOffset(editorOffset, editorText.length, "editor offset");
    const line = greatestStartAtOrBefore(editorStarts, editorOffset);
    return sourceStarts[line] + editorOffset - editorStarts[line];
  }

  function toEditorOffset(sourceOffset) {
    safeOffset(sourceOffset, source.length, "source offset");
    const line = greatestStartAtOrBefore(sourceStarts, sourceOffset);
    if (sourceOffset > sourceEnds[line]) {
      throw new RangeError("source offset splits a line-ending sequence");
    }
    return editorStarts[line] + sourceOffset - sourceStarts[line];
  }

  function encodeEditorText(value) {
    if (typeof value !== "string") throw new TypeError("editor text must be a string");
    return lineBreak === "\n" ? value : value.replaceAll("\n", lineBreak);
  }

  return Object.freeze({
    source,
    editorText,
    lineBreak,
    toSourceOffset,
    toEditorOffset,
    encodeEditorText,
  });
}
