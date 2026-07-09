// engine/persistence.ts tests (Task 11: scene persistence). Network calls
// are routed through a small in-memory fake server (`createFakeServer`
// below) that mirrors the REAL server routes' semantics (content-addressed
// mesh storage, schemaVersion-checked PUT, PATCH rename) closely enough to
// exercise this module's actual save/load orchestration — the real server's
// OWN route/schema behavior is covered separately by apps/server/src/
// app.test.ts. Mesh (de)serialization (serializeMeshStl / parseMeshFile /
// weldMeshSoup) runs through the REAL Node worker_threads WorkerPool (same
// convention as engine/importer.test.ts), so the save -> load round trip
// genuinely exercises the STL byte boundary, not a stub of it.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { CaseDocument, Measurement, Operation } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';
import { caseStore } from './caseStore';
import {
  createCase,
  listCases,
  openCase,
  renameCase,
  resetPersistenceForTests,
  save,
} from './persistence';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

// Outward-wound unit tetrahedron — small, cheap to weld/serialize, and
// non-degenerate (real bbox/volume) so weldMeshSoup's post-round-trip
// analyzeMesh has something meaningful to report.
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
    params: { fileName: 'tet.stl', format: 'stl', triangleCount: 4, vertexCount: 4, contentHash },
    inputHashes: ['file-hash-1'],
    outputHashes: [contentHash],
    kernelVersion: '0.0.0',
    timestamp: '2026-01-01T00:00:00.000Z',
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

/** In-memory stand-in for the real Fastify server — see this file's module
 * doc for why this (not app.inject) is what persistence.test.ts talks to. */
function createFakeServer() {
  const cases = new Map<string, FakeCaseRow>();
  const meshes = new Map<string, Uint8Array>();
  let counter = 0;

  function summaryOf(row: FakeCaseRow) {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      schemaVersion: row.schemaVersion,
    };
  }

  async function fetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input).replace(/^https?:\/\/[^/]*/, '');

    const caseIdMatch = /^\/api\/cases\/([^/]+)$/.exec(path);
    const meshHashMatch = /^\/api\/meshes\/([^/]+)$/.exec(path);

    if (path === '/api/cases' && method === 'GET') {
      return Response.json([...cases.values()].map(summaryOf));
    }
    if (path === '/api/cases' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const id = `case-${(counter += 1)}`;
      const now = new Date().toISOString();
      const row: FakeCaseRow = { id, name: body.name, createdAt: now, updatedAt: now, schemaVersion: 1, document: null };
      cases.set(id, row);
      return Response.json(summaryOf(row), { status: 201 });
    }
    if (caseIdMatch && method === 'PATCH') {
      const row = cases.get(caseIdMatch[1]!);
      if (!row) return new Response(null, { status: 404 });
      const body = JSON.parse(String(init?.body)) as { name: string };
      row.name = body.name;
      row.updatedAt = new Date().toISOString();
      return Response.json(summaryOf(row));
    }
    if (caseIdMatch && method === 'GET') {
      const row = cases.get(caseIdMatch[1]!);
      if (!row || !row.document) return new Response(null, { status: 404 });
      return Response.json(row.document);
    }
    if (caseIdMatch && method === 'PUT') {
      const row = cases.get(caseIdMatch[1]!);
      if (!row) return new Response(null, { status: 404 });
      const body = JSON.parse(String(init?.body)) as CaseDocument;
      if (body.id !== row.id) return new Response(null, { status: 400 });
      if (body.schemaVersion !== 1) return new Response(null, { status: 400 });
      row.document = body;
      row.schemaVersion = body.schemaVersion;
      row.updatedAt = new Date().toISOString();
      return Response.json(summaryOf(row));
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
      // Same TS 5.7+ ArrayBufferLike-generic typing gap as
      // engine/persistence.ts's uploadMeshBytes cast.
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    throw new Error(`fake server: unhandled ${method} ${path}`);
  }

  return { fetchImpl, cases, meshes };
}

let server: ReturnType<typeof createFakeServer>;

beforeEach(() => {
  caseStore.resetForTests();
  resetPersistenceForTests();
  usePersistenceStore.setState({
    status: 'idle',
    errorMessage: null,
    activeCaseId: null,
    activeCaseName: null,
    lastSavedAt: null,
    cases: [],
    casesLoading: false,
    casesError: null,
    isPickerOpen: false,
  });
  server = createFakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetchImpl));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Registers the tetrahedron mesh, places it in the scene under `role`, and
 * appends a point-to-point measurement on it — a small but representative
 * case for the round-trip tests below. */
function buildRepresentativeCase(): { contentHash: string; nodeId: string } {
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
  const node = caseStore.addSceneNode(contentHash, 'upperJaw');
  const measurement: Measurement = {
    id: 'measurement-1',
    kind: 'pointToPoint',
    points: [
      { nodeId: node.id, position: [0, 0, 0] },
      { nodeId: node.id, position: [1, 0, 0] },
    ],
    value: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  caseStore.addMeasurement(measurement);
  return { contentHash, nodeId: node.id };
}

describe('createCase', () => {
  it('creates a case on the (fake) server and installs a matching empty document', async () => {
    await createCase('New case');

    const state = usePersistenceStore.getState();
    expect(state.status).toBe('saved');
    expect(state.activeCaseId).not.toBeNull();
    expect(state.activeCaseName).toBe('New case');

    const doc = useCaseStore.getState().document;
    expect(doc.id).toBe(state.activeCaseId);
    expect(doc.scene).toHaveLength(0);
    expect(doc.meshes).toHaveLength(0);

    // The server's stored document (via PUT) matches what's now "current".
    const row = server.cases.get(state.activeCaseId!)!;
    expect(row.document).toEqual(doc);
  });
});

describe('save / openCase round trip', () => {
  it('preserves scene nodes (roles/transforms/visibility), measurements, and journal order across a save -> load cycle', async () => {
    await createCase('Round trip case');
    const { contentHash, nodeId } = buildRepresentativeCase();
    caseStore.setSceneNodeOpacity(nodeId, 0.5);
    caseStore.setSceneNodeVisibility(nodeId, false);

    await save();
    expect(usePersistenceStore.getState().status).toBe('saved');

    const savedDocument = useCaseStore.getState().document;
    const savedAsset = savedDocument.meshes.find((m) => m.contentHash === contentHash);
    expect(savedAsset?.fileHash).toBeTruthy();
    expect(server.meshes.size).toBe(1);

    const activeCaseId = usePersistenceStore.getState().activeCaseId!;
    const activeCaseName = usePersistenceStore.getState().activeCaseName!;

    // Simulate a fresh page load: wipe every in-memory engine/state
    // structure, then reopen the same case purely from the fake server.
    caseStore.resetForTests();
    resetPersistenceForTests();

    await openCase(activeCaseId, activeCaseName);

    const loadedDocument = useCaseStore.getState().document;
    expect(loadedDocument).toEqual(savedDocument);
    expect(loadedDocument.scene).toEqual(savedDocument.scene);
    expect(loadedDocument.measurements).toEqual(savedDocument.measurements);
    // Journal order preserved exactly (import op, in this case just one).
    expect(loadedDocument.history.map((op) => op.id)).toEqual(savedDocument.history.map((op) => op.id));

    // Render nodes resolve — meshStore was populated via the NORMAL register
    // path (not a shortcut) before loadDocument installed the document.
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(1);
    expect(renderNodes[0]!.role).toBe('upperJaw');
    expect(renderNodes[0]!.visible).toBe(false);
    expect(renderNodes[0]!.opacity).toBe(0.5);
  });

  it('is a no-op (does not re-upload) when saving an unchanged document a second time', async () => {
    await createCase('Idempotent save case');
    buildRepresentativeCase();
    await save();
    expect(server.meshes.size).toBe(1);

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    await save(); // document unchanged since the last save
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('save() is a no-op with no active case', async () => {
    const fetchMock = vi.mocked(fetch);
    await save();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usePersistenceStore.getState().status).toBe('idle');
  });

  it('coalesces a save requested while one is already in flight into a single follow-up save', async () => {
    await createCase('Coalesce case');
    buildRepresentativeCase();

    const firstSave = save();
    // Mutate again immediately, then request a second save before the first
    // one's network calls resolve — should NOT fire two overlapping PUTs.
    caseStore.setSceneNodeOpacity(useCaseStore.getState().document.scene[0]!.id, 0.25);
    const secondSave = save();

    await Promise.all([firstSave, secondSave]);

    const putCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT');
    // One PUT for the first save, and (since the mutation made it dirty
    // again) exactly one coalesced follow-up PUT — never more.
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    expect(putCalls.length).toBeLessThanOrEqual(2);
    expect(usePersistenceStore.getState().status).toBe('saved');
    expect(useCaseStore.getState().document.scene[0]!.opacity).toBe(0.25);
  });

  it('discards a save\'s bookkeeping if a DIFFERENT case became active while its PUT was in flight', async () => {
    await createCase('Case A');
    buildRepresentativeCase();
    const caseAId = usePersistenceStore.getState().activeCaseId!;

    const realFetch = server.fetchImpl;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = String(input);
        if (method === 'PUT' && path.includes(`/cases/${caseAId}`)) {
          // Simulate the user opening a DIFFERENT case while case A's PUT
          // was in flight (openCase/createCase would have already reset
          // activeCaseId — reproduced directly here for a deterministic,
          // race-free test).
          usePersistenceStore.getState().setActiveCase({ id: 'case-b-simulated', name: 'Case B' });
        }
        return realFetch(input, init);
      }),
    );

    await save();

    // Case A's stale save result must NOT have clobbered case B's active-case
    // tracking (it would show case A's own name/id here if the guard were
    // missing — see persistence.ts's `save()` doc).
    expect(usePersistenceStore.getState().activeCaseId).toBe('case-b-simulated');
    expect(usePersistenceStore.getState().activeCaseName).toBe('Case B');
  });
});

describe('renameCase', () => {
  it('renames a case on the server and updates the active case name if it is the open one', async () => {
    await createCase('Original name');
    const id = usePersistenceStore.getState().activeCaseId!;

    await renameCase(id, 'Renamed');

    expect(usePersistenceStore.getState().activeCaseName).toBe('Renamed');
    expect(server.cases.get(id)?.name).toBe('Renamed');
  });
});

describe('autosave debounce', () => {
  // Deliberately mesh-free mutations (measurements only, no
  // registerImportedMesh/serializeMeshStl) — keeps `save()`'s only async
  // work the (mocked) PUT fetch, so `vi.advanceTimersByTimeAsync` doesn't
  // have to race a REAL worker_threads round trip under faked timers.
  function mutateDocument(suffix: string): void {
    caseStore.addMeasurement({
      id: `measurement-${suffix}`,
      kind: 'pointToPoint',
      points: [
        { nodeId: 'n/a', position: [0, 0, 0] },
        { nodeId: 'n/a', position: [1, 0, 0] },
      ],
      value: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  function putCallCount(): number {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT').length;
  }

  it('does not autosave before 30s of inactivity, and does autosave once 30s elapse', async () => {
    await createCase('Autosave case');
    vi.useFakeTimers();
    try {
      mutateDocument('a');
      expect(usePersistenceStore.getState().status).toBe('unsaved');
      vi.mocked(fetch).mockClear();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(putCallCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(putCallCount()).toBe(1);
      expect(usePersistenceStore.getState().status).toBe('saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the debounce timer on each new mutation — only 30s of silence after the LAST one triggers autosave', async () => {
    await createCase('Reset case');
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockClear();
      mutateDocument('a');
      await vi.advanceTimersByTimeAsync(20_000);
      mutateDocument('b'); // resets the timer — total elapsed since 'a' is 20s, but since 'b' it's 0s
      await vi.advanceTimersByTimeAsync(20_000); // 20s since 'b': still short of the 30s threshold
      expect(putCallCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(10_001); // now 30s+ since 'b'
      expect(putCallCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not autosave an already-saved (non-dirty) document even after 30s', async () => {
    await createCase('No-op autosave case');
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(putCallCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listCases', () => {
  it('populates usePersistenceStore.cases from the server', async () => {
    await createCase('Case A');
    await createCase('Case B');

    await listCases();

    const names = usePersistenceStore.getState().cases.map((c) => c.name).sort();
    expect(names).toEqual(['Case A', 'Case B']);
    expect(usePersistenceStore.getState().casesError).toBeNull();
  });
});
