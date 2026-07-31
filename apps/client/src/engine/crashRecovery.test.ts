// apps/client/src/engine/crashRecovery.test.ts
//
// Phase 8 Task 4 — the crash-safe local layer, falsifiable BOTH ways:
//  1. crash mid-edit → next launch DETECTS it and recovery is state-IDENTICAL
//     (deep-equal document AND journal-replay-hash identical);
//  2. clean exit → next launch shows NO spurious prompt;
//  3. a corrupt/partial snapshot → DETECTED and REJECTED (never restored as
//     garbage);
//  4. atomicity — a snapshot is never readable half-written (a write
//     interrupted between staging the payload and committing the marker yields
//     the PREVIOUS committed snapshot, or none, never the half-staged one).
//
// The stores are injected in-memory fakes (mirrors persistence.ts's
// `__setFinalMeshSourceForTests`); the marker store is synchronous (localStorage
// stand-in) and the payload store is async + content-addressed (IndexedDB
// stand-in), exactly as production splits them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashCaseJournal } from '@dqcad/kernel-workers';
import type { CaseDocument, Operation } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';
import {
  __setRecoveryStoresForTests,
  clearLocalSnapshot,
  detectRecovery,
  LOCAL_SNAPSHOT_DEBOUNCE_MS,
  markCleanShutdown,
  RECOVERY_SCHEMA_VERSION,
  resetCrashRecoveryForTests,
  startLocalSnapshotTracking,
  writeLocalSnapshot,
  type RecoveryMarker,
  type RecoveryMarkerStore,
  type RecoveryPayloadStore,
} from './crashRecovery';

class FakeMarkerStore implements RecoveryMarkerStore {
  value: RecoveryMarker | null = null;
  read(): RecoveryMarker | null {
    return this.value;
  }
  write(marker: RecoveryMarker): void {
    this.value = { ...marker };
  }
  clear(): void {
    this.value = null;
  }
}

class FakePayloadStore implements RecoveryPayloadStore {
  readonly map = new Map<string, string>();
  async read(checksum: string): Promise<string | null> {
    return this.map.get(checksum) ?? null;
  }
  async write(checksum: string, json: string): Promise<void> {
    this.map.set(checksum, json);
  }
  async delete(checksum: string): Promise<void> {
    this.map.delete(checksum);
  }
  async prune(keep: string | null): Promise<void> {
    for (const key of [...this.map.keys()]) {
      if (keep === null || key !== keep) {
        this.map.delete(key);
      }
    }
  }
}

/** A payload store whose `write` STAGES the payload, signals `staged`, then
 * suspends on a gate the test releases — lets a test force the exact
 * clear-vs-write interleave (the HIGH dangling-marker race). */
class GatedPayloadStore implements RecoveryPayloadStore {
  readonly map = new Map<string, string>();
  staged: Promise<void> | null = null;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private signalStaged: (() => void) | null = null;
  arm(): void {
    this.gate = new Promise<void>((r) => {
      this.release = r;
    });
    this.staged = new Promise<void>((r) => {
      this.signalStaged = r;
    });
  }
  releaseGate(): void {
    this.release?.();
  }
  async read(checksum: string): Promise<string | null> {
    return this.map.get(checksum) ?? null;
  }
  async write(checksum: string, json: string): Promise<void> {
    this.map.set(checksum, json);
    if (this.gate) {
      this.signalStaged?.();
      await this.gate;
    }
  }
  async delete(checksum: string): Promise<void> {
    this.map.delete(checksum);
  }
  async prune(keep: string | null): Promise<void> {
    for (const key of [...this.map.keys()]) {
      if (keep === null || key !== keep) {
        this.map.delete(key);
      }
    }
  }
}

let markerStore: FakeMarkerStore;
let payloadStore: FakePayloadStore;

function op(id: string, name: string, outputHash: string): Operation {
  return {
    id,
    name,
    params: { step: name, nested: { a: 1, b: [3, 2, 1] } },
    inputHashes: [],
    outputHashes: [outputHash],
    kernelVersion: '0.26.0',
    timestamp: '2026-07-18T00:00:00.000Z',
  };
}

/** A representative, non-trivial case document with a real multi-op journal. */
function buildDocument(id = 'case-1'): CaseDocument {
  return {
    id,
    schemaVersion: 2,
    createdAt: '2026-07-18T00:00:00.000Z',
    meshes: [{ id: 'm1', contentHash: 'hash-a', name: 'prep.stl', unit: 'mm', triangleCount: 4 }],
    scene: [
      { id: 'n1', meshId: 'hash-a', role: 'prepDie', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], visible: true, opacity: 1 },
    ],
    restorations: [],
    measurements: [
      { id: 'meas-1', kind: 'pointToPoint', points: [{ nodeId: 'n1', position: [0, 0, 0] }, { nodeId: 'n1', position: [1, 0, 0] }], value: 1, createdAt: '2026-07-18T00:01:00.000Z' },
    ],
    history: [op('op-1', 'import-mesh', 'hash-a'), op('op-2', 'margin-commit', 'hash-b')],
    settings: { materialProfileId: 'zirconia', profileVersion: '1.4.0' },
  };
}

function activateCase(id: string, status: 'unsaved' | 'saved' | 'error' | 'saving' | 'idle', document?: CaseDocument): void {
  useCaseStore.setState({ document: document ?? buildDocument(id) });
  usePersistenceStore.setState({ activeCaseId: id, activeCaseName: `Name ${id}`, status });
}

beforeEach(() => {
  markerStore = new FakeMarkerStore();
  payloadStore = new FakePayloadStore();
  __setRecoveryStoresForTests(markerStore, payloadStore);
  resetCrashRecoveryForTests();
  usePersistenceStore.setState({
    status: 'idle',
    errorMessage: null,
    activeCaseId: null,
    activeCaseName: null,
    lastSavedAt: null,
    localBackupAt: null,
  });
  useCaseStore.setState({ document: buildDocument('reset') });
});

afterEach(() => {
  resetCrashRecoveryForTests();
  __setRecoveryStoresForTests(null, null);
});

describe('writeLocalSnapshot — when it captures state', () => {
  it('writes a snapshot for an active case with un-synced ("unsaved") edits', async () => {
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();

    const marker = markerStore.read();
    expect(marker).not.toBeNull();
    expect(marker!.caseId).toBe('case-1');
    expect(marker!.cleanShutdown).toBe(false);
    expect(marker!.schemaVersion).toBe(RECOVERY_SCHEMA_VERSION);
    expect(marker!.journalOperationCount).toBe(2);
    expect(payloadStore.map.has(marker!.payloadChecksum)).toBe(true);
    // Honest visibility: local-backup timestamp published.
    expect(usePersistenceStore.getState().localBackupAt).toBe(marker!.snapshotAt);
  });

  it('is a NO-OP when the document is already server-synced ("saved") — nothing local to protect', async () => {
    activateCase('case-1', 'saved');
    await writeLocalSnapshot();
    expect(markerStore.read()).toBeNull();
    expect(payloadStore.map.size).toBe(0);
  });

  it('is a NO-OP when no case is open', async () => {
    usePersistenceStore.setState({ activeCaseId: null, status: 'idle' });
    await writeLocalSnapshot();
    expect(markerStore.read()).toBeNull();
  });

  it('also captures state in the "error" (server save failed) status — the un-synced edits still need protecting', async () => {
    activateCase('case-1', 'error');
    await writeLocalSnapshot();
    expect(markerStore.read()).not.toBeNull();
  });
});

describe('FALSIFIABLE #1 — crash mid-edit → detect → state-IDENTICAL recovery', () => {
  it('detects the unclean shutdown and recovers a document deep-equal to the pre-crash one, journal-replay bit-identical', async () => {
    const preCrash = buildDocument('case-1');
    activateCase('case-1', 'unsaved', preCrash);
    await writeLocalSnapshot();
    // (a crash: no markCleanShutdown, no server save — marker stays cleanShutdown=false)

    const detection = await detectRecovery();
    expect(detection.kind).toBe('recoverable');
    if (detection.kind !== 'recoverable') return;

    // Structural identity.
    expect(detection.document).toEqual(preCrash);
    // Journal-replay identity: the shared reproducible-journal hash matches.
    const recoveredHash = await hashCaseJournal(detection.document.history);
    const originalHash = await hashCaseJournal(preCrash.history);
    expect(recoveredHash).toBe(originalHash);
    // The marker carries the un-PHI display metadata.
    expect(detection.marker.caseId).toBe('case-1');
    expect(detection.marker.journalOperationCount).toBe(preCrash.history.length);
  });
});

describe('FALSIFIABLE #2 — clean exit → NO spurious recovery prompt', () => {
  it('a graceful shutdown (markCleanShutdown) makes the next launch detect nothing', async () => {
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();
    expect(markerStore.read()!.cleanShutdown).toBe(false);

    markCleanShutdown(); // pagehide

    expect(markerStore.read()!.cleanShutdown).toBe(true);
    const detection = await detectRecovery();
    expect(detection.kind).toBe('none');
  });

  it('no marker at all (fresh install) → detect none', async () => {
    const detection = await detectRecovery();
    expect(detection.kind).toBe('none');
  });

  it('SF1: a FOREIGN tab\'s clean close does NOT mask this tab\'s crash (sessionId-guarded)', async () => {
    // Tab A (session A) writes the shared marker for its un-synced edits.
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();
    const sessionA = markerStore.read()!.sessionId;
    expect(markerStore.read()!.cleanShutdown).toBe(false);

    // Tab B: a DIFFERENT session opens and closes cleanly (its own pagehide).
    resetCrashRecoveryForTests(); // regenerates the module session id → session B
    markCleanShutdown();

    // Tab A's marker must be untouched — a foreign tab cannot mark A's crash
    // clean. Before the sessionId guard this flipped cleanShutdown=true and the
    // next launch returned 'none' (A's work silently lost).
    expect(markerStore.read()!.sessionId).toBe(sessionA);
    expect(markerStore.read()!.cleanShutdown).toBe(false);
    expect((await detectRecovery()).kind).toBe('recoverable');
  });

  it('SF1: the SAME session\'s clean close still marks clean (single-tab reload path preserved)', async () => {
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();
    // Same session (no reset) → the guard permits the flip.
    markCleanShutdown();
    expect(markerStore.read()!.cleanShutdown).toBe(true);
    expect((await detectRecovery()).kind).toBe('none');
  });
});

describe('FALSIFIABLE #3 — corrupt / partial snapshot → detected and REJECTED', () => {
  it('a payload whose bytes no longer match the committed checksum is reported "corrupt", never restored', async () => {
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();
    const checksum = markerStore.read()!.payloadChecksum;

    // Simulate a torn / tampered payload: mutate the stored bytes in place so
    // they no longer hash to the committed checksum.
    payloadStore.map.set(checksum, payloadStore.map.get(checksum)!.slice(0, -5) + 'XXXXX');

    const detection = await detectRecovery();
    expect(detection.kind).toBe('corrupt');
    if (detection.kind === 'corrupt') {
      expect(detection.reason).toBe('checksum-mismatch');
    }
  });

  it('a payload that is valid-checksummed but not a CaseDocument is rejected as corrupt (shape check)', async () => {
    // Commit a garbage payload directly (checksum matches, shape does not).
    const garbage = JSON.stringify({ hello: 'world' });
    const checksum = await sha256(garbage);
    await payloadStore.write(checksum, garbage);
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'case-1',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: checksum,
      journalOperationCount: 0,
    });

    const detection = await detectRecovery();
    expect(detection.kind).toBe('corrupt');
    if (detection.kind === 'corrupt') {
      expect(detection.reason).toBe('invalid-document-shape');
    }
  });
});

describe('FALSIFIABLE #4 — atomicity: a snapshot is never readable half-written', () => {
  it('a write interrupted between staging the payload and committing the marker recovers the PREVIOUS committed snapshot, not the half-staged one', async () => {
    // Commit v1 fully.
    const v1 = buildDocument('case-1');
    activateCase('case-1', 'unsaved', v1);
    await writeLocalSnapshot();
    const committedChecksum = markerStore.read()!.payloadChecksum;

    // Simulate an interrupted v2 write: stage the v2 payload, but crash before
    // the marker commit (the marker still points at v1).
    const v2 = { ...v1, measurements: [] };
    const v2Json = JSON.stringify(v2);
    const v2Checksum = await sha256(v2Json);
    await payloadStore.write(v2Checksum, v2Json); // staged, NOT committed
    expect(v2Checksum).not.toBe(committedChecksum);

    const detection = await detectRecovery();
    expect(detection.kind).toBe('recoverable');
    if (detection.kind !== 'recoverable') return;
    // The committed pointer governs — v1 is recovered, the half-staged v2 is
    // never observed as a valid snapshot.
    expect(detection.document).toEqual(v1);
    expect(detection.marker.payloadChecksum).toBe(committedChecksum);
  });

  it('a torn FIRST write (payload staged, marker never committed) yields nothing to recover — never garbage', async () => {
    // No prior marker. Stage a payload with no committing marker.
    const json = JSON.stringify(buildDocument('case-1'));
    await payloadStore.write(await sha256(json), json);

    const detection = await detectRecovery();
    expect(detection.kind).toBe('none');
  });

  it('a committed marker pointing at a payload that is GONE (dangling) is treated as nothing-to-recover', async () => {
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'case-1',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: 'deadbeef',
      journalOperationCount: 0,
    });
    const detection = await detectRecovery();
    expect(detection.kind).toBe('none');
  });
});

describe('clearLocalSnapshot / server-sync clears the recoverable state', () => {
  it('clears the marker + payloads and resets the local-backup timestamp', async () => {
    activateCase('case-1', 'unsaved');
    await writeLocalSnapshot();
    expect(markerStore.read()).not.toBeNull();

    await clearLocalSnapshot();

    expect(markerStore.read()).toBeNull();
    expect(payloadStore.map.size).toBe(0);
    expect(usePersistenceStore.getState().localBackupAt).toBeNull();
    expect((await detectRecovery()).kind).toBe('none');
  });
});

describe('unknown-schema marker is ignored (forward-compat, no destructive guess)', () => {
  it('detect returns none for a marker with a future schemaVersion', async () => {
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION + 1,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'case-1',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: 'x',
      journalOperationCount: 0,
    });
    expect((await detectRecovery()).kind).toBe('none');
  });
});

describe('startLocalSnapshotTracking — debounced autosave on document change', () => {
  it('writes a snapshot a debounce after a document mutation of an unsaved case', async () => {
    vi.useFakeTimers();
    try {
      activateCase('case-1', 'unsaved');
      startLocalSnapshotTracking();

      // Mutate the document (new reference) — schedules the debounced write.
      useCaseStore.setState({ document: { ...buildDocument('case-1'), measurements: [] } });
      expect(markerStore.read()).toBeNull(); // not yet

      await vi.advanceTimersByTimeAsync(LOCAL_SNAPSHOT_DEBOUNCE_MS - 1);
      expect(markerStore.read()).toBeNull();

      // Fires the debounce → writeLocalSnapshot() STARTS. Its actual write is
      // gated behind an `await sha256Hex()` (real-async WebCrypto, NOT
      // controlled by fake timers), so the marker is not guaranteed to be
      // present the instant the timer fires.
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    // Deterministically wait for the real-async write to settle (avoids a
    // cross-test leak where a not-yet-settled write lands in the next test).
    await vi.waitFor(() => {
      expect(markerStore.read()).not.toBeNull();
    });
    expect(markerStore.read()!.caseId).toBe('case-1');
  });

  it('does not schedule a snapshot when no case is open', async () => {
    vi.useFakeTimers();
    try {
      usePersistenceStore.setState({ activeCaseId: null, status: 'idle' });
      startLocalSnapshotTracking();
      // No case open → the subscription returns early, so no debounce is ever
      // scheduled (no timer, no async write to leak) — advancing well past the
      // debounce writes nothing.
      useCaseStore.setState({ document: buildDocument('x') });
      await vi.advanceTimersByTimeAsync(LOCAL_SNAPSHOT_DEBOUNCE_MS + 10);
      expect(markerStore.read()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('defensive + lifecycle paths', () => {
  it('markCleanShutdown is a safe no-op when there is no marker', () => {
    expect(() => markCleanShutdown()).not.toThrow();
    expect(markerStore.read()).toBeNull();
  });

  it('rejects a valid-checksummed payload that parses to a non-object (array) as corrupt', async () => {
    const json = JSON.stringify([]);
    const checksum = await sha256(json);
    await payloadStore.write(checksum, json);
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'c',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: checksum,
      journalOperationCount: 0,
    });
    const detection = await detectRecovery();
    expect(detection.kind).toBe('corrupt');
    if (detection.kind === 'corrupt') expect(detection.reason).toBe('invalid-document-shape');
  });

  it('rejects a valid-checksummed payload that is not JSON at all as corrupt', async () => {
    const raw = 'this is not json {';
    const checksum = await sha256(raw);
    await payloadStore.write(checksum, raw);
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'c',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: checksum,
      journalOperationCount: 0,
    });
    const detection = await detectRecovery();
    expect(detection.kind).toBe('corrupt');
    if (detection.kind === 'corrupt') expect(detection.reason).toBe('unparseable-json');
  });

  it('treats a payload-store read failure at launch as nothing-to-recover (never crashes boot)', async () => {
    const throwingPayload: RecoveryPayloadStore = {
      read: () => Promise.reject(new Error('idb unavailable')),
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      prune: () => Promise.resolve(),
    };
    __setRecoveryStoresForTests(markerStore, throwingPayload);
    markerStore.write({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      sessionId: 's',
      cleanShutdown: false,
      caseId: 'c',
      caseName: 'X',
      snapshotAt: '2026-07-18T00:00:00.000Z',
      payloadChecksum: 'abc',
      journalOperationCount: 0,
    });
    expect((await detectRecovery()).kind).toBe('none');
  });

  it('startLocalSnapshotTracking is idempotent; resetting cancels a pending debounced write', async () => {
    vi.useFakeTimers();
    try {
      activateCase('case-1', 'unsaved');
      const dispose1 = startLocalSnapshotTracking();
      const dispose2 = startLocalSnapshotTracking(); // idempotent — same disposer
      expect(dispose2).toBe(dispose1);

      useCaseStore.setState({ document: { ...buildDocument('case-1'), measurements: [] } });
      // Reset (models teardown) BEFORE the debounce fires — the pending timer
      // is cleared, so no snapshot is written.
      resetCrashRecoveryForTests();
      await vi.advanceTimersByTimeAsync(LOCAL_SNAPSHOT_DEBOUNCE_MS + 10);
      expect(markerStore.read()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FALSIFIABLE (HIGH) — writeLocalSnapshot protects an edit across the whole save window', () => {
  it('captures a snapshot even while a server save is IN FLIGHT (status "saving")', async () => {
    // A quick Cmd/Ctrl+S within the 2 s local debounce flips status to
    // 'saving' before the snapshot timer fires. "In the middle of getting to
    // the server" is NOT durable — a crash during the PUT means the server
    // never got it — so the local snapshot MUST still protect the edit. Pre-fix
    // writeLocalSnapshot early-returned for any status other than
    // unsaved/error, leaving the edit protected nowhere during the PUT.
    activateCase('case-1', 'saving');
    await writeLocalSnapshot();
    const marker = markerStore.read();
    expect(marker).not.toBeNull(); // FAILS pre-fix: no-op while 'saving'
    expect(marker!.caseId).toBe('case-1');
    expect(payloadStore.map.has(marker!.payloadChecksum)).toBe(true);
  });
});

describe('FALSIFIABLE (HIGH) — clearLocalSnapshot never races writeLocalSnapshot into a dangling marker', () => {
  it('a server-sync clear concurrent with a debounced write never commits the marker at a pruned payload', async () => {
    const gated = new GatedPayloadStore();
    __setRecoveryStoresForTests(markerStore, gated);
    resetCrashRecoveryForTests(); // fresh session/owned-set/mutex for this store

    activateCase('case-1', 'unsaved', buildDocument('case-1'));
    gated.arm();

    // writeLocalSnapshot stages its payload, then suspends on the gate.
    const writePromise = writeLocalSnapshot();
    await gated.staged;

    // The server save resolves → clearLocalSnapshot fires. Pre-fix (no mutex)
    // it prunes the just-staged payload while the marker commit is still
    // pending; post-fix it is serialized behind the in-flight write.
    const clearPromise = clearLocalSnapshot();
    gated.releaseGate();
    await Promise.all([writePromise, clearPromise]);

    // The core invariant: a committed marker must NEVER point at a payload that
    // was pruned out from under it (that is the dangling → silent-loss state).
    const marker = markerStore.read();
    if (marker !== null) {
      expect(gated.map.has(marker.payloadChecksum)).toBe(true); // FAILS pre-fix
    }
    // And detection must not silently degrade to a dangling 'none'.
    const detection = await detectRecovery();
    expect(detection.kind === 'recoverable' || detection.kind === 'none').toBe(true);
  });
});

describe('FALSIFIABLE (HIGH) — multi-tab: a second tab does not destroy the first tab\'s un-synced payload', () => {
  it('a second session\'s snapshot prunes only ITS OWN payloads, never a foreign live tab\'s', async () => {
    // Tab A (session A) writes an un-synced snapshot for case-1.
    activateCase('case-1', 'unsaved', buildDocument('case-1'));
    await writeLocalSnapshot();
    const checksumA = markerStore.read()!.payloadChecksum;
    expect(payloadStore.map.has(checksumA)).toBe(true);

    // Tab B is a DIFFERENT session (a new tab — modelled by regenerating the
    // module session id + its owned-checksum set) editing a different case; the
    // shared marker + payload stores persist across the "tabs".
    resetCrashRecoveryForTests();
    activateCase('case-2', 'unsaved', buildDocument('case-2'));
    await writeLocalSnapshot();
    const checksumB = markerStore.read()!.payloadChecksum;
    expect(checksumB).not.toBe(checksumA);

    // Tab B pruned only its own session's payloads — tab A's un-synced payload
    // survives. Pre-fix the blanket prune-all deleted checksumA, so tab A's
    // un-synced case-1 edits were silently lost on its next crash.
    expect(payloadStore.map.has(checksumB)).toBe(true);
    expect(payloadStore.map.has(checksumA)).toBe(true); // FAILS pre-fix
  });
});

// Local SHA-256 helper for the test (same algorithm the module uses).
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
