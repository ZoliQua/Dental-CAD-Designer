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

      await vi.advanceTimersByTimeAsync(1);
      expect(markerStore.read()).not.toBeNull();
      expect(markerStore.read()!.caseId).toBe('case-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule a snapshot when no case is open', async () => {
    vi.useFakeTimers();
    try {
      usePersistenceStore.setState({ activeCaseId: null, status: 'idle' });
      startLocalSnapshotTracking();
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

// Local SHA-256 helper for the test (same algorithm the module uses).
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
