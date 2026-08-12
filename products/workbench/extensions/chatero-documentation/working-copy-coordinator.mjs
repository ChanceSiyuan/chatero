import {
  applyOffsetChanges,
  digestOffsetChanges,
  digestSourceText,
  toWorkspaceTextEdits,
  validateOffsetChanges,
  withChangeContext,
} from "./text-change-set.mjs";

const ORIGINS = new Set(["live-preview", "human-apply", "settlement"]);

function freezeRecords(records) {
  return Object.freeze(records.map(record => Object.freeze(record)));
}

function uriKey(uri) {
  if (!uri || typeof uri.toString !== "function") throw new TypeError("working-copy URI must expose toString()");
  const key = uri.toString();
  if (typeof key !== "string" || key.length === 0) throw new TypeError("working-copy URI string must not be empty");
  return key;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("working-copy input must be an object");
  if (typeof input.operationId !== "string" || input.operationId.length === 0) {
    throw new TypeError("working-copy operationId must not be empty");
  }
  if (!ORIGINS.has(input.origin)) throw new TypeError("working-copy origin is unsupported");
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new TypeError("working-copy edits must not be empty");
  if (input.applyWorkspaceEdit !== undefined && typeof input.applyWorkspaceEdit !== "function") {
    throw new TypeError("working-copy applyWorkspaceEdit must be a function");
  }
  return Object.freeze({
    operationId: input.operationId,
    origin: input.origin,
    ...(input.applyWorkspaceEdit ? { applyWorkspaceEdit: input.applyWorkspaceEdit } : {}),
    edits: Object.freeze(input.edits.map((edit, index) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new TypeError(`working-copy edit ${index} must be an object`);
      uriKey(edit.uri);
      if (!Number.isSafeInteger(edit.baseVersion) || edit.baseVersion < 0) {
        throw new TypeError(`working-copy edit ${index} baseVersion must be a non-negative safe integer`);
      }
      if (!Array.isArray(edit.changes)) throw new TypeError(`working-copy edit ${index} changes must be an array`);
      return Object.freeze({
        uri: edit.uri,
        baseVersion: edit.baseVersion,
        changes: Object.freeze(edit.changes.map(change => Object.freeze({ ...change }))),
      });
    })),
  });
}

function authoritativeDocument(workspace, key, fallback) {
  if (!Array.isArray(workspace.textDocuments)) return fallback;
  return workspace.textDocuments.find(document => uriKey(document.uri) === key) ?? fallback;
}

function conflictResult(workspace, input, recordsByKey) {
  const documents = [];
  for (const edit of input.edits) {
    const key = uriKey(edit.uri);
    const record = recordsByKey?.get(key);
    const document = authoritativeDocument(workspace, key, record?.document);
    if (!document) throw new Error(`authoritative working copy disappeared: ${key}`);
    const text = document.getText();
    if (!record || document.version !== record.beforeVersion || text !== record.source) {
      documents.push(Object.freeze({
        uri: edit.uri,
        expectedVersion: edit.baseVersion,
        actualVersion: document.version,
        text,
      }));
    }
  }
  return Object.freeze({
    kind: "version-conflict",
    operationId: input.operationId,
    documents: Object.freeze(documents),
  });
}

function initialVersionConflicts(input, documents) {
  const conflicts = [];
  for (const edit of input.edits) {
    const document = documents.get(uriKey(edit.uri));
    if (document.version !== edit.baseVersion) {
      conflicts.push(Object.freeze({
        uri: edit.uri,
        expectedVersion: edit.baseVersion,
        actualVersion: document.version,
        text: document.getText(),
      }));
    }
  }
  return conflicts;
}

function createEventTracker(workspace, records) {
  const expected = new Map(records.map(record => [record.key, record]));
  const matched = new Set();
  let settled = false;
  let settle;
  const outcome = new Promise(resolve => { settle = resolve; });
  let eventTail = Promise.resolve();

  function finish(value) {
    if (settled) return;
    settled = true;
    settle(value);
  }

  async function inspect(snapshot) {
    if (settled) return;
    const record = expected.get(snapshot.key);
    if (!record) return;
    try {
      if (matched.has(snapshot.key) || snapshot.afterVersion !== record.beforeVersion + 1) {
        finish(Object.freeze({ kind: "conflict" }));
        return;
      }
      const sourceChanges = [...snapshot.contentChanges]
        .map(change => ({
          from: change.rangeOffset,
          to: change.rangeOffset + change.rangeLength,
          insert: change.text,
        }))
        .sort((left, right) => left.from - right.from || left.to - right.to);
      const contextual = withChangeContext(record.source, sourceChanges);
      const [changeDigest, resultDigest] = await Promise.all([
        digestOffsetChanges(contextual),
        digestSourceText(snapshot.text),
      ]);
      if (changeDigest !== record.changeDigest || resultDigest !== record.resultDigest) {
        finish(Object.freeze({ kind: "conflict" }));
        return;
      }
      matched.add(snapshot.key);
      if (matched.size === expected.size) finish(Object.freeze({ kind: "matched" }));
    }
    catch {
      finish(Object.freeze({ kind: "conflict" }));
    }
  }

  const subscription = workspace.onDidChangeTextDocument(event => {
    const key = uriKey(event.document.uri);
    if (!expected.has(key) || settled) return;
    const snapshot = Object.freeze({
      key,
      afterVersion: event.document.version,
      text: event.document.getText(),
      contentChanges: Object.freeze(Array.from(event.contentChanges ?? [], change => Object.freeze({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      }))),
    });
    eventTail = eventTail.then(() => inspect(snapshot));
  });

  return Object.freeze({
    outcome,
    dispose() {
      subscription.dispose();
    },
  });
}

export function createWorkingCopyCoordinator({ workspace, WorkspaceEdit, Position, Range }) {
  if (!workspace || typeof workspace.openTextDocument !== "function"
    || typeof workspace.applyEdit !== "function"
    || typeof workspace.onDidChangeTextDocument !== "function") {
    throw new TypeError("workspace must expose TextDocument and WorkspaceEdit APIs");
  }
  if (typeof WorkspaceEdit !== "function" || typeof Position !== "function" || typeof Range !== "function") {
    throw new TypeError("WorkspaceEdit, Position, and Range constructors are required");
  }
  const queues = new Map();
  let disposed = false;

  function assertActive() {
    if (disposed) throw new Error("WorkingCopyCoordinator is disposed");
  }

  function enqueue(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.catch(() => {});
    queues.set(key, tail);
    const cleanup = () => {
      if (queues.get(key) === tail) queues.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async function withUris(uris, task) {
    assertActive();
    if (!Array.isArray(uris)) throw new TypeError("working-copy URIs must be an array");
    if (typeof task !== "function") throw new TypeError("working-copy task must be a function");
    const byKey = new Map();
    for (const value of uris) {
      const key = uriKey(value);
      if (byKey.has(key)) throw new Error(`duplicate URI in working-copy request: ${key}`);
      byKey.set(key, value);
    }
    const entries = [...byKey].sort(([left], [right]) => compareStrings(left, right));

    async function acquire(index) {
      assertActive();
      if (index < entries.length) {
        return enqueue(entries[index][0], () => acquire(index + 1));
      }
      const documents = new Map();
      for (const [key, value] of entries) {
        documents.set(key, await workspace.openTextDocument(value));
      }
      assertActive();
      return task(documents);
    }

    return acquire(0);
  }

  async function applyVersionedTextEdits(rawInput) {
    assertActive();
    const input = snapshotInput(rawInput);
    return withUris(input.edits.map(edit => edit.uri), async documents => {
      const stale = initialVersionConflicts(input, documents);
      if (stale.length > 0) {
        return Object.freeze({
          kind: "version-conflict",
          operationId: input.operationId,
          documents: Object.freeze(stale),
        });
      }

      const records = [];
      for (const edit of input.edits) {
        const key = uriKey(edit.uri);
        const document = documents.get(key);
        const source = document.getText();
        const changes = validateOffsetChanges(source, edit.changes);
        const expectedEventChanges = withChangeContext(source, changes.map(change => ({
          from: change.from,
          to: change.to,
          insert: change.insert,
        })));
        const resultText = applyOffsetChanges(source, changes);
        const [sourceDigest, changeDigest, resultDigest] = await Promise.all([
          digestSourceText(source),
          digestOffsetChanges(expectedEventChanges),
          digestSourceText(resultText),
        ]);
        records.push({
          key,
          uri: edit.uri,
          document,
          source,
          sourceDigest,
          changes,
          changeDigest,
          resultDigest,
          beforeVersion: edit.baseVersion,
        });
      }
      const recordsByKey = new Map(records.map(record => [record.key, record]));
      const tracker = createEventTracker(workspace, records);
      try {
        const workspaceEdit = new WorkspaceEdit();
        for (const record of records) {
          for (const replacement of toWorkspaceTextEdits(record.document, record.changes, Range)) {
            workspaceEdit.replace(record.uri, replacement.range, replacement.newText);
          }
        }

        let finalConflict = false;
        for (const record of records) {
          const document = authoritativeDocument(workspace, record.key, record.document);
          const text = document.getText();
          if (document.version !== record.beforeVersion || text !== record.source) {
            finalConflict = true;
            break;
          }
          try {
            validateOffsetChanges(text, record.changes);
          }
          catch {
            finalConflict = true;
            break;
          }
        }
        if (finalConflict) return conflictResult(workspace, input, recordsByKey);

        let applied;
        try {
          applied = input.applyWorkspaceEdit
            ? await input.applyWorkspaceEdit(workspaceEdit)
            : await workspace.applyEdit(workspaceEdit);
        }
        catch (error) {
          return Object.freeze({
            kind: "apply-failed",
            operationId: input.operationId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (applied !== true) {
          return Object.freeze({
            kind: "apply-failed",
            operationId: input.operationId,
            message: "workspace.applyEdit returned false",
          });
        }
        const outcome = await tracker.outcome;
        if (outcome.kind !== "matched") return conflictResult(workspace, input, recordsByKey);
        return Object.freeze({
          kind: "applied",
          operationId: input.operationId,
          versions: freezeRecords(records.map(record => ({
            uri: record.uri,
            before: record.beforeVersion,
            after: record.beforeVersion + 1,
          }))),
        });
      }
      finally {
        tracker.dispose();
      }
    });
  }

  function drain(uri) {
    assertActive();
    return enqueue(uriKey(uri), async () => {});
  }

  function dispose() {
    disposed = true;
  }

  return Object.freeze({ withUris, applyVersionedTextEdits, drain, dispose });
}
