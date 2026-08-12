import { createHash } from "node:crypto";

const CONTEXT_LINES = 3;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactLines(text) {
  const lines = [];
  const expression = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu;
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    if (!match[0]) continue;
    lines.push(Object.freeze({ text: match[0], start: offset, end: offset + match[0].length }));
    offset += match[0].length;
  }
  if (offset !== text.length) throw new TypeError("QMD line splitting did not preserve the source");
  return lines;
}

function mapValue(map, key) {
  return map.has(key) ? map.get(key) : Number.NEGATIVE_INFINITY;
}

function noCommonLines(before, after) {
  if (before.length === 0 || after.length === 0) return true;
  const smaller = before.length <= after.length ? before : after;
  const larger = before.length <= after.length ? after : before;
  const values = new Set(smaller.map(line => line.text));
  return !larger.some(line => values.has(line.text));
}

function myersLineOperations(before, after) {
  if (before.length === 0) return after.map(line => ({ kind: "insert", text: line.text }));
  if (after.length === 0) return before.map(line => ({ kind: "delete", text: line.text }));
  if (noCommonLines(before, after)) {
    return [
      ...before.map(line => ({ kind: "delete", text: line.text })),
      ...after.map(line => ({ kind: "insert", text: line.text })),
    ];
  }

  const maximum = before.length + after.length;
  let frontier = new Map([[1, 0]]);
  const trace = [];
  for (let distance = 0; distance <= maximum; distance++) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const insertion = diagonal === -distance
        || (diagonal !== distance && mapValue(frontier, diagonal - 1) < mapValue(frontier, diagonal + 1));
      let x = insertion ? mapValue(frontier, diagonal + 1) : mapValue(frontier, diagonal - 1) + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x].text === after[y].text) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        trace.push(next);
        const reversed = [];
        let currentX = before.length;
        let currentY = after.length;
        for (let step = trace.length - 1; step > 0; step--) {
          const previous = trace[step - 1];
          const currentDiagonal = currentX - currentY;
          const cameFromInsertion = currentDiagonal === -step
            || (currentDiagonal !== step
              && mapValue(previous, currentDiagonal - 1) < mapValue(previous, currentDiagonal + 1));
          const previousDiagonal = cameFromInsertion ? currentDiagonal + 1 : currentDiagonal - 1;
          const previousX = Math.max(0, mapValue(previous, previousDiagonal));
          const previousY = previousX - previousDiagonal;
          while (currentX > previousX && currentY > previousY) {
            reversed.push({ kind: "equal", text: before[currentX - 1].text });
            currentX -= 1;
            currentY -= 1;
          }
          if (cameFromInsertion) {
            reversed.push({ kind: "insert", text: after[currentY - 1].text });
            currentY -= 1;
          }
          else {
            reversed.push({ kind: "delete", text: before[currentX - 1].text });
            currentX -= 1;
          }
        }
        while (currentX > 0 && currentY > 0) {
          reversed.push({ kind: "equal", text: before[currentX - 1].text });
          currentX -= 1;
          currentY -= 1;
        }
        while (currentX > 0) reversed.push({ kind: "delete", text: before[--currentX].text });
        while (currentY > 0) reversed.push({ kind: "insert", text: after[--currentY].text });
        return reversed.reverse();
      }
    }
    trace.push(next);
    frontier = next;
  }
  throw new Error("line diff did not converge");
}

function annotateOffsets(operations) {
  let beforeOffset = 0;
  let afterOffset = 0;
  return operations.map(operation => {
    const record = {
      ...operation,
      beforeStart: beforeOffset,
      afterStart: afterOffset,
    };
    if (operation.kind !== "insert") beforeOffset += operation.text.length;
    if (operation.kind !== "delete") afterOffset += operation.text.length;
    record.beforeEnd = beforeOffset;
    record.afterEnd = afterOffset;
    return Object.freeze(record);
  });
}

function changedGroups(operations) {
  const groups = [];
  let index = 0;
  while (index < operations.length) {
    while (index < operations.length && operations[index].kind === "equal") index += 1;
    if (index >= operations.length) break;
    const start = index;
    let lastChange = index;
    let equalRun = 0;
    while (index < operations.length) {
      if (operations[index].kind === "equal") {
        equalRun += 1;
        if (equalRun > CONTEXT_LINES) break;
      }
      else {
        equalRun = 0;
        lastChange = index;
      }
      index += 1;
    }
    groups.push(Object.freeze({ start, end: lastChange + 1 }));
    index = lastChange + 1;
  }
  return groups;
}

function contextText(operations, from, direction) {
  const values = [];
  let index = from;
  while (index >= 0 && index < operations.length && values.length < CONTEXT_LINES) {
    const operation = operations[index];
    if (operation.kind !== "equal") break;
    if (direction < 0) values.unshift(operation.text);
    else values.push(operation.text);
    index += direction;
  }
  return values.join("");
}

function stableHunkId(record) {
  const fields = [
    "chatero-stable-hunk-v1",
    record.operationId,
    record.beforeText,
    record.afterText,
    record.contextBefore,
    record.contextAfter,
  ];
  const encoded = fields.map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `hunk-${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function dependencies(values) {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("stable hunk dependencies are invalid");
  }
  const result = [...new Set(values)].sort(compareUtf8Bytes);
  if (result.length !== values.length) throw new TypeError("stable hunk dependencies contain duplicates");
  return Object.freeze(result);
}

export function deriveStableHunks({ operationId, baseText, proposedText, dependsOn } = {}) {
  if (typeof operationId !== "string" || operationId.length === 0
    || Buffer.byteLength(operationId, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(operationId)
    || typeof baseText !== "string" || typeof proposedText !== "string") {
    throw new TypeError("stable hunk input is invalid");
  }
  if (baseText === proposedText) return Object.freeze([]);
  const before = exactLines(baseText);
  const after = exactLines(proposedText);
  const operations = annotateOffsets(myersLineOperations(before, after));
  const boundDependencies = dependencies(dependsOn);
  const hunks = changedGroups(operations).map(({ start, end }) => {
    const members = operations.slice(start, end);
    const record = {
      operationId,
      beforeStart: members[0].beforeStart,
      beforeEnd: members.at(-1).beforeEnd,
      afterStart: members[0].afterStart,
      afterEnd: members.at(-1).afterEnd,
      beforeText: members.filter(value => value.kind !== "insert").map(value => value.text).join(""),
      afterText: members.filter(value => value.kind !== "delete").map(value => value.text).join(""),
      contextBefore: contextText(operations, start - 1, -1),
      contextAfter: contextText(operations, end, 1),
      dependsOn: boundDependencies,
    };
    return Object.freeze({ id: stableHunkId(record), ...record });
  });
  return Object.freeze(hunks);
}
