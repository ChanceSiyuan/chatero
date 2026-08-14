import { createHash } from "node:crypto";

function frontierValue(frontier, diagonal) {
  return frontier.has(diagonal) ? frontier.get(diagonal) : Number.NEGATIVE_INFINITY;
}

function sequenceOperations(before, after) {
  if (before.length === 0) return after.map(value => ({ kind: "insert", value }));
  if (after.length === 0) return before.map(value => ({ kind: "delete", value }));
  const maximum = before.length + after.length;
  let frontier = new Map([[1, 0]]);
  const trace = [];
  for (let distance = 0; distance <= maximum; distance++) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const insertion = diagonal === -distance
        || (diagonal !== distance && frontierValue(frontier, diagonal - 1) < frontierValue(frontier, diagonal + 1));
      let x = insertion ? frontierValue(frontier, diagonal + 1) : frontierValue(frontier, diagonal - 1) + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        trace.push(next);
        const reversed = [];
        let currentX = before.length;
        let currentY = after.length;
        for (let step = trace.length - 1; step > 0; step--) {
          const currentDiagonal = currentX - currentY;
          const previous = trace[step - 1];
          const cameFromInsert = currentDiagonal === -step
            || (currentDiagonal !== step
              && frontierValue(previous, currentDiagonal - 1) < frontierValue(previous, currentDiagonal + 1));
          const previousDiagonal = cameFromInsert ? currentDiagonal + 1 : currentDiagonal - 1;
          const previousX = Math.max(0, frontierValue(previous, previousDiagonal));
          const previousY = previousX - previousDiagonal;
          while (currentX > previousX && currentY > previousY) {
            reversed.push({ kind: "equal", value: before[currentX - 1] }); currentX--; currentY--;
          }
          if (cameFromInsert) { reversed.push({ kind: "insert", value: after[currentY - 1] }); currentY--; }
          else { reversed.push({ kind: "delete", value: before[currentX - 1] }); currentX--; }
        }
        while (currentX > 0 && currentY > 0) {
          reversed.push({ kind: "equal", value: before[currentX - 1] }); currentX--; currentY--;
        }
        while (currentX > 0) reversed.push({ kind: "delete", value: before[--currentX] });
        while (currentY > 0) reversed.push({ kind: "insert", value: after[--currentY] });
        return reversed.reverse();
      }
    }
    trace.push(next);
    frontier = next;
  }
  throw new Error("three-way diff did not converge");
}

function unitLength(values, from, to) {
  let units = 0;
  for (let index = from; index < to; index++) units += values[index].length;
  return units;
}

function textEdits(base, target) {
  if (base === target) return [];
  // Code points as plain strings -- the diff only ever compares them and measures their length.
  const baseValues = Array.from(base);
  const targetValues = Array.from(target);
  // The common leading and trailing code points can never fall inside an edit range, so the Myers
  // search only runs over the region that actually differs.
  const shortest = Math.min(baseValues.length, targetValues.length);
  let prefix = 0;
  while (prefix < shortest && baseValues[prefix] === targetValues[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix
    && baseValues[baseValues.length - 1 - suffix] === targetValues[targetValues.length - 1 - suffix]) {
    suffix++;
  }
  const operations = sequenceOperations(
    baseValues.slice(prefix, baseValues.length - suffix),
    targetValues.slice(prefix, targetValues.length - suffix),
  );
  const edits = [];
  const prefixUnits = unitLength(baseValues, 0, prefix);
  let baseOffset = prefixUnits;
  let targetOffset = prefixUnits;
  let active = null;
  const flush = () => {
    if (!active) return;
    edits.push(Object.freeze({
      from: active.from,
      to: baseOffset,
      insert: target.slice(active.targetFrom, targetOffset),
    }));
    active = null;
  };
  for (const operation of operations) {
    if (operation.kind === "equal") {
      flush();
      baseOffset += operation.value.length;
      targetOffset += operation.value.length;
    }
    else {
      active ??= { from: baseOffset, targetFrom: targetOffset };
      if (operation.kind === "delete") baseOffset += operation.value.length;
      else targetOffset += operation.value.length;
    }
  }
  flush();
  return edits;
}

function intersects(left, right) {
  const leftInsert = left.from === left.to;
  const rightInsert = right.from === right.to;
  if (leftInsert && rightInsert) return left.from === right.from;
  if (leftInsert) return left.from > right.from && left.from < right.to;
  if (rightInsert) return right.from > left.from && right.from < left.to;
  return Math.max(left.from, right.from) < Math.min(left.to, right.to);
}

function mapOffset(offset, humanEdits, affinity) {
  let delta = 0;
  for (const edit of humanEdits) {
    if (edit.to < offset || edit.to === offset && edit.from !== edit.to) {
      delta += edit.insert.length - (edit.to - edit.from);
      continue;
    }
    if (edit.from === edit.to && edit.from === offset && affinity === "after") delta += edit.insert.length;
  }
  return offset + delta;
}

function conflictEvidence(base, current, proposed, conflicts) {
  const fields = ["chatero-review-conflict-v1", base, current, proposed, JSON.stringify(conflicts)];
  const value = fields.map(field => `${Buffer.byteLength(field, "utf8")}:${field}`).join("|");
  return `review-conflict:sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function threeWayReconcile({ base, current, proposed } = {}) {
  if (typeof base !== "string" || typeof current !== "string" || typeof proposed !== "string") {
    throw new TypeError("three-way source input is invalid");
  }
  if (current === proposed) return Object.freeze({ kind: "merged", text: current, changes: Object.freeze([]) });
  if (current === base) {
    return Object.freeze({ kind: "merged", text: proposed, changes: Object.freeze(textEdits(base, proposed)) });
  }
  if (proposed === base) return Object.freeze({ kind: "merged", text: current, changes: Object.freeze([]) });
  const humanEdits = textEdits(base, current);
  const agentEdits = textEdits(base, proposed);
  const conflicts = [];
  for (const agent of agentEdits) {
    for (const human of humanEdits) {
      if (intersects(agent, human)) conflicts.push(Object.freeze({ agent, human }));
    }
  }
  if (conflicts.length > 0) {
    return Object.freeze({
      kind: "conflict",
      evidenceRef: conflictEvidence(base, current, proposed, conflicts),
      base,
      current,
      proposed,
      conflicts: Object.freeze(conflicts),
    });
  }
  const mapped = agentEdits.map(edit => Object.freeze({
    from: mapOffset(edit.from, humanEdits, "after"),
    to: mapOffset(edit.to, humanEdits, "before"),
    insert: edit.insert,
  }));
  let text = current;
  for (const edit of [...mapped].sort((left, right) => right.from - left.from || right.to - left.to)) {
    text = `${text.slice(0, edit.from)}${edit.insert}${text.slice(edit.to)}`;
  }
  return Object.freeze({ kind: "merged", text, changes: Object.freeze(mapped) });
}
