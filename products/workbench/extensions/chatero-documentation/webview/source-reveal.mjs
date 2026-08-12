function validRange(value, label) {
  if (!value || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)
    || value.from < 0 || value.to < value.from) {
    throw new TypeError(`invalid ${label} source range`);
  }
}

function selectionIntersects(selectionRange, sourceRange) {
  if (selectionRange.empty) return sourceRange.from <= selectionRange.from && selectionRange.from <= sourceRange.to;
  return selectionRange.from < sourceRange.to && selectionRange.to > sourceRange.from;
}

function selectionContained(selectionRange, sourceRange) {
  return selectionRange.from >= sourceRange.from && selectionRange.to <= sourceRange.to;
}

export function sourceRevealRange(node, selection) {
  validRange(node, "visual node");
  validRange(node.reveal, "visual reveal");
  const ranges = selection?.ranges && typeof selection.ranges[Symbol.iterator] === "function"
    ? [...selection.ranges]
    : Number.isSafeInteger(selection?.from) && Number.isSafeInteger(selection?.to)
      ? [selection]
      : null;
  if (!ranges) throw new TypeError("EditorSelection is required");
  const relevant = ranges.filter(range => selectionIntersects(range, node));
  if (relevant.length === 0) return null;
  for (const child of node.children ?? []) {
    validRange(child, "visual child");
    if (relevant.every(range => selectionContained(range, child))) {
      return sourceRevealRange(child, selection) ?? Object.freeze({ ...child.reveal });
    }
  }
  return Object.freeze({ from: node.reveal.from, to: node.reveal.to });
}
