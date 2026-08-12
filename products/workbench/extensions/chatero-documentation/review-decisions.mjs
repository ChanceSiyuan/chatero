const DECISIONS = new Set(["accept", "reject", "defer"]);

function invalid(violations) {
  return Object.freeze({ kind: "invalid-decision-set", violations: Object.freeze(violations) });
}

export function validateReviewDecisions(snapshot, decisions) {
  if (!snapshot || !Array.isArray(snapshot.leaves) || !(decisions instanceof Map)) {
    return invalid(["invalid-input"]);
  }
  const expected = new Set(snapshot.leaves.map(leaf => leaf.id));
  if (expected.size !== snapshot.leaves.length) return invalid(["duplicate-snapshot-leaf"]);
  const missing = snapshot.leaves.filter(leaf => !decisions.has(leaf.id)).map(leaf => leaf.id);
  if (missing.length > 0) {
    return Object.freeze({ kind: "incomplete-decision-set", missing: Object.freeze(missing) });
  }
  const violations = [];
  for (const id of decisions.keys()) {
    if (!expected.has(id)) violations.push(`unknown:${id}`);
  }
  for (const leaf of snapshot.leaves) {
    const decision = decisions.get(leaf.id);
    if (!DECISIONS.has(decision)) {
      violations.push(`decision:${leaf.id}`);
      continue;
    }
    if (decision === "accept") {
      for (const dependency of leaf.dependsOn) {
        if (decisions.get(dependency) !== "accept") violations.push(`dependency:${leaf.id}:${dependency}`);
      }
    }
    else if (decision === "defer") {
      for (const dependency of leaf.dependsOn) {
        if (decisions.get(dependency) === "reject") violations.push(`dependency:${leaf.id}:${dependency}`);
      }
    }
  }
  if (violations.length > 0) return invalid(violations);
  return Object.freeze({ kind: "complete", decisions: new Map(decisions) });
}
