const TTL_SECONDS = 86400;

function assertDependencies(value) {
  for (const field of ["captureActive", "getRemoteContext", "openSource", "confirm", "notify"]) {
    if (typeof value?.[field] !== "function") throw new TypeError(`full-paper transfer ${field} is required`);
  }
  if (!value.grants || typeof value.grants.issue !== "function" || typeof value.grants.revoke !== "function") {
    throw new TypeError("full-paper transfer grant registry is required");
  }
}

export function createFullPaperTransfer(dependencies) {
  assertDependencies(dependencies);
  return async function transferFullPaper() {
    const snapshot = dependencies.captureActive();
    const remote = await dependencies.getRemoteContext();
    if (!remote) throw new Error("Open a Chatero SSH workspace before sending a full paper");
    const source = await dependencies.openSource(Object.freeze({
      attachmentKey: snapshot.attachmentKey,
      contentType: "application/pdf",
      libraryId: snapshot.libraryId,
    }));
    let granted = false;
    let registryOwnsSource = false;
    let grantId;
    try {
      const confirmed = await dependencies.confirm(Object.freeze({
        alias: remote.alias,
        size: source.size,
        title: snapshot.title,
        ttlSeconds: TTL_SECONDS,
      }));
      if (!confirmed) {
        await source.close();
        return null;
      }
      registryOwnsSource = true;
      grantId = dependencies.grants.issue({
        source,
        targetId: remote.targetId,
        hostFingerprint: remote.hostFingerprint,
      });
      granted = true;
      const result = await remote.stageEvidence({
        grantId,
        targetId: remote.targetId,
        ttlSeconds: TTL_SECONDS,
      });
      dependencies.notify(Object.freeze({ alias: remote.alias, expiresAt: result.expiresAt }));
      return result;
    }
    catch (error) {
      if (granted) await dependencies.grants.revoke(grantId).catch(() => {});
      else if (!registryOwnsSource) await source.close().catch(() => {});
      throw error;
    }
  };
}

export const FULL_PAPER_TTL_SECONDS = TTL_SECONDS;
