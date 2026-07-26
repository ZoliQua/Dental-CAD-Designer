// scripts/journal-replay-lib.ts
//
// Shared "record a scripted case journal, then replay it fresh" logic for
// Phase 2 Task 8's journal-replay harness (PLAN §6.3 / PLAN.md §6 invariant
// 3: "Journal reproducibility. Replaying a case journal reproduces every
// stage hash."). Imported by BOTH scripts/replay-journal.ts (CLI entry) and
// test/golden/journal-replay.test.ts (CI-wired assertions) — one source of
// truth, same reasoning as scripts/kernel-ops-lib.ts.
//
// ## What "replay" means here, precisely (ADR-001)
//
// docs/adr/001-post-intake-stl-persistence.md documents that a real,
// deployed case NEVER retains the original uploaded file bytes past the
// importing session — only the mesh's POST-INTAKE geometry survives
// (re-serialized to binary STL, content-addressed on the server). So a
// literal "replay `import-mesh` by re-running `parseMeshFile` +
// `intakeMesh` against the original file" is impossible for a case loaded
// from storage. ADR-001's decision: this harness's `import-mesh` REPLAY
// step is `weldMeshSoup(storedStlBytes)` — jobs/io.ts's "intake-skip"
// reconstruction (`weldVertices` alone; `dropDegenerateTriangles`/
// `orientNormalsConsistently` are structural no-ops on an already-clean,
// already-oriented mesh, so re-running only the weld is equivalent) — NOT a
// fresh `intake()` from raw scan bytes.
//
// Concretely, for the `import-mesh` operation, THIS HARNESS'S "RECORD" step
// and "REPLAY" step are the SAME computation (`weldMeshSoup`-equivalent
// reconstruction of the SAME stored STL bytes), run at two different times
// — proving that reconstruction is deterministic (bit-identical every time
// a case is reloaded), which is precisely, and ONLY, the claim ADR-001
// says this harness can make. The (separate, stronger) claim "intake
// itself is deterministic against the ORIGINAL scan bytes" is already
// covered by test/golden/intake.test.ts's own goldens, whose fixtures keep
// their original files on disk (unlike a real deployed case).
//
// `unit-rescale` and the 4 `repair-*` operations have no such caveat —
// their kernel effects (`rescaleMesh`: multiply positions by a factor;
// `removeComponents`/`splitNonManifoldEdges`/`fillSmallHoles`/
// `splitNonManifoldVertices`: pure functions of an already-in-memory
// `IndexedMesh`) never touch a lossy file boundary at all, so their replay
// is a straightforward fresh recomputation from the SAME recorded inputs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStl, writeStlBinary } from '@dqcad/io';
import {
  KERNEL_VERSION,
  intake,
  weldVertices,
  indexedToSoup,
  removeComponents,
  splitNonManifoldEdges,
  fillSmallHoles,
  splitNonManifoldVertices,
  buildHalfedge,
  buildBvh,
  computeCurvature,
  snapToSurface,
  evaluateSurfacePoint,
  proposeMarginLoop,
  type IndexedMesh,
  type SurfacePoint,
  type Vec3,
} from '@dqcad/kernel';
import { runMorphingStage, type PipelineContext, type PipelineMaterialProfile, type PipelineMeshHandle } from '@dqcad/cad-pipeline';
import type { FdiTooth, MarginReferenceExport, Operation } from '@dqcad/shared-types';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// --- hashing (byte-for-byte the same convention as
// packages/kernel-workers/src/hash.ts's sha256Hex/hashMeshContent/
// hashFloat64 — reimplemented locally since neither this script nor
// test/golden/ may import kernel-workers' internal, non-exported job
// functions; see this task's report for why re-derivation, not a deep
// import, is the correct call here) --------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashMeshContent(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

function hashFloat64(values: Float64Array): string {
  return sha256Hex(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

// --- "intake-skip" reconstruction (jobs/io.ts's weldMeshSoup kernel effect,
// re-derived from already-public @dqcad/kernel functions — see this file's
// module doc) ---------------------------------------------------------------

function weldMeshSoupEquivalent(stlBytes: Uint8Array): IndexedMesh {
  const { soup } = parseStl(stlBytes);
  return weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });
}

// --- fixture loading ---------------------------------------------------

function readFixtureBytes(relPath: string): Uint8Array {
  const buffer = readFileSync(join(repoRoot, relPath));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

// --- small local seeded-damage helpers (same convention as
// scripts/kernel-ops-lib.ts — see that file's module doc for why these are
// re-derived locally rather than importing kernel's TEST-ONLY fixtures) ---

function addFarAwayStrayTriangle(mesh: IndexedMesh): IndexedMesh {
  const vertexCount = mesh.positions.length / 3;
  const positions = new Float64Array(mesh.positions.length + 9);
  positions.set(mesh.positions, 0);
  positions.set([1000, 1000, 1000, 1001, 1000, 1000, 1000, 1001, 1000], mesh.positions.length);
  const indices = new Uint32Array(mesh.indices.length + 3);
  indices.set(mesh.indices, 0);
  indices.set([vertexCount, vertexCount + 1, vertexCount + 2], mesh.indices.length);
  return { positions, indices };
}

function duplicateTriangleZero(mesh: IndexedMesh): IndexedMesh {
  const indices = new Uint32Array(mesh.indices.length + 3);
  indices.set(mesh.indices, 0);
  indices.set(mesh.indices.subarray(0, 3), mesh.indices.length);
  return { positions: mesh.positions, indices };
}

function removeTriangleZero(mesh: IndexedMesh): IndexedMesh {
  return { positions: mesh.positions, indices: mesh.indices.subarray(3) };
}

/** Turns vertex 0 into a bowtie: glues a brand-new, otherwise-disjoint
 * closed tetrahedral fan onto it, reusing vertex 0 as that fan's apex —
 * same "share only the apex" construction as
 * packages/kernel/src/repair/repair.test-fixtures.ts's `apexFan`/
 * `singleBowtieMesh` (re-derived locally, not imported, per this file's
 * module doc), just placed far away (same `+1000`-offset convention as
 * `addFarAwayStrayTriangle` above) so the new fan's base vertices can never
 * accidentally coincide with anything already in `mesh`. `findNonManifoldVertices`
 * then reports vertex 0 with `fanCount: 2` (its pre-existing fan + this
 * one) — exactly the input `splitNonManifoldVertices` exists to repair. */
function attachBowtieFanAtVertexZero(mesh: IndexedMesh): IndexedMesh {
  const apex = 0;
  const apexX = mesh.positions[0]!;
  const apexY = mesh.positions[1]!;
  const apexZ = mesh.positions[2]!;
  const offset = 1000;
  const baseIndex = mesh.positions.length / 3;
  const b0 = baseIndex;
  const b1 = baseIndex + 1;
  const b2 = baseIndex + 2;

  const positions = new Float64Array(mesh.positions.length + 9);
  positions.set(mesh.positions, 0);
  positions.set(
    [
      apexX + offset, apexY, apexZ,
      apexX, apexY + offset, apexZ,
      apexX, apexY, apexZ + offset,
    ],
    mesh.positions.length,
  );

  // Closed tetrahedron over (apex, b0, b1, b2) — consistent outward winding,
  // apex vertex REUSED (not duplicated) so it becomes a bowtie, mirroring
  // `apexFan`'s exact triangle layout.
  const newTriangles = [apex, b0, b1, apex, b2, b0, apex, b1, b2, b0, b2, b1];
  const indices = new Uint32Array(mesh.indices.length + newTriangles.length);
  indices.set(mesh.indices, 0);
  indices.set(newTriangles, mesh.indices.length);

  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Recorded journal shape
// ---------------------------------------------------------------------------

export interface ReplayStep {
  /** Index into `RecordedJournal.operations` this step replays. */
  operationIndex: number;
  /** Recomputes this operation's kernel effect FRESH (not reusing any
   * already-computed result) and returns its output hash — compared against
   * `operations[operationIndex].outputHashes[0]`. */
  recompute: () => string;
}

export interface RecordedJournal {
  fixtureLabel: string;
  /** The scripted case journal — same shape a real CaseDocument.history
   * would carry (packages/shared-types' `Operation`). */
  operations: readonly Operation[];
  replaySteps: readonly ReplayStep[];
  /** The final mesh state after every operation — for a human/report to
   * sanity-check (e.g. triangle counts), not itself part of the replay
   * proof. */
  finalMesh: IndexedMesh;
}

const FORCED_RESCALE_FACTOR = 2.54; // arbitrary but fixed — see recordJournal's doc.

/**
 * Records a scripted case journal on `fixtureRelPath` (a committed STL
 * fixture): import -> unit-rescale -> 4 chained repair ops. See this file's
 * module doc for exactly what "replay" proves for each operation kind.
 *
 * `includeRescaleAndRepair`: arch-case-01 upperjaw (a real, open scan) gets
 * import-only coverage — real scans don't need a synthetic unit-mistake or
 * seeded damage to prove replay works on THIS repo's real-fixture set; the
 * small synthetic fixture(s) get the full chain.
 */
export function recordJournal(fixtureRelPath: string, fixtureLabel: string, includeRescaleAndRepair: boolean): RecordedJournal {
  const rawBytes = readFixtureBytes(fixtureRelPath);
  const { soup } = parseStl(rawBytes);
  const originalMesh = intake({ kind: 'soup', soup }).mesh;

  // Simulates "this mesh was saved, then a later session reloads it" —
  // ADR-001's storage boundary. storedBytes is the ONLY thing the replay
  // steps below are allowed to depend on for `import-mesh` (never
  // `rawBytes`/`originalMesh` directly) — see this file's module doc.
  const storedBytes = writeStlBinary(indexedToSoup(originalMesh));
  const storedBytesHash = sha256Hex(storedBytes);

  const operations: Operation[] = [];
  const replaySteps: ReplayStep[] = [];
  const timestamp = new Date(0).toISOString(); // fixed — journal timestamps are audit-display-only, never fed into computations (shared-types' Operation doc); a fixed value keeps this script's own output deterministic byte-for-byte.

  // --- import-mesh (ADR-001 intake-skip reconstruction) ------------------
  const reconstructed0 = weldMeshSoupEquivalent(storedBytes);
  const contentHash0 = hashMeshContent(reconstructed0.positions, reconstructed0.indices);
  operations.push({
    id: `${fixtureLabel}-import-mesh`,
    name: 'import-mesh',
    params: { fixture: fixtureLabel, triangleCount: reconstructed0.indices.length / 3 },
    inputHashes: [storedBytesHash],
    outputHashes: [contentHash0],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 0,
    recompute: () => {
      const fresh = weldMeshSoupEquivalent(storedBytes);
      return hashMeshContent(fresh.positions, fresh.indices);
    },
  });

  let currentMesh = reconstructed0;

  if (!includeRescaleAndRepair) {
    return { fixtureLabel, operations, replaySteps, finalMesh: currentMesh };
  }

  // --- unit-rescale --------------------------------------------------
  // A FORCED, deliberate rescale (not derived from the real unit-mistake
  // heuristic — apps/client/src/engine/units.ts's `suggestUnitRescale`,
  // out of scope here) — this harness exercises the rescaleMesh OPERATION's
  // replay mechanics (positions *= factor, hash before/after), not the
  // heuristic that decides WHEN to offer it (covered by
  // apps/client/src/engine/importer.test.ts).
  const preRescalePositions = currentMesh.positions;
  const beforeHash = hashFloat64(preRescalePositions);
  const rescaledPositions = new Float64Array(preRescalePositions.length);
  for (let i = 0; i < preRescalePositions.length; i++) {
    rescaledPositions[i] = preRescalePositions[i]! * FORCED_RESCALE_FACTOR;
  }
  const afterHash = hashFloat64(rescaledPositions);
  operations.push({
    id: `${fixtureLabel}-unit-rescale`,
    name: 'unit-rescale',
    params: { fixture: fixtureLabel, factor: FORCED_RESCALE_FACTOR },
    inputHashes: [beforeHash],
    outputHashes: [afterHash],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 1,
    recompute: () => {
      const fresh = new Float64Array(preRescalePositions.length);
      for (let i = 0; i < preRescalePositions.length; i++) {
        fresh[i] = preRescalePositions[i]! * FORCED_RESCALE_FACTOR;
      }
      return hashFloat64(fresh);
    },
  });
  currentMesh = { positions: rescaledPositions, indices: currentMesh.indices };

  // --- repair-remove-components (seeded: a far-away stray triangle) ------
  const beforeRemoveComponents = addFarAwayStrayTriangle(currentMesh);
  const inputHashRc = hashMeshContent(beforeRemoveComponents.positions, beforeRemoveComponents.indices);
  const removeComponentsSelector = { mode: 'minTriangles' as const, minTriangles: 2 };
  const afterRemoveComponentsResult = removeComponents(beforeRemoveComponents, removeComponentsSelector);
  const outputHashRc = hashMeshContent(afterRemoveComponentsResult.mesh.positions, afterRemoveComponentsResult.mesh.indices);
  operations.push({
    id: `${fixtureLabel}-repair-remove-components`,
    name: 'repair-remove-components',
    params: { fixture: fixtureLabel, selector: removeComponentsSelector },
    inputHashes: [inputHashRc],
    outputHashes: [outputHashRc],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 2,
    recompute: () => {
      const fresh = removeComponents(beforeRemoveComponents, removeComponentsSelector);
      return hashMeshContent(fresh.mesh.positions, fresh.mesh.indices);
    },
  });
  currentMesh = afterRemoveComponentsResult.mesh;

  // --- repair-split-non-manifold-edges (seeded: duplicated triangle 0) ---
  const beforeSplit = duplicateTriangleZero(currentMesh);
  const inputHashSplit = hashMeshContent(beforeSplit.positions, beforeSplit.indices);
  const afterSplitResult = splitNonManifoldEdges(beforeSplit);
  const outputHashSplit = hashMeshContent(afterSplitResult.mesh.positions, afterSplitResult.mesh.indices);
  operations.push({
    id: `${fixtureLabel}-repair-split-non-manifold-edges`,
    name: 'repair-split-non-manifold-edges',
    params: { fixture: fixtureLabel },
    inputHashes: [inputHashSplit],
    outputHashes: [outputHashSplit],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 3,
    recompute: () => {
      const fresh = splitNonManifoldEdges(beforeSplit);
      return hashMeshContent(fresh.mesh.positions, fresh.mesh.indices);
    },
  });
  currentMesh = afterSplitResult.mesh;

  // --- repair-fill-small-holes (seeded: triangle 0 removed) ---------------
  const beforeFill = removeTriangleZero(currentMesh);
  const inputHashFill = hashMeshContent(beforeFill.positions, beforeFill.indices);
  const afterFillResult = fillSmallHoles(beforeFill);
  const outputHashFill = hashMeshContent(afterFillResult.mesh.positions, afterFillResult.mesh.indices);
  operations.push({
    id: `${fixtureLabel}-repair-fill-small-holes`,
    name: 'repair-fill-small-holes',
    params: { fixture: fixtureLabel },
    inputHashes: [inputHashFill],
    outputHashes: [outputHashFill],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 4,
    recompute: () => {
      const fresh = fillSmallHoles(beforeFill);
      return hashMeshContent(fresh.mesh.positions, fresh.mesh.indices);
    },
  });
  currentMesh = afterFillResult.mesh;

  // --- repair-split-non-manifold-vertices (seeded: vertex 0 turned into a
  // bowtie by gluing on a disjoint fan) ------------------------------------
  const beforeSplitVertices = attachBowtieFanAtVertexZero(currentMesh);
  const inputHashSplitVertices = hashMeshContent(beforeSplitVertices.positions, beforeSplitVertices.indices);
  const afterSplitVerticesResult = splitNonManifoldVertices(beforeSplitVertices);
  const outputHashSplitVertices = hashMeshContent(
    afterSplitVerticesResult.mesh.positions,
    afterSplitVerticesResult.mesh.indices,
  );
  operations.push({
    id: `${fixtureLabel}-repair-split-non-manifold-vertices`,
    name: 'repair-split-non-manifold-vertices',
    params: { fixture: fixtureLabel },
    inputHashes: [inputHashSplitVertices],
    outputHashes: [outputHashSplitVertices],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  });
  replaySteps.push({
    operationIndex: 5,
    recompute: () => {
      const fresh = splitNonManifoldVertices(beforeSplitVertices);
      return hashMeshContent(fresh.mesh.positions, fresh.mesh.indices);
    },
  });
  currentMesh = afterSplitVerticesResult.mesh;

  return { fixtureLabel, operations, replaySteps, finalMesh: currentMesh };
}

export interface ReplayFailure {
  fixtureLabel: string;
  operationId: string;
  operationName: string;
  expectedHash: string;
  actualHash: string;
}

/** Replays every step in `journal.replaySteps`, comparing each FRESH
 * recomputation against the matching recorded `Operation.outputHashes[0]`.
 * Returns every failure found (empty = full reproducibility). */
export function replayJournal(journal: RecordedJournal): ReplayFailure[] {
  const failures: ReplayFailure[] = [];
  for (const step of journal.replaySteps) {
    const operation = journal.operations[step.operationIndex]!;
    const expectedHash = operation.outputHashes[0]!;
    const actualHash = step.recompute();
    if (actualHash !== expectedHash) {
      failures.push({
        fixtureLabel: journal.fixtureLabel,
        operationId: operation.id,
        operationName: operation.name,
        expectedHash,
        actualHash,
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Phase 3 Task 11: margin/axis journal-replay extension
//
// PLAN.md invariant 3 / this task's brief: "margin/axis ops with kernel
// effects... enter the replay harness". Of the 3 margin/axis `Operation`
// names `apps/client/src/engine/` actually journals —
//   - `margin-edit` (marginEditor.ts): committed on EVERY margin-anchor
//     gesture. When it is a session's FIRST commit AND that session began
//     with a successful auto-proposal, it additionally carries
//     `params.seed` (triangleIndex+barycentric) and
//     `params.proposalDefaults.targetAnchorCount` — enough to
//     DETERMINISTICALLY re-derive the exact same anchor set via
//     `proposeMarginLoop` alone (a pure function of mesh + seed + options,
//     CLAUDE.md invariant 2), and `outputHashes[0]` is a real
//     content-addressed hash (SHA-256 over the anchors' flat Float64
//     ambient-position buffer — `marginEditor.ts`'s `hashAnchorPositionsHex`,
//     re-derived below via this file's own `hashFloat64`, same convention
//     as `import-mesh`/`repair-*` above) — REPLAYABLE, and
//     `recordMarginProposeJournal` below does exactly that. A LATER
//     `margin-edit` from a manual anchor drag carries no such seed (its
//     input is an interactive screen pick, not reproducible from journaled
//     params alone) — out of scope here, same as any other non-deterministic
//     user gesture.
//   - `margin-confirm` (marginEditor.ts) and `axis-set` (axis.ts): BOTH are
//     param-records with NO content-addressed geometric output to replay
//     against — `margin-confirm` re-hashes whatever anchor state the prior
//     `margin-edit` already committed (no NEW kernel computation of its
//     own); `axis-set` carries `inputHashes: []`/`outputHashes: []`
//     entirely (it stamps a direction vector onto the restoration — a
//     `SceneNode`-adjacent bookkeeping write, not a mesh-byte or
//     content-addressed output). This is the EXACT "no mesh-byte output for
//     a replay to assert bit-identity over" category
//     `docs/adr/002-scene-ops-not-journaled.md`'s `alignment-apply`
//     amendment already documents for a structurally identical case
//     (`suggestAxis`'s own determinism, like `icpRegister`'s, is separately
//     covered by `packages/kernel/src/axis`'s and
//     `packages/kernel-workers/src/axisJobs.test.ts`'s own determinism
//     tests — NOT this journal-replay harness's job). Deliberately NOT
//     given a `RecordedJournal` entry here — documented as excluded, not an
//     oversight.
// ---------------------------------------------------------------------------

const MARGIN_JOURNAL_UPPERJAW_PATH = 'test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl';
const MARGIN_JOURNAL_REFERENCE_PATH = 'test-fixtures/margins/arch-case-01/21.reference.json';
/** Tooth 21, not 11: `scripts/margin-acceptance.ts`'s own
 * `EXPECTED_NON_CLOSING_TEETH = [11]` documents that tooth 11's real-scan
 * curvature signal never closes into a loop at all (`NoClosureError`) on
 * this fixture — not usable as a replay seed. 21 is one of the 3 closing
 * teeth (`AMENDED_ACCEPTANCE_ASSERTION_TEETH`) and the highest-coverage of
 * the three (see `docs/demos/phase-3-task-8-evidence.md`'s amended-criterion
 * table) — an arbitrary-but-reasoned, reproducible choice among the 3
 * closing teeth (this harness only needs ONE seeded propose to prove
 * replayability, not a repeat of Task 8's own accuracy measurement). */
const MARGIN_JOURNAL_TOOTH = 21;
/** Mirrors `apps/client/src/engine/marginEditor.ts`'s
 * `MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT` — re-derived locally (this file's
 * own "duplicate the trivial constant across the script/app boundary"
 * convention, matching the seeded-damage helpers above) rather than
 * importing across the `scripts/` <-> `apps/client/` boundary. */
const MARGIN_JOURNAL_TARGET_ANCHOR_COUNT = 50;

interface MarginUpperjawSetup {
  mesh: IndexedMesh;
  hm: ReturnType<typeof buildHalfedge>;
  curvature: ReturnType<typeof computeCurvature>;
  bvh: ReturnType<typeof buildBvh>;
}

let cachedMarginUpperjawSetup: MarginUpperjawSetup | null = null;

/**
 * Loads + builds the shared, deterministic PRE-REQUISITE structures
 * (mesh, halfedge overlay, curvature, BVH) `proposeMarginLoop` needs,
 * memoized across calls within this process. This does NOT cache the thing
 * actually being replayed — `proposeMarginLoop` itself is always called
 * FRESH, both in `recordMarginProposeJournal` and inside its replay step's
 * own `recompute()` closure below — only the surrounding infrastructure,
 * exactly the same "cache the expensive deterministic setup, recompute the
 * operation itself" split `packages/kernel-workers/src/jobs/margin.ts`'s
 * own per-worker halfedge/curvature caches already use in production (see
 * that file's module doc for the identical reasoning). Without this,
 * `recordAllFixtures()`'s own repeated self-calls (this file's
 * `test/golden/journal-replay.test.ts`'s "is itself deterministic" case,
 * and its `it.each`'s own argument list) would rebuild curvature + BVH on a
 * real ~250k-triangle clinical scan several times over per test run for no
 * reason.
 */
function loadMarginUpperjawSetup(): MarginUpperjawSetup {
  if (cachedMarginUpperjawSetup) return cachedMarginUpperjawSetup;
  const rawBytes = readFixtureBytes(MARGIN_JOURNAL_UPPERJAW_PATH);
  const { soup } = parseStl(rawBytes);
  const mesh = intake({ kind: 'soup', soup }).mesh;
  const hm = buildHalfedge(mesh);
  const curvature = computeCurvature(mesh, hm);
  const bvh = buildBvh(mesh);
  cachedMarginUpperjawSetup = { mesh, hm, curvature, bvh };
  return cachedMarginUpperjawSetup;
}

function centroidOfPoints(points: readonly Vec3[]): Vec3 {
  const sum: [number, number, number] = [0, 0, 0];
  for (const p of points) {
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

/** SAME algorithm as `apps/client/src/engine/marginEditor.ts`'s
 * `hashAnchorPositionsHex` (SHA-256 over a flat Float64 buffer of each
 * anchor's evaluated ambient position) — re-derived here via this file's
 * own `hashFloat64`, per this file's module doc's "re-derive, don't deep
 * import" convention. */
function hashAnchorPositions(mesh: IndexedMesh, anchors: readonly SurfacePoint[]): string {
  const flat = new Float64Array(anchors.length * 3);
  anchors.forEach((a, i) => {
    const p = evaluateSurfacePoint(mesh, a);
    flat[i * 3] = p[0];
    flat[i * 3 + 1] = p[1];
    flat[i * 3 + 2] = p[2];
  });
  return hashFloat64(flat);
}

/**
 * Records + replay-proves ONE seeded `margin-edit` operation — see this
 * section's module doc above for exactly what makes this op (unlike
 * `margin-confirm`/`axis-set`) genuinely replayable. Seed: the ambient
 * centroid of the COMMITTED hand-traced reference's own `resampledPoints`,
 * `snapToSurface`-projected — the EXACT method
 * `scripts/margin-acceptance.ts`'s `computeToothResult` already uses to
 * derive a reproducible, non-hand-picked seed from a committed fixture
 * alone (re-derived here, not imported, per this file's own convention —
 * `margin-acceptance.ts` is itself a script, not a shared library).
 */
export function recordMarginProposeJournal(): RecordedJournal {
  const fixtureLabel = 'arch-case-01-upperjaw-margin-tooth21';
  const { mesh, hm, curvature, bvh } = loadMarginUpperjawSetup();

  const referenceBytes = readFileSync(join(repoRoot, MARGIN_JOURNAL_REFERENCE_PATH), 'utf8');
  const reference = JSON.parse(referenceBytes) as MarginReferenceExport;
  if (reference.tooth !== MARGIN_JOURNAL_TOOTH) {
    throw new Error(
      `recordMarginProposeJournal: expected reference tooth ${MARGIN_JOURNAL_TOOTH}, got ${reference.tooth} — wrong fixture file?`,
    );
  }
  const referencePoints: Vec3[] = reference.resampledPoints.map((p) => [p[0], p[1], p[2]]);
  const seedCentroidAmbient = centroidOfPoints(referencePoints);
  const seed: SurfacePoint = snapToSurface(mesh, bvh, seedCentroidAmbient);

  const timestamp = new Date(0).toISOString(); // fixed — see recordJournal's own doc for why.
  const meshContentHash = hashMeshContent(mesh.positions, mesh.indices);

  const proposal = proposeMarginLoop(mesh, hm, curvature, seed, {
    targetAnchorCount: MARGIN_JOURNAL_TARGET_ANCHOR_COUNT,
  });
  const outputHash = hashAnchorPositions(mesh, proposal.anchors);

  const operation: Operation = {
    id: `${fixtureLabel}-margin-edit`,
    name: 'margin-edit',
    params: {
      fixture: fixtureLabel,
      tooth: reference.tooth,
      gesture: 'accept-proposal',
      anchorCount: proposal.anchors.length,
      closed: proposal.closed,
      seed: { triangleIndex: seed.triangleIndex, barycentric: seed.barycentric },
      proposalDefaults: { targetAnchorCount: MARGIN_JOURNAL_TARGET_ANCHOR_COUNT },
    },
    inputHashes: [meshContentHash],
    outputHashes: [outputHash],
    kernelVersion: KERNEL_VERSION,
    timestamp,
  };

  const replaySteps: ReplayStep[] = [
    {
      operationIndex: 0,
      recompute: () => {
        const fresh = proposeMarginLoop(mesh, hm, curvature, seed, {
          targetAnchorCount: MARGIN_JOURNAL_TARGET_ANCHOR_COUNT,
        });
        return hashAnchorPositions(mesh, fresh.anchors);
      },
    },
  ];

  return { fixtureLabel, operations: [operation], replaySteps, finalMesh: mesh };
}

// ---------------------------------------------------------------------------
// Phase 4 Task 12: crown-stage journal-replay extension
//
// The brief asks the crown design stages to "enter the existing replay
// harness ... so CI guards crown-stage reproducibility going forward". The
// FULL 6-stage crown chain (inner → anatomy → morph → shell → freeform → qc,
// several stages async / WASM) is recorded + replayed + byte-pinned in
// test/golden/crown-acceptance.test.ts (via scripts/crown-journal-lib.ts).
// Here we enter ONE representative crown stage into THIS always-on SYNC
// harness: the ADAPTATION/MORPHING stage (`runMorphingStage`) — a genuinely
// non-trivial deterministic crown op (a biharmonic RBF direct solve), pure
// Float64 TS (no WASM), fast on the small synthetic scene, so it fits the
// "fast fixture subset" this harness runs on every commit. Its
// content-addressed output (the morphed mesh hash) is recorded and replayed
// FRESH exactly like the repair/margin ops above — proving the crown morph is
// journal-reproducible in the fast lane too.
// ---------------------------------------------------------------------------

const CROWN_MORPH_PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0 },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: 0.5,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5,
  onlayMinThicknessMm: 0.5,
  cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2,
};

function crownMorphHash(mesh: IndexedMesh): string {
  return hashMeshContent(mesh.positions, mesh.indices);
}

function crownMorphOutwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function crownMorphCylinder(radius: number, height: number, rings: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = (height * r) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.cos(th), radius * Math.sin(th), z);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s, b = r * segments + s1, c = (r + 1) * segments + s, d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function crownMorphMarginCircle(radius: number, z: number, n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([radius * Math.cos(th), radius * Math.sin(th), z]);
  }
  return loop;
}

/** Records + replay-proves ONE crown MORPHING stage op (see this section's
 * doc). The synthetic scene + reference placed tooth are byte-identical to
 * test/golden/anatomy-morph.test.ts's synthetic golden, so its output hash is
 * the same content-addressed morphed-mesh hash CI already guards there — here
 * proven reproducible through the RECORD→REPLAY journal mechanism. */
export function recordCrownMorphJournal(): RecordedJournal {
  const fixtureLabel = 'crown-morph-synthetic';
  const tooth = 11 as FdiTooth;
  const R = 1.2, H = 5;
  const handle = (contentHash: string, mesh: IndexedMesh): PipelineMeshHandle => ({ contentHash, mesh });
  const context: PipelineContext = {
    restorationId: 'journal-crown-morph',
    restorationType: 'crown',
    materialProfile: CROWN_MORPH_PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: handle('die', crownMorphCylinder(R, H - 1, 6, 16)),
    marginLoops: { [tooth]: { closed: true, resampledPoints: crownMorphMarginCircle(R, 0, 48) } },
    neighbors: {
      [12 as FdiTooth]: handle('nb-12', crownMorphOutwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7])),
      [21 as FdiTooth]: handle('nb-21', crownMorphOutwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7])),
    },
    antagonist: handle('anta', crownMorphOutwardBox([-2, -2, H + 0.1], [2, 2, H + 2])),
    stages: { anatomyPlacement: 'placed-11' },
  };
  const morphOptions = { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 };
  const placed = handle('placed-11', crownMorphCylinder(R, H, 11, 24));
  const inputHash = crownMorphHash(placed.mesh);

  const result = runMorphingStage(context, tooth, { placedMesh: placed, hashMesh: crownMorphHash, morphOptions });
  const outputHash = result.meshContentHash!;

  const operation: Operation = {
    id: `${fixtureLabel}-morphing`,
    name: 'morphing.morph',
    params: { fixture: fixtureLabel, tooth, rbfKernel: result.params['rbfKernel'], contactClampWarning: result.params['contactClampWarning'] },
    inputHashes: [inputHash],
    outputHashes: [outputHash],
    kernelVersion: KERNEL_VERSION,
    timestamp: new Date(0).toISOString(),
  };
  const replaySteps: ReplayStep[] = [
    {
      operationIndex: 0,
      recompute: () => runMorphingStage(context, tooth, { placedMesh: placed, hashMesh: crownMorphHash, morphOptions }).meshContentHash!,
    },
  ];
  return { fixtureLabel, operations: [operation], replaySteps, finalMesh: result.mesh! };
}

/** The fixture set this harness runs — see this file's module doc: the
 * first two are small/fast enough that this IS the "fast fixture subset"
 * the task brief asks CI to run (no perf-scale fixtures are included); the
 * margin fixture reuses `loadMarginUpperjawSetup`'s memoized curvature/BVH
 * build (see that function's doc) to stay affordable despite the real
 * ~250k-triangle mesh; the crown-morph fixture (Phase 4 Task 12) enters the
 * crown MORPHING stage into this always-on harness. */
export function recordAllFixtures(): readonly RecordedJournal[] {
  return [
    recordJournal('test-fixtures/synthetic/sphere-r5.stl', 'sphere-r5', true),
    recordJournal('test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl', 'arch-case-01-upperjaw', false),
    recordMarginProposeJournal(),
    recordCrownMorphJournal(),
  ];
}
