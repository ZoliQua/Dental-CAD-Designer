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
  type IndexedMesh,
} from '@dqcad/kernel';
import type { Operation } from '@dqcad/shared-types';

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

/** The fixture set this harness runs — see this file's module doc: both
 * are small/fast enough that this IS the "fast fixture subset" the task
 * brief asks CI to run (no perf-scale fixtures are included). */
export function recordAllFixtures(): readonly RecordedJournal[] {
  return [
    recordJournal('test-fixtures/synthetic/sphere-r5.stl', 'sphere-r5', true),
    recordJournal('test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl', 'arch-case-01-upperjaw', false),
  ];
}
