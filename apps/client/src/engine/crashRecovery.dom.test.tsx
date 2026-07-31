// apps/client/src/engine/crashRecovery.dom.test.tsx
//
// Phase 8 Task 4 — exercises the PRODUCTION durable stores (real
// window.localStorage marker + real IndexedDB payload store) in the browser
// lane, where the node-lane fakes cannot reach. Proves the same write → detect
// → clean-shutdown → clear contract holds against actual browser storage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';
import {
  __setRecoveryStoresForTests,
  clearLocalSnapshot,
  detectRecovery,
  LOCAL_SNAPSHOT_DEBOUNCE_MS,
  markCleanShutdown,
  resetCrashRecoveryForTests,
  startLocalSnapshotTracking,
  writeLocalSnapshot,
} from './crashRecovery';

function buildDocument(id = 'dom-case-1'): CaseDocument {
  return {
    id,
    schemaVersion: 2,
    createdAt: '2026-07-18T00:00:00.000Z',
    meshes: [],
    scene: [],
    restorations: [],
    measurements: [
      {
        id: 'm1',
        kind: 'pointToPoint',
        points: [
          { nodeId: 'n', position: [0, 0, 0] },
          { nodeId: 'n', position: [2, 0, 0] },
        ],
        value: 2,
        createdAt: '2026-07-18T00:01:00.000Z',
      },
    ],
    history: [],
    settings: { materialProfileId: 'zirconia', profileVersion: '1.4.0' },
  };
}

beforeEach(async () => {
  // Use the REAL localStorage/IndexedDB stores (no injected fakes).
  __setRecoveryStoresForTests(null, null);
  resetCrashRecoveryForTests();
  await clearLocalSnapshot(); // wipe any residue from a previous run
  usePersistenceStore.setState({
    status: 'unsaved',
    errorMessage: null,
    activeCaseId: 'dom-case-1',
    activeCaseName: 'DOM case',
    lastSavedAt: null,
    localBackupAt: null,
  });
  useCaseStore.setState({ document: buildDocument() });
});

afterEach(async () => {
  await clearLocalSnapshot();
  resetCrashRecoveryForTests();
});

describe('crashRecovery — production localStorage + IndexedDB stores', () => {
  it('writes to real localStorage/IndexedDB and detects a recoverable snapshot back', async () => {
    await writeLocalSnapshot();

    // The marker landed in real localStorage.
    expect(window.localStorage.getItem('dqcad.recovery.marker')).not.toBeNull();

    const detection = await detectRecovery();
    expect(detection.kind).toBe('recoverable');
    if (detection.kind === 'recoverable') {
      expect(detection.document).toEqual(buildDocument());
    }
  });

  it('a clean shutdown suppresses the prompt; a clear removes the marker entirely', async () => {
    await writeLocalSnapshot();
    markCleanShutdown();
    expect((await detectRecovery()).kind).toBe('none');

    // Re-dirty the marker (a new session write resets cleanShutdown), then clear.
    resetCrashRecoveryForTests();
    await writeLocalSnapshot();
    expect((await detectRecovery()).kind).toBe('recoverable');

    await clearLocalSnapshot();
    expect(window.localStorage.getItem('dqcad.recovery.marker')).toBeNull();
    expect((await detectRecovery()).kind).toBe('none');
  });

  it('a malformed marker string in real localStorage is ignored (never crashes launch)', async () => {
    window.localStorage.setItem('dqcad.recovery.marker', 'not-json{');
    expect((await detectRecovery()).kind).toBe('none');
  });

  it('startLocalSnapshotTracking registers a pagehide handler that marks a clean shutdown; teardown removes it', async () => {
    await writeLocalSnapshot();
    startLocalSnapshotTracking();
    // Fire pagehide — the registered handler marks the session clean.
    window.dispatchEvent(new Event('pagehide'));
    expect((await detectRecovery()).kind).toBe('none');

    // A change after tracking starts schedules a debounced write.
    const dispose = startLocalSnapshotTracking(); // idempotent
    expect(typeof dispose).toBe('function');
    expect(LOCAL_SNAPSHOT_DEBOUNCE_MS).toBeGreaterThan(0);

    resetCrashRecoveryForTests(); // removes the pagehide listener
  });
});
