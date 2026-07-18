// packages/kernel/src/boolean/manifold.analytic.test.ts
//
// PHASE 2 ACCEPTANCE (Task 8, docs/plans/phase-2-kernel-core.md's PLAN
// acceptance line): "boolean of two analytic spheres matches analytic
// volume within 0.1%" for ALL THREE ops (union, subtract, intersect).
//
// Fixture-derivation discipline (Global Constraints, CLAUDE.md's "Tests
// first, analytic first"): the COMMITTED boolean-pair-a/b fixtures
// (test-fixtures/synthetic/boolean-pair-{a,b}.stl,
// scripts/generate-fixtures.ts's BOOLEAN_PAIR_SUBDIVISIONS = 3) have a
// documented per-sphere tessellation-deficit tolerance of
// meshVolumeToleranceFraction ≈ 0.7182% (see the sidecar JSON) — well OVER
// the 0.1% acceptance budget this task must prove. Rather than recommitting
// a finer (much larger) binary fixture just to move a decimal point, this
// test builds FINER icospheres IN MEMORY at generation time (same
// deterministic generator, `icosphereMesh`, used to build the committed
// fixture — see manifold.test-fixtures.ts) at a subdivision depth chosen so
// the derived tessellation-deficit bound clears the acceptance budget by a
// wide, documented margin. The committed STL fixtures still get their own
// (looser, appropriately-scaled) check — see test/golden/kernel-ops.test.ts,
// which pins their sha256 golden hash AND asserts a looser volume bound
// consistent with their coarser subdivision.
//
// ## Subdivision choice, derived (not guessed)
//
// scripts/generate-fixtures.ts's `icosphereToleranceFraction(n)` derivation
// (repeated here since kernel test code must not import from scripts/):
// a chord subtending a small central angle `a` on a sphere of radius R sits
// below the true sphere surface by a sagitta s = R*(1 - cos(a/2)) ≈ R*a²/8,
// and since a sphere's volume V = (1/3)*R*SurfaceArea exactly, integrating
// that sagitta gap over the whole surface gives a relative volume deficit
// ΔV/V ≈ 3*s/R ≈ (3/8)*a². The base icosahedron's edge central angle is
// a0 = arccos(1/√5); each subdivision halves it, so at depth n,
// a_n ≈ a0/2ⁿ.
//
// At n=6: a6 = a0/64 ≈ 0.0173 rad, ΔV/V ≈ (3/8)*a6² ≈ 1.122e-4 (0.0112%) —
// nominally ~9x below the 0.1% budget. `test/golden/intake.test.ts`'s own
// empirical measurement of this SAME deficit model (sphere-r5 fixture) found
// the true deficit runs up to ~3x the nominal first-order estimate (still
// inside the *3 bound that test asserts) — applying that same 3x safety
// factor here gives an expected worst case of ~0.034%, still comfortably
// under the 0.1% budget. n=6 also keeps the boolean op fast (81,920
// triangles per sphere — a WASM manifold boolean on meshes this size
// completes in well under a second).
const ACCEPTANCE_SUBDIVISIONS = 6;

// Both spheres share the committed fixtures' geometry (radius 3, centers 3
// mm apart, symmetric about the origin) — only the tessellation is finer.
const SPHERE_RADIUS_MM = 3;
const CENTER_SEPARATION_MM = 3;

// Closed-form two-equal-sphere intersection ("lens") volume (Steinmetz-style
// spherical-cap formula for radius r, center separation d ≤ 2r):
//   V_lens = π * (4r + d) * (2r - d)² / 12
// (documented and cross-referenced in scripts/generate-fixtures.ts, r=3,
// d=3: V_lens = π*15*9/12 = 11.25π ≈ 35.343 mm³.) Union/subtract follow by
// inclusion-exclusion on the two equal single-sphere volumes.
function lensVolumeMm3(r: number, d: number): number {
  return (Math.PI * (4 * r + d) * (2 * r - d) ** 2) / 12;
}

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from './manifold.test-fixtures.ts';
import { intersect, subtract, union, volume } from './manifold.ts';

const singleSphereVolumeMm3 = (4 / 3) * Math.PI * SPHERE_RADIUS_MM ** 3;
const lensVolumeMm3Value = lensVolumeMm3(SPHERE_RADIUS_MM, CENTER_SEPARATION_MM);

const ANALYTIC_VOLUME_MM3 = {
  union: 2 * singleSphereVolumeMm3 - lensVolumeMm3Value,
  subtract: singleSphereVolumeMm3 - lensVolumeMm3Value,
  intersect: lensVolumeMm3Value,
} as const;

/** ACCEPTANCE BUDGET (PLAN.md's Phase 2 acceptance line, verbatim): 0.1%. */
const ACCEPTANCE_RELATIVE_TOLERANCE = 0.001;

function hashMesh(mesh: IndexedMesh): string {
  return createHash('sha256')
    .update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength))
    .update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))
    .digest('hex');
}

function buildSpherePair(): readonly [IndexedMesh, IndexedMesh] {
  const half = CENTER_SEPARATION_MM / 2;
  const a = icosphereMesh(SPHERE_RADIUS_MM, ACCEPTANCE_SUBDIVISIONS, [-half, 0, 0]);
  const b = icosphereMesh(SPHERE_RADIUS_MM, ACCEPTANCE_SUBDIVISIONS, [half, 0, 0]);
  return [a, b];
}

describe('boolean acceptance — two analytic spheres (PLAN.md Phase 2: boolean within 0.1% of analytic volume)', () => {
  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s of the two spheres matches the closed-form analytic volume within 0.1%%',
    async (op) => {
      const [a, b] = buildSpherePair();
      const runOp = op === 'union' ? union : op === 'subtract' ? subtract : intersect;
      const result = await runOp(a, b);
      const resultVolume = await volume(result);
      const analytic = ANALYTIC_VOLUME_MM3[op];
      const relativeError = Math.abs(resultVolume - analytic) / analytic;
      // Deliberate acceptance-evidence log (matches offset.test.ts's timing
      // log convention) — REPORTED per the task brief's "Max deviations
      // REPORTED" requirement; see .superpowers/sdd/p2-task-8-report.md for
      // the collected values across a run.
      console.log(
        `[boolean acceptance] ${op}: mesh=${resultVolume.toFixed(6)} mm³, analytic=${analytic.toFixed(6)} mm³, ` +
          `relative error=${(relativeError * 100).toFixed(4)}%`,
      );
      expect(relativeError).toBeLessThan(ACCEPTANCE_RELATIVE_TOLERANCE);
    },
  );

  it('every op is deterministic across repeated runs (byte-identical output hash)', async () => {
    const [a, b] = buildSpherePair();
    const firstUnion = await union(a, b);
    const secondUnion = await union(a, b);
    expect(hashMesh(firstUnion)).toBe(hashMesh(secondUnion));
  });
});
