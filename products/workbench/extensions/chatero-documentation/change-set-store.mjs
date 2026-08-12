import {
  changeSetGenerationPaths,
  parseChangeSetGeneration,
  serializeChangeSetGeneration,
} from "./change-set-model.mjs";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function publicRef(value) {
  if (!value || typeof value !== "object") throw new TypeError("Change Set reference is invalid");
  return Object.freeze({ lineageId: value.lineageId, generationId: value.generationId });
}

function validateBuilt(value) {
  if (!value || typeof value !== "object" || value.kind === "invalid-proposal"
    || !value.generation || !Array.isArray(value.outputs)) {
    throw new TypeError("built Change Set generation is invalid");
  }
  const manifest = serializeChangeSetGeneration(value.generation);
  const paths = changeSetGenerationPaths(value.generation.ref);
  const output = value.outputs.find(candidate => candidate.path === paths.manifest);
  if (!output || !Buffer.from(output.bytes).equals(manifest)) {
    throw new TypeError("built Change Set manifest does not match its generation");
  }
  return value;
}

export function createChangeSetStore({ adapter, scope } = {}) {
  if (!adapter || typeof adapter.snapshot !== "function" || typeof adapter.transact !== "function" || !scope) {
    throw new TypeError("Change Set store dependencies are invalid");
  }

  const stageGeneration = async value => {
    const built = validateBuilt(value);
    const ref = publicRef(built.generation.ref);
    const result = await adapter.transact(Object.freeze({
      kind: "stage-generation",
      schemaVersion: 1,
      ref,
      ...(built.generation.parentRef ? { parentRef: publicRef(built.generation.parentRef) } : {}),
      generationDigest: built.generation.generationDigest,
      outputs: Object.freeze(built.outputs.map(output => Object.freeze({
        path: output.path,
        size: output.bytes.byteLength,
        sha256: output.sha256,
        bytes: base64url(output.bytes),
      }))),
    }));
    if (result?.kind === "stale-generation") return Object.freeze({ kind: result.kind, currentRef: result.currentRef ?? null });
    if (result?.kind !== "generation-staged"
      || result.generationDigest !== built.generation.generationDigest
      || result.ref?.lineageId !== ref.lineageId || result.ref?.generationId !== ref.generationId
      || typeof result.reused !== "boolean") {
      throw new TypeError("authority returned an invalid staged generation result");
    }
    return Object.freeze({ kind: result.kind, ref, generationDigest: result.generationDigest, reused: result.reused });
  };

  const loadGeneration = async reference => {
    const ref = publicRef(reference);
    const paths = changeSetGenerationPaths(ref);
    const result = await adapter.snapshot(Object.freeze({ kind: "load-generation", ref }));
    if (result?.kind === "generation-missing") return Object.freeze({ kind: result.kind, ref });
    if (result?.kind !== "generation-snapshot" || !Array.isArray(result.outputs)) {
      throw new TypeError("authority returned an invalid generation snapshot");
    }
    const outputs = new Map();
    for (const output of result.outputs) {
      if (!output || typeof output.path !== "string" || typeof output.bytes !== "string"
        || !/^[A-Za-z0-9_-]*$/u.test(output.bytes)) throw new TypeError("generation snapshot output is invalid");
      const bytes = Buffer.from(output.bytes, "base64url");
      if (bytes.toString("base64url") !== output.bytes) throw new TypeError("generation snapshot bytes are not canonical");
      outputs.set(output.path, bytes);
    }
    const manifestBytes = outputs.get(paths.manifest);
    const generation = await parseChangeSetGeneration({
      manifestBytes,
      readBlob: async path => outputs.get(path),
    });
    if (generation.kind === "invalid-proposal") throw new TypeError("stored Change Set generation is invalid");
    return generation;
  };

  const loadCurrentRef = async lineageId => {
    const result = await adapter.snapshot(Object.freeze({ kind: "current-generation", lineageId }));
    if (result?.kind === "current-generation-missing") return Object.freeze({ kind: result.kind, lineageId });
    if (result?.kind !== "current-generation") throw new TypeError("authority returned an invalid current generation");
    const ref = publicRef(result.ref);
    changeSetGenerationPaths(ref);
    if (ref.lineageId !== lineageId || typeof result.generationDigest !== "string") {
      throw new TypeError("current generation identity does not match");
    }
    return Object.freeze({ kind: result.kind, ref, generationDigest: result.generationDigest });
  };

  return Object.freeze({ stageGeneration, loadGeneration, loadCurrentRef });
}
