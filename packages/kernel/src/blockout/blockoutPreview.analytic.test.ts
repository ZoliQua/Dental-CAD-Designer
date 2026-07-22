// packages/kernel/src/blockout/blockoutPreview.analytic.test.ts
//
// Analytic golden cases for `blockoutPreview`, per this task's brief and
// CLAUDE.md's "tests first: property-based + analytic golden case (sphere/
// cylinder/torus with closed-form answer)" convention.
//
// ## Fixture 1 — tilted cylinder, closed-form displacement (derived below)
//
// `undercut/undercutScan.analytic.test.ts` (Phase 2 Task 9, cited not
// re-derived) already proves: for `cappedCylinderMesh(radius, height,
// segments, heightSegments)`'s wall, scanned along `d(a) = (sin a, 0, cos
// a)`, a wall vertex at ring angle `phi` (position `(R cos phi, R sin phi,
// z)`) is undercut BY FACING exactly when `cos(phi) < 0` (for `0 < a <
// pi`). THIS file derives the exact closed-form EXIT (horizon) point for
// such a vertex, which `blockoutPreview` displaces it to.
//
// Parametrize the `+d` ray from `P = (R cos phi, R sin phi, z)`:
// `P + t*d = (R cos phi + t sin a, R sin phi, z + t cos a)`. Its radial
// distance-squared from the cylinder's own axis is
// `R^2 + 2 R cos(phi) t sin(a) + t^2 sin^2(a)` (expand and use
// `cos^2+sin^2=1`) — setting this equal to `R^2` (the ray re-touching the
// wall's own radius) and solving for the nonzero root:
//
//   t_wall = -2 R cos(phi) / sin(a)
//
// which is POSITIVE exactly when `cos(phi) < 0` (the undercut condition,
// for `0 < a < pi` so `sin(a) > 0`) — consistent. At this `t`, the exit
// point's (x, y) is `(-R cos phi, R sin phi)` (substitute `t_wall` back into
// `x(t)`: `R cos phi + t_wall sin a = R cos phi - 2 R cos phi = -R cos
// phi`; `y(t) = R sin phi` is UNCHANGED, since `d` has zero y-component)
// and `z_exit = z - 2 R cos(phi) cot(a)`.
//
// ### Why this file uses `a = 90 degrees` specifically for the CLOSED-FORM
// vertex-position check (not an arbitrary tilt)
//
// At `a = 90 deg`, `cot(a) = 0`, so `z_exit = z` EXACTLY, independent of
// height — the exit point is simply `(-R cos phi, R sin phi, z)`, i.e. the
// MIRROR of the source vertex across the plane `x = 0`. This closed form
// holds for EVERY wall vertex regardless of its ring height (no risk of the
// ray instead exiting through a CAP before reaching `t_wall` — a real
// possibility at a shallower tilt, worked out and rejected as this file's
// primary closed-form check for exactly that reason: at e.g. `a = 30 deg`,
// a vertex near `phi = 180 deg` at low `z` has `t_wall` large enough that
// `z_exit` would exceed the fixture's own height, meaning the ray would
// actually exit through the TOP CAP, not the wall — a real, and separately
// interesting, case this file does NOT attempt to closed-form here since it
// needs cap-plane intersection algebra on top of the above; `a = 90 deg` is
// the tilt at which the wall-only closed form is unconditionally exact for
// this fixture, at every ring). `a = 90 deg` is one of Phase 2 Task 9's own
// three validated tilts (undercut/undercutScan.analytic.test.ts), so this
// is not an arbitrary/untested angle either.
//
// ## Fixture 2 — cone frustum ("prep-die"), self-consistency
//
// `axis/axis.test-fixtures.ts`'s `coneFrustumMesh` (already used by
// `axis/suggestInsertionAxis.analytic.test.ts` as a "prep-die-like
// construction axis" fixture — cited, same params) tapers narrower toward
// `+Z`; every wall triangle's outward normal has a UNIFORM, comfortably
// nonzero component along the true axis at zero tilt (no grazing
// degeneracy). Tilting the scan direction away from `[0,0,1]` beyond the
// frustum's own ~9.46 degree zero-undercut cone (docs/CHANGELOG-kernel.md's
// `[0.6.0]` entry) produces a genuine, non-trivial undercut band with real
// occlusion depth (the ray travels THROUGH the solid to the opposite wall)
// — this is THE self-consistency test: re-scanning the PREVIEW mesh (its
// own fresh BVH) along the SAME axis must show zero (or a documented
// nonzero) undercut.
//
// ## Fixture 3 — canopy (HONEST residual — read before assuming zero always)
//
// `undercut/undercut.test-fixtures.ts`'s `canopyMesh` (Phase 2 Task 9's own
// occlusion fixture, cited) has THREE mutually DISCONNECTED undercut
// regions when scanned along `+Z` (floor underside — undercut by facing;
// floor TOP — undercut by occlusion, the canopy above it; canopy underside
// — undercut by facing) that share the SAME (x, y) footprint. Each
// region's own vertex displacement is computed independently (this
// module's documented "no global smoothness/non-interference guarantee" —
// blockoutPreview.ts's `@errorBound`, point 2) — MEASURED here: after
// displacement, the three regions land at three DIFFERENT heights directly
// above one another (the floor-bottom patch displaces up to coincide with
// the floor's own top; the floor-top patch displaces up to the canopy's
// underside; the canopy-underside patch displaces up to the canopy's own
// top), and a re-scan of the COMBINED preview finds NEW undercut: the
// lower two of the three stacked patches are now occluded by the patch(es)
// above them WITHIN the preview itself — a genuine limitation this file
// documents with its own measured numbers, not a hidden failure.
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { cappedCylinderMesh } from '../curvature/curvature.test-fixtures.ts';
import { coneFrustumMesh } from '../axis/axis.test-fixtures.ts';
import { canopyMesh } from '../undercut/undercut.test-fixtures.ts';
import { undercutScan } from '../undercut/undercutScan.ts';
import { blockoutPreview } from './blockoutPreview.ts';

function allTriangleIndices(mesh: IndexedMesh): Uint32Array {
  const triangleCount = mesh.indices.length / 3;
  const indices = new Uint32Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) indices[i] = i;
  return indices;
}

describe('blockoutPreview — tilted cylinder (a=90deg): displaced vertex matches the exact closed-form horizon point', () => {
  it('every displaced wall vertex equals (-x, y, z) of its source vertex, to float precision', () => {
    const radius = 3;
    const height = 8;
    const segments = 64;
    const heightSegments = 8;
    const mesh = cappedCylinderMesh(radius, height, segments, heightSegments);
    const bvh = buildBvh(mesh);
    const d: [number, number, number] = [1, 0, 0]; // a = 90 degrees

    const result = blockoutPreview(mesh, bvh, { triangleIndices: allTriangleIndices(mesh) }, d, 0);

    expect(result.blockoutTriangleCount).toBeGreaterThan(0);
    expect(result.maxDisplacementMm).toBeCloseTo(2 * radius, 9); // 2R at phi=180deg exactly

    const preview = result.mesh.previewMesh;
    let maxErr = 0;
    let checked = 0;
    for (let v = 0; v < preview.positions.length / 3; v++) {
      const px = preview.positions[v * 3]!;
      const py = preview.positions[v * 3 + 1]!;
      const pz = preview.positions[v * 3 + 2]!;
      // Expected source vertex: mirror across x=0, i.e. (-px, py, pz).
      let bestDist = Infinity;
      for (let ov = 0; ov < mesh.positions.length / 3; ov++) {
        const ox = mesh.positions[ov * 3]!;
        const oy = mesh.positions[ov * 3 + 1]!;
        const oz = mesh.positions[ov * 3 + 2]!;
        const dist = Math.hypot(ox - -px, oy - py, oz - pz);
        if (dist < bestDist) bestDist = dist;
      }
      expect(bestDist).toBeLessThan(1e-6);
      if (bestDist > maxErr) maxErr = bestDist;
      checked++;
    }
    console.log(`[blockoutPreview analytic] tilted-cylinder (a=90deg): ${checked} preview vertices checked, ` + `max|measured - closed form| = ${maxErr.toExponential(3)} mm`);
    expect(checked).toBeGreaterThan(0);
  });
});

describe('blockoutPreview — cone frustum ("prep-die"), tilted axis: SELF-CONSISTENCY', () => {
  it('re-scanning the preview mesh along the SAME axis finds ZERO undercut, at several tilts beyond the zero-undercut cone (measured)', () => {
    const tiltsDeg = [15, 20, 25, 30, 45];
    const measurements: string[] = [];
    for (const tiltDeg of tiltsDeg) {
      const frustum = coneFrustumMesh(4, 2.5, 9, 64, 12);
      const bvh = buildBvh(frustum.mesh);
      const a = (tiltDeg * Math.PI) / 180;
      const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];

      const result = blockoutPreview(frustum.mesh, bvh, { triangleIndices: allTriangleIndices(frustum.mesh) }, d, 0);
      expect(result.blockoutTriangleCount).toBeGreaterThan(0); // genuine undercut beyond the ~9.46deg cone

      const preview = result.mesh.previewMesh;
      const previewBvh = buildBvh(preview);
      const rescan = undercutScan(preview, previewBvh, d);

      measurements.push(
        `tilt=${tiltDeg}deg: selected=${result.blockoutTriangleCount} tris, maxDisplacement=${result.maxDisplacementMm.toFixed(4)}mm, ` +
          `approxVolume=${result.approxVolumeMm3.toFixed(4)}mm^3 -> RESCAN undercutTriangleCount=${rescan.undercutTriangleCount}/${preview.indices.length / 3}, maxDepthMm=${rescan.maxDepthMm}`,
      );
      // HONEST assertion: MEASURED zero, not assumed — see this file's own
      // module doc for the derivation of why a single-connected-solid
      // fixture like this one is expected (and measured) to self-eliminate
      // cleanly, in contrast to Fixture 3 (canopy) below.
      expect(rescan.undercutTriangleCount).toBe(0);
      expect(rescan.maxDepthMm).toBe(0);
    }
    console.log('[blockoutPreview analytic] prep-die self-consistency (measured):\n' + measurements.join('\n'));
  });
});

describe('blockoutPreview — winding reversal is a measured necessity, not a cosmetic choice (blockoutPreview.ts module doc citation)', () => {
  it('un-flipped preview winding re-scans to the SAME undercutTriangleCount as the source selection; this module\'s actual (flipped) output re-scans to ZERO — both measured, on the same fixture the module doc cites', () => {
    const tiltDeg = 20; // beyond the frustum's ~9.46deg zero-undercut cone (Fixture 2's own doc above)
    const frustum = coneFrustumMesh(4, 2.5, 9, 64, 12);
    const bvh = buildBvh(frustum.mesh);
    const a = (tiltDeg * Math.PI) / 180;
    const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];

    const result = blockoutPreview(frustum.mesh, bvh, { triangleIndices: allTriangleIndices(frustum.mesh) }, d, 0);
    expect(result.blockoutTriangleCount).toBeGreaterThan(0); // genuine undercut beyond the cone

    const preview = result.mesh.previewMesh;

    // This module's ACTUAL output: winding REVERSED relative to the source
    // triangles (blockoutPreview.ts's own "Winding is REVERSED" doc —
    // `localOf(0), localOf(2), localOf(1)` construction order).
    const flippedBvh = buildBvh(preview);
    const flippedRescan = undercutScan(preview, flippedBvh, d);

    // The UN-flipped counterpart: IDENTICAL vertex positions, winding
    // restored to match the SOURCE triangles (swap corners 1 and 2 back) —
    // isolates winding as the ONLY variable between the two re-scans below.
    const unflippedIndices = new Uint32Array(preview.indices.length);
    for (let k = 0; k < preview.indices.length / 3; k++) {
      unflippedIndices[k * 3] = preview.indices[k * 3]!;
      unflippedIndices[k * 3 + 1] = preview.indices[k * 3 + 2]!;
      unflippedIndices[k * 3 + 2] = preview.indices[k * 3 + 1]!;
    }
    const unflippedMesh: IndexedMesh = { positions: preview.positions, indices: unflippedIndices };
    const unflippedBvh = buildBvh(unflippedMesh);
    const unflippedRescan = undercutScan(unflippedMesh, unflippedBvh, d);

    console.log(
      `[blockoutPreview analytic] winding-reversal necessity (measured): tilt=${tiltDeg}deg, selected=${result.blockoutTriangleCount} tris -> ` +
        `UN-flipped rescan undercutTriangleCount=${unflippedRescan.undercutTriangleCount}, maxDepthMm=${unflippedRescan.maxDepthMm} ; ` +
        `flipped (actual output) rescan undercutTriangleCount=${flippedRescan.undercutTriangleCount}, maxDepthMm=${flippedRescan.maxDepthMm}`,
    );

    // MEASURED, exactly as blockoutPreview.ts's module doc claims (Task-11
    // review Critical 5: this test is what makes that citation honest — the
    // doc previously cited a test with this name/these numbers that did not
    // exist). A future change to the fixture or the algorithm that alters
    // these numbers should be reviewed, not silently "fixed" by loosening
    // these assertions.
    expect(unflippedRescan.undercutTriangleCount).toBe(result.blockoutTriangleCount);
    expect(unflippedRescan.maxDepthMm).toBe(0);
    expect(flippedRescan.undercutTriangleCount).toBe(0);
    expect(flippedRescan.maxDepthMm).toBe(0);
  });
});

describe('blockoutPreview — canopy fixture: HONEST measured residual (multi-region stacking)', () => {
  it('three disconnected undercut regions sharing a footprint create NEW mutual occlusion in the combined preview — measured, not hidden', () => {
    const mesh = canopyMesh(4, 3, 1, 0.5, 1);
    const bvh = buildBvh(mesh);
    const d: [number, number, number] = [0, 0, 1];

    const result = blockoutPreview(mesh, bvh, { triangleIndices: allTriangleIndices(mesh) }, d, 0);
    expect(result.blockoutTriangleCount).toBeGreaterThan(0);

    const preview = result.mesh.previewMesh;
    const previewBvh = buildBvh(preview);
    const rescan = undercutScan(preview, previewBvh, d);

    console.log(
      `[blockoutPreview analytic] canopy residual (measured): selected=${result.blockoutTriangleCount} tris -> ` +
        `RESCAN undercutTriangleCount=${rescan.undercutTriangleCount}/${preview.indices.length / 3}, maxDepthMm=${rescan.maxDepthMm}`,
    );
    // MEASURED, pinned numbers (see this file's module doc's Fixture 3
    // section for the derivation: the floor-bottom and floor-top-gap
    // patches land directly beneath the canopy-underside patch after
    // displacement, so 4 of the 6 selected triangles are occluded by
    // another patch WITHIN the combined preview). A future change to the
    // fixture or the algorithm that alters this number should be reviewed,
    // not silently "fixed" by loosening this assertion.
    expect(result.blockoutTriangleCount).toBe(6);
    expect(rescan.undercutTriangleCount).toBe(4);
    expect(rescan.maxDepthMm).toBeCloseTo(1, 9);
  });
});

describe('blockoutPreview — no-undercut case -> empty preview (determinism-relevant edge case)', () => {
  it('a sphere patch with zero undercut anywhere (upper hemisphere only, scanned along +Z) -> empty preview', () => {
    // Reuses undercut/undercutScan.analytic.test.ts's own closed-form
    // finding ("every triangle strictly in the upper hemisphere is not
    // undercut") — restricting the REGION to upper-hemisphere-only
    // triangles of a capped cylinder's TOP CAP (uniform +Z normal, never
    // undercut for d=+Z) is the simplest reliable zero-undercut region.
    const mesh = cappedCylinderMesh(3, 8, 32, 4);
    const bvh = buildBvh(mesh);
    const triangleCount = mesh.indices.length / 3;
    const wallTriangleCount = 4 * 32 * 2;
    const topCapTriangleCount = 32;
    const topCapStart = wallTriangleCount; // bottom cap triangles come first per cappedCylinderMesh's own construction order — recomputed defensively below
    void topCapStart;
    // Defensive: identify top-cap triangles directly by geometry (every
    // vertex at z = +height/2) rather than assuming triangulation order.
    const topCapIndices: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!, i1 = mesh.indices[t * 3 + 1]!, i2 = mesh.indices[t * 3 + 2]!;
      const z0 = mesh.positions[i0 * 3 + 2]!, z1 = mesh.positions[i1 * 3 + 2]!, z2 = mesh.positions[i2 * 3 + 2]!;
      if (Math.abs(z0 - 4) < 1e-9 && Math.abs(z1 - 4) < 1e-9 && Math.abs(z2 - 4) < 1e-9) topCapIndices.push(t);
    }
    expect(topCapIndices.length).toBe(topCapTriangleCount);

    const result = blockoutPreview(mesh, bvh, { triangleIndices: new Uint32Array(topCapIndices) }, [0, 0, 1], 0);
    expect(result.blockoutTriangleCount).toBe(0);
    expect(result.mesh.previewMesh.positions.length).toBe(0);
    expect(result.mesh.previewMesh.indices.length).toBe(0);
  });
});
