// packages/kernel/src/bridge/archBridge.test-fixtures.ts
//
// Phase 9 Task 6 — TEST-ONLY closed-form ARCH fixture for the bridge built from
// the case: what a lab receives for a 14-15-16 bridge, reduced to closed form.
// Not exported from the kernel index (the *.test-fixtures.ts convention).
//
//   - TARGET SCAN: two prepped abutment dies in one mesh (two components) —
//     14 (premolar-sized) and 16 (molar-sized), each a solid of revolution with
//     a 1.2 mm shoulder, a tapered axial wall and a DOMED occlusal reduction.
//   - GINGIVA SCAN: the edentulous ridge over the 15 site — the Phase 6 crest
//     "loaf" (bridge.test-fixtures.ts), lowered so its apex sits at the margin
//     height, and long enough to run under the abutments' cervical skirts as a
//     real gingiva does.
//   - MARGIN LOOPS: each die's shoulder ring, a dense ring of exact mesh
//     vertices on the analytic circle (the confirmed margin a technician would
//     have traced).
//   - The shared insertion axis +Z (both dies are parallel).
//
// Frame: X mesiodistal (14 → 16), Y buccal (FDI quadrant 1: buccal = up × md),
// Z occlusal. Units mm. Deterministic Float64.
//
// ## Why a domed occlusal reduction (and not the flat top of `shoulderPrepMesh`)
//
// At a fine voxel pitch the inner-surface op's offset over a large flat die top
// comes out with coplanar overlapping triangles (found while building this
// fixture: 5 self-intersecting pairs at 60 µm on `shoulderPrepMesh`'s flat
// cap; tracked). A clinical occlusal reduction follows the cusps — it is not a
// flat plateau — so the dome is both the more faithful prep and outside that
// pending defect. The margin ring itself is identical in kind to
// `shoulderPrepMesh`'s exact ring.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import type { RidgeCrestCylinder } from './ponticInterface.ts';

export interface ArchPrepDieParams {
  /** FDI tooth. */
  readonly tooth: number;
  /** Die axis position along X (mm). */
  readonly centreXMm: number;
  /** Margin (shoulder inner edge) radius (mm). */
  readonly marginRadiusMm: number;
  /** Shoulder width (mm) — the gingival skirt radius is margin + this. */
  readonly shoulderMm: number;
  /** Radius where the tapered axial wall meets the dome (mm). */
  readonly topRadiusMm: number;
  /** Height of the taper top (mm). */
  readonly topZMm: number;
  /** Dome rise above the taper top (mm). */
  readonly domeMm: number;
}

export interface ArchAbutment {
  readonly tooth: number;
  readonly die: IndexedMesh;
  /** The confirmed margin: the shoulder ring, exact vertices of `die`. */
  readonly marginLoop: Vec3[];
  readonly marginCenterMm: Vec3;
  readonly marginRadiusMm: number;
}

export interface ArchBridgeFixture {
  /** The prepped arch scan (both dies, one mesh). */
  readonly targetScan: IndexedMesh;
  /** The edentulous-ridge gingiva scan. */
  readonly gingiva: IndexedMesh;
  readonly abutments: readonly ArchAbutment[];
  readonly ponticTooth: number;
  readonly insertionAxis: Vec3;
  /** The ridge crest the gingiva was built on (analytic; tests only). */
  readonly crest: RidgeCrestCylinder;
}

/** The margin height above the die base (mm) — both dies. */
export const ARCH_MARGIN_Z_MM = 1.5;
/** Ring segments of each die (the margin loop's vertex count). */
export const ARCH_DIE_SEGMENTS = 96;
/** The ridge crest (gingiva) radius / half-length (mm). */
const RIDGE_RADIUS_MM = 3;
const RIDGE_HALF_LENGTH_MM = 6;

export const ARCH_DIES: readonly ArchPrepDieParams[] = [
  { tooth: 14, centreXMm: -7.5, marginRadiusMm: 3.0, shoulderMm: 1.2, topRadiusMm: 1.9, topZMm: 6.0, domeMm: 1.0 },
  { tooth: 16, centreXMm: 8.0, marginRadiusMm: 3.5, shoulderMm: 1.2, topRadiusMm: 2.2, topZMm: 6.5, domeMm: 1.0 },
];

/** Shoulder corner refinement (mm) — the `shoulderPrepMesh` convention, so the
 * margin ring is a crisp concave crease. */
const CORNER_REFINEMENT_MM = 0.05;
/** Dome rings between the taper top and the apex. */
const DOME_RINGS = 8;

function flip(mesh: IndexedMesh): IndexedMesh {
  const indices = mesh.indices.slice();
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1]!;
    indices[t + 1] = indices[t + 2]!;
    indices[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices };
}

/** A solid of revolution about the vertical axis through (cx, 0): profile
 * (radius, z) bottom → top, flat bottom cap, apex vertex on top. */
function revolve(cx: number, profile: readonly (readonly [number, number])[], apexZ: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (const [r, z] of profile) {
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(cx + r * Math.cos(th), r * Math.sin(th), z);
    }
  }
  const bottom = positions.length / 3;
  positions.push(cx, 0, profile[0]![1]);
  const apex = positions.length / 3;
  positions.push(cx, 0, apexZ);
  const ring = (r: number, s: number): number => r * segments + (s % segments);
  const tris: number[] = [];
  for (let r = 0; r < profile.length - 1; r++) {
    for (let s = 0; s < segments; s++) {
      tris.push(ring(r, s), ring(r, s + 1), ring(r + 1, s + 1), ring(r, s), ring(r + 1, s + 1), ring(r + 1, s));
    }
  }
  const last = profile.length - 1;
  for (let s = 0; s < segments; s++) {
    tris.push(bottom, ring(0, s + 1), ring(0, s));
    tris.push(apex, ring(last, s), ring(last, s + 1));
  }
  const oriented = orientNormalsConsistently({ positions: Float64Array.from(positions), indices: Uint32Array.from(tris) }).mesh;
  const volume = analyzeMesh(oriented).signedVolumeMm3;
  return volume !== null && volume < 0 ? flip(oriented) : oriented;
}

/** One domed shoulder prep die + its exact margin ring. */
export function archPrepDie(p: ArchPrepDieParams, segments = ARCH_DIE_SEGMENTS): ArchAbutment {
  const mz = ARCH_MARGIN_Z_MM;
  const gingivalR = p.marginRadiusMm + p.shoulderMm;
  const taper: [number, number] = [p.topRadiusMm - p.marginRadiusMm, p.topZMm - mz];
  const taperLen = Math.hypot(taper[0], taper[1]);
  const profile: [number, number][] = [
    [gingivalR, 0],
    [gingivalR, mz],
    [p.marginRadiusMm + CORNER_REFINEMENT_MM, mz],
    [p.marginRadiusMm, mz], // the margin ring (profile index 3)
    [p.marginRadiusMm + (taper[0] / taperLen) * CORNER_REFINEMENT_MM, mz + (taper[1] / taperLen) * CORNER_REFINEMENT_MM],
    [p.topRadiusMm, p.topZMm],
  ];
  for (let k = 1; k < DOME_RINGS; k++) {
    const a = (k / DOME_RINGS) * (Math.PI / 2);
    profile.push([p.topRadiusMm * Math.cos(a), p.topZMm + p.domeMm * Math.sin(a)]);
  }
  const die = revolve(p.centreXMm, profile, p.topZMm + p.domeMm, segments);
  const marginLoop: Vec3[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    marginLoop.push([p.centreXMm + p.marginRadiusMm * Math.cos(th), p.marginRadiusMm * Math.sin(th), mz]);
  }
  return { tooth: p.tooth, die, marginLoop, marginCenterMm: [p.centreXMm, 0, mz], marginRadiusMm: p.marginRadiusMm };
}

function concat(meshes: readonly IndexedMesh[]): IndexedMesh {
  let vTotal = 0;
  let iTotal = 0;
  for (const m of meshes) {
    vTotal += m.positions.length;
    iTotal += m.indices.length;
  }
  const positions = new Float64Array(vTotal);
  const indices = new Uint32Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOff);
    const base = vOff / 3;
    for (let i = 0; i < m.indices.length; i++) indices[iOff + i] = m.indices[i]! + base;
    vOff += m.positions.length;
    iOff += m.indices.length;
  }
  return { positions, indices };
}

/** The closed-form 14-15-16 arch bridge case — see this module's doc. */
export function archBridgeFixture(): ArchBridgeFixture {
  const abutments = ARCH_DIES.map((p) => archPrepDie(p));
  // The Phase 6 ridge loaf (crest axis at z = 1), lowered so the apex sits at
  // the margin height.
  const ridge = bridgeFixture({
    ridgeCrestRadiusMm: RIDGE_RADIUS_MM,
    ridgeCrestCenterZMm: 1,
    ridgeHalfLengthMm: RIDGE_HALF_LENGTH_MM,
    ridgeCrestSegments: 64,
    ridgeStations: 12,
  }).ridge.mesh;
  const drop = 1 + RIDGE_RADIUS_MM - ARCH_MARGIN_Z_MM;
  const positions = ridge.positions.slice();
  for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! - drop;
  const gingiva: IndexedMesh = { positions, indices: ridge.indices.slice() };
  return {
    targetScan: concat(abutments.map((a) => a.die)),
    gingiva,
    abutments,
    ponticTooth: 15,
    insertionAxis: [0, 0, 1],
    crest: {
      axisPointMm: [0, 0, 1 - drop],
      mesialDistalDir: [1, 0, 0],
      buccalDir: [0, 1, 0],
      upDir: [0, 0, 1],
      radiusMm: RIDGE_RADIUS_MM,
    },
  };
}
