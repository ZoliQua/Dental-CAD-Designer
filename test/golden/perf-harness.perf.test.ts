// test/golden/perf-harness.perf.test.ts
//
// Phase 8 Task 3 — the consolidated PERFORMANCE HARNESS (docs/plans/
// phase-8-polish-hardening.md Task 3, deliverable 1: "a perf harness
// measuring representative ops — die-offset, boolean, QC, large-scan import,
// render frame budget — with reported before/after numbers, honest,
// machine-load-attributed"). It is the ONE place the phase's representative
// geometry ops are timed together so a baseline can be read off in a single
// run and a catastrophic future regression fails loudly.
//
// ## What this is NOT
//
// This is not a golden test and it MUST NOT touch test-fixtures/ — the Task 3
// hard gate is that every golden stays byte-identical, so this harness builds
// its inputs ENTIRELY from deterministic in-process synthetic geometry (a
// closed icosphere, two overlapping cubes) and generated STL bytes. Nothing
// here reads or writes a fixture file; running it leaves `git status
// test-fixtures/` empty by construction.
//
// ## Honest attribution (the P2/P6 lesson, restated in this task's brief)
//
// Wall-clock is machine-load-sensitive: every number logged below is a
// SINGLE run on whatever machine/CI happened to execute it, under whatever
// contention was present. The `expect(...).toBeLessThan(BUDGET)` bounds are
// deliberately generous REGRESSION TRIPWIRES (multiples of an unloaded local
// run), not performance assertions — they catch an order-of-magnitude
// regression, never a 20% noise swing. Read the logged numbers as "a
// representative picture on this machine", re-run before trusting any single
// figure, and never cherry-pick the fast run. The report
// (.superpowers/sdd/p8-task-3-report.md) records the baseline ranges these
// were read against.
//
// ## Env-gated, same convention as the sibling perf tests
//
// Skipped unless `RUN_PERF=1` (mirrors large-fixture.perf.test.ts's
// RUN_LARGE_FIXTURE gate): the ops here run real SDF/marching-cubes/manifold
// work that takes meaningfully longer than an ordinary unit test, so they do
// NOT belong in the default `npm test` / `npm run test:golden` lane — in that
// lane this whole describe block is collected-then-skipped (fast, zero fixture
// interaction). Run on demand via `npm run test:perf`.
//
// Layer note: lives here (root `golden` Vitest project, NOT inside a package)
// for the same reason halfedge-intake.perf.test.ts does — it needs BOTH
// `@dqcad/io` and `@dqcad/kernel`, and packages/kernel may not depend on
// packages/io (CLAUDE.md's layer rule); this root project sits outside that
// boundary.
import { describe, expect, it } from 'vitest';
import {
  analyzeMesh,
  buildBvh,
  closestPointBatch,
  decimateMesh,
  offsetMesh,
  union,
  type IndexedMesh,
} from '@dqcad/kernel';
import { parseStl, writeStlBinary } from '@dqcad/io';

const RUN_PERF = process.env.RUN_PERF === '1';

/** Regression tripwires (ms) — generous multiples of an unloaded local run,
 * NOT performance targets (see this file's "Honest attribution" doc). A
 * breach means an order-of-magnitude regression, not ordinary noise. */
const BUDGET = {
  dieOffset: 120_000, // the P2 117-126s pain point IS the reference here; the
  //                     banded-ROI kernel keeps a coarser-pitch run far below
  //                     this, but the bound is set at the historical worst case.
  boolean: 30_000,
  qcAnalysis: 30_000,
  largeImport: 60_000,
  renderLod: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Deterministic synthetic geometry (no unseeded randomness — Global
// Constraints; no fixture dependency — the byte-identical-goldens gate).
// ---------------------------------------------------------------------------

/**
 * A closed, watertight, manifold icosphere of `subdivisions` refinement
 * levels and radius `radiusMm`, centered at the origin. Level 0 is the base
 * icosahedron (20 triangles); each level quadruples the triangle count
 * (level n = 20 * 4^n). Deterministic: identical output for identical inputs.
 * Used as the "die-sized" input for the offset/QC/BVH/LOD ops below.
 */
function icosphere(subdivisions: number, radiusMm: number): IndexedMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: [number, number, number][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midpointCache = new Map<string, number>();
    const nextFaces: [number, number, number][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const va = verts[a]!;
      const vb = verts[b]!;
      const index = verts.length;
      verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
      midpointCache.set(key, index);
      return index;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }

  const positions = new Float64Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i]!;
    const len = Math.hypot(x, y, z);
    const scale = radiusMm / len;
    positions[i * 3] = x * scale;
    positions[i * 3 + 1] = y * scale;
    positions[i * 3 + 2] = z * scale;
  }
  const indices = new Uint32Array(faces.length * 3);
  for (let f = 0; f < faces.length; f++) {
    indices[f * 3] = faces[f]![0];
    indices[f * 3 + 1] = faces[f]![1];
    indices[f * 3 + 2] = faces[f]![2];
  }
  return { positions, indices };
}

/** An axis-aligned unit-ish cube [0,size]^3 translated by `offset` on X —
 * closed, watertight, outward-wound. Two overlapping copies feed the boolean
 * op below. */
function cube(size: number, offsetX: number): IndexedMesh {
  const c: [number, number, number][] = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ];
  const tris: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [0, 4, 7], [0, 7, 3],
  ];
  const positions = new Float64Array(c.length * 3);
  for (let i = 0; i < c.length; i++) {
    positions[i * 3] = c[i]![0] + offsetX;
    positions[i * 3 + 1] = c[i]![1];
    positions[i * 3 + 2] = c[i]![2];
  }
  return { positions, indices: Uint32Array.from(tris.flat()) };
}

/** Flattens an `IndexedMesh` to the un-indexed triangle soup `writeStlBinary`
 * consumes (STL is inherently un-indexed). */
function toSoup(mesh: IndexedMesh): { positions: Float64Array; normals: null; triangleCount: number } {
  const triangleCount = mesh.indices.length / 3;
  const positions = new Float64Array(triangleCount * 9);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i]!;
    positions[i * 3] = mesh.positions[v * 3]!;
    positions[i * 3 + 1] = mesh.positions[v * 3 + 1]!;
    positions[i * 3 + 2] = mesh.positions[v * 3 + 2]!;
  }
  return { positions, normals: null, triangleCount };
}

function ms(fn: () => void): number;
function ms(fn: () => Promise<void>): Promise<number>;
function ms(fn: () => void | Promise<void>): number | Promise<number> {
  const start = performance.now();
  const maybe = fn();
  if (maybe instanceof Promise) {
    return maybe.then(() => performance.now() - start);
  }
  return performance.now() - start;
}

describe.skipIf(!RUN_PERF)('Phase 8 perf harness — representative ops (env-gated RUN_PERF=1)', () => {
  it(
    'die-offset (offsetMesh) — the P2 117-126s pain point; banded-ROI SDF + marching cubes + manifold cleanup',
    { timeout: BUDGET.dieOffset + 30_000 },
    async () => {
      // ~5k-triangle die-sized icosphere (radius 5mm, level 4 = 20*4^4 = 5120
      // triangles) — representative of a prepped die's face count without a
      // git-LFS fixture. Pitch 0.05mm (50µm) is a realistic clinical-order
      // cement-gap pitch (CLAUDE.md's default is 20µm; 50µm keeps this
      // env-gated run to seconds while exercising the identical pipeline).
      const die = icosphere(4, 5);
      const inTriangles = die.indices.length / 3;

      let result: Awaited<ReturnType<typeof offsetMesh>> | undefined;
      const elapsed = await ms(async () => {
        result = await offsetMesh(die, -0.03, { pitchMm: 0.05 });
      });
      const out = result!;

      // Falsifiable correctness guard: an inward cement-gap offset of a closed
      // die must itself be a closed, watertight, manifold solid (the whole
      // point — a leaky offset would fail export QC). If the offset op ever
      // silently produced open/non-manifold geometry this fails, independent
      // of timing.
      expect(out.stats.watertight).toBe(true);
      expect(out.stats.manifoldEdges).toBe(true);
      expect(out.mesh.indices.length).toBeGreaterThan(0);
      expect(out.errorBoundMm).toBeGreaterThan(0);

      console.log(
        `[perf] die-offset: ${inTriangles} in-tris, pitch 0.05mm, ` +
          `${(out.mesh.indices.length / 3).toLocaleString()} out-tris, ` +
          `${elapsed.toFixed(0)} ms (tripwire ${BUDGET.dieOffset} ms).`,
      );
      expect(elapsed).toBeLessThan(BUDGET.dieOffset);
    },
  );

  it(
    'boolean (manifold union) — two overlapping closed cubes',
    { timeout: BUDGET.boolean + 30_000 },
    async () => {
      const a = cube(2, 0);
      const b = cube(2, 1); // overlaps a on [1,2] in X

      let result: IndexedMesh | undefined;
      const elapsed = await ms(async () => {
        result = await union(a, b);
      });
      const merged = result!;

      // Falsifiable guard: union of two unit-ish cubes overlapping by half is
      // a single watertight solid whose analytic volume is 2*8 - overlap
      // (overlap = 1x2x2 = 4) = 12 mm^3. A wrong boolean fails this hard.
      const stats = analyzeMesh(merged);
      expect(stats.watertight).toBe(true);
      expect(stats.componentCount).toBe(1);
      expect(Math.abs((stats.signedVolumeMm3 ?? 0) - 12)).toBeLessThan(1e-3);

      console.log(
        `[perf] boolean-union: ${(merged.indices.length / 3).toLocaleString()} out-tris, ` +
          `vol ${(stats.signedVolumeMm3 ?? 0).toFixed(4)} mm^3, ${elapsed.toFixed(0)} ms ` +
          `(tripwire ${BUDGET.boolean} ms).`,
      );
      expect(elapsed).toBeLessThan(BUDGET.boolean);
    },
  );

  it(
    'QC topology analysis (analyzeMesh) — the watertight/manifold/volume gate inputs on a die-scale mesh',
    { timeout: BUDGET.qcAnalysis + 30_000 },
    () => {
      // analyzeMesh computes exactly what the watertight + manifold QC gates
      // consume (packages/cad-pipeline/src/gates/watertight.ts): edge
      // manifoldness, boundary-edge count, connected components, signed
      // volume. Timed on a ~20k-triangle mesh (level 5 = 20480 tris).
      const mesh = icosphere(5, 6);
      let stats: ReturnType<typeof analyzeMesh> | undefined;
      const elapsed = ms(() => {
        stats = analyzeMesh(mesh);
      });
      const s = stats!;
      // Falsifiable guard: a closed icosphere is watertight, manifold, one
      // component, positive volume.
      expect(s.watertight).toBe(true);
      expect(s.manifoldEdges).toBe(true);
      expect(s.componentCount).toBe(1);
      expect(s.signedVolumeMm3 ?? 0).toBeGreaterThan(0);

      console.log(
        `[perf] qc-analysis: ${(mesh.indices.length / 3).toLocaleString()} tris, ` +
          `${elapsed.toFixed(1)} ms (tripwire ${BUDGET.qcAnalysis} ms).`,
      );
      expect(elapsed).toBeLessThan(BUDGET.qcAnalysis);
    },
  );

  it(
    'BVH build + batched closest-point query — the measurement path (build once, query many; the cache-reuse payoff)',
    { timeout: BUDGET.qcAnalysis + 30_000 },
    () => {
      const mesh = icosphere(5, 6); // ~20k triangles
      let elapsedBuild = 0;
      let bvh: ReturnType<typeof buildBvh> | undefined;
      elapsedBuild = ms(() => {
        bvh = buildBvh(mesh);
      });

      // 1000 query points on a shell just outside the surface — the workload
      // a distance heatmap / repeated measurement pick issues against ONE
      // cached BVH (buildBvh once, closestPoint many — the exact reuse the
      // per-worker bvhCache + affinity routing preserves).
      const queryCount = 1000;
      const points = new Float64Array(queryCount * 3);
      for (let i = 0; i < queryCount; i++) {
        const phi = (Math.PI * (i + 0.5)) / queryCount;
        const theta = (2 * Math.PI * i * 0.618) % (2 * Math.PI);
        const r = 7; // outside the radius-6 sphere
        points[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        points[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        points[i * 3 + 2] = r * Math.cos(phi);
      }
      let results: ReturnType<typeof closestPointBatch> | undefined;
      const elapsedQuery = ms(() => {
        results = closestPointBatch(mesh, bvh!, points);
      });

      // Falsifiable guard: every query point is ~1mm outside a radius-6
      // sphere, so its closest-surface distance must be ~1mm (the sphere is
      // faceted, so allow a small chord tolerance).
      for (const res of results!) {
        expect(res.distance).toBeGreaterThan(0.5);
        expect(res.distance).toBeLessThan(1.5);
      }

      console.log(
        `[perf] bvh: build ${(mesh.indices.length / 3).toLocaleString()} tris in ` +
          `${elapsedBuild.toFixed(1)} ms; ${queryCount} closest-point queries in ` +
          `${elapsedQuery.toFixed(1)} ms (${(elapsedQuery / queryCount).toFixed(3)} ms/query).`,
      );
    },
  );

  it(
    'large-scan import (writeStlBinary -> parseStl) — the intake parse path',
    { timeout: BUDGET.largeImport + 30_000 },
    () => {
      // ~320k-triangle mesh (level 6 = 81920... use two shells worth via a
      // dense sphere) — a realistic full-arch scan face count. Serialize to
      // binary STL bytes in-process, then measure the parse (the intake
      // hot path).
      const mesh = icosphere(6, 20); // 20 * 4^6 = 81,920 triangles
      const bytes = writeStlBinary(toSoup(mesh));

      let parsed: ReturnType<typeof parseStl> | undefined;
      const elapsed = ms(() => {
        parsed = parseStl(bytes);
      });
      const soup = parsed!.soup;

      // Falsifiable guard: parse round-trips the exact triangle count and
      // format.
      expect(parsed!.diagnostics.format).toBe('stl-binary');
      expect(soup.triangleCount).toBe(mesh.indices.length / 3);

      console.log(
        `[perf] large-import: ${(bytes.length / (1024 * 1024)).toFixed(1)} MB STL, ` +
          `${soup.triangleCount.toLocaleString()} tris, parse ${elapsed.toFixed(0)} ms ` +
          `(tripwire ${BUDGET.largeImport} ms).`,
      );
      expect(elapsed).toBeLessThan(BUDGET.largeImport);
    },
  );

  it(
    'render-frame budget proxy (decimateMesh) — the LOD build cost (engine-only render copy)',
    { timeout: BUDGET.renderLod + 30_000 },
    () => {
      const mesh = icosphere(6, 20); // ~82k triangles
      const target = Math.round((mesh.indices.length / 3) * 0.2); // RENDER_LOD_TARGET_FRACTION
      let result: ReturnType<typeof decimateMesh> | undefined;
      const elapsed = ms(() => {
        result = decimateMesh(mesh, { targetTriangleCount: target });
      });
      const out = result!;

      // Falsifiable guard: the LOD is a SEPARATE render-only copy at (or
      // below) the target, and it reports a positive geometric error bound —
      // i.e. it is genuinely decimated, not a pass-through of the master.
      expect(out.outputTriangleCount).toBeLessThanOrEqual(target);
      expect(out.outputTriangleCount).toBeLessThan(out.inputTriangleCount);
      expect(out.maxErrorMm).toBeGreaterThan(0);

      console.log(
        `[perf] render-lod: ${out.inputTriangleCount.toLocaleString()} -> ` +
          `${out.outputTriangleCount.toLocaleString()} tris (target ${target.toLocaleString()}), ` +
          `maxErr ${out.maxErrorMm.toFixed(4)} mm, ${elapsed.toFixed(0)} ms ` +
          `(tripwire ${BUDGET.renderLod} ms).`,
      );
      expect(elapsed).toBeLessThan(BUDGET.renderLod);
    },
  );
});
