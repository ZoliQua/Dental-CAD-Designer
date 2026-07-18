// packages/kernel/src/offset/offsetMesh.test.ts
//
// Tests for the full offset pipeline (offsetMesh.ts), per this task's
// brief:
//
//  - PHASE ACCEPTANCE (heavy, ~1-2 min): icosphere r=5 offset by ±0.050 mm
//    at the clinical default pitch 0.02 mm — EVERY final-mesh vertex's
//    |distance-from-center − (5 ± 0.05)| must be ≤ 0.010 mm; the measured
//    max is REPORTED via console.log (phase acceptance evidence).
//  - Sign convention (outward grows / inward shrinks) on a fast fixture.
//  - Cube offset: face-region distance exact within bound; edge/corner
//    rounding radius ≈ d (spot asserts).
//  - Property (fast-check, seeded): offset(offset(m, d), −d) ≈ m within 2×
//    the documented bound (PLAN §6.8's canonical example) — sphere + cube.
//  - Watertight + manifold asserted via analyzeMesh on the FINAL mesh (the
//    manifold cleanup itself is the manifold gate: offsetMesh rejects with
//    NonManifoldInputError if manifold-3d refuses the extraction, so a
//    resolved offsetMesh IS the manifold status assertion; stats re-verify
//    watertightness independently).
//  - Determinism hashes; typed error paths.
//
// ## Acceptance fixture derivation (icosphere subdivision, per the
// established fixture-derivation discipline)
//
// The acceptance metric measures the offset surface against the IDEAL
// sphere (radius 5), but the pipeline offsets the polyhedral fixture — so
// the fixture's own facet sagitta `s = r * (1 - cos(theta/2))`,
// `theta = acos(1/sqrt(5)) / 2^subdivisions` (same derivation as
// sdf/signedDistance.analytic.test.ts / sdf/grid.test.ts), is a floor on
// the measured error that has nothing to do with the offset operator under
// test. Requirement: s must be small vs. the 10 µm budget so the test
// probes the OPERATOR, not the fixture. subdivisions = 5 (20,480 triangles
// — the same mesh scale sdf/grid.ts's perf measurements used) gives
// theta ≈ 0.0346 rad, s ≈ 5 * (1 - cos(0.0173)) ≈ 7.5e-4 mm = 0.75 µm —
// under a tenth of the budget. (subdivisions = 4 would contribute 3 µm —
// nearly a third of the budget — hence 5.)
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { icosphereMesh, cubeMesh, openGridPatchMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { NonWatertightMeshError } from '../sdf/pseudonormals.ts';
import { EmptyOffsetResultError, offsetMesh, type OffsetMeshResult } from './offsetMesh.ts';

const PROPERTY_SEED = 20260714;

function hashMesh(mesh: IndexedMesh): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  hash.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return hash.digest('hex');
}

/** Max over all vertices of | |v| − targetRadius | — the acceptance metric. */
function maxRadialError(mesh: IndexedMesh, targetRadius: number): number {
  let maxErr = 0;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const r = Math.hypot(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    maxErr = Math.max(maxErr, Math.abs(r - targetRadius));
  }
  return maxErr;
}

function assertCleanClosedSurface(result: OffsetMeshResult): void {
  // Watertight + manifold on the FINAL (post-cleanup) mesh. A resolved
  // offsetMesh already implies manifold-3d accepted the surface (the
  // cleanup pass rejects otherwise) — these stats re-verify independently
  // via analyzeMesh's own edge-degree accounting.
  expect(result.stats.watertight).toBe(true);
  expect(result.stats.manifoldEdges).toBe(true);
  expect(result.stats.boundaryEdgeCount).toBe(0);
  expect(result.stats.componentCount).toBe(1);
  expect(result.stats.signedVolumeMm3).not.toBeNull();
  expect(result.stats.signedVolumeMm3!).toBeGreaterThan(0);
}

describe('offsetMesh — PHASE ACCEPTANCE: icosphere r=5, ±50 µm at default pitch 0.02 mm', () => {
  // 0.02 mm — the clinical default DEFAULT_OFFSET_VOXEL_PITCH_MM
  // (packages/clinical-profiles/src/constants.ts). Written literally here
  // because packages/kernel must not depend on packages/clinical-profiles
  // (layer rule); test/golden/offset.test.ts asserts the constant's value
  // is exactly this number, keeping the two in verified lockstep.
  const DEFAULT_PITCH = 0.02;
  const RADIUS = 5;
  const DISTANCE = 0.05;
  const MAX_RADIAL_ERROR_MM = 0.01;
  const mesh = icosphereMesh(RADIUS, 5); // 20,480 triangles — see module doc for the subdivision derivation

  it(
    `outward +${DISTANCE} mm: EVERY vertex within ${MAX_RADIAL_ERROR_MM} mm of radius ${RADIUS + DISTANCE}`,
    { timeout: 600_000 },
    async () => {
      const started = performance.now();
      const result = await offsetMesh(mesh, DISTANCE, { pitchMm: DEFAULT_PITCH });
      const elapsedMs = performance.now() - started;
      assertCleanClosedSurface(result);
      const measured = maxRadialError(result.mesh, RADIUS + DISTANCE);
      // REPORTED (phase acceptance evidence) — see this task's report.
      console.log(
        `[ACCEPTANCE] outward offset +${DISTANCE} mm @ pitch ${DEFAULT_PITCH}: max radial error = ` +
          `${(measured * 1000).toFixed(3)} µm (budget 10 µm); errorBoundMm = ${result.errorBoundMm.toFixed(6)}; ` +
          `${result.mesh.indices.length / 3} triangles; ${(elapsedMs / 1000).toFixed(1)} s`,
      );
      expect(measured).toBeLessThanOrEqual(MAX_RADIAL_ERROR_MM);
      expect(result.errorBoundMm).toBeGreaterThanOrEqual(DEFAULT_PITCH / 2);
      expect(result.errorBoundMm).toBeLessThan(DEFAULT_PITCH / 2 + 1e-4);
    },
  );

  it(
    `inward −${DISTANCE} mm: EVERY vertex within ${MAX_RADIAL_ERROR_MM} mm of radius ${RADIUS - DISTANCE}`,
    { timeout: 600_000 },
    async () => {
      const started = performance.now();
      const result = await offsetMesh(mesh, -DISTANCE, { pitchMm: DEFAULT_PITCH });
      const elapsedMs = performance.now() - started;
      assertCleanClosedSurface(result);
      const measured = maxRadialError(result.mesh, RADIUS - DISTANCE);
      console.log(
        `[ACCEPTANCE] inward offset −${DISTANCE} mm @ pitch ${DEFAULT_PITCH}: max radial error = ` +
          `${(measured * 1000).toFixed(3)} µm (budget 10 µm); errorBoundMm = ${result.errorBoundMm.toFixed(6)}; ` +
          `${result.mesh.indices.length / 3} triangles; ${(elapsedMs / 1000).toFixed(1)} s`,
      );
      expect(measured).toBeLessThanOrEqual(MAX_RADIAL_ERROR_MM);
    },
  );
});

describe('offsetMesh — sign convention (fast fixture: icosphere r=2, pitch 0.05)', () => {
  const radius = 2;
  const pitch = 0.05;
  const mesh = icosphereMesh(radius, 3);
  // Fixture sagitta for subdivisions=3 at r=2 (same derivation as the
  // acceptance module doc): theta ≈ 0.138 rad, s ≈ 2*(1-cos(0.069)) ≈
  // 4.8e-3 mm — added to the pipeline bound when asserting against the
  // IDEAL sphere radius.
  const sagitta = radius * (1 - Math.cos(Math.acos(1 / Math.sqrt(5)) / 2 ** 3 / 2));

  it('positive distance grows the sphere (outward), negative shrinks it (inward)', { timeout: 120_000 }, async () => {
    for (const d of [0.3, -0.3]) {
      const result = await offsetMesh(mesh, d, { pitchMm: pitch });
      assertCleanClosedSurface(result);
      const measured = maxRadialError(result.mesh, radius + d);
      expect(measured).toBeLessThanOrEqual(result.errorBoundMm + sagitta);
    }
  });

  it('an inward offset beyond the inradius produces EmptyOffsetResultError', { timeout: 120_000 }, async () => {
    await expect(offsetMesh(icosphereMesh(1, 2), -1.4, { pitchMm: 0.1 })).rejects.toThrow(EmptyOffsetResultError);
  });
});

describe('offsetMesh — cube: exact faces, rounded edges/corners (halfExtent 1, d=0.2, pitch 0.05)', () => {
  const he = 1;
  const d = 0.2;
  const pitch = 0.05;

  it('face regions offset exactly; edge/corner regions round with radius ≈ d', { timeout: 120_000 }, async () => {
    const result = await offsetMesh(cubeMesh(he), d, { pitchMm: pitch });
    assertCleanClosedSurface(result);
    const bound = result.errorBoundMm;

    let faceCount = 0;
    let edgeCount = 0;
    let cornerCount = 0;
    const positions = result.mesh.positions;
    for (let v = 0; v < positions.length / 3; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      const az = Math.abs(z);
      // FACE region (here: nearest feature is the +/-z face): |x|,|y|
      // strictly inside the face with margin d, so the true offset surface
      // is the exact plane z = ±(he + d).
      if (ax < he - d && ay < he - d) {
        faceCount++;
        expect(Math.abs(az - (he + d))).toBeLessThanOrEqual(bound);
      }
      // CORNER region: beyond all three face planes — true offset surface
      // is a radius-d sphere about the cube corner.
      if (ax > he && ay > he && az > he) {
        cornerCount++;
        const distToCorner = Math.hypot(ax - he, ay - he, az - he);
        expect(Math.abs(distToCorner - d)).toBeLessThanOrEqual(bound);
      }
      // EDGE region (here: the 4 edges parallel to z): beyond the x and y
      // face planes, strictly between the corner zones along z — true
      // offset surface is a radius-d cylinder about the cube edge.
      if (ax > he && ay > he && az < he - d) {
        edgeCount++;
        const distToEdge = Math.hypot(ax - he, ay - he);
        expect(Math.abs(distToEdge - d)).toBeLessThanOrEqual(bound);
      }
    }
    // Spot-assert coverage is real: each region actually contained vertices.
    expect(faceCount).toBeGreaterThan(10);
    expect(edgeCount).toBeGreaterThan(10);
    expect(cornerCount).toBeGreaterThan(3);
  });

  it('inward cube offset recovers the shrunken face planes', { timeout: 120_000 }, async () => {
    const result = await offsetMesh(cubeMesh(he), -d, { pitchMm: pitch });
    assertCleanClosedSurface(result);
    const bound = result.errorBoundMm;
    const positions = result.mesh.positions;
    let checked = 0;
    for (let v = 0; v < positions.length / 3; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      if (Math.abs(x) < (he - d) / 2 && Math.abs(y) < (he - d) / 2) {
        checked++;
        expect(Math.abs(Math.abs(z) - (he - d))).toBeLessThanOrEqual(bound);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('offsetMesh — property: offset(offset(m, d), −d) ≈ m within 2× the documented bound (PLAN §6.8)', () => {
  // Both fixtures are CONVEX, where dilation-then-erosion (outward then
  // inward by the same d) is the identity in the continuous limit
  // (morphological closing of a convex solid is the solid itself) — so the
  // ONLY deviation is the two pipeline passes' approximation error, each
  // bounded by errorBoundMm: final vertices lie within bound of pass 2's
  // true iso surface, which itself lies within bound (pass 1's surface
  // error, 1-Lipschitz-transported through pass 2's SDF) of the original
  // surface — total 2× the documented bound. Measured as exact point-to-
  // surface distance against the ORIGINAL mesh (closestPoint — exact
  // Float64), so fixture tessellation contributes nothing.
  const pitch = 0.08;
  const fixtures: ReadonlyArray<[string, IndexedMesh]> = [
    ['icosphere r=2 (subdivisions 3)', icosphereMesh(2, 3)],
    ['cube halfExtent 1', cubeMesh(1)],
  ];

  for (const [name, mesh] of fixtures) {
    it(`${name}: every roundtrip vertex within 2× bound of the original surface`, { timeout: 300_000 }, async () => {
      const bvh = buildBvh(mesh);
      await fc.assert(
        fc.asyncProperty(fc.double({ min: 0.1, max: 0.3, noNaN: true }), async (d) => {
          const outward = await offsetMesh(mesh, d, { pitchMm: pitch });
          const roundtrip = await offsetMesh(outward.mesh, -d, { pitchMm: pitch });
          expect(roundtrip.stats.watertight).toBe(true);
          const allowed = outward.errorBoundMm + roundtrip.errorBoundMm; // == 2× the documented per-pass bound
          let maxDist = 0;
          for (let v = 0; v < roundtrip.mesh.positions.length / 3; v++) {
            const hit = closestPoint(mesh, bvh, [
              roundtrip.mesh.positions[v * 3]!,
              roundtrip.mesh.positions[v * 3 + 1]!,
              roundtrip.mesh.positions[v * 3 + 2]!,
            ]);
            maxDist = Math.max(maxDist, hit.distance);
          }
          expect(maxDist).toBeLessThanOrEqual(allowed);
        }),
        { seed: PROPERTY_SEED, numRuns: 3 },
      );
    });
  }
});

describe('offsetMesh — determinism and error paths', () => {
  it('double run produces byte-identical output (determinism hash)', { timeout: 120_000 }, async () => {
    const mesh = icosphereMesh(1.5, 2);
    const first = await offsetMesh(mesh, 0.2, { pitchMm: 0.1 });
    const second = await offsetMesh(mesh, 0.2, { pitchMm: 0.1 });
    expect(hashMesh(second.mesh)).toBe(hashMesh(first.mesh));
    expect(second.stats).toEqual(first.stats);
    expect(second.errorBoundMm).toBe(first.errorBoundMm);
  });

  it('rejects a non-watertight mesh with NonWatertightMeshError', async () => {
    await expect(offsetMesh(openGridPatchMesh(2, 2, 1), 0.1, { pitchMm: 0.1 })).rejects.toThrow(
      NonWatertightMeshError,
    );
  });

  it('rejects invalid pitchMm / distanceMm with TypeError before any heavy work', async () => {
    const mesh = icosphereMesh(1, 1);
    await expect(offsetMesh(mesh, 0.1, { pitchMm: 0 })).rejects.toThrow(TypeError);
    await expect(offsetMesh(mesh, 0.1, { pitchMm: -0.1 })).rejects.toThrow(TypeError);
    await expect(offsetMesh(mesh, 0.1, { pitchMm: Number.NaN })).rejects.toThrow(TypeError);
    await expect(offsetMesh(mesh, Number.POSITIVE_INFINITY, { pitchMm: 0.1 })).rejects.toThrow(TypeError);
    await expect(offsetMesh(mesh, Number.NaN, { pitchMm: 0.1 })).rejects.toThrow(TypeError);
  });
});
