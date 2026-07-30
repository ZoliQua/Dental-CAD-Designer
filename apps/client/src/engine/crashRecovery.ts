// apps/client/src/engine/crashRecovery.ts
//
// Phase 8 Task 4 — the CRASH-SAFE LOCAL layer that sits ON TOP of the existing
// server persistence (engine/persistence.ts). It never replaces the server
// autosave; it protects the window BETWEEN a local edit and that edit reaching
// the server (the server autosave debounces 30 s and needs the server up). If
// the app/tab/browser dies in that window, on next launch this module detects
// the unclean shutdown and lets the user RESTORE the un-synced local state —
// state-identically (journal replay bit-identical) — or DISCARD it (keeping the
// server version). Both are EXPLICIT user choices (CLAUDE.md invariant 5: no
// silent data mutation; a diverging server state is never overwritten without
// confirmation, and a local snapshot is never silently thrown away).
//
// ## What is snapshotted vs what is already durable
//
// The snapshot is the whole `CaseDocument` — the complete, canonical, in-memory
// case state (journal `history`, `scene`, `restorations`, `measurements`,
// `settings`, and every `MeshAsset`'s metadata incl. `contentHash`/`fileHash`).
// That document IS the reproducible/journaled state (CLAUDE.md invariants 2/3),
// so restoring it byte-for-byte restores everything determinism cares about:
// `hashCaseJournal(restored.history)` equals the pre-crash journal hash, and a
// journal replay reproduces identical hashes.
//
// Heavy geometry BYTES (scan/mesh buffers) are NOT snapshotted: they are
// content-addressed and, once uploaded, durable server-side — recovery
// reconstructs them exactly like `openCase` does (fetch by `fileHash` →
// parse → weld → register). The honest boundary (P7-T1/T6 discipline): a mesh
// imported but NEVER uploaded (`MeshAsset` with no `fileHash`) has no durable
// byte source, so its geometry cannot be rebuilt from a document-only
// snapshot. The DOCUMENT/JOURNAL restore is still complete and bit-identical;
// such a mesh is reported honestly (see engine/persistence.ts's
// `restoreFromLocalSnapshot`), never fabricated.
//
// ## Atomicity: content-addressed payload + a committed marker (write-then-swap)
//
// Two stores, deliberately split by size and durability need:
//  - the PAYLOAD store (large `CaseDocument` JSON) — IndexedDB in the browser,
//    async, never blocks the UI thread. Records are keyed by the SHA-256 of the
//    exact JSON string (content-addressed), so a new write NEVER overwrites the
//    previously committed payload.
//  - the MARKER store (tiny) — localStorage in the browser, SYNCHRONOUS, so it
//    can be written reliably from a `pagehide` handler (async IndexedDB writes
//    are not guaranteed to flush during page teardown). The marker carries the
//    `payloadChecksum` that COMMITS one specific payload, plus the
//    clean-shutdown flag.
//
// A write is: (1) stage the payload under its checksum, (2) flip the marker's
// `payloadChecksum` to it, (3) prune older payloads. Step 2 is the single
// atomic commit. If the process dies between (1) and (2), the marker still
// points at the PREVIOUS committed checksum (or has none), so a reader loads
// the previous payload (still present, content-addressed) or nothing — NEVER
// the half-staged new payload. A reader additionally re-hashes the loaded JSON
// and rejects it if it does not match the committed checksum, so a torn/altered
// payload is detected as `corrupt`, never restored as garbage.
//
// ## Unclean-shutdown detection (no false positives)
//
// A local snapshot exists ONLY while there are un-synced local edits: the
// server save-success path (`persistence.ts`) clears it once the server has the
// data (a crash after a successful server save loses nothing, so nothing is
// offered). Therefore:
//
//   prompt for recovery  ⟺  a committed marker+payload exists
//                            AND marker.cleanShutdown !== true
//
//  - a normal tab close fires `pagehide` → `markCleanShutdown()` sets
//    `cleanShutdown = true` → next launch shows NO prompt (a clean exit is the
//    user's choice; only a crash recovers);
//  - a crash fires no handler → `cleanShutdown` stays `false` → prompt (if a
//    snapshot with un-synced edits is present);
//  - `cleanShutdown` is reset to `false` only when a snapshot is actually
//    written (i.e. the CURRENT session produced un-synced edits), so a stale
//    snapshot left from a previous clean exit is never re-offered.
//
// ## Privacy posture (PHI)
//
// The snapshot may contain case data (a `CaseDocument`) — it stays LOCAL, on
// the user's own machine (IndexedDB/localStorage in their browser profile),
// exactly like the running app's in-memory state. Nothing here sends anything
// anywhere: there is no `fetch`/network egress in this module. The server path
// (engine/persistence.ts) is entirely unchanged.
import type { CaseDocument } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';

/** Bump only on a breaking change to the marker/payload shape. A marker with a
 * different schemaVersion is IGNORED at launch (never restored, never errored)
 * — forward/backward compatible, no destructive guess. */
export const RECOVERY_SCHEMA_VERSION = 1;

/** Debounce for the local crash-safe write. Deliberately far SHORTER than the
 * 30 s server autosave (persistence.ts) — the whole point of the local layer is
 * to capture edits BEFORE the server debounce fires. Non-blocking (async IDB),
 * so this cadence never costs UI-thread time. */
export const LOCAL_SNAPSHOT_DEBOUNCE_MS = 2_000;

const MARKER_STORAGE_KEY = 'dqcad.recovery.marker';
const PAYLOAD_DB_NAME = 'dqcad-recovery';
const PAYLOAD_STORE_NAME = 'payloads';

/** The tiny, synchronous commit marker (localStorage). */
export interface RecoveryMarker {
  schemaVersion: number;
  /** Identifies the writing session — diagnostic only. */
  sessionId: string;
  /** `true` once this session exited gracefully (pagehide). A crash leaves it
   * `false`, which is what makes the unclean shutdown detectable. */
  cleanShutdown: boolean;
  caseId: string;
  caseName: string;
  /** ISO-8601 — metadata/display only, NEVER fed into a computation
   * (determinism: the recovered document's replay path uses no timestamp). */
  snapshotAt: string;
  /** SHA-256 (lowercase hex) of the exact payload JSON string — the commit
   * pointer AND the corruption check. */
  payloadChecksum: string;
  /** Count of journal ops in the snapshot — diagnostic for the prompt. */
  journalOperationCount: number;
}

export type RecoveryDetection =
  | { kind: 'none' }
  | { kind: 'corrupt'; reason: string; marker: RecoveryMarker }
  | { kind: 'recoverable'; document: CaseDocument; marker: RecoveryMarker };

/** Synchronous marker store (localStorage-backed in production). */
export interface RecoveryMarkerStore {
  read(): RecoveryMarker | null;
  write(marker: RecoveryMarker): void;
  clear(): void;
}

/** Async, content-addressed payload store (IndexedDB-backed in production). */
export interface RecoveryPayloadStore {
  read(checksum: string): Promise<string | null>;
  write(checksum: string, json: string): Promise<void>;
  /** Delete every stored payload whose key !== `keep` (`keep === null` deletes
   * all). The post-commit GC step — never touches the just-committed payload. */
  prune(keep: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// SHA-256 (main thread, non-blocking) — WebCrypto is present in the browser
// AND in the Node test environment (globalThis.crypto.subtle), so this module
// needs no worker round trip and no Node-only import.
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Production stores (guarded so they are inert under the Node test env, where
// there is no `window`/`indexedDB` — tests inject their own fakes anyway).
// ---------------------------------------------------------------------------

function hasWorkingLocalStorage(): boolean {
  // Same guard rationale as state/appStore.ts: gate on `window` so we never
  // touch Node 22+'s throwing `localStorage` stub under the node test env.
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const storage = window.localStorage;
    return typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
  } catch {
    return false;
  }
}

function createLocalStorageMarkerStore(): RecoveryMarkerStore {
  return {
    read(): RecoveryMarker | null {
      if (!hasWorkingLocalStorage()) {
        return null;
      }
      const raw = window.localStorage.getItem(MARKER_STORAGE_KEY);
      if (raw === null) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as RecoveryMarker;
        return parsed;
      } catch {
        // A corrupt marker string is treated as "no marker" — the payload it
        // would have pointed at is unreachable anyway. Never throws at launch.
        return null;
      }
    },
    write(marker: RecoveryMarker): void {
      if (!hasWorkingLocalStorage()) {
        return;
      }
      window.localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(marker));
    },
    clear(): void {
      if (!hasWorkingLocalStorage()) {
        return;
      }
      window.localStorage.removeItem(MARKER_STORAGE_KEY);
    },
  };
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openPayloadDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PAYLOAD_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAYLOAD_STORE_NAME)) {
        db.createObjectStore(PAYLOAD_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('crashRecovery: indexedDB open failed'));
  });
}

function createIndexedDbPayloadStore(): RecoveryPayloadStore {
  return {
    async read(checksum: string): Promise<string | null> {
      if (!hasIndexedDb()) {
        return null;
      }
      const db = await openPayloadDb();
      try {
        return await new Promise<string | null>((resolve, reject) => {
          const tx = db.transaction(PAYLOAD_STORE_NAME, 'readonly');
          const req = tx.objectStore(PAYLOAD_STORE_NAME).get(checksum);
          req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
          req.onerror = () => reject(req.error ?? new Error('crashRecovery: payload read failed'));
        });
      } finally {
        db.close();
      }
    },
    async write(checksum: string, json: string): Promise<void> {
      if (!hasIndexedDb()) {
        return;
      }
      const db = await openPayloadDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(PAYLOAD_STORE_NAME, 'readwrite');
          tx.objectStore(PAYLOAD_STORE_NAME).put(json, checksum);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('crashRecovery: payload write failed'));
        });
      } finally {
        db.close();
      }
    },
    async prune(keep: string | null): Promise<void> {
      if (!hasIndexedDb()) {
        return;
      }
      const db = await openPayloadDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(PAYLOAD_STORE_NAME, 'readwrite');
          const store = tx.objectStore(PAYLOAD_STORE_NAME);
          const keysReq = store.getAllKeys();
          keysReq.onsuccess = () => {
            for (const key of keysReq.result) {
              if (keep === null || key !== keep) {
                store.delete(key);
              }
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('crashRecovery: payload prune failed'));
        });
      } finally {
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Store wiring + test seams.
// ---------------------------------------------------------------------------

let markerStoreOverride: RecoveryMarkerStore | null = null;
let payloadStoreOverride: RecoveryPayloadStore | null = null;
let defaultMarkerStore: RecoveryMarkerStore | null = null;
let defaultPayloadStore: RecoveryPayloadStore | null = null;

function markerStore(): RecoveryMarkerStore {
  if (markerStoreOverride) {
    return markerStoreOverride;
  }
  defaultMarkerStore ??= createLocalStorageMarkerStore();
  return defaultMarkerStore;
}

function payloadStore(): RecoveryPayloadStore {
  if (payloadStoreOverride) {
    return payloadStoreOverride;
  }
  defaultPayloadStore ??= createIndexedDbPayloadStore();
  return defaultPayloadStore;
}

/** TEST-ONLY: inject in-memory stores (mirrors persistence.ts's
 * `__setFinalMeshSourceForTests`). Pass `null` for either to restore the
 * production (localStorage/IndexedDB) implementation. */
export function __setRecoveryStoresForTests(
  marker: RecoveryMarkerStore | null,
  payload: RecoveryPayloadStore | null,
): void {
  markerStoreOverride = marker;
  payloadStoreOverride = payload;
}

// A stable per-session id (diagnostic only). Regenerated on reset-for-tests so
// each test starts clean.
let sessionId = generateSessionId();

function generateSessionId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `session-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Snapshot writing / clearing.
// ---------------------------------------------------------------------------

/**
 * Writes a crash-safe local snapshot of the CURRENTLY active case IFF it has
 * un-synced-to-server edits. Decides purely off the published server-save
 * status (persistence.ts owns it): a 'saved'/'idle'/'saving' case is already
 * on (or actively reaching) the server, so there is nothing local to protect
 * and this is a no-op. For an 'unsaved'/'error' case it content-addresses the
 * document JSON, stages it, then commits via the marker (write-then-swap) and
 * prunes older payloads. Non-blocking; safe to call from a debounce timer.
 */
export async function writeLocalSnapshot(): Promise<void> {
  const persistence = usePersistenceStore.getState();
  if (persistence.activeCaseId === null) {
    return;
  }
  // 'saved'/'saving'/'idle' ⇒ the server has, or is in the middle of getting,
  // this exact state — no un-synced local edits to protect.
  if (persistence.status !== 'unsaved' && persistence.status !== 'error') {
    return;
  }
  const document = useCaseStore.getState().document;
  const json = JSON.stringify(document);
  const checksum = await sha256Hex(json);
  // 1. stage the content-addressed payload (never overwrites a prior commit)
  await payloadStore().write(checksum, json);
  // 2. commit — flip the marker to this checksum, resetting cleanShutdown to
  //    false (this session now has recoverable un-synced edits).
  const snapshotAt = new Date().toISOString();
  markerStore().write({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    sessionId,
    cleanShutdown: false,
    caseId: persistence.activeCaseId,
    caseName: persistence.activeCaseName ?? '',
    snapshotAt,
    payloadChecksum: checksum,
    journalOperationCount: document.history.length,
  });
  // 3. GC older staged payloads (keep only the just-committed one).
  await payloadStore().prune(checksum);
  usePersistenceStore.getState().setLocalBackupAt(snapshotAt);
}

/**
 * Clears the local snapshot (marker + every payload). Called by
 * engine/persistence.ts once the server confirms a save (the durable copy is
 * now server-side, so a crash loses nothing) and by an explicit user DISCARD.
 * Never called silently over un-synced edits from anywhere else.
 */
export async function clearLocalSnapshot(): Promise<void> {
  markerStore().clear();
  await payloadStore().prune(null);
  usePersistenceStore.getState().setLocalBackupAt(null);
}

/**
 * Marks the current session as cleanly shut down (graceful exit / pagehide) so
 * the next launch does NOT show a spurious recovery prompt. Synchronous (the
 * marker store is localStorage) so it completes during page teardown. The
 * snapshot payload is deliberately LEFT in place: it is harmless (the
 * cleanShutdown flag guards it) and avoids an unreliable async IDB delete on
 * unload; the next session's first snapshot write overwrites it.
 */
export function markCleanShutdown(): void {
  const marker = markerStore().read();
  if (marker === null) {
    return;
  }
  markerStore().write({ ...marker, cleanShutdown: true });
}

// ---------------------------------------------------------------------------
// Launch-time detection.
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal structural validation — enough to REJECT garbage (a truncated /
 * tampered / foreign JSON) without duplicating the server's full schema. A
 * failure here yields `corrupt`, never a restore of a malformed document. */
function isValidCaseDocument(value: unknown): value is CaseDocument {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value['schemaVersion'] === 2 &&
    typeof value['id'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    Array.isArray(value['meshes']) &&
    Array.isArray(value['scene']) &&
    Array.isArray(value['restorations']) &&
    Array.isArray(value['measurements']) &&
    Array.isArray(value['history']) &&
    isPlainRecord(value['settings'])
  );
}

/**
 * Detects, at launch, whether the previous session left recoverable un-synced
 * work. See this module's doc for the exact rule. Returns:
 *  - `none` — nothing to recover (no marker / clean shutdown / dangling
 *    pointer / unknown schema);
 *  - `corrupt` — a committed snapshot exists but its payload fails the checksum
 *    or is not a valid `CaseDocument` (rejected, never restored — the user is
 *    informed, then acknowledges before it is discarded);
 *  - `recoverable` — a valid, checksum-verified pre-crash `CaseDocument`.
 * Never throws (a launch-time read must not crash the app).
 */
export async function detectRecovery(): Promise<RecoveryDetection> {
  const marker = markerStore().read();
  if (marker === null) {
    return { kind: 'none' };
  }
  if (marker.schemaVersion !== RECOVERY_SCHEMA_VERSION) {
    // Unknown shape — do not guess, do not error, do not restore.
    return { kind: 'none' };
  }
  if (marker.cleanShutdown) {
    return { kind: 'none' };
  }
  let json: string | null;
  try {
    json = await payloadStore().read(marker.payloadChecksum);
  } catch {
    // A payload-store read failure at launch is treated as "nothing to
    // recover" rather than crashing the boot — the marker's committed payload
    // is unreachable.
    return { kind: 'none' };
  }
  if (json === null) {
    // Dangling pointer: the committed payload is gone (a torn first write that
    // never committed, or an external clear). Nothing valid to restore.
    return { kind: 'none' };
  }
  const actualChecksum = await sha256Hex(json);
  if (actualChecksum !== marker.payloadChecksum) {
    return { kind: 'corrupt', reason: 'checksum-mismatch', marker };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'corrupt', reason: 'unparseable-json', marker };
  }
  if (!isValidCaseDocument(parsed)) {
    return { kind: 'corrupt', reason: 'invalid-document-shape', marker };
  }
  return { kind: 'recoverable', document: parsed, marker };
}

// ---------------------------------------------------------------------------
// Change tracking (debounced local snapshot) + graceful-exit handler.
// ---------------------------------------------------------------------------

let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let pagehideHandler: (() => void) | null = null;

function clearSnapshotTimer(): void {
  if (snapshotTimer !== null) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
}

function scheduleLocalSnapshot(): void {
  clearSnapshotTimer();
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    void writeLocalSnapshot();
  }, LOCAL_SNAPSHOT_DEBOUNCE_MS);
}

/**
 * Starts the local crash-safe autosave: a debounced snapshot on every
 * `CaseDocument` change, plus a `pagehide` handler that marks a clean shutdown.
 * Idempotent (safe to call once at launch); a second call is a no-op. Returns a
 * disposer (used by tests). Subscribing here — rather than from a React effect
 * — matches the singleton-engine convention (persistence.ts's own
 * `useCaseStore.subscribe`).
 */
export function startLocalSnapshotTracking(): () => void {
  if (unsubscribe !== null) {
    return stopLocalSnapshotTracking;
  }
  unsubscribe = useCaseStore.subscribe((state, previous) => {
    if (state.document === previous.document) {
      return; // pure selection change — not a document mutation.
    }
    if (usePersistenceStore.getState().activeCaseId === null) {
      return; // no case open — nothing to protect yet.
    }
    scheduleLocalSnapshot();
  });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    pagehideHandler = () => markCleanShutdown();
    window.addEventListener('pagehide', pagehideHandler);
  }
  return stopLocalSnapshotTracking;
}

function stopLocalSnapshotTracking(): void {
  clearSnapshotTimer();
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  if (pagehideHandler !== null && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', pagehideHandler);
    pagehideHandler = null;
  }
}

/** TEST-ONLY: resets this module's singleton timer/subscription/session state
 * so tests do not leak state across files (mirrors persistence.ts's
 * `resetPersistenceForTests`). Does NOT clear the injected stores' contents. */
export function resetCrashRecoveryForTests(): void {
  stopLocalSnapshotTracking();
  sessionId = generateSessionId();
}
