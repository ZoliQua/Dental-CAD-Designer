// packages/kernel/src/anatomy/placement.neighbourDatum.test.ts
//
// Phase 14 Task 1 (ADR-027 Decisions 1–2): with no antagonist, the crown's
// height comes from the neighbours' occlusal level, interpolated at the site,
// raised to the intaglio floor when the floor is higher. Closed-form
// scenarios: every expected value is derived in the test's comment.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  type AnatomyPlacementInput,
  type CanonicalFrameAxes,
  type IndexedMesh,
  type NeighbourOcclusalDatum,
  type Vec3,
} from '../index.ts';

const IDENTITY_CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

/** Axis-aligned box [min..max], 12 triangles. */
function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function marginCircle(c: Vec3, r: number, n = 64): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([c[0] + r * Math.cos(th), c[1] + r * Math.sin(th), c[2]]);
  }
  return loop;
}

/** A neighbour's positions: a low block (z ∈ [1, 2]) spanning x ∈ [x0, x1]
 * plus one peak vertex, then optional extra (closure) vertices. The block's
 * y-centre is 5, like the peak's, so md stays exactly +x. */
function neighbour(x0: number, x1: number, peak: Vec3, extra: readonly Vec3[] = []): Float64Array {
  const block = box([x0, 4, 1], [x1, 6, 2]).positions;
  const out = new Float64Array(block.length + 3 + extra.length * 3);
  out.set(block, 0);
  out.set(peak, block.length);
  extra.forEach((p, i) => out.set(p, block.length + 3 + i * 3));
  return out;
}

// ---------------------------------------------------------------------------
// The analytic scenario:
//   origin (margin centroid) O = [10, 5, 2], axis +Z, so og = +Z
//   library box Z ∈ [0, 4], canonical origin 0 ⇒ nativeTop = 4
//   mesial: block x ∈ [4, 8], peak Pm = [7, 5, 5]   ⇒ hm = 3, um = −3
//   distal: block x ∈ [12, 16], peak Pd = [13, 5, 6] ⇒ hd = 4, ud = +3
//   md = +x (centroids differ along x only)
//   level = hm + (hd − hm)·(0 − um)/(ud − um) = 3 + 1·0.5 = 3.5
//   ⇒ scaleOG = 3.5 / 4 = 0.875; the placed top is at z = 2 + 3.5 = 5.5
// ---------------------------------------------------------------------------
const O: Vec3 = [10, 5, 2];
const PM: Vec3 = [7, 5, 5];
const PD: Vec3 = [13, 5, 6];
const BLOCK_VERTS = 8;

/** The datum; `floor` (default 0) is realised as a one-point intaglio at
 * `O + (floor − t)·og` with the occlusal minimum t = 0.5, so the kernel's
 * floor is `floor` (to the margin centroid's rounding). */
function datum(
  overrides: Partial<NeighbourOcclusalDatum> & { floor?: number } = {},
): NeighbourOcclusalDatum {
  const { floor = 0, ...rest } = overrides;
  return {
    mesial: { seedMm: PM, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
    distal: { seedMm: PD, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
    intaglioPositions: new Float64Array([O[0], O[1], O[2] + floor - 0.5]),
    occlusalMinWallThicknessMm: 0.5,
    ...rest,
  };
}

function input(overrides: Partial<AnatomyPlacementInput> = {}): AnatomyPlacementInput {
  return {
    canonicalFrame: IDENTITY_CANONICAL,
    libraryMesh: box([-1, -1, 0], [1, 1, 4]),
    marginLoop: marginCircle(O, 1.5),
    insertionAxis: [0, 0, 1],
    mesialNeighborPositions: neighbour(4, 8, PM),
    distalNeighborPositions: neighbour(12, 16, PD),
    antagonistPositions: null,
    neighbourOcclusalDatum: datum(),
    ...overrides,
  };
}

/** The placed library mesh's highest point above O along +Z. */
function placedTop(inp: AnatomyPlacementInput): number {
  const { frame } = solveAnatomyPlacement(inp);
  const placed = placeMesh(inp.libraryMesh, buildPlacementTransform(frame, inp.canonicalFrame));
  let top = -Infinity;
  for (let i = 2; i < placed.positions.length; i += 3) top = Math.max(top, placed.positions[i]!);
  return top - O[2];
}

describe("solveAnatomyPlacement — the neighbours' occlusal level (ADR-027 Decision 1)", () => {
  it('scales the crown so its top is at the interpolated level (closed form)', () => {
    const { frame, measurements } = solveAnatomyPlacement(input());
    // The 64-gon margin's centroid is O to rounding, hence toBeCloseTo.
    const d = measurements.occlusoGingivalDatum;
    expect(d).toMatchObject({ source: 'neighbours', occlusalReductionShortfallMm: 0 });
    expect(d.floorHeightMm!).toBeCloseTo(0, 12);
    expect(d.reason).toBeUndefined();
    expect(d.neighbourLevelMm!).toBeCloseTo(3.5, 12);
    expect(frame.scaleOcclusoGingival).toBeCloseTo(0.875, 12);
    expect(measurements.targetOcclusoGingivalHeightMm).toBeCloseTo(3.5, 12);
    expect(placedTop(input())).toBeCloseTo(3.5, 12);
    // The M-D scale is untouched by the datum.
    expect(frame.scaleMesialDistal).toBe(solveAnatomyPlacement(input({ neighbourOcclusalDatum: undefined })).frame.scaleMesialDistal);
  });

  it('clamps the interpolation when the site lies outside the peaks (level = the nearer peak)', () => {
    // Distal peak at u = −1 (x = 9): t = (0 − (−3)) / (−1 − (−3)) = 1.5 → 1 ⇒ level = hd = 4.
    const pd: Vec3 = [9, 5, 6];
    const inp = input({
      distalNeighborPositions: neighbour(12, 16, pd),
      neighbourOcclusalDatum: datum({ distal: { seedMm: pd, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 } }),
    });
    expect(solveAnatomyPlacement(inp).measurements.occlusoGingivalDatum.neighbourLevelMm).toBeCloseTo(4, 12);
    expect(placedTop(inp)).toBeCloseTo(4, 12);
  });

  it("ignores the capture's closure vertices (after realVertexCount)", () => {
    const high: Vec3 = [6, 5, 20];
    const inp = input({ mesialNeighborPositions: neighbour(4, 8, PM, [high]) });
    expect(solveAnatomyPlacement(inp).measurements.occlusoGingivalDatum.neighbourLevelMm).toBeCloseTo(3.5, 12);
  });

  it('a peak the window may have cut (beyond radius − band from the seed) falls back to the uniform scale', () => {
    // |Pm − seed| = 6 > 6.2 − 0.5 = 5.7 ⇒ truncated.
    const inp = input({
      neighbourOcclusalDatum: datum({ mesial: { seedMm: [7, 5, -1], radiusMm: 6.2, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 } }),
    });
    const { frame, measurements } = solveAnatomyPlacement(inp);
    expect(measurements.occlusoGingivalDatum).toMatchObject({
      source: 'uniform',
      reason: 'neighbourPeakTruncated',
      neighbourLevelMm: null,
      occlusalReductionShortfallMm: 0,
    });
    expect(frame.scaleOcclusoGingival).toBe(frame.scaleMesialDistal);
    expect(measurements.targetOcclusoGingivalHeightMm).toBeNull();
  });

  it('a level not above the origin falls back to the uniform scale', () => {
    const pm: Vec3 = [7, 5, 1.5];
    const pd: Vec3 = [13, 5, 1.8];
    const inp = input({
      mesialNeighborPositions: neighbourLow(4, 8, pm),
      distalNeighborPositions: neighbourLow(12, 16, pd),
      neighbourOcclusalDatum: datum({
        mesial: { seedMm: pm, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
        distal: { seedMm: pd, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
      }),
    });
    const m = solveAnatomyPlacement(inp).measurements.occlusoGingivalDatum;
    expect(m.source).toBe('uniform');
    expect(m.reason).toBe('levelNotAbove');
  });

  it('the antagonist takes precedence: the datum is ignored and the source is antagonist', () => {
    const inp = input({ antagonistPositions: box([9, 4.5, 8], [11, 5.5, 10]).positions });
    const { frame, measurements } = solveAnatomyPlacement(inp);
    expect(measurements.occlusoGingivalDatum.source).toBe('antagonist');
    expect(measurements.occlusoGingivalDatum.neighbourLevelMm).toBeNull();
    expect(frame.scaleOcclusoGingival).toBeCloseTo(6 / 4, 12);
  });

  it('an absent datum gives the pre-ADR-027 frame bit for bit (source uniform, no reason)', () => {
    const without = solveAnatomyPlacement(input({ neighbourOcclusalDatum: undefined }));
    expect(without.frame.scaleOcclusoGingival).toBe(without.frame.scaleMesialDistal);
    expect(without.measurements.occlusoGingivalDatum).toEqual({
      source: 'uniform',
      neighbourLevelMm: null,
      floorHeightMm: null,
      occlusalReductionShortfallMm: 0,
    });
  });

  it('rejects an invalid datum', () => {
    const bad = (d: Partial<NeighbourOcclusalDatum>) => () => solveAnatomyPlacement(input({ neighbourOcclusalDatum: datum(d) }));
    const w = { seedMm: PM, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 };
    expect(bad({ mesial: { ...w, radiusMm: 0 } })).toThrow(RangeError);
    expect(bad({ mesial: { ...w, windowBoundaryBandMm: -0.1 } })).toThrow(RangeError);
    expect(bad({ mesial: { ...w, realVertexCount: 0 } })).toThrow(RangeError);
    expect(bad({ mesial: { ...w, realVertexCount: 10 } })).toThrow(RangeError); // 9 vertices
    expect(bad({ mesial: { ...w, realVertexCount: 2.5 } })).toThrow(RangeError);
    expect(bad({ mesial: { ...w, seedMm: [Number.NaN, 0, 0] } })).toThrow(RangeError);
    expect(bad({ occlusalMinWallThicknessMm: -0.1 })).toThrow(RangeError);
    expect(bad({ occlusalMinWallThicknessMm: Number.NaN })).toThrow(RangeError);
    expect(bad({ intaglioPositions: new Float64Array(0) })).toThrow(RangeError);
    expect(bad({ intaglioPositions: new Float64Array([1, 2]) })).toThrow(RangeError);
    expect(bad({ intaglioPositions: new Float64Array([1, 2, Number.POSITIVE_INFINITY]) })).toThrow(RangeError);
  });
});

/** Like `neighbour`, with the block below the origin (z ∈ [0, 1]). */
function neighbourLow(x0: number, x1: number, peak: Vec3): Float64Array {
  const block = box([x0, 4, 0], [x1, 6, 1]).positions;
  const out = new Float64Array(block.length + 3);
  out.set(block, 0);
  out.set(peak, block.length);
  return out;
}

describe('solveAnatomyPlacement — the intaglio floor (ADR-027 Decision 2)', () => {
  it('lifts the top to the floor when the floor is above the level, and reports the shortfall exactly', () => {
    const inp = input({ neighbourOcclusalDatum: datum({ floor: 4.5 }) });
    const { frame, measurements } = solveAnatomyPlacement(inp);
    const d = measurements.occlusoGingivalDatum;
    expect(d.source).toBe('neighbours');
    expect(d.floorHeightMm!).toBeCloseTo(4.5, 12);
    expect(d.neighbourLevelMm!).toBeCloseTo(3.5, 12);
    expect(d.occlusalReductionShortfallMm).toBeCloseTo(1, 12);
    expect(d.occlusalReductionShortfallMm).toBe(d.floorHeightMm! - d.neighbourLevelMm!);
    expect(frame.scaleOcclusoGingival).toBeCloseTo(4.5 / 4, 12);
    // The floor is the intaglio's highest point above O plus the occlusal minimum.
    expect(placedTop(inp)).toBeCloseTo(4.5, 12);
  });

  it('the floor covers every intaglio point along the axis, not only the apex (a pyramid library)', () => {
    // Library: a square pyramid, base [-1, 1]² at z = 0, apex (0, 0, 4). Its
    // top surface over canonical (x, y) is 4·(1 − max(|x|, |y|)).
    // scaleMD = scaleBL = proximal gap / native width: the blocks' facing
    // faces are at x = 8 and x = 12, so the gap is 4 and the native width 2,
    // so scale 2. An intaglio point at O + (1, 0, h): canonical x = 0.5, so the
    // unit-scale surface height there is 2.
    // Floor: s = (h + t) / 2 with h = 3, t = 0.5, so s = 1.75 and the top is
    // s·4 = 7.0, not the apex-only (h + t) = 3.5.
    const pyramid: IndexedMesh = {
      positions: new Float64Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 4]),
      indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
    };
    const inp = input({
      libraryMesh: pyramid,
      neighbourOcclusalDatum: { ...datum(), intaglioPositions: new Float64Array([O[0] + 1, O[1], O[2] + 3]) },
    });
    const d = solveAnatomyPlacement(inp).measurements.occlusoGingivalDatum;
    expect(d.floorHeightMm!).toBeCloseTo(7, 9);
    expect(d.occlusalReductionShortfallMm).toBeCloseTo(7 - 3.5, 9);
    expect(placedTop(inp)).toBeCloseTo(7, 9);
    // An intaglio point outside the library's footprint constrains nothing.
    const outside = input({
      libraryMesh: pyramid,
      neighbourOcclusalDatum: { ...datum(), intaglioPositions: new Float64Array([O[0] + 5, O[1], O[2] + 3]) },
    });
    expect(solveAnatomyPlacement(outside).measurements.occlusoGingivalDatum.occlusalReductionShortfallMm).toBe(0);
  });

  it('a floor below the level leaves the level and a zero shortfall', () => {
    const m = solveAnatomyPlacement(input({ neighbourOcclusalDatum: datum({ floor: 2 }) })).measurements.occlusoGingivalDatum;
    expect(m.occlusalReductionShortfallMm).toBe(0);
    expect(m.floorHeightMm!).toBeCloseTo(2, 12);
    expect(placedTop(input({ neighbourOcclusalDatum: datum({ floor: 2 }) }))).toBeCloseTo(3.5, 12);
  });

  it('property: the top is at max(level, floor), the shortfall is max(0, floor − level)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 8, noNaN: true }),
        fc.double({ min: 0.5, max: 8, noNaN: true }),
        fc.double({ min: -8, max: -1, noNaN: true }),
        fc.double({ min: 1, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 9, noNaN: true }),
        (hm, hd, um, ud, floor) => {
          const pm: Vec3 = [O[0] + um, 5, O[2] + hm];
          const pd: Vec3 = [O[0] + ud, 5, O[2] + hd];
          const inp = input({
            mesialNeighborPositions: neighbour(O[0] + um - 1, O[0] + um + 1, pm),
            distalNeighborPositions: neighbour(O[0] + ud - 1, O[0] + ud + 1, pd),
            neighbourOcclusalDatum: datum({
              mesial: { seedMm: pm, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
              distal: { seedMm: pd, radiusMm: 6, windowBoundaryBandMm: 0.5, realVertexCount: BLOCK_VERTS + 1 },
              floor,
            }),
          });
          const level = hm + ((hd - hm) * (0 - um)) / (ud - um);
          const m = solveAnatomyPlacement(inp).measurements.occlusoGingivalDatum;
          expect(m.source).toBe('neighbours');
          expect(m.neighbourLevelMm!).toBeCloseTo(level, 9);
          expect(m.occlusalReductionShortfallMm).toBeCloseTo(Math.max(0, floor - level), 9);
          expect(m.occlusalReductionShortfallMm >= 0).toBe(true);
          expect(m.occlusalReductionShortfallMm === 0).toBe(level >= floor);
          expect(Math.abs(placedTop(inp) - Math.max(level, floor))).toBeLessThanOrEqual(1e-9);
        },
      ),
      { numRuns: 200, seed: 1427 },
    );
  });
});
