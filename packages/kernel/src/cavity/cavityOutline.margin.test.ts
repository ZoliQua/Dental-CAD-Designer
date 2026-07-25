// packages/kernel/src/cavity/cavityOutline.margin.test.ts
//
// Phase 5 Task 2, deliverable 1: VALIDATE the P3/P4 margin machinery on the
// MOD-cavity fixture's cavity outline — a sharp-cornered, genuinely
// NON-PLANAR closed ring (the two proximal-box "U" drops descend the
// proximal faces to the gingival floor), a very different character from the
// smooth, near-planar crown margins the machinery was built against.
// Everything here goes through the DENSE outline points only (the chord-cap
// currency — margin/band.ts's module doc): the outline ring IS the dense
// polyline; no anchor chords are ever derived from it.
//
// ## Findings this file pins (see the Task 2 report for the narrative)
//
//  1. `marginLoopPolyline` — NO point loss at sharp corners: every outline
//     point is preserved bit-exactly (spacing is always far above
//     MESH_WELD_EPSILON_MM; dedup only ever removes genuine duplicates).
//     A production-shaped input WITH duplicated segment-boundary points at
//     the sharp corners dedups back to the clean ring exactly.
//  2. `computeMarginLoopFrame` — Newell's method on this corner-heavy,
//     non-planar loop gives EXACTLY the insertion axis (+Z), analytically:
//     the Newell normal is the loop's total projected-area vector; the
//     outline's XY projection is the exact L x isthmusWidth opening
//     rectangle (the U drops project onto the rectangle's own proximal
//     edges), so Nz = 2*L*W > 0; the two U drops' X/Y contributions cancel
//     exactly by mesial/distal symmetry + per-U telescoping. Orientation is
//     right-handed with the outline's own (CCW-in-XY) point order.
//     CORNER-CASE BEHAVIOR (documented, not a defect): the frame CENTROID
//     is the arithmetic mean of the loop's own vertices (band.ts's
//     documented choice), so on this non-planar outline it sits BELOW the
//     occlusal table (the U-drop points pull it down) — closed-form
//     asserted below, so any future change to that choice fails loudly here.
//  3. `validateMarginLine` — the sharp box line angles do NOT trip any
//     check: not self-intersecting (all non-local approaches are >= the
//     box floor width, orders above the tolerance band), on-surface
//     (outline points are mesh vertices, deviation exactly 0), and NO
//     smoothness warnings: the discrete-curvature check is
//     angle/spacing-normalized and calibrated against ridge-walk NOISE
//     (validate.ts's own doc) — a genuine 90-degree corner spread over
//     mm-scale segments measures ~1.3 mm^-1, far under the 80 mm^-1
//     threshold. That is EXPECTED behavior (smoothness is a jitter
//     warning, not a corner detector), pinned here as documentation.
//  4. `marginLoopMesh` — the band ribbon builds cleanly on the non-planar
//     loop (2n vertices / 2n triangles, rim offset exactly along the frame
//     normal), deterministically.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildBvh } from '../bvh/index.ts';
import { snapToSurface } from '../geodesic/surfacePoint.ts';
import {
  marginLoopPolyline,
  computeMarginLoopFrame,
  marginLoopMesh,
  MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM,
} from '../margin/band.ts';
import { validateMarginLine, classifyMarginValidation } from '../margin/validate.ts';
import type { MarginLineLike } from '../spline/marginLine.ts';
import { modCavityMesh, type ModCavityMesh, type ModCavityMeshOptions } from './cavity.test-fixtures.ts';

type Vec3 = readonly [number, number, number];

/** Outline point count closed-form: buccal margin (3m+1 stations) + distal
 * U (5) + lingual margin (3m) + mesial U (4) = 6m + 10. */
function expectedOutlineCount(m: number): number {
  return 6 * m + 10;
}

/** Builds a real `MarginLineLike` from the fixture outline: the dense ring
 * as `resampledPoints` (the chord-cap currency), with a handful of genuine
 * on-surface anchors (BVH-snapped outline corners — honest triangleIndex/
 * barycentric values, not fabricated ones). */
function outlineAsMarginLine(f: ModCavityMesh): { margin: MarginLineLike; bvh: ReturnType<typeof buildBvh> } {
  const bvh = buildBvh(f.mesh);
  const anchorPoints = [f.cavityOutline[0]!, f.cavityOutline[3]!, f.cavityOutline[7]!, f.cavityOutline[11]!];
  const anchors = anchorPoints.map((p) => {
    const sp = snapToSurface(f.mesh, bvh, p as Vec3);
    return { position: p as Vec3, triangleIndex: sp.triangleIndex, barycentric: sp.barycentric };
  });
  return { margin: { anchors, closed: true, resampledPoints: f.cavityOutline as readonly Vec3[] }, bvh };
}

const fixtureArb = fc
  .record({
    lengthMm: fc.double({ min: 8, max: 14, noNaN: true }),
    widthMm: fc.double({ min: 7, max: 11, noNaN: true }),
    isthmusWidthMm: fc.double({ min: 1.5, max: 4, noNaN: true }),
    isthmusDepthMm: fc.double({ min: 1.0, max: 2.2, noNaN: true }),
    boxDepthMm: fc.double({ min: 2.8, max: 4.5, noNaN: true }),
    boxLengthMm: fc.double({ min: 1.5, max: 3.5, noNaN: true }),
    taperDeg: fc.double({ min: 2, max: 12, noNaN: true }),
    reducedCusp: fc.boolean(),
    mdSegmentsPerZone: fc.integer({ min: 2, max: 5 }),
  })
  .filter((o) => {
    // Same documented fixture invariants the Task 1 property test guards
    // (fc.pre equivalent via filter — never rely on luck for validity).
    const tan = Math.tan((o.taperDeg * Math.PI) / 180);
    return (
      o.boxDepthMm > o.isthmusDepthMm + 0.5 &&
      2 * o.boxLengthMm < o.lengthMm - 1 &&
      o.isthmusWidthMm < o.widthMm - 1 &&
      o.isthmusWidthMm / 2 - o.boxDepthMm * tan > 0.2
    );
  });

describe('cavity outline through marginLoopPolyline (dedup on a sharp-cornered ring)', () => {
  it('preserves every outline point bit-exactly (default fixture)', () => {
    const f = modCavityMesh();
    const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
    expect(loop.length).toBe(expectedOutlineCount(6));
    expect(loop.length).toBe(f.cavityOutline.length);
    for (let i = 0; i < loop.length; i++) {
      expect(loop[i]).toEqual(f.cavityOutline[i]);
    }
  });

  it('preserves the onlay-variant outline identically (cusp knob does not touch the outline)', () => {
    const inlay = modCavityMesh();
    const onlay = modCavityMesh({ reducedCusp: true });
    expect(onlay.cavityOutline).toEqual(inlay.cavityOutline);
    const loop = marginLoopPolyline({ closed: true, resampledPoints: onlay.cavityOutline });
    expect(loop.length).toBe(onlay.cavityOutline.length);
  });

  it('dedups a production-shaped ring with duplicated corner boundary points back to the clean ring', () => {
    // flattenResampledPoints-style input: consecutive segments share their
    // boundary point, so the real production array duplicates it — here
    // simulated at every SHARP corner (the proximal-U turns), plus the
    // closing wraparound duplicate.
    const f = modCavityMesh();
    const clean = f.cavityOutline;
    const withDuplicates: Vec3[] = [];
    for (const p of clean) {
      withDuplicates.push(p);
      if (Math.abs(p[0]) === f.lengthMm / 2) withDuplicates.push([p[0], p[1], p[2]]); // duplicate every proximal-face (U) point
    }
    withDuplicates.push(clean[0]!); // closing wraparound duplicate
    const loop = marginLoopPolyline({ closed: true, resampledPoints: withDuplicates });
    expect(loop.length).toBe(clean.length);
    for (let i = 0; i < loop.length; i++) expect(loop[i]).toEqual(clean[i]);
  });
});

describe('cavity outline through computeMarginLoopFrame (Newell on a non-planar, corner-heavy loop)', () => {
  it('the Newell normal is EXACTLY the insertion axis (+Z), by the projected-area argument', () => {
    const f = modCavityMesh();
    const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
    const frame = computeMarginLoopFrame(loop);
    // Nz = 2 * projected XY area = 2*L*W (exact rectangle); Nx, Ny cancel by
    // symmetry/telescoping — float residue only.
    expect(Math.abs(frame.normal[0])).toBeLessThan(1e-12);
    expect(Math.abs(frame.normal[1])).toBeLessThan(1e-12);
    expect(frame.normal[2]).toBeCloseTo(1, 12);
    // Right-handed with the outline's own CCW-in-XY order.
    expect(frame.normal[2]).toBeGreaterThan(0);
  });

  it('the centroid sits BELOW the occlusal table (vertex-mean on a non-planar loop) — closed-form', () => {
    const f = modCavityMesh();
    const m = 6;
    const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
    const frame = computeMarginLoopFrame(loop);
    // Outline z composition: (6m+2) points at tableZ, 4 at floorZ, 4 at
    // gingivalFloorZ (the two U drops) — the arithmetic vertex mean.
    const n = expectedOutlineCount(m);
    const expectedZ = ((6 * m + 2) * f.tableZ + 4 * f.floorZ + 4 * f.gingivalFloorZ) / n;
    expect(frame.centroidMm[2]).toBeCloseTo(expectedZ, 12);
    expect(frame.centroidMm[2]).toBeLessThan(f.tableZ);
    // Mesiodistal + buccolingual symmetry.
    expect(Math.abs(frame.centroidMm[0])).toBeLessThan(1e-9);
    expect(Math.abs(frame.centroidMm[1])).toBeLessThan(1e-9);
  });

  it('tangent basis is orthonormal and right-handed with the normal', () => {
    const f = modCavityMesh();
    const frame = computeMarginLoopFrame(marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline }));
    const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(frame.tangentU, frame.tangentV)).toBeCloseTo(0, 12);
    expect(dot(frame.tangentU, frame.normal)).toBeCloseTo(0, 12);
    expect(dot(frame.tangentV, frame.normal)).toBeCloseTo(0, 12);
    const cross: Vec3 = [
      frame.tangentU[1] * frame.tangentV[2] - frame.tangentU[2] * frame.tangentV[1],
      frame.tangentU[2] * frame.tangentV[0] - frame.tangentU[0] * frame.tangentV[2],
      frame.tangentU[0] * frame.tangentV[1] - frame.tangentU[1] * frame.tangentV[0],
    ];
    expect(cross[0]).toBeCloseTo(frame.normal[0], 12);
    expect(cross[1]).toBeCloseTo(frame.normal[1], 12);
    expect(cross[2]).toBeCloseTo(frame.normal[2], 12);
  });
});

describe('cavity outline through validateMarginLine (sharp corners vs every check)', () => {
  it('validates clean: closed, no self-intersection, on-surface (deviation exactly 0), not degenerate', () => {
    const f = modCavityMesh();
    const { margin, bvh } = outlineAsMarginLine(f);
    const report = validateMarginLine(f.mesh, bvh, margin);
    expect(report.closed).toBe(true);
    expect(report.selfIntersecting).toBe(false);
    expect(report.selfIntersections).toEqual([]);
    expect(report.onSurface).toBe(true);
    expect(report.maxSurfaceDeviationMm).toBe(0); // outline points ARE mesh vertices
    expect(report.degenerate).toBe(false);
    expect(report.validatedPointCount).toBe(f.cavityOutline.length);
    expect(classifyMarginValidation(report).blocked).toBe(false);
  });

  it('sharp box line angles do NOT trip the smoothness warning (documented expected behavior)', () => {
    // The discrete-curvature check normalizes turning angle by local
    // spacing (validate.ts doc) — a genuine 90-degree corner over mm-scale
    // segments measures ~1.3 mm^-1 << the 80 mm^-1 noise-calibrated
    // threshold. Smoothness is a jitter warning, not a corner detector.
    const f = modCavityMesh();
    const { margin, bvh } = outlineAsMarginLine(f);
    const report = validateMarginLine(f.mesh, bvh, margin);
    expect(report.smoothnessWarnings).toEqual([]);
  });

  it('still catches a genuinely corrupted outline point (off-surface hard failure works here too)', () => {
    const f = modCavityMesh();
    const { margin, bvh } = outlineAsMarginLine(f);
    const corrupted = f.cavityOutline.map((p, i) => (i === 10 ? ([p[0], p[1], p[2] + 0.5] as Vec3) : (p as Vec3)));
    const report = validateMarginLine(f.mesh, bvh, { ...margin, resampledPoints: corrupted });
    expect(report.onSurface).toBe(false);
    expect(classifyMarginValidation(report).hardFailureKinds).toContain('offSurface');
  });
});

describe('cavity outline through marginLoopMesh (band ribbon on the non-planar loop)', () => {
  it('builds the 2n-vertex / 2n-triangle ribbon with rims offset exactly along the frame normal', () => {
    const f = modCavityMesh();
    const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
    const frame = computeMarginLoopFrame(loop);
    const band = marginLoopMesh(loop);
    const n = loop.length;
    expect(band.mesh.positions.length).toBe(n * 2 * 3);
    expect(band.mesh.indices.length).toBe(n * 2 * 3);
    expect(band.halfThicknessMm).toBe(MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM);
    // Top rim vertex i = loop[i] + h*normal (exact construction).
    for (const i of [0, 5, n - 1]) {
      const p = loop[i]!;
      expect(band.mesh.positions[i * 3]!).toBeCloseTo(p[0] + frame.normal[0] * band.halfThicknessMm, 12);
      expect(band.mesh.positions[i * 3 + 1]!).toBeCloseTo(p[1] + frame.normal[1] * band.halfThicknessMm, 12);
      expect(band.mesh.positions[i * 3 + 2]!).toBeCloseTo(p[2] + frame.normal[2] * band.halfThicknessMm, 12);
    }
    for (const v of band.mesh.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('is deterministic (two builds byte-identical)', () => {
    const f = modCavityMesh();
    const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
    const a = marginLoopMesh(loop);
    const b = marginLoopMesh(loop);
    expect(a.mesh.positions).toEqual(b.mesh.positions);
    expect(a.mesh.indices).toEqual(b.mesh.indices);
  });
});

describe('cavity outline through the margin machinery — property-varied parameters', () => {
  it('polyline preserves all points, frame normal is +Z, validation is clean, band builds — across the parameter space', () => {
    fc.assert(
      fc.property(fixtureArb, (o: ModCavityMeshOptions) => {
        const f = modCavityMesh(o);
        const m = o.mdSegmentsPerZone!;

        const loop = marginLoopPolyline({ closed: true, resampledPoints: f.cavityOutline });
        expect(loop.length).toBe(expectedOutlineCount(m));

        const frame = computeMarginLoopFrame(loop);
        expect(Math.abs(frame.normal[0])).toBeLessThan(1e-10);
        expect(Math.abs(frame.normal[1])).toBeLessThan(1e-10);
        expect(frame.normal[2]).toBeGreaterThan(1 - 1e-10);

        const { margin, bvh } = outlineAsMarginLine(f);
        const report = validateMarginLine(f.mesh, bvh, margin);
        expect(report.selfIntersecting).toBe(false);
        expect(report.onSurface).toBe(true);
        expect(report.smoothnessWarnings).toEqual([]);
        expect(classifyMarginValidation(report).blocked).toBe(false);

        const band = marginLoopMesh(loop);
        expect(band.mesh.positions.length).toBe(loop.length * 6);
      }),
      { numRuns: 15 },
    );
  });
});
