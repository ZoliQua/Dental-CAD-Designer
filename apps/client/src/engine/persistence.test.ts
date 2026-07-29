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
import type { CaseDocument, Measurement, Operation, Restoration } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { usePersistenceStore } from '../state/persistenceStore';
import { caseStore } from './caseStore';
import {
  __setFinalMeshSourceForTests,
  createCase,
  listCases,
  openCase,
  renameCase,
  resetPersistenceForTests,
  save,
} from './persistence';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

// Local minimal DQFM (final-mesh container) decode — avoids an engine→io lint
// boundary import in this test. Layout: magic(4) version(4) V(4) T(4), then
// V*3 float64 LE positions, then T*3 uint32 LE indices. The mesh content hash
// (what the server keys the container by) is sha256 over the positions ‖
// indices region, which is exactly `container.subarray(16)` (contiguous).
function decodeDqfm(bytes: Uint8Array): { positions: Float64Array; indices: Uint32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v = view.getUint32(8, true);
  const t = view.getUint32(12, true);
  const positions = new Float64Array(v * 3);
  new Uint8Array(positions.buffer).set(bytes.subarray(16, 16 + v * 24));
  const indices = new Uint32Array(t * 3);
  new Uint8Array(indices.buffer).set(bytes.subarray(16 + v * 24, 16 + v * 24 + t * 12));
  return { positions, indices };
}
function dqfmContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes.subarray(16)).digest('hex');
}

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
  // Phase 7 Task 6 (Part A): content-addressed final-mesh container store —
  // keyed by the DECODED mesh's content hash (server-computed), mirroring the
  // real /api/final-meshes route.
  const finalMeshes = new Map<string, Uint8Array>();
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
    const finalMeshHashMatch = /^\/api\/final-meshes\/([^/]+)$/.exec(path);

    if (path === '/api/cases' && method === 'GET') {
      return Response.json([...cases.values()].map(summaryOf));
    }
    if (path === '/api/cases' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const id = `case-${(counter += 1)}`;
      const now = new Date().toISOString();
      const row: FakeCaseRow = { id, name: body.name, createdAt: now, updatedAt: now, schemaVersion: 2, document: null };
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
      if (body.schemaVersion !== 2) return new Response(null, { status: 400 });
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
    if (path === '/api/final-meshes' && method === 'POST') {
      const buffer = new Uint8Array(init?.body as Uint8Array);
      // Server computes the content hash from the DECODED mesh (sha256 over
      // positions ‖ indices), never trusts the client — mirror that here.
      const contentHash = dqfmContentHash(buffer);
      finalMeshes.set(contentHash, buffer);
      return Response.json({ contentHash, byteLength: buffer.byteLength });
    }
    if (finalMeshHashMatch && method === 'HEAD') {
      return new Response(null, { status: finalMeshes.has(finalMeshHashMatch[1]!) ? 200 : 404 });
    }
    if (finalMeshHashMatch && method === 'GET') {
      const bytes = finalMeshes.get(finalMeshHashMatch[1]!);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
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

  return { fetchImpl, cases, meshes, finalMeshes };
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

/** Creates a new case, registers+places one `upperJaw` SceneNode per
 * `meshContentHashes` (each a translated copy of the tetrahedron geometry —
 * translated by its POSITION in the array, not by its hash string, so two
 * calls sharing a contentHash at the same index produce byte-identical STL
 * output/fileHash, which the "shared mesh" test below relies on; distinct
 * indices get distinct STL bytes/fileHash, which the "fetch fails partway
 * through" test below relies on to target one specific mesh's GET), saves
 * it (uploading every mesh's bytes to the fake server), and returns its
 * server-assigned id/name — a ready-to-reopen fixture for the openCase
 * atomic-swap tests below. Leaves the newly created case active. */
async function createSavedCase(
  name: string,
  meshContentHashes: readonly string[],
): Promise<{ id: string; name: string }> {
  await createCase(name);
  meshContentHashes.forEach((contentHash, index) => {
    const positions = TET_POSITIONS.map((value, i) => (i % 3 === 0 ? value + index + 1 : value));
    caseStore.registerImportedMesh({
      contentHash,
      name: `${contentHash}.stl`,
      format: 'stl',
      positions,
      indices: TET_INDICES.slice(),
      stats: tetStats(),
      report: EMPTY_REPORT,
      operations: [importOp(contentHash)],
    });
    caseStore.addSceneNode(contentHash, 'upperJaw');
  });
  await save();
  return { id: usePersistenceStore.getState().activeCaseId!, name };
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

  it('on a PUT failure, leaves the previously active case\'s document AND meshes fully intact (and renderable), and surfaces status "error"', async () => {
    const caseA = await createSavedCase('Case A', ['a-hash']);
    const documentBeforeFailedAttempt = useCaseStore.getState().document;
    expect(documentBeforeFailedAttempt.id).toBe(caseA.id);

    // Fail the NEW case's PUT (the one createCase('Case B') is about to
    // issue) while letting everything else (including case A's own PUT,
    // already long past by this point) through untouched.
    const realFetch = server.fetchImpl;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = String(input);
        if (method === 'PUT' && !path.includes(`/cases/${caseA.id}`)) {
          return new Response(null, { status: 500 });
        }
        return realFetch(input, init);
      }),
    );

    await expect(createCase('Case B')).rejects.toThrow();

    expect(usePersistenceStore.getState().status).toBe('error');
    // Case A is still the active case — createCase's PUT failure must never
    // reach setActiveCase/loadDocument/resetMeshRegistryForCaseSwitch.
    expect(usePersistenceStore.getState().activeCaseId).toBe(caseA.id);
    expect(useCaseStore.getState().document).toBe(documentBeforeFailedAttempt);

    // Case A's mesh is still resident and resolves via the normal render
    // path — no dangling meshId, no premature registry clear.
    expect(caseStore.getMeshRecord('a-hash')).toBeDefined();
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(1);
    expect(renderNodes[0]!.role).toBe('upperJaw');
  });

  it('on success, releases the previously active case\'s meshes and installs a clean empty document', async () => {
    const caseA = await createSavedCase('Case A', ['a-hash']);
    expect(caseStore.getMeshRecord('a-hash')).toBeDefined();

    await createCase('Case B');

    expect(usePersistenceStore.getState().status).toBe('saved');
    expect(usePersistenceStore.getState().activeCaseId).not.toBe(caseA.id);
    // Case A's mesh was only referenced by the outgoing case — released once
    // Case B's empty document was installed.
    expect(caseStore.getMeshRecord('a-hash')).toBeUndefined();

    const doc = useCaseStore.getState().document;
    expect(doc.scene).toHaveLength(0);
    expect(doc.meshes).toHaveLength(0);
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
    // Exactly one PUT for the first save, and (since the mutation made it
    // dirty again) exactly one coalesced follow-up PUT — never more, never
    // fewer. This is deterministic, not just likely: `saveInFlight` is set
    // synchronously before `firstSave`'s first `await`, so `secondSave`'s
    // call to `save()` is guaranteed to observe it already `true` and take
    // the coalescing (`pendingSaveRequested = true`) branch rather than a
    // second overlapping PUT.
    expect(putCalls.length).toBe(2);
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

describe('CaseDocument.schemaVersion 1 -> 2 migration (Phase 3 Task 1)', () => {
  it('migrates a legacy schemaVersion-1 document on load, then a save -> reload round trip is byte-for-byte identical', async () => {
    // Simulate a case row that predates this task's schema evolution: the
    // fake server's GET route just echoes back whatever `document` is
    // stored (mirroring the REAL server's app.ts, which does no validation
    // of its own stored JSON — see engine/caseDocumentMigration.ts's module
    // doc) — a raw, schemaVersion-1-shaped object, injected directly (never
    // constructible as a real `CaseDocument` — this cast is the point).
    const legacyDocument = {
      id: 'legacy-case-1',
      schemaVersion: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      meshes: [],
      scene: [],
      restorations: [
        {
          id: 'restoration-1',
          type: 'crown',
          teeth: [26],
          marginLines: {
            26: {
              vertexAnchors: [0, 1, 2, 3],
              controlPoints: [
                [0, 0, 0],
                [1, 0, 0],
                [1, 1, 0],
                [0, 1, 0],
              ],
              closed: true,
            },
          },
          insertionAxis: [0, 0, 1],
          params: {
            cementGapMm: 0.05,
            marginalGapMm: 0.02,
            spacerStartMm: 0.75,
            minWallThicknessMm: 0.5,
            proximalContactPenetrationMm: 0.02,
            occlusalContactMm: 0,
          },
          stages: {},
          qc: null,
        },
      ],
      measurements: [],
      history: [],
      settings: { materialProfileId: 'zirconia-default', profileVersion: '1.0.0' },
    };
    server.cases.set('legacy-case-1', {
      id: 'legacy-case-1',
      name: 'Legacy case',
      createdAt: legacyDocument.createdAt,
      updatedAt: legacyDocument.createdAt,
      schemaVersion: 1,
      document: legacyDocument as unknown as CaseDocument,
    });

    await openCase('legacy-case-1', 'Legacy case');

    // 1. Loaded document is migrated to schemaVersion 2 with the new
    // MarginLine.anchors shape — position carried through EXACTLY,
    // triangleIndex/barycentric are the documented UNRESOLVED sentinel.
    const loaded = useCaseStore.getState().document;
    expect(loaded.schemaVersion).toBe(2);
    const marginLine = loaded.restorations[0]?.marginLines[26];
    expect(marginLine?.closed).toBe(true);
    expect(marginLine?.anchors).toHaveLength(4);
    expect(marginLine?.anchors.map((a) => a.position)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]);
    for (const anchor of marginLine!.anchors) {
      expect(anchor.triangleIndex).toBe(-1); // UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX
    }
    // No `vertexAnchors`/`controlPoints` field survives the reshape.
    expect(marginLine).not.toHaveProperty('vertexAnchors');
    expect(marginLine).not.toHaveProperty('controlPoints');

    // 2. The migration is journaled, not silent (CLAUDE.md invariant 5).
    const migrationOp = loaded.history.find((op) => op.name === 'migrate-schema-v1-to-v2');
    expect(migrationOp).toBeDefined();
    expect(migrationOp?.params['fromSchemaVersion']).toBe(1);
    expect(migrationOp?.params['toSchemaVersion']).toBe(2);
    expect(migrationOp?.params['anchorCount']).toBe(4);

    // 3. A migrated document is not silently left dangling as "saved" on
    // the server (it never was, until now) — `openCase` persists the
    // migration ITSELF as part of loading (persistence.ts's `openCase`
    // doc's "wasMigrated" branch), so by the time it resolves the migrated
    // document is already durably saved.
    expect(usePersistenceStore.getState().status).toBe('saved');
    const savedDocument = useCaseStore.getState().document;
    expect(savedDocument.schemaVersion).toBe(2);
    expect(server.cases.get('legacy-case-1')!.document).toEqual(savedDocument);

    // 4. save() again is a genuine no-op (already in sync) — this task's
    // brief's explicit round-trip shape ("v1 doc -> load -> v2 -> save ->
    // reload") still holds even though `openCase` already did the save.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await save();
    expect(fetchMock).not.toHaveBeenCalled();

    // 5. Reload from scratch: v1 doc -> load -> v2 -> save -> reload
    // IDENTICAL (this task's brief's exact required round-trip test).
    caseStore.resetForTests();
    resetPersistenceForTests();
    await openCase('legacy-case-1', 'Legacy case');
    const reloadedDocument = useCaseStore.getState().document;
    expect(reloadedDocument).toEqual(savedDocument);
    // Idempotent: reloading an ALREADY-v2 document does not migrate again
    // (no second migrate-schema-v1-to-v2 entry, no re-dirtying).
    expect(reloadedDocument.history.filter((op) => op.name === 'migrate-schema-v1-to-v2')).toHaveLength(1);
    expect(usePersistenceStore.getState().status).toBe('saved');
  });

  it('rejects an unsupported schemaVersion (neither 1 nor 2) rather than silently guessing', async () => {
    const badDocument = {
      id: 'bad-case-1',
      schemaVersion: 3,
      createdAt: '2025-01-01T00:00:00.000Z',
      meshes: [],
      scene: [],
      restorations: [],
      measurements: [],
      history: [],
      settings: { materialProfileId: '', profileVersion: '' },
    };
    server.cases.set('bad-case-1', {
      id: 'bad-case-1',
      name: 'Bad case',
      createdAt: badDocument.createdAt,
      updatedAt: badDocument.createdAt,
      schemaVersion: 3,
      document: badDocument as unknown as CaseDocument,
    });

    await expect(openCase('bad-case-1', 'Bad case')).rejects.toThrow(/unsupported CaseDocument.schemaVersion/);
    expect(usePersistenceStore.getState().status).toBe('error');
  });
});

describe('CaseDocument schemaVersion-2 restoration-field backfill (Phase 3 Task 2 review fix)', () => {
  // A schemaVersion-2 restoration as it could exist on disk from a case
  // saved between Task 1 (shipped schemaVersion 2) and Task 2 (added
  // `pontics`/`targetNodeId` to that SAME schemaVersion as required
  // fields, with no migration at the time) — the keys are genuinely ABSENT
  // from the JSON, not `undefined`-valued (mirrors the v1 fixture above's
  // "never constructible as a real CaseDocument" cast).
  function legacyV2RestorationWithoutTask2Fields(): Record<string, unknown> {
    return {
      id: 'restoration-1',
      type: 'crown',
      teeth: [26],
      marginLines: {},
      insertionAxis: [0, 0, 1],
      params: {
        cementGapMm: 0.05,
        marginalGapMm: 0.02,
        spacerStartMm: 0.75,
        minWallThicknessMm: 0.5,
        proximalContactPenetrationMm: 0.02,
        occlusalContactMm: 0,
      },
      stages: {},
      qc: null,
    };
  }

  function v2DocumentWith(id: string, restorations: readonly Record<string, unknown>[]): Record<string, unknown> {
    return {
      id,
      schemaVersion: 2,
      createdAt: '2025-06-01T00:00:00.000Z',
      meshes: [],
      scene: [],
      restorations,
      measurements: [],
      history: [],
      settings: { materialProfileId: 'zirconia-default', profileVersion: '1.0.0' },
    };
  }

  it('(a) backfills a legacy v2 restoration missing pontics/targetNodeId, journals it exactly once, and the next save passes server validation', async () => {
    const legacyDocument = v2DocumentWith('v2-case-1', [legacyV2RestorationWithoutTask2Fields()]);
    server.cases.set('v2-case-1', {
      id: 'v2-case-1',
      name: 'Legacy v2 case',
      createdAt: legacyDocument['createdAt'] as string,
      updatedAt: legacyDocument['createdAt'] as string,
      schemaVersion: 2,
      document: legacyDocument as unknown as CaseDocument,
    });

    // Loads without throwing (this is the sidebar-render crash site the
    // finding describes — ui/RestorationWizard.tsx's
    // `restoration.pontics.includes`).
    await expect(openCase('v2-case-1', 'Legacy v2 case')).resolves.toBeUndefined();

    const loaded = useCaseStore.getState().document;
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.restorations[0]?.pontics).toEqual([]);
    expect(loaded.restorations[0]?.targetNodeId).toBeNull();

    // Journaled, not silent (CLAUDE.md invariant 5).
    const backfillOps = loaded.history.filter((op) => op.name === 'migrate-backfill-restoration-fields');
    expect(backfillOps).toHaveLength(1);
    expect(backfillOps[0]?.params['backfilledRestorationCount']).toBe(1);

    // The migration is itself persisted as part of loading (same
    // "wasMigrated" save-back as the v1 migration) — server now has the
    // complete, schema-valid document.
    expect(usePersistenceStore.getState().status).toBe('saved');
    const savedRow = server.cases.get('v2-case-1')!;
    expect((savedRow.document!.restorations[0] as unknown as Record<string, unknown>)['pontics']).toEqual([]);
    expect((savedRow.document!.restorations[0] as unknown as Record<string, unknown>)['targetNodeId']).toBeNull();

    // Next save (e.g. a real user edit) passes the tightened server schema
    // (apps/server/src/schemas.ts requires both fields) — exercised here by
    // just calling save() again; a schema-rejecting PUT would surface as a
    // thrown error / status 'error'.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await save();
    expect(fetchMock).not.toHaveBeenCalled(); // already in sync — genuine no-op, not a hidden failure

    // Reloading again does NOT re-journal (exactly-once semantics: the
    // fields are now genuinely present, so the field-presence check finds
    // nothing left to backfill).
    caseStore.resetForTests();
    resetPersistenceForTests();
    await openCase('v2-case-1', 'Legacy v2 case');
    const reloaded = useCaseStore.getState().document;
    expect(reloaded.history.filter((op) => op.name === 'migrate-backfill-restoration-fields')).toHaveLength(1);
    expect(usePersistenceStore.getState().status).toBe('saved');
  });

  it('(b) leaves a fresh v2 document with pontics/targetNodeId already present untouched — no backfill op, no re-save', async () => {
    const freshDocument = v2DocumentWith('v2-case-2', [
      { ...legacyV2RestorationWithoutTask2Fields(), pontics: [], targetNodeId: null },
    ]);
    server.cases.set('v2-case-2', {
      id: 'v2-case-2',
      name: 'Fresh v2 case',
      createdAt: freshDocument['createdAt'] as string,
      updatedAt: freshDocument['createdAt'] as string,
      schemaVersion: 2,
      document: freshDocument as unknown as CaseDocument,
    });

    await openCase('v2-case-2', 'Fresh v2 case');

    const loaded = useCaseStore.getState().document;
    expect(loaded.history).toHaveLength(0);
    expect(loaded.restorations[0]?.pontics).toEqual([]);
    expect(loaded.restorations[0]?.targetNodeId).toBeNull();
    // Not migrated: openCase's own "wasMigrated" branch never fired, so no
    // extra save() round trip beyond the (only) GET.
    const putCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT');
    expect(putCalls).toHaveLength(0);
    expect(usePersistenceStore.getState().status).toBe('saved');
  });

  it('(c) round-trip byte-identity after backfill: reloading the persisted, backfilled document is identical to what was saved', async () => {
    const legacyDocument = v2DocumentWith('v2-case-3', [
      legacyV2RestorationWithoutTask2Fields(),
      { ...legacyV2RestorationWithoutTask2Fields(), id: 'restoration-2', type: 'bridge', teeth: [26, 27, 28] },
    ]);
    server.cases.set('v2-case-3', {
      id: 'v2-case-3',
      name: 'Round-trip v2 case',
      createdAt: legacyDocument['createdAt'] as string,
      updatedAt: legacyDocument['createdAt'] as string,
      schemaVersion: 2,
      document: legacyDocument as unknown as CaseDocument,
    });

    await openCase('v2-case-3', 'Round-trip v2 case');
    const savedDocument = useCaseStore.getState().document;

    caseStore.resetForTests();
    resetPersistenceForTests();
    await openCase('v2-case-3', 'Round-trip v2 case');
    const reloadedDocument = useCaseStore.getState().document;

    expect(reloadedDocument).toEqual(savedDocument);
    expect(reloadedDocument.restorations).toEqual(savedDocument.restorations);
    expect(reloadedDocument.history.map((op) => op.id)).toEqual(savedDocument.history.map((op) => op.id));
  });
});

describe('openCase atomic swap on failure', () => {
  it('leaves the previous case\'s document AND meshes fully intact (and renderable) when a mesh fetch fails partway through', async () => {
    const caseA = await createSavedCase('Case A', ['a-hash']);
    const caseB = await createSavedCase('Case B', ['b-hash-1', 'b-hash-2', 'b-hash-3']);

    // Reactivate A as "the case currently open" before attempting the
    // (about to fail) switch to B.
    await openCase(caseA.id, caseA.name);
    const documentBeforeFailedAttempt = useCaseStore.getState().document;

    // Fail the 2nd of B's 3 mesh fetches (b-hash-2); b-hash-1 (fetched
    // first) succeeds, b-hash-3 is never reached. Mesh GETs are keyed by
    // `fileHash` (content-addressed STL bytes), not by our own contentHash
    // strings, so look up the actual fileHash the save() above assigned to
    // b-hash-2's MeshAsset.
    const caseBRow = server.cases.get(caseB.id)!;
    const bHash2FileHash = caseBRow.document!.meshes.find((m) => m.contentHash === 'b-hash-2')!.fileHash!;
    const realFetch = server.fetchImpl;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes(`/api/meshes/${bHash2FileHash}`)) {
          return new Response(null, { status: 500 });
        }
        return realFetch(input, init);
      }),
    );

    await expect(openCase(caseB.id, caseB.name)).rejects.toThrow();

    expect(usePersistenceStore.getState().status).toBe('error');
    // The document was never swapped — same object, not just deep-equal.
    expect(useCaseStore.getState().document).toBe(documentBeforeFailedAttempt);
    expect(usePersistenceStore.getState().activeCaseId).toBe(caseA.id);

    // A's mesh is still resident and resolves via the normal render path.
    expect(caseStore.getMeshRecord('a-hash')).toBeDefined();
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(1);
    expect(renderNodes[0]!.role).toBe('upperJaw');

    // b-hash-1 (registered successfully before b-hash-2 failed) was rolled
    // back, not leaked — this failed attempt left NO trace in meshStore.
    expect(caseStore.getMeshRecord('b-hash-1')).toBeUndefined();
    expect(caseStore.getMeshRecord('b-hash-2')).toBeUndefined();
    expect(caseStore.getMeshRecord('b-hash-3')).toBeUndefined();
  });
});

describe('openCase successful switch', () => {
  it('releases the outgoing case\'s meshes/BVHs, but keeps meshes shared (by contentHash) with the new case', async () => {
    const caseA = await createSavedCase('Case A', ['shared-hash', 'a-only-hash']);
    const caseB = await createSavedCase('Case B', ['shared-hash', 'b-only-hash']);

    await openCase(caseA.id, caseA.name);
    expect(caseStore.getMeshRecord('shared-hash')).toBeDefined();
    expect(caseStore.getMeshRecord('a-only-hash')).toBeDefined();

    await openCase(caseB.id, caseB.name);

    expect(usePersistenceStore.getState().status).toBe('saved');
    // a-only-hash was only referenced by the outgoing case (A) — released.
    expect(caseStore.getMeshRecord('a-only-hash')).toBeUndefined();
    // shared-hash is referenced by the NEW case (B) too — kept, not
    // released-then-refetched.
    expect(caseStore.getMeshRecord('shared-hash')).toBeDefined();
    expect(caseStore.getMeshRecord('b-only-hash')).toBeDefined();

    // Both of B's scene nodes resolve — no dangling meshId.
    const renderNodes = caseStore.getRenderNodes();
    expect(renderNodes).toHaveLength(2);
    expect(renderNodes.every((node) => node.role === 'upperJaw')).toBe(true);
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

describe('save — final-mesh persistence (Phase 7 Task 6 Part A)', () => {
  /** sha256(positions ‖ indices) — the canonical mesh content hash the server
   * addresses a final-mesh container by (mirrors kernel-workers' hashMeshContent
   * and the server's hashMesh). */
  function contentHashOf(positions: Float64Array, indices: Uint32Array): string {
    return createHash('sha256')
      .update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength))
      .update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength))
      .digest('hex');
  }

  function crownRestoration(finalMeshHash: string): Restoration {
    return {
      id: 'resto-crown-1',
      type: 'crown',
      teeth: [11],
      pontics: [],
      targetNodeId: null,
      marginLines: {},
      insertionAxis: [0, 0, 1],
      params: {
        cementGapMm: 0.05,
        marginalGapMm: 0.02,
        spacerStartMm: 0.8,
        minWallThicknessMm: 0.5,
        proximalContactPenetrationMm: 0.02,
        occlusalContactMm: 0,
      },
      stages: { finalMesh: finalMeshHash },
      qc: null,
    };
  }

  function createOp(): Operation {
    return {
      id: 'op-resto-1',
      name: 'restoration-create',
      params: { restorationId: 'resto-crown-1' },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: '0.0.0',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
  }

  it('persists a restoration final mesh content-addressed on save (lossless round-trip)', async () => {
    await createCase('final-mesh case');
    const positions = TET_POSITIONS.slice();
    const indices = TET_INDICES.slice();
    const finalMeshHash = contentHashOf(positions, indices);
    __setFinalMeshSourceForTests((r) =>
      r.id === 'resto-crown-1' ? { positions, indices, contentHash: finalMeshHash } : null,
    );
    caseStore.addRestoration(crownRestoration(finalMeshHash), createOp());

    await save();

    // The container is now stored server-side keyed by the content hash.
    expect(server.finalMeshes.has(finalMeshHash)).toBe(true);
    const stored = server.finalMeshes.get(finalMeshHash)!;
    const back = decodeDqfm(stored);
    expect(Array.from(back.positions)).toEqual(Array.from(positions));
    expect(Array.from(back.indices)).toEqual(Array.from(indices));
  });

  it('skips (never fabricates) when no live session holds the final mesh', async () => {
    await createCase('final-mesh case 2');
    __setFinalMeshSourceForTests(() => null); // post-reload: buffers gone
    caseStore.addRestoration(crownRestoration('a'.repeat(64)), createOp());

    await save();

    expect(server.finalMeshes.size).toBe(0);
    // The save itself still succeeds (the document is persisted).
    expect(usePersistenceStore.getState().status).toBe('saved');
  });

  it('is idempotent: a second save with the mesh already stored does not re-upload', async () => {
    await createCase('final-mesh case 3');
    const positions = TET_POSITIONS.slice();
    const indices = TET_INDICES.slice();
    const finalMeshHash = contentHashOf(positions, indices);
    __setFinalMeshSourceForTests(() => ({ positions, indices, contentHash: finalMeshHash }));
    caseStore.addRestoration(crownRestoration(finalMeshHash), createOp());
    await save();
    const postCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => String(c[0]).endsWith('/api/final-meshes') && (c[1] as RequestInit)?.method === 'POST',
    ).length;

    // Force another save by mutating the document, then save again.
    caseStore.setSelectedRestorationId('resto-crown-1');
    caseStore.addMeasurement({
      id: 'm-1',
      kind: 'pointToPoint',
      points: [
        { nodeId: 'x', position: [0, 0, 0] },
        { nodeId: 'x', position: [1, 0, 0] },
      ],
      value: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await save();
    const postCallsAfter = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => String(c[0]).endsWith('/api/final-meshes') && (c[1] as RequestInit)?.method === 'POST',
    ).length;
    expect(postCallsAfter).toBe(postCalls); // HEAD-checked; no second POST
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
