// apps/client/src/engine/recovery.test.ts
//
// Phase 8 Task 4 — end-to-end crash → recovery, through the REAL restore path
// (mesh reconstructed from the server, exactly like openCase) and the REAL
// coordinator (engine/recovery.ts → state/recoveryStore.ts). Proves:
//  - crash mid-edit → relaunch detects it → RESTORE yields a document
//    deep-equal to the pre-crash one, journal-replay bit-identical, meshes
//    reconstructed and rendering;
//  - NO SILENT OVERWRITE: the server keeps its last version until the restored
//    (dirty) case is explicitly re-saved; DISCARD clears only the local snapshot
//    and leaves the server untouched;
//  - a failed restore (server down) keeps the snapshot for retry (never
//    discards it);
//  - a corrupt snapshot surfaces as a corrupt prompt, cleared only on the
//    user's acknowledgment.
//
// Network goes through the same in-memory fake server style as persistence.test.ts;
// mesh (de)serialization runs on the REAL Node worker pool, so the round trip
// genuinely crosses the STL byte boundary.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashCaseJournal } from '@dqcad/kernel-workers';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { CaseDocument, Operation } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';
import { useRecoveryStore } from '../state/recoveryStore';
import { caseStore } from './caseStore';
import {
  __setRecoveryStoresForTests,
  detectRecovery,
  resetCrashRecoveryForTests,
  writeLocalSnapshot,
  type RecoveryMarker,
  type RecoveryMarkerStore,
  type RecoveryPayloadStore,
} from './crashRecovery';
import { createCase, resetPersistenceForTests, save } from './persistence';
import {
  acceptRecovery,
  acknowledgeIncompleteRestore,
  dismissRecovery,
  initRecovery,
  resetRecoveryCoordinatorForTests,
} from './recovery';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };
const TET_POSITIONS = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const TET_INDICES = Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]);

function tetStats(): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    surfaceAreaMm2: 1,
    signedVolumeMm3: 1 / 6,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

function importOp(contentHash: string): Operation {
  return {
    id: 'op-import-1',
    name: 'import-mesh',
    params: { fileName: 'tet.stl', format: 'stl', triangleCount: 4, contentHash },
    inputHashes: ['file-hash-1'],
    outputHashes: [contentHash],
    kernelVersion: '0.26.0',
    timestamp: '2026-07-18T00:00:00.000Z',
  };
}

interface FakeCaseRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  document: CaseDocument | null;
}

function createFakeServer() {
  const cases = new Map<string, FakeCaseRow>();
  const meshes = new Map<string, Uint8Array>();
  let counter = 0;
  const summaryOf = (row: FakeCaseRow) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: row.schemaVersion,
  });

  async function fetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input).replace(/^https?:\/\/[^/]*/, '');
    const caseIdMatch = /^\/api\/cases\/([^/]+)$/.exec(path);
    const meshHashMatch = /^\/api\/meshes\/([^/]+)$/.exec(path);

    if (path === '/api/cases' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const id = `case-${(counter += 1)}`;
      const now = new Date().toISOString();
      const row: FakeCaseRow = { id, name: body.name, createdAt: now, updatedAt: now, schemaVersion: 2, document: null };
      cases.set(id, row);
      return Response.json(summaryOf(row), { status: 201 });
    }
    if (caseIdMatch && method === 'PUT') {
      const row = cases.get(caseIdMatch[1]!);
      if (!row) return new Response(null, { status: 404 });
      row.document = JSON.parse(String(init?.body)) as CaseDocument;
      row.updatedAt = new Date().toISOString();
      return Response.json(summaryOf(row));
    }
    if (path === '/api/cases' && method === 'GET') {
      return Response.json([...cases.values()].map(summaryOf));
    }
    if (path === '/api/meshes' && method === 'POST') {
      const buffer = init?.body as Uint8Array;
      const hash = createHash('sha256').update(buffer).digest('hex');
      meshes.set(hash, new Uint8Array(buffer));
      return Response.json({ hash, byteLength: buffer.byteLength });
    }
    if (meshHashMatch && method === 'HEAD') {
      return new Response(null, { status: meshes.has(meshHashMatch[1]!) ? 200 : 404 });
    }
    if (meshHashMatch && method === 'GET') {
      const bytes = meshes.get(meshHashMatch[1]!);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }
    throw new Error(`fake server: unhandled ${method} ${path}`);
  }
  return { fetchImpl, cases, meshes };
}

class FakeMarkerStore implements RecoveryMarkerStore {
  value: RecoveryMarker | null = null;
  read() {
    return this.value;
  }
  write(marker: RecoveryMarker) {
    this.value = { ...marker };
  }
  clear() {
    this.value = null;
  }
}
class FakePayloadStore implements RecoveryPayloadStore {
  readonly map = new Map<string, string>();
  async read(checksum: string) {
    return this.map.get(checksum) ?? null;
  }
  async write(checksum: string, json: string) {
    this.map.set(checksum, json);
  }
  async delete(checksum: string) {
    this.map.delete(checksum);
  }
  async prune(keep: string | null) {
    for (const key of [...this.map.keys()]) if (keep === null || key !== keep) this.map.delete(key);
  }
}

let server: ReturnType<typeof createFakeServer>;
let markerStore: FakeMarkerStore;
let payloadStore: FakePayloadStore;

function resetPersistenceStoreState(): void {
  usePersistenceStore.setState({
    status: 'idle',
    errorMessage: null,
    activeCaseId: null,
    activeCaseName: null,
    lastSavedAt: null,
    localBackupAt: null,
    cases: [],
    casesLoading: false,
    casesError: null,
    isPickerOpen: false,
  });
}

beforeEach(() => {
  caseStore.resetForTests();
  resetPersistenceForTests();
  resetCrashRecoveryForTests();
  resetRecoveryCoordinatorForTests();
  resetPersistenceStoreState();
  useRecoveryStore.setState({ kind: 'hidden', info: null, detail: null });
  markerStore = new FakeMarkerStore();
  payloadStore = new FakePayloadStore();
  __setRecoveryStoresForTests(markerStore, payloadStore);
  server = createFakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetchImpl));
});

afterEach(() => {
  resetCrashRecoveryForTests();
  resetRecoveryCoordinatorForTests();
  __setRecoveryStoresForTests(null, null);
  vi.unstubAllGlobals();
});

/** Creates + saves a case with one mesh/scene node, then makes an un-synced
 * edit and writes a local snapshot. Returns the pre-crash state. */
async function seedCrashedSession(): Promise<{ caseId: string; caseName: string; preCrashDoc: CaseDocument }> {
  await createCase('Crash case');
  const contentHash = 'tet-hash-1';
  caseStore.registerImportedMesh({
    contentHash,
    name: 'tet.stl',
    format: 'stl',
    positions: TET_POSITIONS.slice(),
    indices: TET_INDICES.slice(),
    stats: tetStats(),
    report: EMPTY_REPORT,
    operations: [importOp(contentHash)],
  });
  const node = caseStore.addSceneNode(contentHash, 'prepDie');
  await save(); // server now durably holds doc + mesh; local snapshot cleared

  // Un-synced edit AFTER the last server save (opacity is not journaled, so the
  // journal is unchanged — the scene diverges from the server copy).
  caseStore.setSceneNodeOpacity(node.id, 0.5);
  expect(usePersistenceStore.getState().status).toBe('unsaved');
  const preCrashDoc = useCaseStore.getState().document;
  await writeLocalSnapshot();
  expect(markerStore.read()).not.toBeNull();

  return {
    caseId: usePersistenceStore.getState().activeCaseId!,
    caseName: usePersistenceStore.getState().activeCaseName!,
    preCrashDoc,
  };
}

/** Wipes every in-memory engine/state structure — a fresh page load. The
 * injected recovery stores retain their contents (they model durable storage). */
function simulateRelaunch(): void {
  caseStore.resetForTests();
  resetPersistenceForTests();
  resetRecoveryCoordinatorForTests();
  resetPersistenceStoreState();
  useRecoveryStore.setState({ kind: 'hidden', info: null, detail: null });
}

describe('crash → detect → RESTORE (state-identical) via the coordinator', () => {
  it('restores the exact pre-crash document (deep-equal, journal bit-identical), reconstructs the mesh, and marks it un-synced', async () => {
    const { caseId, preCrashDoc } = await seedCrashedSession();
    const serverDocBeforeRestore = server.cases.get(caseId)!.document!;

    simulateRelaunch();
    await initRecovery();
    expect(useRecoveryStore.getState().kind).toBe('recoverable');
    expect(useRecoveryStore.getState().info?.journalOperationCount).toBe(preCrashDoc.history.length);

    // NO SILENT OVERWRITE (yet): the server still holds its pre-edit version.
    expect(serverDocBeforeRestore.scene[0]!.opacity).toBe(1);

    await acceptRecovery();

    const restored = useCaseStore.getState().document;
    expect(restored).toEqual(preCrashDoc);
    expect(restored.scene[0]!.opacity).toBe(0.5); // the un-synced edit is back
    expect(await hashCaseJournal(restored.history)).toBe(await hashCaseJournal(preCrashDoc.history));

    // Restored state is honestly NOT-yet-on-the-server.
    expect(usePersistenceStore.getState().status).toBe('unsaved');
    expect(usePersistenceStore.getState().activeCaseId).toBe(caseId);
    // Mesh reconstructed from the server → renders.
    expect(caseStore.getMeshRecord('tet-hash-1')).toBeDefined();
    expect(caseStore.getRenderNodes()).toHaveLength(1);
    // Prompt closed.
    expect(useRecoveryStore.getState().kind).toBe('hidden');

    // The server is only updated when the recovered (dirty) case is re-saved —
    // an explicit/visible save, never silent.
    expect(server.cases.get(caseId)!.document!.scene[0]!.opacity).toBe(1);
    await save();
    expect(server.cases.get(caseId)!.document!.scene[0]!.opacity).toBe(0.5);
    // Snapshot cleared after the successful re-sync.
    expect((await detectRecovery()).kind).toBe('none');
  });
});

describe('DISCARD keeps the server version and clears only the local snapshot', () => {
  it('clears the snapshot, leaves the server untouched, opens no case', async () => {
    const { caseId } = await seedCrashedSession();
    simulateRelaunch();
    await initRecovery();
    expect(useRecoveryStore.getState().kind).toBe('recoverable');

    await dismissRecovery();

    expect(useRecoveryStore.getState().kind).toBe('hidden');
    expect((await detectRecovery()).kind).toBe('none'); // local snapshot gone
    // Server version intact; no case force-loaded.
    expect(server.cases.get(caseId)!.document!.scene[0]!.opacity).toBe(1);
    expect(usePersistenceStore.getState().activeCaseId).toBeNull();
  });
});

describe('a failed restore preserves the snapshot for retry', () => {
  it('surfaces an error and keeps the local snapshot when the mesh fetch fails (server down)', async () => {
    await seedCrashedSession();
    simulateRelaunch();
    await initRecovery();
    expect(useRecoveryStore.getState().kind).toBe('recoverable');

    // Server "down" for mesh GETs.
    const realFetch = server.fetchImpl;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes('/api/meshes/') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
          return new Response(null, { status: 500 });
        }
        return realFetch(input, init);
      }),
    );

    await acceptRecovery();

    expect(useRecoveryStore.getState().kind).toBe('error');
    // Snapshot NOT discarded — the user can retry.
    expect((await detectRecovery()).kind).toBe('recoverable');
  });
});

describe('SF2 — an incomplete restore (never-uploaded mesh) is surfaced, not a clean success', () => {
  it('names the mesh(es) that could not be recovered and keeps the case loaded + un-synced', async () => {
    // A case with an imported-but-NEVER-SAVED mesh (so it has no fileHash — the
    // realistic 2s..30s window the local snapshot can capture).
    await createCase('Unsaved-mesh case');
    const contentHash = 'never-uploaded-hash';
    caseStore.registerImportedMesh({
      contentHash,
      name: 'prep-scan.stl',
      format: 'stl',
      positions: TET_POSITIONS.slice(),
      indices: TET_INDICES.slice(),
      stats: tetStats(),
      report: EMPTY_REPORT,
      operations: [importOp(contentHash)],
    });
    caseStore.addSceneNode(contentHash, 'prepDie');
    expect(usePersistenceStore.getState().status).toBe('unsaved');
    const caseId = usePersistenceStore.getState().activeCaseId!;
    await writeLocalSnapshot();

    simulateRelaunch();
    await initRecovery();
    expect(useRecoveryStore.getState().kind).toBe('recoverable');

    await acceptRecovery();

    // The restore DID happen (case loaded + un-synced), but the loss is
    // surfaced to the operator — NOT reported as a clean success.
    expect(usePersistenceStore.getState().activeCaseId).toBe(caseId);
    expect(usePersistenceStore.getState().status).toBe('unsaved');
    expect(useRecoveryStore.getState().kind).toBe('incomplete');
    expect(useRecoveryStore.getState().unrecoverableMeshes).toContain('prep-scan.stl');
    // The dropped node genuinely has no renderable geometry (the silent-loss
    // condition this fix exposes).
    expect(caseStore.getMeshRecord(contentHash)).toBeUndefined();

    // Acknowledging the informational prompt only hides it — the snapshot is
    // kept (it clears on the next server save), never discarded here.
    acknowledgeIncompleteRestore();
    expect(useRecoveryStore.getState().kind).toBe('hidden');
    expect((await detectRecovery()).kind).toBe('recoverable');
  });

  it('a fully-recoverable restore still reports a clean success (no incomplete surface)', async () => {
    await seedCrashedSession();
    simulateRelaunch();
    await initRecovery();
    await acceptRecovery();
    expect(useRecoveryStore.getState().kind).toBe('hidden');
  });
});

describe('a corrupt snapshot surfaces as a corrupt prompt, cleared on acknowledgment', () => {
  it('detects corruption at launch and clears only on the explicit acknowledgment', async () => {
    await seedCrashedSession();
    // Tamper the payload so its checksum no longer matches.
    const checksum = markerStore.read()!.payloadChecksum;
    payloadStore.map.set(checksum, `${payloadStore.map.get(checksum)!.slice(0, -3)}zzz`);

    simulateRelaunch();
    await initRecovery();
    expect(useRecoveryStore.getState().kind).toBe('corrupt');

    // Not restored (no case loaded) and not silently cleared.
    expect(usePersistenceStore.getState().activeCaseId).toBeNull();
    expect(markerStore.read()).not.toBeNull();

    await dismissRecovery();
    expect(useRecoveryStore.getState().kind).toBe('hidden');
    expect(markerStore.read()).toBeNull();
  });
});
