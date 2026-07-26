// packages/kernel/src/cavity/regions.test.ts
//
// Phase 5 Task 2, deliverables 2 + 3: the cavity region-analysis kernel op
// (`classifyCavityRegions`) tested against the MOD-cavity fixture's
// CLOSED-FORM expected classification, and the insertion-axis suitability
// scan (`scanCavityUndercut`) proven BOTH ways (zero on the drafted fixture
// AND detected, with an exact expected count, on a negative-taper variant —
// the P4-T4 falsifiability lesson).
//
// ## The closed-form expected answer (derived from the fixture construction)
//
// With m = mdSegmentsPerZone, the cavity surface tessellates as:
//   - isthmus zone: m segments x (2 wall quads + 1 floor quad) = 4m wall +
//     2m floor triangles (floor at z = floorZ exactly);
//   - each proximal box: m segments x (4 wall quads + 1 floor quad) = 8m
//     wall + 2m floor triangles (floor at z = gingivalFloorZ exactly);
//   - each pulpal step wall: 1 transverse quad = 2 triangles (all vertices
//     at |x| = isthmusHalfLenMm exactly, normal perpendicular to +Z).
// Totals: cavity = 26m + 4; floor = 6m; axial walls = 4m; box walls =
// 16m + 4 (8m drafted + 2 pulpal per box, x2 boxes); boxes = 2 with
// proximal directions ~ -X (mesial) and +X (distal).
//
// Every triangle's expected label is ALSO independently derivable from the
// analytic loci (used for the zero-misclassification assertion):
//   - isthmus floor: all 3 vertices z === floorZ (bitwise — constructed);
//   - box floor: all 3 vertices z === gingivalFloorZ;
//   - pulpal wall: all 3 vertices |x| === isthmusHalfLenMm;
//   - drafted wall: every vertex on |y| = isthmusHalfWidth - (tableZ-z)*tan
//     (within 1e-9 float tolerance — the test recomputes the plane);
//   - box zone: |centroid.x| >= isthmusHalfLenMm - 1e-9, else axial.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { analyzeMesh } from '../intake/analyze.ts';
import { buildBvh } from '../bvh/index.ts';
import type { AxisRegion } from '../axis/roi.ts';
import {
  classifyCavityRegions,
  scanCavityUndercut,
  proximalDirectionUnit,
  CavityOutlineNotOnMeshError,
  CavityOutlineNotEdgeConnectedError,
  CavityPartitionError,
  AmbiguousCavitySideError,
  CAVITY_FLOOR_MAX_ANGLE_DEG,
  CAVITY_FLOOR_STEP_MIN_MM,
  type CavityRegionsResult,
} from './regions.ts';
import { modCavityMesh, type ModCavityMesh, type ModCavityMeshOptions } from './cavity.test-fixtures.ts';

type Vec3 = readonly [number, number, number];

const AXIS_Z: Vec3 = [0, 0, 1];

// ---------------------------------------------------------------------------
// Independent closed-form labeler (test-side; never calls the op's own code)
// ---------------------------------------------------------------------------

type ExpectedLabel = 'isthmusFloor' | 'boxFloor' | 'pulpalWall' | 'axialDraftedWall' | 'boxDraftedWall';

function triangleVerts(f: ModCavityMesh, t: number): [Vec3, Vec3, Vec3] {
  const { positions, indices } = f.mesh;
  const v = (i: number): Vec3 => [positions[indices[t * 3 + i]! * 3]!, positions[indices[t * 3 + i]! * 3 + 1]!, positions[indices[t * 3 + i]! * 3 + 2]!];
  return [v(0), v(1), v(2)];
}

/** The test's OWN closed-form label for a cavity triangle — derived purely
 * from the fixture's analytic loci (module doc above). Throws if a triangle
 * matches no locus (i.e. the op returned a non-cavity triangle). */
function expectedLabel(f: ModCavityMesh, t: number): ExpectedLabel {
  const verts = triangleVerts(f, t);
  const tan = Math.tan(f.taperRad);
  if (verts.every(([, , z]) => z === f.floorZ)) return 'isthmusFloor';
  if (verts.every(([, , z]) => z === f.gingivalFloorZ)) return 'boxFloor';
  if (verts.every(([x]) => Math.abs(x) === f.isthmusHalfLenMm)) return 'pulpalWall';
  const onDraftedPlane = verts.every(([, y, z]) => Math.abs(Math.abs(y) - (f.isthmusHalfWidthMm - (f.tableZ - z) * tan)) <= 1e-9);
  if (onDraftedPlane) {
    const cx = (verts[0][0] + verts[1][0] + verts[2][0]) / 3;
    return Math.abs(cx) >= f.isthmusHalfLenMm - 1e-9 ? 'boxDraftedWall' : 'axialDraftedWall';
  }
  throw new Error(`triangle ${t} matches no cavity locus — misclassified (an outer triangle leaked into the cavity region?)`);
}

function toSet(region: AxisRegion): Set<number> {
  return new Set(region.triangleIndices);
}

function assertSortedUnique(region: AxisRegion): void {
  for (let i = 1; i < region.triangleIndices.length; i++) {
    expect(region.triangleIndices[i]!).toBeGreaterThan(region.triangleIndices[i - 1]!);
  }
}

/** Full closed-form acceptance for one fixture build: counts + per-triangle
 * zero-misclassification + partition/sortedness + box structure. */
function assertClosedFormClassification(f: ModCavityMesh, m: number, res: CavityRegionsResult): void {
  // --- counts (closed form) ---
  expect(res.cavity.triangleIndices.length).toBe(26 * m + 4);
  expect(res.floor.triangleIndices.length).toBe(6 * m);
  expect(res.walls.triangleIndices.length).toBe(20 * m + 4);
  expect(res.axialWalls.triangleIndices.length).toBe(4 * m);
  expect(res.boxWalls.triangleIndices.length).toBe(16 * m + 4);
  expect(res.boxes.length).toBe(2);
  for (const box of res.boxes) {
    expect(box.floor.triangleIndices.length).toBe(2 * m);
    expect(box.walls.triangleIndices.length).toBe(8 * m + 2);
    expect(box.region.triangleIndices.length).toBe(10 * m + 2);
  }

  // --- sortedness (AxisRegion currency contract) ---
  for (const r of [res.cavity, res.floor, res.walls, res.axialWalls, res.boxWalls]) assertSortedUnique(r);
  for (const box of res.boxes) for (const r of [box.floor, box.walls, box.region]) assertSortedUnique(r);

  // --- partition: floor ∪ walls = cavity, disjoint; axial ∪ box = walls ---
  const floorSet = toSet(res.floor);
  const wallSet = toSet(res.walls);
  const axialSet = toSet(res.axialWalls);
  const boxWallSet = toSet(res.boxWalls);
  expect(floorSet.size + wallSet.size).toBe(res.cavity.triangleIndices.length);
  expect(axialSet.size + boxWallSet.size).toBe(wallSet.size);
  for (const t of res.cavity.triangleIndices) {
    expect(floorSet.has(t) !== wallSet.has(t)).toBe(true); // exactly one
  }
  for (const t of wallSet) expect(axialSet.has(t) !== boxWallSet.has(t)).toBe(true);

  // --- ZERO misclassification: op label === independent closed-form label ---
  const boxFloorSet = new Set<number>();
  for (const box of res.boxes) for (const t of box.floor.triangleIndices) boxFloorSet.add(t);
  for (const t of res.cavity.triangleIndices) {
    const label = expectedLabel(f, t); // throws if t is not on any cavity locus
    switch (label) {
      case 'isthmusFloor':
        expect(floorSet.has(t)).toBe(true);
        expect(boxFloorSet.has(t)).toBe(false);
        break;
      case 'boxFloor':
        expect(floorSet.has(t)).toBe(true);
        expect(boxFloorSet.has(t)).toBe(true);
        break;
      case 'pulpalWall':
      case 'boxDraftedWall':
        expect(boxWallSet.has(t)).toBe(true);
        break;
      case 'axialDraftedWall':
        expect(axialSet.has(t)).toBe(true);
        break;
    }
  }

  // --- box structure: one mesial (-X), one distal (+X); exact floor levels ---
  const mesial = res.boxes.find((b) => b.proximalDirectionUnit[0] < 0);
  const distal = res.boxes.find((b) => b.proximalDirectionUnit[0] > 0);
  expect(mesial).toBeDefined();
  expect(distal).toBeDefined();
  for (const box of res.boxes) {
    expect(Math.abs(Math.abs(box.proximalDirectionUnit[0]) - 1)).toBeLessThan(1e-9); // ~ +/-X
    expect(Math.abs(box.proximalDirectionUnit[2])).toBeLessThan(1e-9); // axis-perpendicular
    expect(box.floorLevelMm).toBeCloseTo(f.gingivalFloorZ, 9);
  }
  expect(res.floorReferenceLevelMm).not.toBeNull();
  expect(res.floorReferenceLevelMm!).toBeCloseTo(f.floorZ, 9);

  // --- documented algorithm params echoed (journaling currency) ---
  expect(res.floorMaxAngleDeg).toBe(CAVITY_FLOOR_MAX_ANGLE_DEG);
  expect(res.floorStepMinMm).toBe(CAVITY_FLOOR_STEP_MIN_MM);
}

// ---------------------------------------------------------------------------
// Classification — closed form
// ---------------------------------------------------------------------------

describe('classifyCavityRegions — closed-form exact on the default fixture', () => {
  it('matches the fixture closed-form answer exactly (counts + zero misclassified triangles)', () => {
    const f = modCavityMesh();
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    assertClosedFormClassification(f, 6, res);
  });

  it('normalizes the insertion axis (a non-unit axis gives the identical result)', () => {
    const f = modCavityMesh();
    const a = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const b = classifyCavityRegions(f.mesh, f.cavityOutline, [0, 0, 2.5]);
    expect(b.axisUnit).toEqual([0, 0, 1]);
    expect(b.cavity.triangleIndices).toEqual(a.cavity.triangleIndices);
    expect(b.floor.triangleIndices).toEqual(a.floor.triangleIndices);
  });

  it('the onlay (reduced-cusp) variant classifies identically (cusp knob never touches the cavity)', () => {
    const inlay = modCavityMesh();
    const onlay = modCavityMesh({ reducedCusp: true });
    const res = classifyCavityRegions(onlay.mesh, onlay.cavityOutline, AXIS_Z);
    assertClosedFormClassification(onlay, 6, res);
    const inlayRes = classifyCavityRegions(inlay.mesh, inlay.cavityOutline, AXIS_Z);
    expect(res.cavity.triangleIndices.length).toBe(inlayRes.cavity.triangleIndices.length);
  });

  it('classifies a NEGATIVE-taper (undercut-walled) cavity by the same closed form', () => {
    // Classification is a facing/zone question, not a draft question — an
    // undercut wall is still a wall. (The undercut SCAN below is what
    // detects the draft problem.)
    const f = modCavityMesh({ taperDeg: -1 });
    expect(analyzeMesh(f.mesh).watertight).toBe(true); // fixture supports negative taper natively
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    assertClosedFormClassification(f, 6, res);
  });
});

describe('classifyCavityRegions — property-varied parameters (fc)', () => {
  const arb = fc
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
      const tan = Math.tan((o.taperDeg * Math.PI) / 180);
      return (
        // step must exceed the default floorStepMinMm (0.5) with margin, plus
        // the fixture's own documented validity invariants (Task 1 style).
        o.boxDepthMm > o.isthmusDepthMm + 0.7 &&
        2 * o.boxLengthMm < o.lengthMm - 1 &&
        o.isthmusWidthMm < o.widthMm - 1 &&
        o.isthmusWidthMm / 2 - o.boxDepthMm * tan > 0.2
      );
    });

  it('stays closed-form exact across the parameter space', () => {
    fc.assert(
      fc.property(arb, (o: ModCavityMeshOptions) => {
        const f = modCavityMesh(o);
        const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
        assertClosedFormClassification(f, o.mdSegmentsPerZone!, res);
      }),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism (byte-identical + committed-hash pin — the 0.9.0+ pure-TS-op
// precedent: regression-pinned by its own committed-hash test, no
// kernel-ops.json entry)
// ---------------------------------------------------------------------------

describe('classifyCavityRegions — determinism', () => {
  function hashResult(res: CavityRegionsResult): string {
    const h = createHash('sha256');
    for (const r of [res.cavity, res.floor, res.walls, res.axialWalls, res.boxWalls]) {
      h.update(Buffer.from(r.triangleIndices.buffer, r.triangleIndices.byteOffset, r.triangleIndices.byteLength));
    }
    for (const box of res.boxes) {
      for (const r of [box.floor, box.walls, box.region]) {
        h.update(Buffer.from(r.triangleIndices.buffer, r.triangleIndices.byteOffset, r.triangleIndices.byteLength));
      }
      const dir = new Float64Array([...box.proximalDirectionUnit, box.floorLevelMm]);
      h.update(Buffer.from(dir.buffer));
    }
    return h.digest('hex');
  }

  it('two runs are byte-identical', () => {
    const f = modCavityMesh();
    const a = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const b = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    expect(hashResult(a)).toBe(hashResult(b));
  });

  it('matches the committed regression hash (default fixture, +Z axis)', () => {
    // Committed-hash pin (the 0.9.0-0.15.0 pure-Float64-op precedent, in
    // lieu of a kernel-ops.json entry — see docs/CHANGELOG-kernel.md
    // [0.16.0]). A change here without a KERNEL_VERSION bump + changelog
    // entry is a regression, not a refresh opportunity.
    const f = modCavityMesh();
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    expect(hashResult(res)).toBe('46a5b5edec2f8677f97b6805b29d774bd1a1ba817ecd4a0c94327cc05fae9527');
  });
});

// ---------------------------------------------------------------------------
// Error handling / documented edge behavior
// ---------------------------------------------------------------------------

describe('classifyCavityRegions — validation and documented edge behavior', () => {
  it('throws TypeError for a zero-length axis', () => {
    const f = modCavityMesh();
    expect(() => classifyCavityRegions(f.mesh, f.cavityOutline, [0, 0, 0])).toThrow(TypeError);
  });

  it('throws for a too-short outline (margin machinery floor, reused)', () => {
    const f = modCavityMesh();
    expect(() => classifyCavityRegions(f.mesh, f.cavityOutline.slice(0, 2), AXIS_Z)).toThrow(/point/i);
  });

  it('throws CavityOutlineNotOnMeshError for an outline point off the mesh', () => {
    const f = modCavityMesh();
    const bad = f.cavityOutline.map((p, i) => (i === 4 ? ([p[0], p[1], p[2] + 1] as Vec3) : (p as Vec3)));
    expect(() => classifyCavityRegions(f.mesh, bad, AXIS_Z)).toThrow(CavityOutlineNotOnMeshError);
  });

  it('accepts a sub-weld-epsilon perturbed outline point (nearest-vertex snap fallback) with an identical result', () => {
    const f = modCavityMesh();
    const nudged = f.cavityOutline.map((p, i) => (i === 4 ? ([p[0], p[1], p[2] + 5e-7] as Vec3) : (p as Vec3)));
    const a = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const b = classifyCavityRegions(f.mesh, nudged, AXIS_Z);
    expect(b.cavity.triangleIndices).toEqual(a.cavity.triangleIndices);
    expect(b.boxWalls.triangleIndices).toEqual(a.boxWalls.triangleIndices);
  });

  it('throws CavityOutlineNotEdgeConnectedError when consecutive outline points are not mesh-edge neighbors', () => {
    const f = modCavityMesh();
    const sparse = f.cavityOutline.filter((_, i) => i % 2 === 0); // skip every other point
    expect(() => classifyCavityRegions(f.mesh, sparse, AXIS_Z)).toThrow(CavityOutlineNotEdgeConnectedError);
  });

  it('throws AmbiguousCavitySideError for an axis perpendicular to the opening (no side opens along it)', () => {
    const f = modCavityMesh();
    expect(() => classifyCavityRegions(f.mesh, f.cavityOutline, [1, 0, 0])).toThrow(AmbiguousCavitySideError);
  });

  it('a tilted axis + tight floor angle yields an all-wall cavity (empty floor, no boxes, null reference)', () => {
    // axis 45 degrees in XZ: floors sit at 45 degrees from it; with
    // floorMaxAngleDeg = 30 no triangle qualifies as floor.
    const f = modCavityMesh();
    const s = Math.SQRT1_2;
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, [s, 0, s], { floorMaxAngleDeg: 30 });
    expect(res.floor.triangleIndices.length).toBe(0);
    expect(res.walls.triangleIndices.length).toBe(res.cavity.triangleIndices.length);
    expect(res.boxes.length).toBe(0);
    expect(res.boxWalls.triangleIndices.length).toBe(0);
    expect(res.floorReferenceLevelMm).toBeNull();
  });

  it('a floorStepMinMm above the fixture step demotes the boxes to plain floor (no boxes)', () => {
    const f = modCavityMesh(); // step = 1.5mm
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z, { floorStepMinMm: 2.0 });
    expect(res.boxes.length).toBe(0);
    expect(res.boxWalls.triangleIndices.length).toBe(0);
    expect(res.axialWalls.triangleIndices.length).toBe(res.walls.triangleIndices.length);
    expect(res.floor.triangleIndices.length).toBe(6 * 6); // floor split unchanged
  });

  it('throws CavityPartitionError when the ring does not separate the mesh into two components', () => {
    // A single open triangle with its own boundary as the "ring": every
    // edge is a barrier but there is only ONE component — the documented
    // Jordan-violation guard (a leaking/degenerate outline or a
    // non-closed mesh).
    const mesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const ring: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(() => classifyCavityRegions(mesh, ring, AXIS_Z)).toThrow(CavityPartitionError);
  });

  it('a FLIPPED axis (-Z) selects the OPPOSITE side — the op trusts the caller\'s axis (documented behavior)', () => {
    // The "cavity" is DEFINED as the side that opens along the given axis;
    // along -Z that is the block's outer surface. The two selections
    // partition the mesh exactly.
    const f = modCavityMesh();
    const up = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const down = classifyCavityRegions(f.mesh, f.cavityOutline, [0, 0, -1]);
    const totalTris = f.mesh.indices.length / 3;
    expect(down.cavity.triangleIndices.length).toBe(totalTris - up.cavity.triangleIndices.length);
    const upSet = toSet(up.cavity);
    for (const t of down.cavity.triangleIndices) expect(upSet.has(t)).toBe(false);
  });

  it('proximalDirectionUnit returns null for a deep component with no horizontal offset (degenerate direction guard)', () => {
    // A deep floor component centered under the cavity centroid (a pulpal
    // extension, not a proximal box) has no well-defined proximal direction
    // — the guard demotes it from "box" rather than fabricating a direction.
    expect(proximalDirectionUnit([0, 0, 5], [0, 0, 2], AXIS_Z)).toBeNull();
    const dir = proximalDirectionUnit([0, 0, 5], [3, 0, 2], AXIS_Z);
    expect(dir).not.toBeNull();
    expect(dir![0]).toBeCloseTo(1, 12);
    expect(dir![2]).toBeCloseTo(0, 12);
  });
});

// ---------------------------------------------------------------------------
// Insertion-axis suitability — the undercut scan, BOTH ways
// ---------------------------------------------------------------------------

describe('scanCavityUndercut — insertion-axis suitability on the cavity region', () => {
  it('ZERO undercut on the drafted fixture (+6 degree draft, +Z insertion)', () => {
    const f = modCavityMesh();
    const bvh = buildBvh(f.mesh);
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const scan = scanCavityUndercut(f.mesh, bvh, res.cavity, AXIS_Z);
    expect(scan.undercutTriangleCount).toBe(0);
    expect(scan.maxDepthMm).toBe(0);
    expect(scan.undercutTriangleIndices.length).toBe(0);
    for (const u of scan.undercut) expect(u).toBe(0);
  });

  it('DETECTS undercut on the negative-taper variant — exactly the drafted wall set (falsifiability)', () => {
    // taperDeg = -1: every drafted wall's outward normal has
    // normal . +Z = sin(-1 deg) < -UNDERCUT_BOUNDARY_EPSILON => undercut by
    // facing. Pulpal step walls stay in the boundary band (nd = 0 exactly);
    // floor centroids sit at |y| = floorHalfWidth/3, far inside the (now
    // narrower) opening, so their +Z rays still exit freely => exactly the
    // 20m drafted-wall triangles are undercut, closed form.
    const m = 6;
    const f = modCavityMesh({ taperDeg: -1 });
    const bvh = buildBvh(f.mesh);
    const res = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z);
    const scan = scanCavityUndercut(f.mesh, bvh, res.cavity, AXIS_Z);

    expect(scan.undercutTriangleCount).toBe(20 * m);
    expect(scan.maxDepthMm).toBeGreaterThan(0);

    // The undercut set is EXACTLY the drafted walls (independent labeler).
    const undercutSet = new Set(scan.undercutTriangleIndices);
    for (const t of res.cavity.triangleIndices) {
      const label = expectedLabel(f, t);
      const drafted = label === 'axialDraftedWall' || label === 'boxDraftedWall';
      expect(undercutSet.has(t)).toBe(drafted);
    }
    // undercutTriangleIndices are mesh-triangle ids, sorted ascending.
    for (let i = 1; i < scan.undercutTriangleIndices.length; i++) {
      expect(scan.undercutTriangleIndices[i]!).toBeGreaterThan(scan.undercutTriangleIndices[i - 1]!);
    }
  });

  it('is deterministic and echoes the scanned region', () => {
    const f = modCavityMesh({ taperDeg: -1 });
    const bvh = buildBvh(f.mesh);
    const region = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z).cavity;
    const a = scanCavityUndercut(f.mesh, bvh, region, AXIS_Z);
    const b = scanCavityUndercut(f.mesh, bvh, region, AXIS_Z);
    expect(a.undercut).toEqual(b.undercut);
    expect(a.depthMm).toEqual(b.depthMm);
    expect(a.region).toBe(region);
  });

  it('zero-draft walls (taper 0) sit in the documented boundary band: not undercut', () => {
    // nd = 0 exactly on every drafted wall — inside UNDERCUT_BOUNDARY_EPSILON's
    // band (undercutScan.ts's documented "grazing is not undercut"
    // manufacturing convention), so a zero-draft cavity scans clean too.
    const f = modCavityMesh({ taperDeg: 0 });
    const bvh = buildBvh(f.mesh);
    const region = classifyCavityRegions(f.mesh, f.cavityOutline, AXIS_Z).cavity;
    const scan = scanCavityUndercut(f.mesh, bvh, region, AXIS_Z);
    expect(scan.undercutTriangleCount).toBe(0);
  });
});
