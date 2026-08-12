import { StateEffect, StateField } from "@codemirror/state";

import { collectFormalBlocks } from "./formal-block-parser.mjs";

const proofCollapseEffect = StateEffect.define();

function configuredCollapse(block) {
  return block.attributes.values.get("collapse") === "true";
}

export function proofKey(block) {
  if (!block || block.kind !== "proof" || !Number.isSafeInteger(block.opener?.from)) {
    throw new TypeError("proof block is required");
  }
  return `proof:${block.attributes.id ?? "-"}:${block.opener.from}`;
}

function keyPosition(key) {
  const separator = key.lastIndexOf(":");
  const value = Number(key.slice(separator + 1));
  if (separator < 0 || !Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid proof key");
  return Object.freeze({ prefix: key.slice(0, separator + 1), position: value });
}

const createProofCollapseEffect = proofCollapseEffect.of.bind(proofCollapseEffect);
Object.defineProperty(proofCollapseEffect, "of", {
  value(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || typeof value.proofKey !== "string" || value.proofKey.length === 0
      || typeof value.collapsed !== "boolean") {
      throw new TypeError("invalid proof collapse effect");
    }
    keyPosition(value.proofKey);
    return createProofCollapseEffect(Object.freeze({ proofKey: value.proofKey, collapsed: value.collapsed }));
  },
});

export const setProofCollapsed = proofCollapseEffect;

function proofBlocks(state) {
  return collectFormalBlocks(state, [{ from: 0, to: state.doc.length }]).filter(block => block.kind === "proof");
}

function initialProofState(state) {
  return new Map(proofBlocks(state).map(block => [proofKey(block), Object.freeze({
    collapsed: configuredCollapse(block),
    configured: configuredCollapse(block),
    touched: false,
  })]));
}

function mappedRecords(value, transaction) {
  const mapped = new Map();
  for (const [key, record] of value) {
    const parsed = keyPosition(key);
    const position = transaction.changes.mapPos(parsed.position, 1);
    mapped.set(`${parsed.prefix}${position}`, record);
  }
  const next = new Map();
  for (const block of proofBlocks(transaction.state)) {
    const key = proofKey(block);
    const previous = mapped.get(key);
    const configured = configuredCollapse(block);
    if (!previous) {
      next.set(key, Object.freeze({ collapsed: configured, configured, touched: false }));
    }
    else if (!previous.touched && previous.configured !== configured) {
      next.set(key, Object.freeze({ collapsed: configured, configured, touched: false }));
    }
    else {
      next.set(key, previous.configured === configured ? previous : Object.freeze({ ...previous, configured }));
    }
  }
  return next;
}

function validatedEffect(value, records) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || typeof value.proofKey !== "string" || value.proofKey.length === 0
    || typeof value.collapsed !== "boolean" || !records.has(value.proofKey)) {
    throw new TypeError("invalid proof collapse effect");
  }
  keyPosition(value.proofKey);
  return value;
}

const proofCollapseField = StateField.define({
  create: initialProofState,
  update(value, transaction) {
    let next = transaction.docChanged ? mappedRecords(value, transaction) : value;
    for (const effect of transaction.effects) {
      if (!effect.is(setProofCollapsed)) continue;
      const change = validatedEffect(effect.value, next);
      const current = next.get(change.proofKey);
      if (current.collapsed === change.collapsed && current.touched) continue;
      if (next === value) next = new Map(value);
      next.set(change.proofKey, Object.freeze({ ...current, collapsed: change.collapsed, touched: true }));
    }
    return next;
  },
});

export function createProofCollapseExtension() {
  return proofCollapseField;
}

export function isProofCollapsed(state, block) {
  if (!state || block?.kind !== "proof") return false;
  return state.field(proofCollapseField, false)?.get(proofKey(block))?.collapsed ?? configuredCollapse(block);
}

function selectionIntersects(range, selection) {
  return selection.ranges.some(value => value.empty
    ? range.from <= value.from && value.from < range.to
    : value.from < range.to && value.to > range.from);
}

export function isProofTemporarilyRevealed(state, block) {
  return block?.kind === "proof" && [block.attributes.range, block.label, block.body, block.closer]
    .filter(Boolean)
    .some(range => selectionIntersects(range, state.selection));
}

export function toggleProof(view, block) {
  if (!view || typeof view.dispatch !== "function" || block?.kind !== "proof") throw new TypeError("proof view and block are required");
  view.dispatch({ effects: setProofCollapsed.of({
    proofKey: proofKey(block),
    collapsed: !isProofCollapsed(view.state, block),
  }) });
}
