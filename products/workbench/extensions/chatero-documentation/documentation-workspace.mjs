import { createHash, randomUUID } from "node:crypto";

import {
  decodeAuthorityResponse,
  encodeAuthorityRequest,
} from "./runtime/protocol.mjs";
import { documentationWorkspaceUri } from "./documentation-path.mjs";

function uriString(uri) {
  if (!uri || typeof uri.toString !== "function") throw new TypeError("workspace URI is invalid");
  return uri.toString(true);
}

function canonicalUri(uri) {
  try {
    return new URL(typeof uri === "string" ? uri : uriString(uri));
  }
  catch {
    throw new TypeError("workspace URI is invalid");
  }
}

function sameUri(left, right) {
  const a = canonicalUri(left);
  const b = canonicalUri(right);
  return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
    && !a.search && !a.hash && !b.search && !b.hash;
}

function withinUri(root, candidate) {
  const base = canonicalUri(root);
  const value = canonicalUri(candidate);
  const prefix = base.pathname === "/" ? "/" : `${base.pathname.replace(/\/+$/u, "")}/`;
  return base.protocol === value.protocol && base.host === value.host
    && (value.pathname === base.pathname || value.pathname.startsWith(prefix));
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function currentValues(source) {
  const values = typeof source === "function" ? source() : source;
  return Array.isArray(values) ? values : [];
}

function validateScopeRecord(scope) {
  if (!scope || typeof scope !== "object"
    || typeof scope.uri !== "string" || typeof scope.authority !== "string"
    || typeof scope.epoch !== "string" || typeof scope.workspaceScopeDigest !== "string") {
    throw new TypeError("workspace scope is invalid");
  }
  return scope;
}

function overlayForDocument(document) {
  if (!document || typeof document !== "object" || !Number.isSafeInteger(document.version)
    || typeof document.isDirty !== "boolean" || typeof document.getText !== "function") {
    throw new TypeError("TextDocument overlay is invalid");
  }
  const text = document.getText();
  if (typeof text !== "string") throw new TypeError("TextDocument text is invalid");
  return Object.freeze({
    uri: uriString(document.uri),
    version: document.version,
    dirty: document.isDirty,
    text,
    revision: `text-document:${document.version}:sha256:${sha256Utf8(text)}`,
  });
}

function overlayProof(overlay) {
  return Object.freeze({
    uri: overlay.uri,
    version: overlay.version,
    dirty: overlay.dirty,
    revision: overlay.revision,
  });
}

export function createDocumentationWorkspaceView({ workspaceFolders, textDocuments }) {
  const findFolder = scope => {
    validateScopeRecord(scope);
    const folder = currentValues(workspaceFolders).find(value => value?.uri && sameUri(value.uri, scope.uri));
    if (!folder) throw new TypeError("workspace scope is unavailable");
    const uri = canonicalUri(folder.uri);
    const expectedAuthority = uri.protocol === "file:" ? "local" : uri.host;
    if (expectedAuthority !== scope.authority) throw new TypeError("workspace scope authority changed");
    if (folder.epoch !== undefined && folder.epoch !== scope.epoch) {
      throw new TypeError("workspace epoch changed");
    }
    return folder;
  };

  const capture = (scope, paths) => {
    const folder = findFolder(scope);
    const allDocuments = currentValues(textDocuments).filter(document => document?.uri && withinUri(folder.uri, document.uri));
    let targets;
    let mode;
    if (paths === null) {
      mode = "workspace";
      targets = allDocuments.map(document => document.uri);
    }
    else {
      if (!Array.isArray(paths)) throw new TypeError("Documentation paths must be an array");
      mode = "paths";
      targets = paths.map(path => documentationWorkspaceUri(folder.uri, path));
    }
    const targetStrings = targets.map(uriString);
    const overlays = [];
    const proofs = [];
    for (const target of targetStrings) {
      const document = allDocuments.find(value => sameUri(value.uri, target));
      const overlay = document ? overlayForDocument(document) : null;
      if (overlay) overlays.push(overlay);
      proofs.push(overlay ? overlayProof(overlay) : Object.freeze({ uri: target, absent: true }));
    }
    if (mode === "workspace") {
      overlays.sort((left, right) => Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)));
      proofs.sort((left, right) => Buffer.compare(Buffer.from(left.uri), Buffer.from(right.uri)));
      targetStrings.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    }
    return Object.freeze({
      scope,
      mode,
      paths: paths === null ? null : Object.freeze([...paths]),
      folderUri: uriString(folder.uri),
      folderEpoch: folder.epoch,
      targetUris: Object.freeze(targetStrings),
      overlays: Object.freeze(overlays),
      proofs: Object.freeze(proofs),
    });
  };

  const revalidate = evidence => {
    const next = capture(evidence.scope, evidence.paths);
    if (next.folderUri !== evidence.folderUri || next.folderEpoch !== evidence.folderEpoch) {
      throw new TypeError("workspace epoch changed");
    }
    if (JSON.stringify(next.proofs) !== JSON.stringify(evidence.proofs)) {
      throw new TypeError("Documentation working copy changed during authority request");
    }
    return true;
  };

  return Object.freeze({ capture, revalidate });
}

function exactPublicRequest(request, kind) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.kind !== kind) {
    throw new TypeError(`${kind} request is invalid`);
  }
  return request;
}

export function createWorkspaceTransactionAdapter({ scope, transport, workspaceView }) {
  validateScopeRecord(scope);
  if (!transport || typeof transport.request !== "function"
    || !workspaceView || typeof workspaceView.capture !== "function"
    || typeof workspaceView.revalidate !== "function") {
    throw new TypeError("workspace transaction adapter dependencies are invalid");
  }

  const invoke = async (kind, payloadName, payload, evidence) => {
    const requestId = randomUUID();
    const frame = encodeAuthorityRequest({
      protocolVersion: 1,
      requestId,
      kind,
      workspace: scope.uri,
      epoch: scope.epoch,
      [payloadName]: payload,
    });
    const response = decodeAuthorityResponse(await transport.request(frame));
    if (response.requestId !== requestId) throw new TypeError("authority response request id does not match");
    const resultEpoch = response.result.epoch ?? response.result.workspaceEpoch;
    if (resultEpoch !== undefined && resultEpoch !== scope.epoch) {
      throw new TypeError("authority response workspace epoch does not match");
    }
    workspaceView.revalidate(evidence);
    return response.result;
  };

  const snapshot = async request => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("snapshot request is invalid");
    }
    if (request.kind === "paths") {
      if (Object.keys(request).some(key => !new Set(["kind", "paths"]).has(key)) || !Array.isArray(request.paths)) {
        throw new TypeError("path snapshot request has unknown field");
      }
      const evidence = workspaceView.capture(scope, request.paths);
      return invoke("snapshot", "snapshot", {
        kind: "paths",
        paths: request.paths.map(path => `documentation/${path.value}`),
        overlays: evidence.overlays,
      }, evidence);
    }
    if (request.kind === "plan-migration") {
      if (Object.keys(request).some(key => !new Set(["kind", "limits"]).has(key))) {
        throw new TypeError("migration snapshot request has unknown field");
      }
      const evidence = workspaceView.capture(scope, null);
      return invoke("snapshot", "snapshot", {
        kind: "plan-migration",
        limits: request.limits,
        overlays: evidence.overlays,
      }, evidence);
    }
    if (request.kind === "documentation-state") {
      if (Object.keys(request).some(key => !new Set(["kind", "workspaceScopeDigest"]).has(key))
        || request.workspaceScopeDigest !== scope.workspaceScopeDigest) {
        throw new TypeError("Documentation state snapshot scope does not match");
      }
      const evidence = workspaceView.capture(scope, null);
      return invoke("snapshot", "snapshot", {
        kind: "documentation-state",
        overlays: evidence.overlays,
      }, evidence);
    }
    throw new TypeError("snapshot request kind is unsupported");
  };

  const transact = async request => {
    const payload = exactPublicRequest(request, request?.kind);
    if (request.workspaceScopeDigest !== undefined
      && request.workspaceScopeDigest !== scope.workspaceScopeDigest) {
      throw new TypeError("transaction workspace scope does not match");
    }
    if (request.workspaceEpoch !== undefined && request.workspaceEpoch !== scope.epoch) {
      throw new TypeError("transaction workspace epoch does not match");
    }
    const evidence = workspaceView.capture(scope, []);
    return invoke("transact", "transaction", payload, evidence);
  };

  const recover = async request => {
    const payload = exactPublicRequest(request, request?.kind);
    if (request.workspaceScopeDigest !== undefined
      && request.workspaceScopeDigest !== scope.workspaceScopeDigest) {
      throw new TypeError("recovery workspace scope does not match");
    }
    if (request.workspaceEpoch !== undefined && request.workspaceEpoch !== scope.epoch) {
      throw new TypeError("recovery workspace epoch does not match");
    }
    const evidence = workspaceView.capture(scope, []);
    return invoke("recover", "recovery", payload, evidence);
  };

  return Object.freeze({ snapshot, transact, recover });
}
