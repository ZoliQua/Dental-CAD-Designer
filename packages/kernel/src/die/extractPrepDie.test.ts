// packages/kernel/src/die/extractPrepDie.test.ts
//
// Phase 10 Task 1 (ADR-023 Decision 1) — the closed prep die extracted from
// an open scan. Tests first, on the closed-form open-arch prep case
// (die.test-fixtures.ts): which rings are kept, the die volume and the
// clearance certificate are known in closed form.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { findSelfIntersections } from '../intersect/selfIntersect.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { ARCH_DIES, archPrepDie } from '../bridge/archBridge.test-fixtures.ts';
import { dieVolumeAnalytic, openArchPrepCase } from './die.test-fixtures.ts';
import {
  extractPrepDie,
  PREP_DIE_DEFAULT_DEPTH_SKIRT_MM,
  PREP_DIE_DEFAULT_FLOOR_GAP_MM,
  PREP_DIE_DEFAULT_PROTECT_BAND_MM,
  PREP_DIE_DEFAULT_RADIAL_SKIRT_MM,
  PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM,
  PrepDieClearanceError,
  PrepDieRegionError,
} from './extractPrepDie.ts';

const fixture = openArchPrepCase();
const n = fixture.params.segments;
const MARGIN_Z = fixture.params.marginZMm;

/** The profile rings the default skirts keep (ρ within the radial skirt of
 * the margin ring and z above the depth floor) — the rim is the last one. */
function keptProfile(radialSkirt: number, depthSkirt: number): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const ring of fixture.profile) {
    const [r, z] = ring;
    if (r - fixture.params.marginRadiusMm > radialSkirt || z < MARGIN_Z - depthSkirt) break;
    out.push(ring);
  }
  return out;
}

function rigid(p: Vec3, angle: number, t: Vec3): Vec3 {
  // Rotation about the (1, 1, 1)/√3 axis by `angle`, then translation.
  const k = 1 / Math.sqrt(3);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = k * (p[0] + p[1] + p[2]);
  const cross: Vec3 = [k * (p[2] - p[1]), k * (p[0] - p[2]), k * (p[1] - p[0])];
  return [
    p[0] * c + cross[0] * s + k * dot * (1 - c) + t[0],
    p[1] * c + cross[1] * s + k * dot * (1 - c) + t[1],
    p[2] * c + cross[2] * s + k * dot * (1 - c) + t[2],
  ];
}

function rigidMesh(mesh: IndexedMesh, angle: number, t: Vec3): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let v = 0; v < positions.length / 3; v++) {
    const q = rigid([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!], angle, t);
    positions.set(q, v * 3);
  }
  return { positions, indices: mesh.indices.slice() };
}

describe('extractPrepDie — the closed-form open-arch prep case', () => {
  const result = extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis);
  const kept = keptProfile(PREP_DIE_DEFAULT_RADIAL_SKIRT_MM, PREP_DIE_DEFAULT_DEPTH_SKIRT_MM);
  const [rimR, rimZ] = kept[kept.length - 1]!;

  it('the fixture is an open scan with a single boundary loop (its base cut)', () => {
    const stats = analyzeMesh(fixture.scan);
    expect(stats.watertight).toBe(false);
    expect(stats.boundaryEdgeCount).toBe(n);
  });

  it('keeps exactly the die rings inside the skirts — never the gingiva beyond, never the neighbours', () => {
    expect(kept.length).toBeGreaterThan(10);
    expect(rimR).toBeCloseTo(4.4, 12);
    expect(rimZ).toBeCloseTo(0.75, 12);
    // Apex fan + two triangles per segment per band.
    expect(result.keptTriangleCount).toBe(n + (kept.length - 2) * 2 * n);
    for (let v = 0; v < result.mesh.positions.length / 3; v++) {
      const rho = Math.hypot(result.mesh.positions[v * 3]!, result.mesh.positions[v * 3 + 1]!);
      expect(rho).toBeLessThanOrEqual(rimR + 1e-12);
    }
  });

  it('copies the kept scan triangles verbatim (bit-identical vertices, source indices ascending)', () => {
    const src = result.sourceTriangleIndices;
    expect(src.length).toBe(result.keptTriangleCount);
    for (let i = 1; i < src.length; i++) expect(src[i]!).toBeGreaterThan(src[i - 1]!);
    for (let t = 0; t < result.keptTriangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const a = result.mesh.indices[t * 3 + k]!;
        const b = fixture.scan.indices[src[t]! * 3 + k]!;
        for (let c = 0; c < 3; c++) {
          expect(result.mesh.positions[a * 3 + c]).toBe(fixture.scan.positions[b * 3 + c]);
        }
      }
    }
  });

  it('closes into a valid solid: walls on every rim edge and a planar floor cap', () => {
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    let pairs = 0;
    findSelfIntersections(result.mesh, { onIntersectingPair: () => void pairs++ });
    expect(pairs).toBe(0);
    expect(result.rimVertexCount).toBe(n);
    // 2 wall triangles per rim edge + an (n − 2)-triangle floor.
    expect(result.syntheticTriangleCount).toBe(2 * n + (n - 2));
    expect(result.mesh.indices.length / 3).toBe(result.keptTriangleCount + result.syntheticTriangleCount);
  });

  it('puts the floor `floorGapMm` below the lowest kept vertex, and its volume equals the closed form', () => {
    const floorZ = rimZ - PREP_DIE_DEFAULT_FLOOR_GAP_MM;
    expect(result.floorHeightMm).toBeCloseTo(floorZ, 12);
    const expected = dieVolumeAnalytic(fixture.profile, n, rimR, floorZ);
    expect(result.volumeMm3).toBeCloseTo(expected, 9);
    expect(analyzeMesh(result.mesh).signedVolumeMm3!).toBeCloseTo(expected, 9);
  });

  it('certifies the clearance of the synthetic closure from the protected prism, exactly', () => {
    // Walls: the rim edge's 2-D distance to the margin polygon minus the
    // protect band, and the height of the wall top below the lowest margin
    // point; the floor: its depth below the lowest margin point.
    const lateral = (rimR - fixture.params.marginRadiusMm) * Math.cos(Math.PI / n) - PREP_DIE_DEFAULT_PROTECT_BAND_MM;
    const wall = Math.hypot(lateral, MARGIN_Z - rimZ);
    const floor = MARGIN_Z - (rimZ - PREP_DIE_DEFAULT_FLOOR_GAP_MM);
    expect(result.clearanceMm).toBeCloseTo(Math.min(wall, floor), 9);
    expect(result.marginMinHeightMm).toBeCloseTo(MARGIN_Z, 12);
    expect(result.radialSkirtMm).toBe(PREP_DIE_DEFAULT_RADIAL_SKIRT_MM);
    expect(result.depthSkirtMm).toBe(PREP_DIE_DEFAULT_DEPTH_SKIRT_MM);
    expect(result.protectBandMm).toBe(PREP_DIE_DEFAULT_PROTECT_BAND_MM);
    expect(result.floorGapMm).toBe(PREP_DIE_DEFAULT_FLOOR_GAP_MM);
  });

  it('is deterministic: two runs are byte-identical', () => {
    const again = extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis);
    expect(Array.from(again.mesh.positions)).toEqual(Array.from(result.mesh.positions));
    expect(Array.from(again.mesh.indices)).toEqual(Array.from(result.mesh.indices));
    expect(again.clearanceMm).toBe(result.clearanceMm);
  });

  it('is equivariant under rigid motion (same triangles kept, same volume and certificate)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.tuple(
          fc.double({ min: -50, max: 50, noNaN: true }),
          fc.double({ min: -50, max: 50, noNaN: true }),
          fc.double({ min: -50, max: 50, noNaN: true }),
        ),
        (angle, t) => {
          const moved = extractPrepDie(
            rigidMesh(fixture.scan, angle, t),
            fixture.marginLoop.map((p) => rigid(p, angle, t)),
            rigid(fixture.insertionAxis, angle, [0, 0, 0]),
          );
          expect(Array.from(moved.sourceTriangleIndices)).toEqual(Array.from(result.sourceTriangleIndices));
          expect(moved.volumeMm3).toBeCloseTo(result.volumeMm3, 6);
          expect(moved.clearanceMm).toBeCloseTo(result.clearanceMm, 9);
        },
      ),
      { numRuns: 6, seed: 1010 },
    );
  });

  it('the certificate never shrinks as the skirts grow', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.25, max: 1.6, noNaN: true }),
        fc.double({ min: 0.05, max: 0.3, noNaN: true }),
        fc.double({ min: 0.8, max: 1.3, noNaN: true }),
        (radial, extra, depth) => {
          const a = extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis, {
            radialSkirtMm: radial,
            depthSkirtMm: depth,
            requiredClearanceMm: 0,
          });
          const b = extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis, {
            radialSkirtMm: radial + extra,
            depthSkirtMm: depth,
            requiredClearanceMm: 0,
          });
          expect(b.clearanceMm).toBeGreaterThanOrEqual(a.clearanceMm - 1e-12);
        },
      ),
      { numRuns: 8, seed: 2020 },
    );
  });
});

describe('extractPrepDie — a rim that folds in projection is repaired, not refused', () => {
  it('drops the folded rim triangles, closes a valid die and certifies it (arch-case-01 tooth 12 regression)', () => {
    // Move one rim vertex tangentially past its neighbour (angle s → s + 1.5
    // steps): the rim edges into and out of it now cross the next rim edge in
    // projection, the shape a real scan's undercut gives at the cut.
    const rimK = fixture.profile.findIndex(([r]) => Math.abs(r - 4.4) < 1e-9);
    const s = 17;
    const v = 1 + (rimK - 1) * n + s;
    const positions = fixture.scan.positions.slice();
    const th = (2 * Math.PI * (s + 1.5)) / n;
    positions[v * 3] = 4.4 * Math.cos(th);
    positions[v * 3 + 1] = 4.4 * Math.sin(th);
    const folded: IndexedMesh = { positions, indices: fixture.scan.indices.slice() };

    const result = extractPrepDie(folded, fixture.marginLoop, fixture.insertionAxis);
    expect(result.foldTrianglesDropped).toBeGreaterThan(0);
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    let pairs = 0;
    findSelfIntersections(result.mesh, { onIntersectingPair: () => void pairs++ });
    expect(pairs).toBe(0);
    // The moved vertex is no longer part of the die.
    for (const t of result.sourceTriangleIndices) {
      for (let k = 0; k < 3; k++) expect(folded.indices[t * 3 + k]).not.toBe(v);
    }
    expect(result.clearanceMm).toBeGreaterThanOrEqual(PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM);
  });
});

describe('extractPrepDie — fails closed', () => {
  it('refuses when the synthetic closure would reach the protected prism (the scan ends at the margin)', () => {
    const short = openArchPrepCase({ outerMm: 3.4, neighbours: null });
    let error: unknown;
    try {
      extractPrepDie(short.scan, short.marginLoop, short.insertionAxis);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PrepDieClearanceError);
    expect((error as PrepDieClearanceError).clearanceMm).toBe(0);
  });

  it('refuses a required clearance the scan cannot give, naming the measured value', () => {
    let error: unknown;
    try {
      extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis, { requiredClearanceMm: 2 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PrepDieClearanceError);
    expect((error as PrepDieClearanceError).clearanceMm).toBeGreaterThan(1);
    expect((error as PrepDieClearanceError).requiredMm).toBe(2);
  });

  it('refuses a margin that does not lie on the kept scan surface', () => {
    const lifted = fixture.marginLoop.map((p): Vec3 => [p[0], p[1], p[2] + 2]);
    expect(() => extractPrepDie(fixture.scan, lifted, fixture.insertionAxis)).toThrow(PrepDieRegionError);
  });

  it('refuses a kept surface with a hole (two rim loops), and a margin far from any scan surface', () => {
    // Drop one shoulder triangle: the kept surface gains an inner boundary.
    const shoulderK = fixture.profile.findIndex(([r]) => Math.abs(r - 4.2) < 1e-9);
    const drop = n + (shoulderK - 2) * 2 * n + 2 * 5;
    const indices = Uint32Array.from(
      Array.from(fixture.scan.indices).filter((_, i) => Math.floor(i / 3) !== drop),
    );
    let error: unknown;
    try {
      extractPrepDie({ positions: fixture.scan.positions, indices }, fixture.marginLoop, fixture.insertionAxis);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PrepDieRegionError);
    expect((error as PrepDieRegionError).reason).toBe('rim-loops');

    const far = fixture.marginLoop.map((p): Vec3 => [p[0] + 100, p[1], p[2]]);
    let emptyError: unknown;
    try {
      extractPrepDie(fixture.scan, far, fixture.insertionAxis);
    } catch (e) {
      emptyError = e;
    }
    expect(emptyError).toBeInstanceOf(PrepDieRegionError);
    expect((emptyError as PrepDieRegionError).reason).toBe('empty');
  });

  it('rejects invalid parameters', () => {
    expect(() => extractPrepDie(fixture.scan, fixture.marginLoop.slice(0, 2), fixture.insertionAxis)).toThrow(RangeError);
    expect(() => extractPrepDie(fixture.scan, fixture.marginLoop, [0, 0, 0])).toThrow(RangeError);
    expect(() =>
      extractPrepDie(fixture.scan, fixture.marginLoop, fixture.insertionAxis, { radialSkirtMm: 0 }),
    ).toThrow(RangeError);
  });
});

describe('extractPrepDie — an already closed single die goes through the same op', () => {
  it('keeps the die above the depth floor and certifies the shoulder-edge rim', () => {
    const p = ARCH_DIES[0]!;
    const die = archPrepDie(p);
    const result = extractPrepDie(die.die, die.marginLoop, [0, 0, 1]);
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
    // The rim is the shoulder's outer edge at the margin height: the walls
    // clear the prism laterally only, the floor by the floor gap.
    const segments = die.marginLoop.length;
    const lateral = p.shoulderMm * Math.cos(Math.PI / segments) - PREP_DIE_DEFAULT_PROTECT_BAND_MM;
    expect(result.clearanceMm).toBeCloseTo(Math.min(lateral, PREP_DIE_DEFAULT_FLOOR_GAP_MM), 9);
  });
});
