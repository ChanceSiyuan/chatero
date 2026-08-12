import { createHash } from "node:crypto";

import { documentationPagePath } from "./documentation-path.mjs";
import { settlementTextProofDigest } from "./settlement-protocol.mjs";
import { withChangeContext } from "./text-change-set.mjs";

function textDigest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function uriKey(value) {
  if (!value || typeof value.toString !== "function") throw new TypeError("recovery URI is invalid");
  return value.toString();
}

function validateInspection(value) {
  if (value?.kind === "no-active-settlement" || value?.kind === "documentation-tamper"
    || value?.kind === "recovery-conflict" || value?.kind === "settlement-committed") return value;
  if (!value || value.kind !== "awaiting-text" || typeof value.operationId !== "string"
    || typeof value.operationDigest !== "string" || typeof value.affectedResourceDigest !== "string"
    || !Array.isArray(value.textOverlay)) throw new TypeError("settlement inspection is invalid");
  return value;
}

function classify(document, overlay) {
  const text = document.getText();
  const observedDigest = textDigest(text);
  const classification = observedDigest === overlay.beforeDigest ? "before"
    : observedDigest === overlay.intendedDigest ? "intended" : "unknown";
  return Object.freeze({
    overlay,
    document,
    uri: document.uri,
    observedText: text,
    observedDigest,
    observedVersion: document.version,
    classification,
  });
}

function conflictResult(inspected, classified) {
  return Object.freeze({
    kind: "recovery-conflict",
    operationId: inspected.operationId,
    operationDigest: inspected.operationDigest,
    evidenceRef: `documentation-operation:${inspected.operationId}`,
    resources: Object.freeze(classified.map(value => Object.freeze({
      path: value.overlay.path,
      classification: value.classification,
      observedDigest: value.observedDigest,
      beforeDigest: value.overlay.beforeDigest,
      intendedDigest: value.overlay.intendedDigest,
    }))),
  });
}

function recoveryProof(inspected, classified, versions) {
  const applied = new Map((versions ?? []).map(value => [uriKey(value.uri), value]));
  const resources = classified.map(value => {
    const version = applied.get(uriKey(value.uri));
    if (value.classification === "before") {
      if (!version || version.before !== value.observedVersion || version.after !== value.observedVersion + 1) {
        throw new TypeError("settlement recovery version proof is invalid");
      }
      return Object.freeze({
        uri: uriKey(value.uri),
        action: "apply-intended",
        observedVersion: value.observedVersion,
        afterVersion: version.after,
        observedDigest: value.observedDigest,
        intendedDigest: value.overlay.intendedDigest,
      });
    }
    return Object.freeze({
      uri: uriKey(value.uri),
      action: "already-intended",
      observedVersion: value.observedVersion,
      afterVersion: value.observedVersion,
      observedDigest: value.observedDigest,
      intendedDigest: value.overlay.intendedDigest,
    });
  });
  const identity = Object.freeze({
    kind: "settlement-recovery-text-proof",
    operationId: inspected.operationId,
    operationDigest: inspected.operationDigest,
    resources: Object.freeze(resources),
  });
  return Object.freeze({ ...identity, proofDigest: settlementTextProofDigest(identity) });
}

export async function recoverSettlement({
  adapter, barrier, coordinator, uriFor, openDocuments,
} = {}) {
  if (typeof adapter?.recover !== "function" || typeof adapter?.transact !== "function"
    || typeof barrier?.acquire !== "function" || typeof coordinator?.applyVersionedTextEdits !== "function"
    || typeof uriFor !== "function" || typeof openDocuments !== "function") {
    throw new TypeError("settlement recovery dependencies are invalid");
  }
  const inspected = validateInspection(await adapter.recover(Object.freeze({
    kind: "inspect-settlement",
    schemaVersion: 1,
  })));
  if (inspected.kind !== "awaiting-text") return inspected;
  const paths = inspected.textOverlay.map(value => documentationPagePath(value.path));
  const documents = await openDocuments(paths);
  if (!Array.isArray(documents) || documents.length !== paths.length) {
    throw new TypeError("settlement recovery working copies are unavailable");
  }
  const byUri = new Map(documents.map(document => [uriKey(document.uri), document]));
  const classified = inspected.textOverlay.map(overlay => {
    const uri = uriFor(documentationPagePath(overlay.path));
    const document = byUri.get(uriKey(uri));
    if (!document || !Number.isSafeInteger(document.version) || typeof document.getText !== "function") {
      throw new TypeError("settlement recovery TextDocument is invalid");
    }
    return classify(document, overlay);
  });
  const resources = Object.freeze(classified.map(value => Object.freeze({
    uri: value.uri,
    expectedVersion: value.observedVersion,
    expectedDigest: value.observedDigest,
    intendedDigest: value.overlay.intendedDigest,
    requireClean: false,
  })));
  const acquired = await barrier.acquire(Object.freeze({
    operationId: inspected.operationId,
    resources,
    reason: "recovery",
  }));
  if (acquired?.kind === "dirty-working-copy" || acquired?.kind === "barrier-conflict") return acquired;
  if (!acquired || typeof acquired.revalidate !== "function" || typeof acquired.dispose !== "function") {
    throw new TypeError("settlement recovery barrier lease is invalid");
  }
  const lease = acquired;
  const valid = await lease.revalidate();
  if (valid?.kind !== "valid") {
    lease.dispose();
    return valid;
  }
  if (classified.some(value => value.classification === "unknown")) {
    return conflictResult(inspected, classified);
  }
  const before = classified.filter(value => value.classification === "before");
  let versions = [];
  if (before.length > 0) {
    const applied = await coordinator.applyVersionedTextEdits(Object.freeze({
      operationId: inspected.operationId,
      origin: "settlement",
      edits: Object.freeze(before.map(value => Object.freeze({
        uri: value.uri,
        baseVersion: value.observedVersion,
        changes: withChangeContext(value.observedText, [{
          from: 0,
          to: value.observedText.length,
          insert: value.overlay.intendedText,
        }]),
      }))),
      applyWorkspaceEdit: edit => lease.applyWorkspaceEdit(edit),
    }));
    if (applied.kind !== "applied") return conflictResult(inspected, classified);
    versions = applied.versions;
  }
  const textProof = recoveryProof(inspected, classified, versions);
  const result = await adapter.transact(Object.freeze({
    kind: "ack-settlement-text",
    schemaVersion: 1,
    operationId: inspected.operationId,
    operationDigest: inspected.operationDigest,
    affectedResourceDigest: inspected.affectedResourceDigest,
    textProof,
  }));
  if (result?.kind === "settlement-committed") lease.dispose();
  return result;
}
