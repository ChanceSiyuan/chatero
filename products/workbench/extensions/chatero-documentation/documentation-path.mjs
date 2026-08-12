const pagePaths = new WeakSet();
const assetPaths = new WeakSet();
const OPERATION_KINDS = new Set(["create", "edit", "rename", "delete"]);

function normalizeDocumentationRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Documentation path must be a non-empty string");
  }
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\")) {
    throw new TypeError("Documentation path must be workspace-relative");
  }
  if (/[%:?#]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Documentation path contains URI or control characters");
  }
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("Documentation path is not normalized");
  }
  const normalized = segments.map(segment => segment.normalize("NFC")).join("/");
  if (Buffer.byteLength(normalized, "utf8") > 4096) {
    throw new TypeError("Documentation path is too long");
  }
  return normalized;
}

function createPath(kind, value, brand) {
  const path = Object.freeze({ kind, value });
  brand.add(path);
  return path;
}

function assertDocumentationPath(path) {
  if (!path || typeof path !== "object" || (!pagePaths.has(path) && !assetPaths.has(path))) {
    throw new TypeError("unrecognized Documentation path");
  }
  return path;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function caseFold(value) {
  return value.normalize("NFC").toLowerCase();
}

function operationPaths(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)
    || !OPERATION_KINDS.has(operation.kind)) {
    throw new TypeError("unknown Documentation operation kind");
  }
  if (operation.kind === "rename") {
    return [
      { path: assertDocumentationPath(operation.source), role: "source" },
      { path: assertDocumentationPath(operation.destination), role: "target" },
    ];
  }
  return [{ path: assertDocumentationPath(operation.path), role: "target" }];
}

function assertNoRenameCycle(renameEdges) {
  const destinations = new Map(renameEdges.map(edge => [edge.source, edge.destination]));
  for (const start of destinations.keys()) {
    const seen = new Set();
    let current = start;
    while (destinations.has(current)) {
      if (seen.has(current)) throw new TypeError("Documentation rename cycle is not allowed");
      seen.add(current);
      current = destinations.get(current);
    }
  }
}

export function documentationPagePath(value) {
  const normalized = normalizeDocumentationRelativePath(value);
  if (!normalized.toLowerCase().endsWith(".qmd")) {
    throw new TypeError("Documentation pages must use .qmd");
  }
  return createPath("documentation-page", normalized, pagePaths);
}

export function documentationAssetPath(value) {
  const normalized = normalizeDocumentationRelativePath(value);
  if (normalized.toLowerCase().endsWith(".qmd")) {
    throw new TypeError("QMD content must use a Documentation page path");
  }
  return createPath("documentation-asset", normalized, assetPaths);
}

export function documentationWorkspaceUri(workspaceUri, path) {
  const branded = assertDocumentationPath(path);
  if (!workspaceUri || typeof workspaceUri !== "object" || Array.isArray(workspaceUri)
    || typeof workspaceUri.scheme !== "string" || typeof workspaceUri.authority !== "string"
    || typeof workspaceUri.path !== "string" || !workspaceUri.path.startsWith("/")) {
    throw new TypeError("workspace URI is invalid");
  }
  if (workspaceUri.query || workspaceUri.fragment) {
    throw new TypeError("workspace URI must not contain a query or fragment");
  }
  if (workspaceUri.path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(workspaceUri.path)) {
    throw new TypeError("workspace URI path is invalid");
  }
  const root = workspaceUri.path === "/" ? "" : workspaceUri.path.replace(/\/+$/u, "");
  const joinedPath = `${root}/documentation/${branded.value}`;
  const candidate = typeof workspaceUri.with === "function"
    ? workspaceUri.with({ path: joinedPath, query: "", fragment: "" })
    : {
        scheme: workspaceUri.scheme,
        authority: workspaceUri.authority,
        path: joinedPath,
        query: "",
        fragment: "",
      };
  if (!candidate || candidate.scheme !== workspaceUri.scheme
    || candidate.authority !== workspaceUri.authority || candidate.path !== joinedPath
    || candidate.query || candidate.fragment) {
    throw new TypeError("workspace URI authority changed during resolution");
  }
  return Object.freeze(candidate);
}

export function validateOperationPathSet(operations) {
  if (!Array.isArray(operations)) throw new TypeError("Documentation operations must be an array");
  const occurrences = new Map();
  const aliases = new Map();
  const targets = new Set();
  const renameEdges = [];
  for (const operation of operations) {
    const paths = operationPaths(operation);
    if (operation.kind === "rename") {
      renameEdges.push({ source: paths[0].path.value, destination: paths[1].path.value });
    }
    for (const { path, role } of paths) {
      const folded = caseFold(path.value);
      const existingAlias = aliases.get(folded);
      if (existingAlias !== undefined && existingAlias !== path.value) {
        throw new TypeError("Documentation path set contains a case-fold alias");
      }
      aliases.set(folded, path.value);
      const records = occurrences.get(path.value) ?? [];
      records.push({ operation, role });
      occurrences.set(path.value, records);
      if (role === "target") {
        if (targets.has(path.value)) throw new TypeError("Documentation operation set has a duplicate target");
        targets.add(path.value);
      }
    }
  }

  const values = [...occurrences.keys()].sort(compareUtf8);
  for (let index = 0; index < values.length; index++) {
    for (let candidate = index + 1; candidate < values.length; candidate++) {
      if (values[candidate].startsWith(`${values[index]}/`)) {
        throw new TypeError("Documentation operation paths have a file-ancestor collision");
      }
    }
  }
  assertNoRenameCycle(renameEdges);
  for (const records of occurrences.values()) {
    if (records.length > 1) {
      throw new TypeError("Documentation operation source and destination paths overlap");
    }
  }
  return Object.freeze([...operations]);
}
