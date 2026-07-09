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
// second full `intakeMesh` run; see jobs.ts's "serializeMeshStl /
// weldMeshSoup" section doc for the "intake-skip" rationale. Each mesh is
// registered into `meshStore` via the NORMAL `MeshStore.register()` path
// (recentering etc. — Task 11's guardrail: "no shortcuts"), keyed by the
// document's OWN `MeshAsset.contentHash` (never recomputed from the reloaded
// buffers — see shared-types' `MeshAsset.fileHash` doc for why the STL round
// trip can't reproduce that hash bit-for-bit). Only once every live mesh is
// registered does `caseStore.loadDocument()` install the document — so
// `getRenderNodes()` never observes a dangling `meshId`, even transiently.
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
import type { CaseDocument, MeshAsset } from '@dqcad/shared-types';
import { createEmptyCaseDocument, useCaseStore } from '../state/caseStore';
import { type CaseSummary, usePersistenceStore } from '../state/persistenceStore';
import { caseStore } from './caseStore';
import { sha256Hex } from './hash';
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
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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

async function uploadMeshBytes(expectedHash: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(`${API_BASE}/meshes`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    // Same TS 5.7+ `ArrayBufferView<ArrayBuffer>`-vs-`ArrayBufferLike`
    // generic-typing gap as engine/hash.ts's `sha256Hex` cast — `bytes` is a
    // real, non-shared-ArrayBuffer-backed Uint8Array at runtime, a valid
    // BodyInit, DOM lib's fetch() types just don't see it structurally.
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
 * shared by `createCase`/`openCase` (both fully replace "the current case",
 * so the OUTGOING case's geometry has no reason to stay resident). */
function resetMeshRegistryForCaseSwitch(): void {
  for (const record of caseStore.meshStore.list()) {
    releaseBvhForMesh(record.contentHash);
  }
  caseStore.meshStore.clear();
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
 */
export async function createCase(name: string): Promise<void> {
  const created = await requestJson<CaseSummary>('POST', '/cases', { name });
  resetMeshRegistryForCaseSwitch();
  const emptyDocument: CaseDocument = {
    ...createEmptyCaseDocument(),
    id: created.id,
    createdAt: created.createdAt,
  };
  const summary = await requestJson<CaseSummary>('PUT', `/cases/${created.id}`, emptyDocument);
  lastPersistedDocument = emptyDocument;
  caseStore.loadDocument(emptyDocument);
  usePersistenceStore.getState().setActiveCase({ id: summary.id, name: summary.name });
  usePersistenceStore.getState().setLastSavedAt(summary.updatedAt);
  usePersistenceStore.getState().setStatus('saved');
  await listCases();
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
 */
export async function openCase(id: string, name: string): Promise<void> {
  try {
    const document = await requestJson<CaseDocument>('GET', `/cases/${id}`);
    resetMeshRegistryForCaseSwitch();

    const liveMeshIds = new Set(document.scene.map((node) => node.meshId));
    for (const meshId of liveMeshIds) {
      const asset: MeshAsset | undefined = document.meshes.find((mesh) => mesh.contentHash === meshId);
      if (!asset) {
        console.warn(`persistence: openCase — scene references unknown mesh ${meshId}, skipping`);
        continue;
      }
      if (!asset.fileHash) {
        console.warn(
          `persistence: openCase — MeshAsset ${asset.contentHash} has no fileHash (never saved), skipping`,
        );
        continue;
      }
      const bytes = await fetchMeshBytes(asset.fileHash);
      const parsed = await getPool().run(
        'parseMeshFile',
        { format: 'stl', bytes },
        { transfer: [bytes.buffer] },
      );
      if (parsed.kind !== 'stl-soup') {
        throw new Error(`persistence: openCase — expected an STL soup, got ${parsed.kind}`);
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
    }

    lastPersistedDocument = document;
    caseStore.loadDocument(document);
    usePersistenceStore.getState().setActiveCase({ id, name });
    // GET /api/cases/:id doesn't return `updatedAt` (only the document) — a
    // freshly loaded document is, by construction, identical to what's on
    // the server, so "now" is a reasonable (if approximate) "last confirmed
    // in sync with server" timestamp for the header's status display.
    usePersistenceStore.getState().setLastSavedAt(new Date().toISOString());
    usePersistenceStore.getState().setStatus('saved');
  } catch (error) {
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
    const { bytes } = await getPool().run(
      'serializeMeshStl',
      { positions: positionsCopy, indices: indicesCopy },
      { transfer: [positionsCopy.buffer, indicesCopy.buffer] },
    );
    const fileHash = await sha256Hex(bytes);
    if (!(await headMeshExists(fileHash))) {
      await uploadMeshBytes(fileHash, bytes);
    }
    caseStore.setMeshAssetFileHash(asset.contentHash, fileHash);
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

/** TEST-ONLY: resets this module's persistence-tracking state (dirty
 * baseline, in-flight/pending-save flags, pending debounce timer) so tests
 * don't leak state through this module-level singleton across files —
 * mirrors engine/caseStore.ts's `resetForTests`. Does NOT reset
 * usePersistenceStore itself (tests reset that store directly if needed). */
export function resetPersistenceForTests(): void {
  lastPersistedDocument = null;
  saveInFlight = false;
  pendingSaveRequested = false;
  clearAutosaveTimer();
}
