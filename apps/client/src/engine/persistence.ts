// apps/client/src/engine/persistence.ts
//
// Task 11: scene persistence (save/load/autosave) — the ONLY module allowed
// to talk to the server's `/api/cases`/`/api/meshes` routes (mirrors
// engine/workers.ts being the only module allowed to touch
// @dqcad/kernel-workers directly: ui/ and state/ never `fetch()` themselves,
// they call this module's exported actions and read state/persistenceStore.ts).
//
// ## Save: serialize -> upload missing mesh bytes -> PUT the document
//
// `save()` turns the CURRENT `caseStore` document into exactly what Task 11's
// brief asks for: every `MeshAsset` without a `fileHash` yet gets its
// geometry serialized to binary STL (via kernel-workers' `serializeMeshStl`
// job — engine/** cannot import `@dqcad/io` directly, see that job's doc),
// HEAD-checked against the server's content-addressed store, uploaded if
// missing, and stamped onto the document (`caseStore.setMeshAssetFileHash`)
// — THEN the whole document is `PUT`. See `MeshAsset.fileHash`'s doc
// (shared-types) for why this is a hash of the uploaded FILE bytes, distinct
// from `contentHash` (the in-session Float64 geometry identity).
//
// ## Load: GET -> fetch/parse/weld each live mesh -> loadDocument (no re-intake)
//
// `openCase()` fetches the `CaseDocument`, then for every mesh actually
// referenced by `document.scene` (see this file's `openCase` doc for why
// ONLY scene-referenced meshes, not every `MeshAsset` ever recorded),
// fetches its stored STL bytes and reconstructs an `IndexedMesh` via
// `parseMeshFile` + `weldMeshSoup` (kernel-workers) — deliberately NOT a
// second full `intakeMesh` run; see jobs/io.ts's "weldMeshSoup" and jobs/misc.ts's "serializeMeshStl" /
// weldMeshSoup" section doc for the "intake-skip" rationale. Each mesh is
// registered into `meshStore` via the NORMAL `MeshStore.register()` path
// (recentering etc. — Task 11's guardrail: "no shortcuts"), keyed by the
// document's OWN `MeshAsset.contentHash` (never recomputed from the reloaded
// buffers — see shared-types' `MeshAsset.fileHash` doc for why the STL round
// trip can't reproduce that hash bit-for-bit). Only once every live mesh is
// registered does `caseStore.loadDocument()` install the document — so
// `getRenderNodes()` never observes a dangling `meshId`, even transiently.
// The OUTGOING case's now-unreferenced meshes/BVHs are only released AFTER
// that swap succeeds (both cases briefly resident together), and if the
// fetch/parse/weld loop fails partway through, this attempt's own partial
// registrations are rolled back and the outgoing case's document/meshes are
// left exactly as they were — see `openCase`'s own doc for the full
// rationale.
//
// ## Autosave: debounced, coalesced, dirty-tracked
//
// A module-level `useCaseStore.subscribe(...)` (below) is this module's
// mutation hook: whenever the published `CaseDocument` reference changes
// AND it differs from `lastPersistedDocument` (the exact object instance
// this module most recently confirmed saved/loaded), the document is
// "dirty" — status flips to 'unsaved' and a 30 s debounce timer (re)starts.
// `save()` itself is what enforces the two correctness guardrails: it's a
// no-op if the document isn't dirty (`documentToSave === lastPersistedDocument`
// is impossible to reach here, but the equivalent live check is used), and if
// a save is already in flight, a concurrent `save()` call (autosave timer AND
// manual Cmd/Ctrl+S racing) only sets `pendingSaveRequested`, coalescing into
// ONE follow-up save after the in-flight one finishes rather than firing two
// overlapping PUTs.
import type { CaseDocument, MeshAsset, Restoration } from '@dqcad/shared-types';
import { createEmptyCaseDocument, useCaseStore } from '../state/caseStore';
import { type CaseSummary, usePersistenceStore } from '../state/persistenceStore';
import { authHeaders } from './apiAuth';
import { caseStore } from './caseStore';
import { migrateCaseDocumentIfNeeded } from './caseDocumentMigration';
import { clearLocalSnapshot } from './crashRecovery';
import { logInfo } from './diagnosticLog';
import { liveFinalMeshForRestoration, type LiveFinalMeshBuffers } from './finalMeshSource';
import { getPool, releaseBvhForMesh } from './workers';

const API_BASE = '/api';
const AUTOSAVE_DEBOUNCE_MS = 30_000;

class PersistenceHttpError extends Error {
  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`${method} ${path} failed with ${status}${bodyText ? `: ${bodyText}` : ''}`);
    this.name = 'PersistenceHttpError';
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Phase 8 Task 6: attach the local single-user auth token to mutating
  // requests (ADR-020). `authHeaders()` is `{}` for GETs-when-uninitialized and
  // for a disabled-gate server, so this is inert in dev/tests.
  const auth = await authHeaders();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? auth : { 'content-type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new PersistenceHttpError(method, path, response.status, text);
  }
  return (await response.json()) as T;
}

async function fetchMeshBytes(fileHash: string): Promise<Uint8Array> {
  const response = await fetch(`${API_BASE}/meshes/${fileHash}`);
  if (!response.ok) {
    throw new PersistenceHttpError('GET', `/meshes/${fileHash}`, response.status, '');
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function headMeshExists(fileHash: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/meshes/${fileHash}`, { method: 'HEAD' });
  return response.ok;
}

async function headFinalMeshExists(contentHash: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/final-meshes/${contentHash}`, { method: 'HEAD' });
  return response.ok;
}

/** Uploads a final-mesh container (content-addressed by the DECODED mesh's
 * content hash, computed server-side). Asserts the server-returned hash equals
 * the expected `stages.finalMesh` — the "assert anyway" discipline (mirrors
 * `uploadMeshBytes`). */
async function uploadFinalMeshContainer(expectedContentHash: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(`${API_BASE}/final-meshes`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...(await authHeaders()) },
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new PersistenceHttpError('POST', '/final-meshes', response.status, text);
  }
  const result = (await response.json()) as { contentHash: string; byteLength: number };
  if (result.contentHash !== expectedContentHash) {
    throw new Error(
      `persistence: server-computed final-mesh content hash (${result.contentHash}) does not match the ` +
        `document's stages.finalMesh (${expectedContentHash}) — the container serialized a different mesh`,
    );
  }
}

async function uploadMeshBytes(expectedHash: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(`${API_BASE}/meshes`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...(await authHeaders()) },
    // Same TS 5.7+ `ArrayBufferView<ArrayBuffer>`-vs-`ArrayBufferLike`
    // generic-typing gap as kernel-workers/src/hash.ts's `sha256Hex` cast —
    // `bytes` is a real, non-shared-ArrayBuffer-backed Uint8Array at
    // runtime, a valid BodyInit, DOM lib's fetch() types just don't see it
    // structurally.
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new PersistenceHttpError('POST', '/meshes', response.status, text);
  }
  const result = (await response.json()) as { hash: string; byteLength: number };
  if (result.hash !== expectedHash) {
    // Should be unreachable (both sides hash the exact same bytes with the
    // same algorithm) — asserted anyway per this task's "write-once...
    // assert anyway" guardrail, mirrored from the server's own
    // MeshStorageIntegrityError.
    throw new Error(
      `persistence: server-computed mesh hash (${result.hash}) does not match the client-computed hash ` +
        `(${expectedHash}) for the same upload — possible corruption in transit`,
    );
  }
}

/** Releases every currently-registered mesh's worker-side BVH cache entry
 * (see engine/workers.ts's `releaseBvhForMesh` doc) and clears `meshStore` —
 * used by `createCase`, whose new document starts with an empty `scene`, so
 * the OUTGOING case's geometry unconditionally has no reason to stay
 * resident (there's no fetch/parse/weld loop that could fail partway
 * through in between, unlike `openCase` below — see that function's doc for
 * why it does its own targeted release instead of this blanket clear).
 *
 * MUST be called only AFTER `caseStore.loadDocument()` has installed the new
 * (empty-`scene`) document — never before, and never if the POST/PUT that
 * produced it could still fail. Clearing first would leave the OLD
 * document's SceneNodes pointing at now-missing `meshId`s the instant a
 * later step throws (a transiently-observable dangling `meshId`, exactly
 * the invariant this file's module doc rules out); clearing after is safe
 * specifically because the just-installed document's `scene` is empty, so
 * every mesh this clears is, by construction, already unreferenced. */
function resetMeshRegistryForCaseSwitch(): void {
  for (const record of caseStore.meshStore.list()) {
    releaseBvhForMesh(record.contentHash);
  }
  caseStore.meshStore.clear();
}

/** A scene-referenced mesh whose geometry could NOT be reconstructed on load
 * (no durable byte source) — surfaced honestly to the operator by crash
 * recovery (Phase 8 Task 4 review SF2) rather than dropped with only a
 * `console.warn`. `name` falls back to the meshId when the `MeshAsset` itself
 * is missing. */
export interface UnrecoverableMesh {
  meshId: string;
  name: string;
}

/**
 * Fetches, parses, welds, and registers every mesh referenced by
 * `document.scene` that is not already resident — the shared mesh-reconstruction
 * loop used by BOTH `openCase` (server load) and `restoreFromLocalSnapshot`
 * (Phase 8 Task 4 crash recovery). Appends each contentHash it NEWLY registers
 * to `registeredThisAttempt` as it goes (so a caller's `catch` can roll back
 * even a partial run — see `openCase`'s atomic-swap doc). A mesh with no
 * `fileHash` (never uploaded — no durable byte source) or an unknown meshId is
 * SKIPPED (never fabricated) and, so the caller can surface it, recorded in
 * `unrecoverable` when that array is provided. Throws on a fetch/parse failure,
 * leaving `registeredThisAttempt` populated up to the failure for rollback.
 */
async function reconstructSceneMeshes(
  document: CaseDocument,
  registeredThisAttempt: string[],
  unrecoverable?: UnrecoverableMesh[],
): Promise<void> {
  const liveMeshIds = new Set(document.scene.map((node) => node.meshId));
  for (const meshId of liveMeshIds) {
    const asset: MeshAsset | undefined = document.meshes.find((mesh) => mesh.contentHash === meshId);
    if (!asset) {
      console.warn(`persistence: reconstructSceneMeshes — scene references unknown mesh ${meshId}, skipping`);
      unrecoverable?.push({ meshId, name: meshId });
      continue;
    }
    if (!asset.fileHash) {
      console.warn(
        `persistence: reconstructSceneMeshes — MeshAsset ${asset.contentHash} has no fileHash (never saved), skipping`,
      );
      unrecoverable?.push({ meshId: asset.contentHash, name: asset.name });
      continue;
    }
    if (caseStore.meshStore.has(asset.contentHash)) {
      // Already resident — shared (by contentHash) with the outgoing case, or
      // left from a rolled-back attempt. Skip the wasted fetch AND keep it OUT
      // of `registeredThisAttempt` so a later failure won't roll it back out
      // from under the case still relying on it.
      continue;
    }
    const bytes = await fetchMeshBytes(asset.fileHash);
    const parsed = await getPool().run(
      'parseMeshFile',
      { format: 'stl', bytes },
      { transfer: [bytes.buffer] },
    );
    if (parsed.kind !== 'stl-soup') {
      throw new Error(`persistence: reconstructSceneMeshes — expected an STL soup, got ${parsed.kind}`);
    }
    const welded = await getPool().run(
      'weldMeshSoup',
      { positions: parsed.positions },
      { transfer: [parsed.positions.buffer] },
    );
    caseStore.meshStore.register({
      contentHash: asset.contentHash,
      name: asset.name,
      format: 'stl',
      positions: welded.positions,
      indices: welded.indices,
      stats: welded.stats,
      report: welded.report,
    });
    registeredThisAttempt.push(asset.contentHash);
  }
}

// ---------------------------------------------------------------------------
// Case picker actions: list / create / open / rename.
// ---------------------------------------------------------------------------

/** Refreshes `usePersistenceStore`'s `cases` list — the case picker's data
 * source (`GET /api/cases`, already existed before this task). */
export async function listCases(): Promise<void> {
  const store = usePersistenceStore.getState();
  store.setCasesLoading(true);
  store.setCasesError(null);
  try {
    const cases = await requestJson<CaseSummary[]>('GET', '/cases');
    usePersistenceStore.getState().setCases(cases);
  } catch (error) {
    usePersistenceStore.getState().setCasesError(errorMessageOf(error));
  } finally {
    usePersistenceStore.getState().setCasesLoading(false);
  }
}

/**
 * Creates a new case on the server, then immediately `PUT`s the client's own
 * empty `CaseDocument` shape back — this is NOT redundant: the server's own
 * `createEmptyCaseDocument` (apps/server/src/case-document.ts) and the
 * client's (state/caseStore.ts) use slightly different placeholder
 * `settings` values (documented independently in each), so without this
 * round trip `lastPersistedDocument` would claim "saved" against a document
 * the server never actually has, silently diverging until the first real
 * edit triggers a save. This makes creation behave exactly like any other
 * confirmed save.
 *
 * ## Ordering: POST -> PUT -> loadDocument -> release old meshes
 *
 * Mirrors `openCase`'s "never observe a dangling meshId, old state intact on
 * failure" discipline, adapted to `createCase`'s simpler shape (no
 * fetch/parse/weld loop to roll back — the new document's `scene` is always
 * empty). The OUTGOING case's meshes are only released via
 * `resetMeshRegistryForCaseSwitch()` AFTER `loadDocument(emptyDocument)` has
 * installed the new (empty-scene) document — at that point they're
 * unconditionally unreferenced, so the blanket clear is safe. If the POST or
 * the PUT rejects, execution never reaches `loadDocument`/the registry
 * clear at all: the previously active case's document AND meshes are left
 * completely untouched (still the current `caseStore` document, still
 * resident/renderable), status flips to `'error'`, and the error is
 * rethrown for the caller (ui/CasePicker.tsx) to react to — same contract
 * `openCase` already provides.
 */
export async function createCase(name: string): Promise<void> {
  try {
    const created = await requestJson<CaseSummary>('POST', '/cases', { name });
    const emptyDocument: CaseDocument = {
      ...createEmptyCaseDocument(),
      id: created.id,
      createdAt: created.createdAt,
    };
    const summary = await requestJson<CaseSummary>('PUT', `/cases/${created.id}`, emptyDocument);

    // Only NOW, with the new case durably created and its empty document
    // confirmed stored server-side, do we touch any client-side state that
    // can't be trivially rolled back.
    lastPersistedDocument = emptyDocument;
    caseStore.loadDocument(emptyDocument);
    // The just-installed document's `scene` is empty, so every mesh this
    // releases is, by construction, unreferenced by it — see
    // `resetMeshRegistryForCaseSwitch`'s doc for why this must run AFTER
    // `loadDocument`, never before.
    resetMeshRegistryForCaseSwitch();

    usePersistenceStore.getState().setActiveCase({ id: summary.id, name: summary.name });
    usePersistenceStore.getState().setLastSavedAt(summary.updatedAt);
    usePersistenceStore.getState().setStatus('saved');
    await listCases();
  } catch (error) {
    usePersistenceStore.getState().setStatus('error', errorMessageOf(error));
    throw error;
  }
}

/**
 * Fetches `id`'s `CaseDocument` and every mesh its `scene` currently
 * references, reconstructs each into `meshStore`, then installs the
 * document as the active case. `name` is supplied by the caller (the case
 * picker already has it from `listCases()`'s summary — `GET
 * /api/cases/:id` returns only the `CaseDocument`, which has no `name`
 * field; see shared-types) rather than re-fetched here.
 *
 * Only meshes referenced by `document.scene` are fetched — a `MeshAsset`
 * with no current `SceneNode` (an orphaned/historical journal entry; see
 * engine/caseStore.ts's `removeSceneNode` doc) has nothing to render, and
 * Phase 1 has no UI to re-place an already-imported-but-unplaced mesh after
 * a reload anyway (ImportPanel's role dropdown only exists for the SAME
 * session's freshly imported files) — fetching its bytes would be pure
 * waste. Deliberate scope cut, not an oversight.
 *
 * ## Atomic swap, not clear-then-load
 *
 * Unlike `createCase` (which has no fetch/parse/weld loop that can fail
 * partway through, so it's safe to blanket-clear `meshStore` up front — see
 * `resetMeshRegistryForCaseSwitch`'s doc), `openCase` must NOT release the
 * OUTGOING case's meshes before every INCOMING mesh is confirmed resident.
 * If a fetch/parse/weld failed mid-loop after an early clear, `caseStore`'s
 * document would still point at the old case (this function's `catch`
 * rethrows without ever calling `loadDocument`) while the meshes it renders
 * were already gone — a dangling `meshId` observable by `getRenderNodes()`,
 * violating this file's module doc "never observes a dangling meshId, even
 * transiently" invariant.
 *
 * So instead: fetch/register every live mesh the NEW document needs
 * (skipping any whose `contentHash` is already resident — e.g. shared with
 * the outgoing case, so both cases briefly overlapping in `meshStore` costs
 * nothing extra there), THEN swap the document in with `loadDocument`, THEN
 * release whatever the OUTGOING case had that the new document doesn't
 * reference. Both cases' meshes are resident together for the duration of
 * the fetch loop — acceptable Phase 1 memory tradeoff for correctness (scans
 * are a handful of meshes, not hundreds).
 *
 * On failure, anything THIS attempt newly registered (tracked in
 * `registeredThisAttempt`) is rolled back — those meshes have no SceneNode
 * referencing them (the swap never happened) and would otherwise leak until
 * some later successful switch happened to notice they're unreferenced.
 * Meshes reused from the outgoing case (skipped above, never added to that
 * list) are correctly left alone since the outgoing case's document is still
 * the active one.
 */
export async function openCase(id: string, name: string): Promise<void> {
  const registeredThisAttempt: string[] = [];
  try {
    // `requestJson<unknown>`, not `<CaseDocument>`: the server's GET route
    // does no validation of its own stored JSON (apps/server/src/app.ts
    // just echoes back `documentJson` as-is) — a case saved before Phase 3
    // Task 1's schemaVersion 1 -> 2 evolution can still be schemaVersion 1
    // on disk until its next successful save. `migrateCaseDocumentIfNeeded`
    // (engine/caseDocumentMigration.ts) is the ONLY place that boundary is
    // crossed: every `CaseDocument`-typed value from this point on in the
    // whole client is guaranteed schemaVersion 2.
    const rawDocument = await requestJson<unknown>('GET', `/cases/${id}`);
    const document = migrateCaseDocumentIfNeeded(rawDocument);
    // Reference inequality is a cheap, exact "was this migrated" signal:
    // `migrateCaseDocumentIfNeeded` returns `rawDocument` BY REFERENCE,
    // unchanged, when it was already schemaVersion 2 (see that function's
    // doc) — a NEW object only ever comes back from an actual v1 -> v2
    // migration.
    const wasMigrated = (rawDocument as unknown) !== (document as unknown);

    const previousMeshHashes = new Set(caseStore.meshStore.list().map((record) => record.contentHash));
    const liveMeshIds = new Set(document.scene.map((node) => node.meshId));

    await reconstructSceneMeshes(document, registeredThisAttempt);

    // Every live mesh the new document needs is now resident — safe to swap
    // atomically. `getRenderNodes()` never observes a dangling `meshId`.
    //
    // `lastPersistedDocument` is set to `document` ONLY when it was NOT
    // migrated: a migrated document genuinely DIFFERS from what the server
    // still has on disk (the server never sees a schemaVersion-1 document —
    // it only ever exists transiently, client-side, until the next save),
    // so treating it as "already in sync" here would be wrong — it must
    // stay dirty so the normal autosave/`isDirty()` machinery (this file's
    // module doc's "Autosave" section) picks it up and persists the
    // migration back to the server. Leaving `lastPersistedDocument` pointing
    // at whatever it was before (a different case's document, or `null`) is
    // exactly what makes `useCaseStore.subscribe`'s mutation hook (below)
    // see a genuine change once `loadDocument` publishes the migrated
    // document, and mark the case 'unsaved'.
    if (!wasMigrated) {
      lastPersistedDocument = document;
    }
    caseStore.loadDocument(document);

    // NOW release whatever the OUTGOING case had that the new document
    // doesn't also reference (see this function's doc's "Atomic swap"
    // section).
    for (const oldContentHash of previousMeshHashes) {
      if (!liveMeshIds.has(oldContentHash)) {
        caseStore.meshStore.remove(oldContentHash);
        releaseBvhForMesh(oldContentHash);
      }
    }

    usePersistenceStore.getState().setActiveCase({ id, name });
    // PHI-free diagnostic breadcrumb (engine/diagnosticLog.ts): the case id (a
    // UUID) + sizes only — never the case name, patientRef, or any content.
    logInfo('case.opened', {
      caseId: id,
      restorationCount: useCaseStore.getState().document.restorations.length,
      journalOperationCount: useCaseStore.getState().document.history.length,
    });
    if (wasMigrated) {
      // See the `lastPersistedDocument` doc above — a migrated document is
      // NOT yet in sync with the server (the server never sees a
      // schemaVersion-1 document at all). Rather than leaving it dirty for
      // the 30s autosave debounce to eventually notice (this function's
      // own final `setStatus` below would otherwise race the subscribe
      // hook's — `useCaseStore.subscribe` bails out early here anyway,
      // since `setActiveCase` above hasn't run yet the moment
      // `loadDocument` publishes, so it can't be relied on), persist the
      // migration explicitly, as part of THIS load — `save()` reads
      // `isDirty()`/`activeCaseId` off the stores set above, PUTs the
      // migrated document, and updates `lastPersistedDocument`/status
      // itself (never throws — failures set status 'error' internally, see
      // `save()`'s doc), so `openCase`'s own success path doesn't need to
      // set status afterward for this branch.
      console.info(
        `persistence: openCase — case ${id} was migrated from CaseDocument.schemaVersion 1 to 2 on load; ` +
          'persisting the migration now.',
      );
      await save();
    } else {
      // GET /api/cases/:id doesn't return `updatedAt` (only the document) —
      // a freshly loaded, non-migrated document is, by construction,
      // identical to what's on the server, so "now" is a reasonable (if
      // approximate) "last confirmed in sync with server" timestamp for the
      // header's status display.
      usePersistenceStore.getState().setLastSavedAt(new Date().toISOString());
      usePersistenceStore.getState().setStatus('saved');
    }
  } catch (error) {
    // Roll back this FAILED attempt's own newly-registered meshes (see this
    // function's doc) — the outgoing case's document/meshes were never
    // touched (loadDocument only runs once every live mesh is confirmed
    // resident, above), so they remain exactly as they were.
    for (const contentHash of registeredThisAttempt) {
      caseStore.meshStore.remove(contentHash);
      releaseBvhForMesh(contentHash);
    }
    usePersistenceStore.getState().setStatus('error', errorMessageOf(error));
    throw error;
  }
}

export async function renameCase(id: string, name: string): Promise<void> {
  const summary = await requestJson<CaseSummary>('PATCH', `/cases/${id}`, { name });
  usePersistenceStore.setState((state) => ({
    cases: state.cases.map((existing) => (existing.id === id ? summary : existing)),
    activeCaseName: state.activeCaseId === id ? summary.name : state.activeCaseName,
  }));
}

// ---------------------------------------------------------------------------
// Save (manual Cmd/Ctrl+S and autosave share this one function).
// ---------------------------------------------------------------------------

/** The exact `CaseDocument` instance this module last confirmed the server
 * holds (via a successful `save`/`createCase`/`openCase`) — see this file's
 * module doc's "Autosave" section. `null` before any case has ever been
 * opened/created/saved this session. */
let lastPersistedDocument: CaseDocument | null = null;
let saveInFlight = false;
let pendingSaveRequested = false;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function isDirty(): boolean {
  return useCaseStore.getState().document !== lastPersistedDocument;
}

function clearAutosaveTimer(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

function scheduleAutosave(): void {
  clearAutosaveTimer();
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void save();
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** Uploads every `MeshAsset` in the CURRENT document that has no `fileHash`
 * yet — HEAD-checked first (skips the upload entirely if the server already
 * has those exact bytes, e.g. a mesh saved from a different case/session
 * that happens to share content), and stamps the confirmed `fileHash` onto
 * the document via `caseStore.setMeshAssetFileHash` either way. See this
 * file's module doc's "Save" section. */
async function uploadMissingMeshes(): Promise<void> {
  const document = useCaseStore.getState().document;
  for (const asset of document.meshes) {
    if (asset.fileHash) {
      continue; // content-addressed & immutable — already uploaded, never changes.
    }
    const record = caseStore.meshStore.get(asset.contentHash);
    if (!record) {
      // See engine/caseStore.ts's `removeSceneNode` doc: a MeshAsset whose
      // buffers were released (its last SceneNode removed) before its
      // first-ever save has nothing left to serialize. Known, documented
      // Phase 1 limitation — such a mesh's bytes are simply never
      // persisted (it isn't rendered/referenced by anything either).
      console.warn(
        `persistence: save — MeshAsset ${asset.contentHash} has no live geometry buffers and no ` +
          'fileHash; skipping (its SceneNode(s) were removed before it was ever saved)',
      );
      continue;
    }
    const positionsCopy = record.positions.slice();
    const indicesCopy = record.indices.slice();
    // `fileHash` is computed WORKER-SIDE by serializeMeshStl itself now
    // (kernel-workers/src/jobs/misc.ts's `SerializeMeshStlResult.fileHash` doc) —
    // replaces the old main-thread `sha256Hex(bytes)` call (Phase 2 Task 1);
    // identical value, computed right where `bytes` is already produced.
    const { bytes, fileHash } = await getPool().run(
      'serializeMeshStl',
      { positions: positionsCopy, indices: indicesCopy },
      { transfer: [positionsCopy.buffer, indicesCopy.buffer] },
    );
    if (!(await headMeshExists(fileHash))) {
      await uploadMeshBytes(fileHash, bytes);
    }
    caseStore.setMeshAssetFileHash(asset.contentHash, fileHash);
  }
}

/**
 * Phase 7 Task 6 (Part A — the T4-F2 closure): persists each restoration's
 * FINAL-MESH bytes content-addressed (the lossless `serializeFinalMeshContent`
 * container, keyed server-side by the mesh content hash = `stages.finalMesh`),
 * so the export endpoint can resolve `stages.finalMesh` to the exact Float64
 * design solid and certify the delivered OUTER envelope against it.
 *
 * ## What this can materialize (honest boundary)
 *
 * Only a restoration whose LIVE design session still holds its final-mesh
 * buffers (`liveFinalMeshForRestoration`, backed by the T3
 * `finalMeshForExport` getters) can be (re)serialized here. After a reload the
 * session buffers are gone (that is exactly why the export flow's
 * `finalMeshUnavailable` refusal exists) — such a restoration is SKIPPED with a
 * documented warning. This is NOT a gap in coverage: the store is
 * content-addressed and immutable, so a finalMesh persisted at the save when
 * its design WAS live remains resolvable forever after; a later reload cannot
 * re-upload it but never needs to. The only genuinely-unrecoverable case is a
 * restoration whose finalMesh was NEVER saved with a live session — as of
 * Phase 7 Task 8 the export endpoint REFUSES that export
 * (`export-final-mesh-not-persisted`, 409) rather than releasing uncertified:
 * finalMesh persistence is mandatory at the release gate, and this pre-release
 * `save()` step (which runs `uploadMissingFinalMeshes`) is how the normal flow
 * satisfies it before the POST.
 *
 * HEAD-checked first (skips the upload when the server already holds those exact
 * bytes — content-addressed immutability), same discipline as
 * `uploadMissingMeshes`.
 */
/** Injectable final-mesh source (TEST-ONLY seam; mirrors exportFlow's
 * `__setFinalMeshSourceForTests`). `null` restores the default design-engine
 * resolver. Lets persistence tests exercise `uploadMissingFinalMeshes` without
 * standing up a full crown/inlay/bridge design session. */
let finalMeshSourceOverride: ((restoration: Restoration) => LiveFinalMeshBuffers | null) | null = null;

/** TEST-ONLY: override the live final-mesh source (see `finalMeshSourceOverride`). */
export function __setFinalMeshSourceForTests(
  source: ((restoration: Restoration) => LiveFinalMeshBuffers | null) | null,
): void {
  finalMeshSourceOverride = source;
}

async function uploadMissingFinalMeshes(): Promise<void> {
  const document = useCaseStore.getState().document;
  const resolve = finalMeshSourceOverride ?? liveFinalMeshForRestoration;
  for (const restoration of document.restorations) {
    const finalMeshHash = restoration.stages.finalMesh;
    if (!finalMeshHash) {
      continue; // no final solid yet — nothing to persist.
    }
    const live = resolve(restoration);
    if (!live || live.contentHash !== finalMeshHash) {
      // No live session holds THIS final mesh (post-reload, or a session/
      // document drift) — see this function's doc. Cannot re-materialize; if it
      // was persisted at an earlier live save it is already resolvable, so this
      // is a no-op either way. Never silently fabricates bytes.
      continue;
    }
    if (await headFinalMeshExists(finalMeshHash)) {
      continue; // content-addressed & immutable — already persisted.
    }
    const positionsCopy = live.positions.slice();
    const indicesCopy = live.indices.slice();
    const { bytes, contentHash } = await getPool().run(
      'serializeFinalMeshContent',
      { positions: positionsCopy, indices: indicesCopy },
      { transfer: [positionsCopy.buffer, indicesCopy.buffer] },
    );
    await uploadFinalMeshContainer(contentHash, bytes);
  }
}

/**
 * Saves the active case: uploads any not-yet-persisted mesh bytes, then
 * `PUT`s the full document. A no-op if there's no active case, the document
 * hasn't changed since the last confirmed save, or a save is already in
 * flight (in which case this call is coalesced — see module doc). Shared by
 * the header's manual save button, the Cmd/Ctrl+S shortcut (ui/App.tsx), and
 * the 30 s autosave debounce timer below.
 */
export async function save(): Promise<void> {
  const activeCaseId = usePersistenceStore.getState().activeCaseId;
  if (!activeCaseId || !isDirty()) {
    return;
  }
  if (saveInFlight) {
    pendingSaveRequested = true;
    return;
  }

  saveInFlight = true;
  clearAutosaveTimer();
  usePersistenceStore.getState().setStatus('saving');
  try {
    await uploadMissingMeshes();
    await uploadMissingFinalMeshes();
    const documentToSave = useCaseStore.getState().document;
    const summary = await requestJson<CaseSummary>('PUT', `/cases/${activeCaseId}`, documentToSave);
    if (usePersistenceStore.getState().activeCaseId !== activeCaseId) {
      // The user opened/created a DIFFERENT case while this save's network
      // calls were in flight (openCase/createCase already reset
      // lastPersistedDocument/status/meshStore for the now-active case) —
      // the PUT above still correctly wrote `documentToSave` to ITS OWN
      // case id on the server (harmless, even useful), but applying its
      // "saved" bookkeeping here would clobber the NEW case's tracking
      // state. Silently drop it.
      return;
    }
    lastPersistedDocument = documentToSave;
    // Phase 8 Task 4: the server now durably holds `documentToSave`, so the
    // crash-safe LOCAL snapshot for this state is redundant — clear it (a crash
    // after a confirmed server save loses nothing). If a newer mutation landed
    // while this PUT was in flight, the document is dirty again and the local
    // debounce (crashRecovery.ts) writes a fresh snapshot for THOSE edits; this
    // clear only drops the now-server-durable state. Fire-and-forget: it is a
    // best-effort local cleanup, never gates the save result.
    void clearLocalSnapshot();
    usePersistenceStore.getState().setActiveCase({ id: summary.id, name: summary.name });
    usePersistenceStore.getState().setLastSavedAt(summary.updatedAt);
    // A mutation may have landed WHILE this save's network calls were in
    // flight (`documentToSave` was snapshotted before them) — if so the
    // document is dirty again right away; the mutation's own
    // useCaseStore.subscribe callback (below) has already scheduled a fresh
    // autosave timer for it, so nothing further is needed here besides
    // reflecting that in the status.
    usePersistenceStore.getState().setStatus(isDirty() ? 'unsaved' : 'saved');
  } catch (error) {
    usePersistenceStore.getState().setStatus('error', errorMessageOf(error));
  } finally {
    saveInFlight = false;
    if (pendingSaveRequested) {
      pendingSaveRequested = false;
      void save();
    }
  }
}

// Module-level mutation hook — see this file's module doc's "Autosave"
// section for the full contract. Subscribing at module load (rather than
// from a React effect) matches this codebase's existing singleton-engine
// convention (engine/caseStore.ts's `caseStore`, engine/workers.ts's
// `getPool()`): persistence tracking exists for the whole client session,
// not tied to any one component's mount lifecycle.
useCaseStore.subscribe((state) => {
  if (state.document === lastPersistedDocument) {
    return; // not dirty: either a pure-selection change, or WE just set this.
  }
  if (usePersistenceStore.getState().activeCaseId === null) {
    return; // no case open yet — nothing to autosave into.
  }
  usePersistenceStore.getState().setStatus('unsaved');
  scheduleAutosave();
});

/** UI entry point for the Cmd/Ctrl+S shortcut (ui/App.tsx) and the header's
 * manual save button — a thin, clearly-named alias for `save()` so call
 * sites read as an explicit user action rather than the autosave path,
 * even though they share one implementation (see this file's module doc). */
export const saveActiveCase = save;

/**
 * Phase 8 Task 4 — restores a crash-safe LOCAL snapshot's `CaseDocument` as the
 * active case (called by engine/recovery.ts on an EXPLICIT user "Restore").
 * Reconstructs every scene-referenced mesh with a durable `fileHash` (server
 * fetch → parse → weld → register, the SAME `reconstructSceneMeshes` path
 * `openCase` uses), then installs the document.
 *
 * ## State identity & the un-synced contract
 *
 * The document is installed VERBATIM (via `caseStore.loadDocument`), so the
 * restored state is byte-for-byte the pre-crash state — journal replay
 * bit-identical, all hashes equal (the P7-T1/T6 "recover honestly, never
 * fabricate" discipline). A local snapshot exists ONLY for edits the server
 * never received, so the restored document is by construction NOT yet on the
 * server: `lastPersistedDocument` is set to `null` and status to `'unsaved'`,
 * which makes the normal autosave/save path push the recovered work to the
 * server (visibly — never a silent overwrite; the user's "Restore" click
 * authorizes syncing their own recovered edits). The local snapshot is
 * deliberately NOT cleared here: it stays until that server save confirms
 * (`save()` clears it), so a second crash before the re-sync still recovers.
 *
 * ## Incomplete restore is surfaced, not hidden (review SF2)
 *
 * A local snapshot can legitimately capture a mesh imported but NEVER uploaded
 * (the local debounce fires ~2 s after an edit, well before the 30 s server
 * autosave stamps a `fileHash`), whose bytes therefore exist nowhere durable.
 * Such a mesh cannot be rebuilt from a document-only snapshot; its scene node
 * silently vanishes from the render output (`getRenderNodes` skips a node with
 * no mesh record). Rather than report a clean success, this returns the list of
 * `unrecoverableMeshes` so the caller (engine/recovery.ts) can TELL the operator
 * exactly which geometry did not come back — fulfilling the DoD's "if some
 * element is genuinely unrecoverable, say so and fail visibly, never fabricate"
 * to the OPERATOR, not just the console.
 *
 * On failure (e.g. the server is down and a mesh fetch fails), this THROWS and
 * rolls back its own partial mesh registrations, leaving the outgoing case and
 * the local snapshot untouched — the user can retry; nothing is discarded.
 *
 * @returns the meshes whose geometry could not be reconstructed (empty on a
 * fully-complete restore).
 * @throws on a mesh fetch/parse failure (recovery surfaced as a visible error;
 * the snapshot is preserved for retry).
 */
export async function restoreFromLocalSnapshot(
  document: CaseDocument,
  caseId: string,
  caseName: string,
): Promise<{ unrecoverableMeshes: UnrecoverableMesh[] }> {
  const registeredThisAttempt: string[] = [];
  const unrecoverableMeshes: UnrecoverableMesh[] = [];
  try {
    const previousMeshHashes = new Set(caseStore.meshStore.list().map((record) => record.contentHash));
    const liveMeshIds = new Set(document.scene.map((node) => node.meshId));

    await reconstructSceneMeshes(document, registeredThisAttempt, unrecoverableMeshes);

    // The restored document carries un-synced edits — mark it dirty so the
    // normal save path re-syncs it to the server (never trusted as "saved").
    lastPersistedDocument = null;
    caseStore.loadDocument(document);

    // Release whatever the outgoing (pre-restore) case had that the restored
    // document doesn't reference — mirrors `openCase`'s post-swap release.
    for (const oldContentHash of previousMeshHashes) {
      if (!liveMeshIds.has(oldContentHash)) {
        caseStore.meshStore.remove(oldContentHash);
        releaseBvhForMesh(oldContentHash);
      }
    }

    usePersistenceStore.getState().setActiveCase({ id: caseId, name: caseName });
    // Honest status: the recovered state is NOT on the server yet.
    usePersistenceStore.getState().setStatus('unsaved');
    return { unrecoverableMeshes };
  } catch (error) {
    for (const contentHash of registeredThisAttempt) {
      caseStore.meshStore.remove(contentHash);
      releaseBvhForMesh(contentHash);
    }
    usePersistenceStore.getState().setStatus('error', errorMessageOf(error));
    throw error;
  }
}

/** TEST-ONLY: resets this module's persistence-tracking state (dirty
 * baseline, in-flight/pending-save flags, pending debounce timer) so tests
 * don't leak state through this module-level singleton across files —
 * mirrors engine/caseStore.ts's `resetForTests`. Does NOT reset
 * usePersistenceStore itself (tests reset that store directly if needed). */
export function resetPersistenceForTests(): void {
  lastPersistedDocument = null;
  saveInFlight = false;
  pendingSaveRequested = false;
  finalMeshSourceOverride = null;
  clearAutosaveTimer();
}
