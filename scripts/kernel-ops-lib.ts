// scripts/kernel-ops-lib.ts
//
// Shared kernel-op runner + hashing logic for Phase 2 Task 8's golden
// regression suite. Imported by BOTH scripts/generate-kernel-goldens.ts
// (writes test-fixtures/golden/kernel-ops.json) and
// test/golden/kernel-ops.test.ts (recomputes the same ops fresh and
// compares against the committed file) — a SINGLE source of truth for
// "what each op computes, with which pinned params, and how its output is
// hashed", so the two files can never drift out of sync. (Contrast
// test/golden/intake.test.ts / scripts/generate-intake-golden.ts, which
// independently duplicate their hash function with a "must match X exactly"
// comment — defensible for one op, too risky for the ~11 ops this suite
// covers.)
//
// ## Golden-file policy
//
// See docs/CHANGELOG-kernel.md's policy header (also CLAUDE.md's "Golden
// hashes change ONLY with a deliberate kernel version bump + changelog
// entry"). PARAMS ARE PINNED HERE — changing any of them (fixture,
// endpoints, plane, pitch, seeded-damage construction, ...) changes an op's
// committed hash exactly like a kernel algorithm change would, and needs
// the same bump+changelog discipline.
//
// ## Runtime budget (guardrail: whole suite < ~2 min in CI)
//
// Every fixture/param below was chosen to keep this FAST — coarse SDF/
// offset pitches, small synthetic repair fixtures, a modest real-scan
// fixture for intake/curvature. See each op's inline comment for the
// specific choice and why. This is a SEPARATE, faster suite from the
// existing test/golden/offset.test.ts (which pins the die at the CLINICAL
// DEFAULT pitch, ~119 s, and stays as its own acceptance test, not folded
// in here).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStl } from '@dqcad/io';
import {
  KERNEL_VERSION,
  intake,
  computeCurvature,
  buildHalfedge,
  buildBvh,
  snapToSurface,
  evaluateSurfacePoint,
  geodesicPath,
  fitSurfaceSpline,
  computePseudonormals,
  sampleSdfGrid,
  offsetMesh,
  offsetGridSpec,
  marchingCubes,
  union,
  subtract,
  intersect,
  volume,
  sectionMesh,
  removeComponents,
  splitNonManifoldEdges,
  fillSmallHoles,
  analyzeMesh,
  undercutScan,
  type IndexedMesh,
  type SurfaceSpline,
} from '@dqcad/kernel';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture loading (real, committed files — the "synthetic + arch-case-01
// upperjaw + standin-prep-die" set named in the task brief).
// ---------------------------------------------------------------------------

function readFixtureBytes(relPath: string): Uint8Array {
  const buffer = readFileSync(join(repoRoot, relPath));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Parses + intakes a committed STL fixture — the `intake` op itself is
 * pinned separately below (on the RAW upperjaw soup); every other op that
 * needs "a real mesh" reuses this post-intake result, which is legitimate
 * (intake is deterministic — reusing its output doesn't hide anything the
 * dedicated intake-op entry wouldn't already catch). */
function intakeStlFixture(relPath: string): IndexedMesh {
  const { soup } = parseStl(readFixtureBytes(relPath));
  return intake({ kind: 'soup', soup }).mesh;
}

const SPHERE_R5_PATH = 'test-fixtures/synthetic/sphere-r5.stl';
const ARCH_UPPERJAW_PATH = 'test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl';
const STANDIN_DIE_PATH = 'test-fixtures/standin-scans/standin-prep-die.stl';
const BOOLEAN_PAIR_A_PATH = 'test-fixtures/synthetic/boolean-pair-a.stl';
const BOOLEAN_PAIR_B_PATH = 'test-fixtures/synthetic/boolean-pair-b.stl';

// ---------------------------------------------------------------------------
// Hashing — the sha256(positions-bytes, indices-bytes[, ...]) convention
// used throughout this repo's golden tests (intake.test.ts, curvature.test.ts,
// offset.test.ts, manifold.test.ts all reimplement this independently; this
// is the same byte layout, generalized to accept any ordered list of typed
// arrays / strings).
// ---------------------------------------------------------------------------

function sha256Of(...parts: readonly (Float64Array | Float32Array | Uint32Array | Uint8Array | string)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (typeof part === 'string') {
      hash.update(part);
    } else {
      hash.update(Buffer.from(part.buffer as ArrayBuffer, part.byteOffset, part.byteLength));
    }
  }
  return hash.digest('hex');
}

function hashMesh(mesh: IndexedMesh): string {
  return sha256Of(mesh.positions, mesh.indices);
}

// ---------------------------------------------------------------------------
// Small, local, deterministic repair-op fixtures. Kernel's own TEST-ONLY
// fixture modules (packages/kernel/src/{boolean,repair}/*.test-fixtures.ts)
// are NOT exported from @dqcad/kernel's public index (deliberately —
// "Icosphere generator utility allowed in TEST code... kept out of the
// shipped kernel API"), and this file lives outside packages/kernel, so it
// cannot import them without an unconventional deep relative import across
// a package boundary. Instead these are re-derived locally — the SAME
// established repo convention ("duplicated rather than shared... N lines of
// fixture data, not shared logic" — see manifold.test-fixtures.ts's own
// module doc for the precedent).
// ---------------------------------------------------------------------------

function unitCubeMesh(offset: readonly [number, number, number] = [0, 0, 0]): IndexedMesh {
  const [ox, oy, oz] = offset;
  const positions = new Float64Array([
    ox, oy, oz,
    ox + 1, oy, oz,
    ox + 1, oy + 1, oz,
    ox, oy + 1, oz,
    ox, oy, oz + 1,
    ox + 1, oy, oz + 1,
    ox + 1, oy + 1, oz + 1,
    ox, oy + 1, oz + 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    1, 2, 6, 1, 6, 5, // right (+x)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
  ]);
  return { positions, indices };
}

/** Two disjoint meshes concatenated into one — `b`'s indices offset past
 * `a`'s vertex count. Mirrors repair.test-fixtures.ts's `concatMeshes`. */
function concatMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const vertexCountA = a.positions.length / 3;
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + vertexCountA;
  }
  return { positions, indices };
}

/** Cube + one stray far-away triangle (a 2nd, tiny connected component) —
 * mirrors removeComponents.test.ts's own fixture exactly. */
function removeComponentsFixture(): IndexedMesh {
  const cube = unitCubeMesh([0, 0, 0]);
  const speck: IndexedMesh = {
    positions: new Float64Array([100, 100, 100, 101, 100, 100, 100, 101, 100]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  return concatMeshes(cube, speck);
}

/** Cube with triangle 0 duplicated verbatim — every one of that triangle's
 * 3 edges goes non-manifold (degree 3). Mirrors
 * splitNonManifoldEdges.test.ts's `cubeWithDoubledTriangle` exactly. */
function splitNonManifoldEdgesFixture(): IndexedMesh {
  const cube = unitCubeMesh();
  const indices = new Uint32Array(cube.indices.length + 3);
  indices.set(cube.indices, 0);
  indices.set(cube.indices.subarray(0, 3), cube.indices.length);
  return { positions: cube.positions, indices };
}

/** Cube with triangle 0 (one of the bottom face's two triangles) deleted —
 * a single 3-edge boundary loop, well inside fillSmallHoles' default
 * `maxBoundaryEdges` (32). A cube-minus-triangle, NOT the icosphere fixture
 * kernel's own repair tests use for this op (packages/kernel/src/repair/
 * fillSmallHoles.test.ts) — valid seeded-damage geometry for pinning a
 * hash, just a different (simpler) shape than that fixture, not a mirror
 * of it. */
function fillSmallHolesFixture(): IndexedMesh {
  const cube = unitCubeMesh();
  return { positions: cube.positions, indices: cube.indices.subarray(3) };
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export interface KernelOpEntry {
  /** Stable identifier — the key this suite's enforcement logic reports on. */
  id: string;
  /** Kernel function exercised. */
  op: string;
  /** Fixture(s)/params used — informational, also doubles as documentation
   * embedded IN the committed golden file (not just this source file). */
  fixture: string;
  params: Record<string, unknown>;
  hash: string;
  /** A few cheap scalar facts alongside the hash — lets a diff reviewer see
   * roughly WHAT changed (e.g. "triangleCount 512 -> 480") without decoding
   * a sha256, same spirit as offset.test.ts's committed `stats` field. */
  meta: Record<string, unknown>;
}

export interface KernelOpsSnapshot {
  kernelVersion: string;
  /** Documents the runtime budget decisions above, INSIDE the committed
   * file too (brief: "document choices in the goldens JSON"). */
  notes: readonly string[];
  ops: readonly KernelOpEntry[];
}

// ---------------------------------------------------------------------------
// Op computation
// ---------------------------------------------------------------------------

/** Flattens a SurfaceSpline's every span's on-surface AMBIENT points (plus
 * a few scalar summary fields) into hashable buffers. */
function flattenSpline(mesh: IndexedMesh, spline: SurfaceSpline): { positions: Float64Array; summary: string } {
  const points: number[] = [];
  for (const span of spline.spans) {
    for (const sp of span.points) {
      const [x, y, z] = evaluateSurfacePoint(mesh, sp);
      points.push(x, y, z);
    }
  }
  const summary = JSON.stringify({
    closed: spline.closed,
    pointsPerMm: spline.pointsPerMm,
    spanCount: spline.spans.length,
    converged: spline.converged,
    maxAmbientDeviationMm: spline.maxAmbientDeviationMm,
    spanLengths: spline.spans.map((s) => s.length),
    spanIterations: spline.spans.map((s) => s.iterations),
  });
  return { positions: Float64Array.from(points), summary };
}

export async function computeKernelOpsSnapshot(): Promise<KernelOpsSnapshot> {
  const ops: KernelOpEntry[] = [];

  // --- shared fixtures (loaded/intaken once) --------------------------
  const sphereMesh = intakeStlFixture(SPHERE_R5_PATH); // watertight icosphere, r=5, ~5120 tris
  const dieMesh = intakeStlFixture(STANDIN_DIE_PATH); // watertight die scan
  const pairAMesh = intakeStlFixture(BOOLEAN_PAIR_A_PATH);
  const pairBMesh = intakeStlFixture(BOOLEAN_PAIR_B_PATH);
  const sphereBvh = buildBvh(sphereMesh);

  // --- 1. intake --------------------------------------------------------
  // Real fixture (per brief), RAW soup -> intake, mirroring
  // test/golden/intake.test.ts's own real-fixture coverage but as its own
  // pinned entry in THIS suite.
  {
    const { soup } = parseStl(readFixtureBytes(ARCH_UPPERJAW_PATH));
    const result = intake({ kind: 'soup', soup });
    ops.push({
      id: 'intake',
      op: 'intake',
      fixture: 'arch-case-01 upperjaw (real scan STL)',
      params: {},
      hash: sha256Of(result.mesh.positions, result.mesh.indices, JSON.stringify(result.stats), JSON.stringify(result.report)),
      meta: { triangleCount: result.mesh.indices.length / 3, watertight: result.stats.watertight },
    });
  }

  // --- 2. curvature -------------------------------------------------------
  // Same real fixture's post-intake mesh (reused — see this file's module
  // doc for why reuse is legitimate here).
  {
    const archMesh = intakeStlFixture(ARCH_UPPERJAW_PATH);
    const hm = buildHalfedge(archMesh);
    const result = computeCurvature(archMesh, hm);
    ops.push({
      id: 'curvature',
      op: 'computeCurvature',
      fixture: 'arch-case-01 upperjaw (post-intake)',
      params: {},
      hash: sha256Of(result.H, result.K, result.k1, result.k2, result.isBoundary),
      meta: { vertexCount: result.H.length },
    });
  }

  // --- 3. geodesicPath ------------------------------------------------
  // Fixed, deliberately-not-antipodal endpoints on the sphere-r5 fixture
  // (exact antipodes admit multiple equal-length great circles — a
  // degenerate tie this suite avoids purely to keep the geometry
  // unambiguous, not because ties would break determinism).
  {
    const hm = buildHalfedge(sphereMesh);
    const start = snapToSurface(sphereMesh, sphereBvh, [5, 0, 0]);
    const end = snapToSurface(sphereMesh, sphereBvh, [-4, 1, 1]);
    const result = geodesicPath(sphereMesh, hm, start, end);
    const flatPoints = Float64Array.from(result.points.flatMap((sp) => evaluateSurfacePoint(sphereMesh, sp)));
    ops.push({
      id: 'geodesicPath',
      op: 'geodesicPath',
      fixture: 'sphere-r5 (post-intake), fixed endpoints (5,0,0)->(-4,1,1)',
      params: { startAmbient: [5, 0, 0], endAmbient: [-4, 1, 1] },
      hash: sha256Of(flatPoints, JSON.stringify({ length: result.length, iterations: result.iterations, converged: result.converged })),
      meta: { length: result.length, iterations: result.iterations, converged: result.converged, pointCount: result.points.length },
    });
    if (!result.converged) {
      throw new Error('kernel-ops golden: geodesicPath fixture did not converge — pick different fixed endpoints');
    }
  }

  // --- 4. fitSurfaceSpline ------------------------------------------------
  // Fixed cardinal ambient points around the sphere's equator (matches
  // packages/kernel/src/spline/surfaceSpline.test.ts's own convention of
  // hand-picked ambient points, snapped to the surface internally), closed
  // loop.
  {
    const points: readonly [number, number, number][] = [
      [5, 0, 0],
      [0, 5, 0],
      [-5, 0, 0],
      [0, -5, 0],
    ];
    const pointsPerMm = 3;
    const spline = fitSurfaceSpline(sphereMesh, sphereBvh, points, true, pointsPerMm);
    const { positions, summary } = flattenSpline(sphereMesh, spline);
    ops.push({
      id: 'fitSurfaceSpline',
      op: 'fitSurfaceSpline',
      fixture: 'sphere-r5 (post-intake), 4 fixed cardinal control points, closed',
      params: { points, closed: true, pointsPerMm },
      hash: sha256Of(positions, summary),
      meta: { spanCount: spline.spans.length, converged: spline.converged, maxAmbientDeviationMm: spline.maxAmbientDeviationMm },
    });
  }

  // --- 5. sampleSdfGrid -----------------------------------------------
  // Coarse pitch (0.5 mm, vs. offset's clinical 0.02 mm default) + a 1 mm
  // band — keeps cell count trivial (~sphere's ~10mm bbox / 0.5 => ~21^3
  // cells) while still exercising the banded-sampling code path (this
  // repo's Task 6/7 convention: ALWAYS pass bandMm).
  {
    const pseudonormals = computePseudonormals(sphereMesh);
    const stats = analyzeMesh(sphereMesh);
    const pitchMm = 0.5;
    const bandMm = 1;
    const result = sampleSdfGrid(sphereMesh, sphereBvh, pseudonormals, { bboxMm: stats.bbox, pitchMm, bandMm });
    ops.push({
      id: 'sampleSdfGrid',
      op: 'sampleSdfGrid',
      fixture: 'sphere-r5 (post-intake), own bbox',
      params: { pitchMm, bandMm },
      hash: sha256Of(result.grid, JSON.stringify({ dims: result.dims, origin: result.origin, pitchMm: result.pitchMm, bandMm: result.bandMm })),
      meta: { dims: result.dims, cellCount: result.grid.length },
    });
  }

  // --- 6. offsetMesh (+ secondary pre-cleanup MC-soup hash) ---------------
  // Coarse pitch (0.1 mm — 5x coarser than DEFAULT_OFFSET_VOXEL_PITCH_MM =
  // 0.02 mm, which takes ~119 s on this SAME die fixture per
  // test/golden/offset.test.ts; this golden stays fast, see this file's
  // module doc). Distance 0.05 mm (50 µm), the same clinical cement-gap
  // scenario as the existing acceptance test, just at a cheaper pitch.
  {
    const distanceMm = 0.05;
    const pitchMm = 0.1;
    const result = await offsetMesh(dieMesh, distanceMm, { pitchMm });
    ops.push({
      id: 'offsetMesh',
      op: 'offsetMesh',
      fixture: 'standin-prep-die (post-intake)',
      params: { distanceMm, pitchMm },
      hash: sha256Of(result.mesh.positions, result.mesh.indices, JSON.stringify(result.stats), String(result.errorBoundMm)),
      meta: { triangleCount: result.mesh.indices.length / 3, errorBoundMm: result.errorBoundMm },
    });

    // Secondary: the marching-cubes soup BEFORE weld + manifold-3d WASM
    // cleanup — reviewer suggestion carried over from Task 7 (see
    // .superpowers/sdd/p2-task-7-report.md's "Task 8 consideration"): a
    // pinned pre-cleanup hash isolates a golden failure caused by a
    // manifold-3d WASM version/platform difference (which only touches the
    // PRIMARY hash above) from one caused by an actual SDF/marching-cubes
    // regression (which would ALSO show up here). Replicates offsetMesh's
    // own stage 0-2 exactly via the same exported primitives it uses
    // internally (offsetGridSpec, sampleSdfGrid, marchingCubes) — no
    // private/internal access needed.
    const dieStats = analyzeMesh(dieMesh);
    const dieBvh = buildBvh(dieMesh);
    const diePseudonormals = computePseudonormals(dieMesh);
    const spec = offsetGridSpec(dieStats.bbox, distanceMm, pitchMm);
    const grid = sampleSdfGrid(dieMesh, dieBvh, diePseudonormals, {
      bboxMm: spec.bboxMm,
      pitchMm,
      padding: spec.padding,
      bandMm: spec.bandMm,
    });
    const soup = marchingCubes({ grid: grid.grid, dims: grid.dims, origin: grid.origin, pitchMm: grid.pitchMm }, distanceMm);
    ops.push({
      id: 'offsetMesh-preCleanupSoup',
      op: 'marchingCubes (offsetMesh stage 2, before weld + manifold-3d cleanup)',
      fixture: 'standin-prep-die (post-intake)',
      params: { distanceMm, pitchMm },
      hash: sha256Of(soup.positions, String(soup.triangleCount)),
      meta: { triangleCount: soup.triangleCount },
    });
  }

  // --- 7-9. booleans (union/subtract/intersect) --------------------------
  // Committed boolean-pair-a/b fixtures (real files, subdivisions=3) — the
  // secondary, LOOSER volume-vs-analytic check the task brief asks for
  // alongside the primary finer-in-memory acceptance test
  // (packages/kernel/src/boolean/manifold.analytic.test.ts). See this
  // block's inline math for the closed-form lens/union/subtract values.
  {
    const r = 3;
    const d = 3; // boolean-pair-a/b centers are 1.5 apart from origin each way.
    const lens = (Math.PI * (4 * r + d) * (2 * r - d) ** 2) / 12;
    const single = (4 / 3) * Math.PI * r ** 3;
    const analytic = { union: 2 * single - lens, subtract: single - lens, intersect: lens };
    // The committed fixture's OWN sidecar tolerance (see
    // test-fixtures/synthetic/boolean-pair-a.expected.json's
    // meshVolumeToleranceFraction, ~0.7182% at subdivisions=3) governs a
    // single sphere's volume deficit; a boolean combination of two such
    // spheres empirically deviates by roughly the same order (measured
    // directly below and asserted with a documented, generous 5x margin —
    // NOT the tight 0.1% acceptance budget, which the finer in-memory
    // spheres in manifold.analytic.test.ts already prove).
    const looseToleranceFraction = 0.007182294628787686 * 5; // ~3.6%

    for (const [id, runOp] of [
      ['union', union],
      ['subtract', subtract],
      ['intersect', intersect],
    ] as const) {
      const result = await runOp(pairAMesh, pairBMesh);
      const resultVolume = await volume(result);
      const relativeError = Math.abs(resultVolume - analytic[id]) / analytic[id];
      if (relativeError >= looseToleranceFraction) {
        throw new Error(
          `kernel-ops golden: ${id} of boolean-pair-a/b deviated ${(relativeError * 100).toFixed(3)}% from the ` +
            `analytic lens volume (loose budget ${(looseToleranceFraction * 100).toFixed(3)}%) — investigate before regenerating`,
        );
      }
      ops.push({
        id,
        op: id,
        fixture: 'boolean-pair-a + boolean-pair-b (committed STL, subdivisions=3)',
        params: {},
        hash: hashMesh(result),
        meta: { volumeMm3: resultVolume, analyticVolumeMm3: analytic[id], relativeError },
      });
    }
  }

  // --- 10. sectionMesh --------------------------------------------------
  {
    const plane = { point: [0, 0, 0] as const, normal: [0, 0, 1] as const };
    const result = sectionMesh(sphereMesh, plane);
    const flat: number[] = [];
    const flags: number[] = [];
    for (const line of result.polylines) {
      flat.push(...line.points);
      flags.push(line.closed ? 1 : 0);
    }
    ops.push({
      id: 'sectionMesh',
      op: 'sectionMesh',
      fixture: 'sphere-r5 (post-intake)',
      params: { plane },
      hash: sha256Of(Float64Array.from(flat), Uint8Array.from(flags)),
      meta: { polylineCount: result.polylines.length },
    });
  }

  // --- 11-13. repair ops (seeded-damage fixtures) -------------------------
  {
    const mesh = removeComponentsFixture();
    const { mesh: result, report } = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 2 });
    ops.push({
      id: 'repairRemoveComponents',
      op: 'removeComponents',
      fixture: 'unit cube + 1 stray far-away triangle (seeded 2-component damage)',
      params: { selector: { mode: 'minTriangles', minTriangles: 2 } },
      hash: sha256Of(result.positions, result.indices, JSON.stringify(report)),
      meta: { removedComponentIds: report.removedComponentIds, keptComponentIds: report.keptComponentIds },
    });
  }
  {
    const mesh = splitNonManifoldEdgesFixture();
    const { mesh: result, report } = splitNonManifoldEdges(mesh);
    ops.push({
      id: 'repairSplitNonManifoldEdges',
      op: 'splitNonManifoldEdges',
      fixture: 'unit cube with triangle 0 duplicated (seeded non-manifold-edge damage)',
      params: {},
      hash: sha256Of(result.positions, result.indices, JSON.stringify(report)),
      meta: { nonManifoldEdgeCountBefore: report.nonManifoldEdgeCountBefore, duplicatedVertexCount: report.duplicatedVertexCount },
    });
  }
  {
    const mesh = fillSmallHolesFixture();
    const { mesh: result, report } = fillSmallHoles(mesh);
    ops.push({
      id: 'repairFillSmallHoles',
      op: 'fillSmallHoles',
      fixture: 'unit cube with triangle 0 removed (seeded 3-edge-boundary-loop damage)',
      params: {},
      hash: sha256Of(result.positions, result.indices, JSON.stringify(report)),
      meta: { loopsFound: report.loopsFound, loopsFilled: report.loopsFilled },
    });
  }

  // --- 14. undercutScan (Phase 2 Task 9) ---------------------------------
  // standin-prep-die, ONE fixed non-axis-aligned direction (per this task's
  // brief: "golden on standin-prep-die, one fixed direction") — 'corners'
  // sampling (the more expensive, more conservative policy — see
  // undercut/undercutScan.ts's doc) so this golden also exercises the
  // 4x-sample code path, not just the cheaper default.
  {
    const dieBvhForUndercut = buildBvh(dieMesh);
    const direction = [0.2, -0.4, 0.9] as const;
    const result = undercutScan(dieMesh, dieBvhForUndercut, direction, { sampling: 'corners' });
    ops.push({
      id: 'undercutScan',
      op: 'undercutScan',
      fixture: 'standin-prep-die (post-intake)',
      params: { direction, sampling: 'corners' },
      hash: sha256Of(
        result.undercut,
        result.depthMm,
        JSON.stringify({
          directionUnit: result.directionUnit,
          undercutTriangleCount: result.undercutTriangleCount,
          maxDepthMm: result.maxDepthMm,
        }),
      ),
      meta: {
        triangleCount: result.triangleCount,
        undercutTriangleCount: result.undercutTriangleCount,
        maxDepthMm: result.maxDepthMm,
      },
    });
  }

  return {
    kernelVersion: KERNEL_VERSION,
    notes: [
      'Runtime budget: every param here is chosen to keep this suite fast (target: whole suite well under the ~2 min CI budget) — see scripts/kernel-ops-lib.ts\'s module doc for each choice.',
      'offsetMesh uses pitchMm=0.1 (coarse) here, NOT DEFAULT_OFFSET_VOXEL_PITCH_MM=0.02 — the clinical-default-pitch acceptance golden lives separately in test/golden/offset.test.ts (~119 s on this same die fixture).',
      'sampleSdfGrid uses pitchMm=0.5, bandMm=1 (coarse) — ALWAYS passes bandMm per this repo\'s banded-sampling convention.',
      'union/subtract/intersect additionally assert a LOOSE (~3.6%) volume-vs-analytic bound against the committed boolean-pair-a/b fixtures (subdivisions=3) — the TIGHT 0.1% acceptance budget is proven separately, on finer in-memory spheres, by packages/kernel/src/boolean/manifold.analytic.test.ts.',
      'offsetMesh-preCleanupSoup is a SECONDARY hash (marching-cubes soup before weld + manifold-3d WASM cleanup) — isolates a manifold-3d WASM version/platform-only golden failure from a real SDF/marching-cubes regression (Task 7 reviewer suggestion).',
      'Repair-op fixtures are small, hand-built, seeded-damage meshes (not committed files) — see scripts/kernel-ops-lib.ts for their exact construction.',
      'undercutScan (Phase 2 Task 9) uses \'corners\' sampling (the more expensive, more conservative policy) at a single fixed direction — see packages/kernel/src/undercut/undercutScan.ts for the sign convention and depth semantics.',
    ],
    ops,
  };
}
