// marginEditor.test.ts — Phase 3 Task 5.
//
// Three tiers, same "pure logic first, then real worker round trips" split
// as alignment.test.ts:
//  1. Pure gesture-logic (index math) unit tests — `planAnchorDeletion`/
//     `rebuildSegmentsAfterDeletion`/`nearestSegmentIndex`/
//     `summarizeAnchorDiff` — no worker, no mesh, instant.
//  2. Manual-mode + editing + journal-coalescing tests through the REAL
//     WorkerPool (Node worker_threads path) against a small icosahedron
//     fixture (same convex-mesh + `rayAtVertex` convention as
//     alignment.test.ts — deterministic, exact hits).
//  3. Real-fixture tests: `standin-prep-die.stl` (384 triangles, verified
//     convex EVERYWHERE — Phase 3 Task 4's report — so ANY seed on it
//     deterministically throws `NoRidgeFoundError`, exercising the
//     propose-error -> manual-fallback path) and the real 250k-tri
//     `arch-case-01-upperjaw.stl` at Task 4's own golden seed (a KNOWN,
//     already-verified-closing margin) for the actual auto-propose success
//     path AND the deliverable-5 drag-latency measurement this task's
//     report cites.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { Vec3 } from '@dqcad/shared-types';
import {
  marginEditor,
  nearestSegmentIndex,
  planAnchorDeletion,
  rebuildSegmentsAfterDeletion,
  summarizeAnchorDiff,
  type AnchorDiffSummary,
} from './marginEditor';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import { ensureBvhBuilt, getPool, resetBvhCacheForTests } from './workers';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore, type LiveMarginSegment } from '../state/marginStore';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 400,
    signedVolumeMm3: 100,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Tier 1: pure gesture-logic (no worker, no mesh)
// ---------------------------------------------------------------------------

describe('planAnchorDeletion / rebuildSegmentsAfterDeletion (pure)', () => {
  // Stand-in "segment" — rebuildSegmentsAfterDeletion never inspects a
  // segment's contents, only its position, so a plain id tag suffices (see
  // that function's own doc).
  function seg(id: string): { id: string } {
    return { id };
  }

  it('open curve: deleting the FIRST anchor drops only the first segment, no bridging', () => {
    // 4 anchors (0,1,2,3), open -> 3 segments: s01, s12, s23.
    const plan = planAnchorDeletion(4, false, 0);
    expect(plan.needsBridging).toBe(false);
    expect(plan.prevAnchorIdx).toBe(-1);
    expect(plan.nextAnchorIdx).toBe(1);
    const result = rebuildSegmentsAfterDeletion([seg('s01'), seg('s12'), seg('s23')], plan, null);
    expect(result).toEqual([seg('s12'), seg('s23')]);
  });

  it('open curve: deleting the LAST anchor drops only the last segment, no bridging', () => {
    const plan = planAnchorDeletion(4, false, 3);
    expect(plan.needsBridging).toBe(false);
    expect(plan.prevAnchorIdx).toBe(2);
    expect(plan.nextAnchorIdx).toBe(-1);
    const result = rebuildSegmentsAfterDeletion([seg('s01'), seg('s12'), seg('s23')], plan, null);
    expect(result).toEqual([seg('s01'), seg('s12')]);
  });

  it('open curve: deleting an INTERIOR anchor requires bridging and replaces the two touching segments', () => {
    const plan = planAnchorDeletion(4, false, 1); // delete anchor 1 (between 0 and 2)
    expect(plan.needsBridging).toBe(true);
    expect(plan.prevAnchorIdx).toBe(0);
    expect(plan.nextAnchorIdx).toBe(2);
    const result = rebuildSegmentsAfterDeletion([seg('s01'), seg('s12'), seg('s23')], plan, seg('BRIDGE'));
    expect(result).toEqual([seg('BRIDGE'), seg('s23')]);
  });

  it('closed curve: deleting an INTERIOR anchor (no wraparound) replaces the two touching segments in place', () => {
    // 5 anchors closed -> 5 segments: s01,s12,s23,s34,s40. Delete anchor 2.
    const plan = planAnchorDeletion(5, true, 2);
    expect(plan.prevAnchorIdx).toBe(1);
    expect(plan.nextAnchorIdx).toBe(3);
    expect(plan.needsBridging).toBe(true);
    const oldSegments = [seg('s01'), seg('s12'), seg('s23'), seg('s34'), seg('s40')];
    const result = rebuildSegmentsAfterDeletion(oldSegments, plan, seg('BRIDGE'));
    expect(result).toEqual([seg('s01'), seg('BRIDGE'), seg('s34'), seg('s40')]);
  });

  it('closed curve: deleting anchor 0 (WRAPAROUND — the two touched segments sit at OPPOSITE ends of the array) is still correct', () => {
    // This is the exact bug this task's implementation caught and fixed: a
    // naive linear slice-and-splice mishandles this case.
    const plan = planAnchorDeletion(5, true, 0);
    expect(plan.prevAnchorIdx).toBe(4); // s40 touches the deleted anchor
    expect(plan.nextAnchorIdx).toBe(1); // s01 touches the deleted anchor
    expect(plan.needsBridging).toBe(true);
    const oldSegments = [seg('s01'), seg('s12'), seg('s23'), seg('s34'), seg('s40')];
    const result = rebuildSegmentsAfterDeletion(oldSegments, plan, seg('BRIDGE'));
    // New anchors, in order: [old1, old2, old3, old4] (old anchor 0 removed,
    // re-indexed to new indices [0,1,2,3]). Per this module's storage
    // convention (`segments[i]` joins `anchors[i]` -> `anchors[(i+1)%n]`),
    // the BRIDGE segment (old4 -> old1, replacing s40+s01) is the WRAPAROUND
    // edge from the new LAST anchor (new index 3 = old4) back to the new
    // FIRST anchor (new index 0 = old1) — i.e. segments[3], not segments[0].
    expect(result).toEqual([seg('s12'), seg('s23'), seg('s34'), seg('BRIDGE')]);
  });

  it('closed curve, minimum size (3 anchors): deleting any one still produces exactly 2 segments (an open 2-anchor result)', () => {
    // Below this task's own `deleteSelectedAnchor` minimum-count guard in
    // practice (which refuses at exactly 3) — this still exercises the pure
    // math correctly in isolation.
    const plan = planAnchorDeletion(3, true, 1);
    const result = rebuildSegmentsAfterDeletion([seg('s01'), seg('s12'), seg('s20')], plan, seg('BRIDGE'));
    expect(result).toEqual([seg('BRIDGE'), seg('s20')]);
  });

  it('rebuildSegmentsAfterDeletion throws if bridging is required but omitted (caller programming error)', () => {
    const plan = planAnchorDeletion(4, false, 1);
    expect(() => rebuildSegmentsAfterDeletion([seg('a'), seg('b'), seg('c')], plan, null)).toThrow(RangeError);
  });
});

describe('nearestSegmentIndex (pure)', () => {
  it('picks the segment whose sampled polyline is closest to the query point', () => {
    const segments: LiveMarginSegment[] = [
      { points: [[0, 0, 0], [1, 0, 0]] },
      { points: [[1, 0, 0], [1, 1, 0]] },
      { points: [[1, 1, 0], [0, 1, 0]] },
    ];
    expect(nearestSegmentIndex(segments, [0.5, 0, 0])).toBe(0);
    expect(nearestSegmentIndex(segments, [1, 0.5, 0])).toBe(1);
    expect(nearestSegmentIndex(segments, [0.5, 1, 0])).toBe(2);
  });

  it('returns null for zero segments', () => {
    expect(nearestSegmentIndex([], [0, 0, 0])).toBeNull();
  });
});

describe('summarizeAnchorDiff (pure)', () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [1, 0, 0];
  const c: Vec3 = [2, 0, 0];

  it('counts added anchors', () => {
    const diff: AnchorDiffSummary = summarizeAnchorDiff(
      [{ position: a, triangleIndex: 0, barycentric: [1, 0, 0] }],
      [
        { position: a, triangleIndex: 0, barycentric: [1, 0, 0] },
        { position: b, triangleIndex: 1, barycentric: [1, 0, 0] },
      ],
    );
    expect(diff).toEqual({ previousCount: 1, nextCount: 2, added: 1, removed: 0, moved: 0 });
  });

  it('counts removed anchors', () => {
    const diff = summarizeAnchorDiff(
      [
        { position: a, triangleIndex: 0, barycentric: [1, 0, 0] },
        { position: b, triangleIndex: 1, barycentric: [1, 0, 0] },
      ],
      [{ position: a, triangleIndex: 0, barycentric: [1, 0, 0] }],
    );
    expect(diff).toEqual({ previousCount: 2, nextCount: 1, added: 0, removed: 1, moved: 0 });
  });

  it('counts moved anchors only when the count is unchanged', () => {
    const diff = summarizeAnchorDiff(
      [
        { position: a, triangleIndex: 0, barycentric: [1, 0, 0] },
        { position: b, triangleIndex: 1, barycentric: [1, 0, 0] },
      ],
      [
        { position: a, triangleIndex: 0, barycentric: [1, 0, 0] },
        { position: c, triangleIndex: 2, barycentric: [1, 0, 0] },
      ],
    );
    expect(diff).toEqual({ previousCount: 2, nextCount: 2, added: 0, removed: 0, moved: 1 });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: manual mode + editing + journal coalescing (real WorkerPool, small
// icosahedron fixture — same construction as alignment.test.ts).
// ---------------------------------------------------------------------------

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: ReadonlyArray<readonly [number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces: ReadonlyArray<readonly [number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { positions: new Float64Array(raw.flat()), indices: Uint32Array.from(faces.flat()) };
}

/** Ray from well outside the mesh, through `vertex`, toward `center` — for a
 * convex icosahedron this reliably hits the surface AT `vertex` (same
 * convention as alignment.test.ts's own `rayAtVertex`, duplicated here per
 * this repo's "small fixture helper, not shared" convention). */
function rayAtVertex(vertex: Vec3, center: readonly [number, number, number]): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const offset: Vec3 = [vertex[0] - center[0], vertex[1] - center[1], vertex[2] - center[2]];
  const len = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const dir: Vec3 = [-offset[0] / len, -offset[1] / len, -offset[2] / len];
  const origin: Vec3 = [center[0] + offset[0] * 3, center[1] + offset[1] * 3, center[2] + offset[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

function registerIcosahedron(): { nodeId: string; positions: Float64Array } {
  const { positions, indices } = icosahedronBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'margin-ico',
    name: 'margin-ico.stl',
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([-2, -2, -2], [2, 2, 2]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('margin-ico', 'prepDie');
  return { nodeId: node.id, positions };
}

beforeEach(() => {
  caseStore.resetForTests();
  marginEditor.resetForTests();
  resetBvhCacheForTests();
});

describe('marginEditor — manual mode + editing + journal coalescing', () => {
  it('accumulates anchor placements locally (uncommitted) until an explicit close, then auto-commits every further gesture', async () => {
    const { nodeId, positions } = registerIcosahedron();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });

    marginEditor.startForTooth(restoration.id, 11);
    marginEditor.setMode('manual');
    expect(useMarginStore.getState().phase).toBe('active');

    const historyBefore = useCaseStore.getState().document.history.length;

    // Place 4 anchors at 4 known icosahedron vertices — none of this commits
    // (deliverable 3's "no per-click journal spam during freehand tracing" —
    // see marginEditor.ts's top doc, "Commit model").
    for (let i = 0; i < 4; i++) {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, i), [0, 0, 0]));
    }
    expect(useMarginStore.getState().anchors).toHaveLength(4);
    expect(useMarginStore.getState().closed).toBe(false);
    expect(useCaseStore.getState().document.history).toHaveLength(historyBefore); // still nothing journaled
    expect(restorationMarginLine(restoration.id, 11)).toBeUndefined();

    // Explicit close (≥3 anchors) — the FIRST commit.
    await marginEditor.toggleClosed();
    expect(useMarginStore.getState().closed).toBe(true);
    const afterClose = useCaseStore.getState().document.history;
    expect(afterClose).toHaveLength(historyBefore + 1);
    expect(afterClose.at(-1)!.name).toBe('margin-edit');
    expect(afterClose.at(-1)!.params.gesture).toBe('toggle-close');
    const savedLine = restorationMarginLine(restoration.id, 11)!;
    expect(savedLine.anchors).toHaveLength(4);
    expect(savedLine.closed).toBe(true);
    expect(typeof afterClose.at(-1)!.outputHashes[0]).toBe('string');
    expect(afterClose.at(-1)!.outputHashes[0]!.length).toBe(64); // sha256 hex

    // ONE further placement click, NOW that a baseline is established, DOES
    // immediately commit (deliverable 2/3) — routed as "add anchor on
    // segment" since the curve is already closed.
    await marginEditor.handlePick(rayAtVertex(pointAt(positions, 5), [0, 0, 0]));
    expect(useMarginStore.getState().anchors).toHaveLength(5);
    const afterAdd = useCaseStore.getState().document.history;
    expect(afterAdd).toHaveLength(historyBefore + 2);
    expect(afterAdd.at(-1)!.params.gesture).toBe('add-anchor-on-segment');
  });

  it('delete-anchor: select + delete removes the anchor and journals ONE op', async () => {
    const { nodeId, positions } = registerIcosahedron();
    const restoration = createRestoration({ type: 'crown', teeth: [21], targetNodeId: nodeId });
    marginEditor.startForTooth(restoration.id, 21);
    marginEditor.setMode('manual');
    for (let i = 0; i < 5; i++) {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, i), [0, 0, 0]));
    }
    await marginEditor.toggleClosed();
    expect(useMarginStore.getState().anchors).toHaveLength(5);

    const historyBefore = useCaseStore.getState().document.history.length;
    marginEditor.selectAnchor(0); // delete the anchor at the CLOSED curve's wraparound boundary
    await marginEditor.deleteSelectedAnchor();

    expect(useMarginStore.getState().anchors).toHaveLength(4);
    expect(useMarginStore.getState().segments).toHaveLength(4); // still closed: segments === anchors
    const history = useCaseStore.getState().document.history;
    expect(history).toHaveLength(historyBefore + 1); // exactly one coalesced op
    expect(history.at(-1)!.params.gesture).toBe('delete-anchor');
    const savedLine = restorationMarginLine(restoration.id, 21)!;
    expect(savedLine.anchors).toHaveLength(4);
  });

  it('drag: live pointermove updates are NOT journaled; drag-end commits exactly ONE op (journal coalescing)', async () => {
    const { nodeId, positions } = registerIcosahedron();
    const restoration = createRestoration({ type: 'crown', teeth: [12], targetNodeId: nodeId });
    marginEditor.startForTooth(restoration.id, 12);
    marginEditor.setMode('manual');
    for (let i = 0; i < 4; i++) {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, i), [0, 0, 0]));
    }
    await marginEditor.toggleClosed();

    const historyBefore = useCaseStore.getState().document.history.length;
    const anchorBeforeDrag = useMarginStore.getState().anchors[0]!.position;

    marginEditor.beginAnchorDrag(0);
    // Several intermediate pointermove-equivalent updates — none of these
    // should journal (deliverable 3).
    for (let step = 0; step < 4; step++) {
      const target = pointAt(positions, 6); // drag toward a different vertex
      await marginEditor.updateAnchorDrag(rayAtVertex(target, [0, 0, 0]));
      expect(useCaseStore.getState().document.history).toHaveLength(historyBefore);
    }
    await marginEditor.endAnchorDrag();

    const history = useCaseStore.getState().document.history;
    expect(history).toHaveLength(historyBefore + 1); // ONE coalesced op, not 4
    expect(history.at(-1)!.params.gesture).toBe('drag-anchor');
    const movedAnchor = useMarginStore.getState().anchors[0]!.position;
    expect(movedAnchor).not.toEqual(anchorBeforeDrag);
    const diff = history.at(-1)!.params.diff as AnchorDiffSummary;
    expect(diff.moved).toBe(1);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('startForTooth throws for a restoration with no assigned target scan', () => {
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
    expect(() => marginEditor.startForTooth(restoration.id, 11)).toThrow(/target scan/);
  });
});

function restorationMarginLine(restorationId: string, tooth: number) {
  const restoration = useCaseStore.getState().document.restorations.find((r) => r.id === restorationId);
  return restoration?.marginLines[tooth as 11 | 12 | 21];
}

// ---------------------------------------------------------------------------
// Tier 3: real fixtures.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** A minimal Float64 indexed mesh — `IndexedMesh` (`@dqcad/kernel`) is
 * deliberately NOT imported here (`engine/` may only depend on
 * `@dqcad/kernel-workers`, never `@dqcad/kernel`/`@dqcad/io` directly — see
 * CLAUDE.md's layer rule, lint-enforced): `loadFixtureMesh` below parses +
 * intakes a real STL fixture through the SAME `parseMeshFile`/`intakeMesh`
 * WORKER JOBS engine/importer.ts itself uses for a real import, rather than
 * calling `@dqcad/io`'s `parseStl`/`@dqcad/kernel`'s `intake` directly. */
interface TestMesh {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
  contentHash: string;
}

async function loadFixtureMesh(...pathParts: string[]): Promise<TestMesh> {
  const bytes = readFileSync(join(repoRoot, 'test-fixtures', ...pathParts));
  const parsed = await getPool().run('parseMeshFile', { format: 'stl', bytes: new Uint8Array(bytes) });
  const intakeResult = await getPool().run('intakeMesh', { kind: 'soup', positions: parsed.positions });
  return {
    positions: intakeResult.positions,
    indices: intakeResult.indices,
    stats: intakeResult.stats,
    report: intakeResult.report,
    contentHash: intakeResult.contentHash,
  };
}

/** Ray from `point + normal*5` back down at `point`, along `-normal` — hits
 * the mesh very close to (usually exactly at) `point`'s own triangle,
 * without needing any assumption about the mesh's overall shape/orientation
 * (unlike `rayAtVertex`'s "convex mesh, ray through a vertex toward its
 * centroid" trick, which only works for star-convex meshes). */
function rayThroughSurfacePoint(mesh: Pick<TestMesh, 'positions' | 'indices'>, point: Vec3, triangleIndex: number): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const i0 = mesh.indices[triangleIndex * 3]!;
  const i1 = mesh.indices[triangleIndex * 3 + 1]!;
  const i2 = mesh.indices[triangleIndex * 3 + 2]!;
  const p = mesh.positions;
  const v0: Vec3 = [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!];
  const v1: Vec3 = [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!];
  const v2: Vec3 = [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!];
  const e1: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const normal: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  const origin: Vec3 = [point[0] + normal[0] * 5, point[1] + normal[1] * 5, point[2] + normal[2] * 5];
  const direction: Vec3 = [-normal[0], -normal[1], -normal[2]];
  return { rayOrigin: origin, rayDirection: direction };
}

describe('marginEditor — propose error path (real standin-prep-die.stl, verified convex everywhere)', () => {
  it('NoRidgeFoundError falls into manual mode with anchors DISCARDED (typed error carries no partial loop)', async () => {
    const mesh = await loadFixtureMesh('standin-scans', 'standin-prep-die.stl');
    caseStore.registerImportedMesh({
      contentHash: 'margin-die',
      name: 'standin-prep-die.stl',
      format: 'stl',
      positions: mesh.positions,
      indices: mesh.indices,
      stats: mesh.stats,
      report: mesh.report,
      operations: [],
    });
    const node = caseStore.addSceneNode('margin-die', 'prepDie');
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: node.id });
    marginEditor.startForTooth(restoration.id, 11);
    expect(useMarginStore.getState().mode).toBe('auto');

    // Any vertex works (convex everywhere -> guaranteed no ridge anywhere).
    const vertexIndex = Math.floor(mesh.positions.length / 3 / 2);
    const vertex = pointAt(mesh.positions, vertexIndex);
    const vertexCount = mesh.positions.length / 3;
    const centroid: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < vertexCount; i++) {
      centroid[0] += mesh.positions[i * 3]! / vertexCount;
      centroid[1] += mesh.positions[i * 3 + 1]! / vertexCount;
      centroid[2] += mesh.positions[i * 3 + 2]! / vertexCount;
    }
    await marginEditor.handlePick(rayAtVertex(vertex, centroid));

    const store = useMarginStore.getState();
    // Deliberately still 'active' (not a distinct 'error' phase — see
    // state/marginStore.ts's `MarginToolPhase` doc) — the tool stays
    // immediately clickable in manual mode right after the failure.
    expect(store.phase).toBe('active');
    expect(store.error).not.toBeNull();
    expect(store.mode).toBe('manual');
    expect(store.anchors).toHaveLength(0); // nothing to discard — verified: no partial loop
    expect(marginEditor.getErrorKind()).toBe('noRidgeFound');
  }, 30_000);
});

describe('marginEditor — auto-propose success + drag latency (real arch-case-01 upperjaw, Task 4 golden seed)', () => {
  it('proposes a closed margin at the known-good seed and measures anchor-drag latency', async () => {
    const mesh = await loadFixtureMesh('real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
    const triangleCount = mesh.indices.length / 3;
    expect(triangleCount).toBeGreaterThan(200_000); // sanity: the real ~250k-tri fixture

    caseStore.registerImportedMesh({
      contentHash: 'margin-upperjaw',
      name: 'arch-case-01-upperjaw.stl',
      format: 'stl',
      positions: mesh.positions,
      indices: mesh.indices,
      stats: mesh.stats,
      report: mesh.report,
      operations: [],
    });
    const node = caseStore.addSceneNode('margin-upperjaw', 'upperJaw');
    // FDI 21 — the golden's own "tooth21"-position candidate (Task 4's
    // report): the closing anterior margin at this seed, NOT tooth 11 (the
    // Verify section's separate MANUAL dev-server check target — a
    // different, also-closing anterior tooth).
    const restoration = createRestoration({ type: 'crown', teeth: [21], targetNodeId: node.id });
    marginEditor.startForTooth(restoration.id, 21);
    expect(useMarginStore.getState().mode).toBe('auto');

    // scripts/kernel-ops-lib.ts's own pinned golden seed (Phase 3 Task 4) —
    // reused verbatim so this test proposes from a KNOWN-closing seed rather
    // than guessing a new one.
    const goldenSeedAmbient: Vec3 = [6.675659656524658, -17.737689971923828, 10.945829391479492];

    await ensureBvhBuilt('margin-upperjaw', mesh.positions, mesh.indices);
    const seedHit = await measureClosestPoint('margin-upperjaw', goldenSeedAmbient);
    const seedRay = rayThroughSurfacePoint(mesh, seedHit.point, seedHit.triangleIndex);

    const proposeStart = performance.now();
    await marginEditor.handlePick(seedRay);
    const proposeMs = performance.now() - proposeStart;

    const proposed = useMarginStore.getState();
    if (proposed.error || proposed.anchors.length === 0) {
      throw new Error(`propose unexpectedly failed at the known-good golden seed: ${proposed.error}`);
    }
    expect(proposed.phase).toBe('active');
    expect(proposed.closed).toBe(true);
    expect(proposed.humanEdited).toBe(false); // fresh, unedited proposal -> "proposed" color
    expect(proposed.anchors.length).toBeGreaterThan(50); // curvature-adaptive density, real report cites 261
    expect(proposed.segments).toHaveLength(proposed.anchors.length);
    expect(proposed.segmentConfidence).not.toBeNull();
    console.log(`[marginEditor propose] real upperjaw (${triangleCount} triangles), ${proposed.anchors.length} anchors: ${proposeMs.toFixed(1)}ms`);

    // --- Deliverable 5: measure REAL anchor-drag latency on the real fixture ---
    const dragIndex = Math.floor(proposed.anchors.length / 2);
    const anchorBefore = proposed.anchors[dragIndex]!.position;
    // A small, realistic nudge (0.3mm) — re-projected onto the surface via
    // the SAME raycast path a live drag uses.
    const nudged: Vec3 = [anchorBefore[0] + 0.3, anchorBefore[1], anchorBefore[2]];
    const nudgedHit = await measureClosestPoint('margin-upperjaw', nudged);
    const dragRay = rayThroughSurfacePoint(mesh, nudgedHit.point, nudgedHit.triangleIndex);

    marginEditor.beginAnchorDrag(dragIndex);
    const WARM_CALLS = 5;
    const timings: number[] = [];
    for (let i = 0; i < WARM_CALLS; i++) {
      const t0 = performance.now();
      await marginEditor.updateAnchorDrag(dragRay);
      timings.push(performance.now() - t0);
    }
    const maxMs = Math.max(...timings);
    const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(
      `[marginEditor drag latency] real upperjaw (${triangleCount} triangles), interior anchor (up to 2 geodesic segments recomputed): ` +
        `${WARM_CALLS} calls, max ${maxMs.toFixed(2)}ms, avg ${avgMs.toFixed(2)}ms (target: < 100ms/edit)`,
    );
    expect(maxMs).toBeLessThan(100);

    const historyBefore = useCaseStore.getState().document.history.length;
    await marginEditor.endAnchorDrag();
    const history = useCaseStore.getState().document.history;
    expect(history).toHaveLength(historyBefore + 1); // one coalesced commit, not WARM_CALLS+1
    expect(history.at(-1)!.params.gesture).toBe('drag-anchor');
  }, 60_000);
});

async function measureClosestPoint(contentHash: string, point: Vec3): Promise<{ point: Vec3; triangleIndex: number }> {
  const result = await getPool().run('measurePointToSurface', { contentHash, point }, { affinityKey: contentHash });
  return { point: result.point, triangleIndex: result.triangleIndex };
}
