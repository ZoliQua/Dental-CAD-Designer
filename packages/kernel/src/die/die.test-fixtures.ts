// packages/kernel/src/die/die.test-fixtures.ts
//
// Phase 10 Task 1 — TEST-ONLY closed-form OPEN-ARCH prep case: what an
// intraoral scan of one prepared tooth looks like, reduced to closed form.
// Not exported from the kernel index (the *.test-fixtures.ts convention).
//
// One OPEN height-field sheet z = f(ρ, θ) on a polar grid around the prep
// axis (the origin, +Z):
//
//   - the PREP DIE, rotationally symmetric: a domed occlusal reduction, a
//     tapered axial wall, the margin ring (the shoulder's inner crease, the
//     `archPrepDie` convention), a flat 1.2 mm shoulder, and a drop to the
//     gingiva;
//   - the GINGIVA, flat at z = 0 out to the scan's open rim at ρ = `outerMm`
//     (the base cut of a real scan — the sheet's only boundary loop);
//   - two NEIGHBOUR crowns rising from the gingiva at ±X (bumps beyond the
//     die's drop, so the die region stays exactly symmetric).
//
// Every ring has `segments` vertices at the same angles θ_s = 2πs / n, so
// each band between two rings is made of planar trapezoids. Within a band the
// height is linear in the polygon "radius" ρ, which gives the extracted die's
// volume in closed form (`dieVolumeAnalytic`).
//
// Frame: X mesio-distal, Z occlusal. Units mm. Deterministic Float64.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';

export interface OpenArchPrepParams {
  readonly segments: number;
  readonly marginRadiusMm: number;
  readonly marginZMm: number;
  readonly shoulderMm: number;
  readonly topRadiusMm: number;
  readonly topZMm: number;
  readonly domeMm: number;
  /** Radial width of the drop from the shoulder to the gingiva (mm). */
  readonly dropMm: number;
  /** Rings inside the drop (excluding its ends). */
  readonly dropRings: number;
  /** The scan's open rim (mm). */
  readonly outerMm: number;
  /** Radial step of the gingiva rings (mm). */
  readonly gingivaStepMm: number;
  /** Neighbour crowns: centre distance from the axis along ±X, radius,
   * height above the gingiva (mm). `null` for none. */
  readonly neighbours: { readonly centreMm: number; readonly radiusMm: number; readonly heightMm: number } | null;
}

export const OPEN_ARCH_PREP_DEFAULTS: OpenArchPrepParams = {
  segments: 192,
  marginRadiusMm: 3.0,
  marginZMm: 1.5,
  shoulderMm: 1.2,
  topRadiusMm: 1.9,
  topZMm: 6.0,
  domeMm: 1.0,
  dropMm: 0.4,
  dropRings: 3,
  outerMm: 12.5,
  gingivaStepMm: 0.1,
  neighbours: { centreMm: 8.4, radiusMm: 3.5, heightMm: 6.5 },
};

export interface OpenArchPrepCase {
  /** The open scan (one boundary loop: the rim at `outerMm`). */
  readonly scan: IndexedMesh;
  /** The confirmed margin: the ring at `marginRadiusMm`, exact vertices. */
  readonly marginLoop: Vec3[];
  readonly insertionAxis: Vec3;
  /** The symmetric die profile (ρ, z), centre outward, apex first; every
   * ring with ρ ≤ marginRadius + shoulder + drop. */
  readonly profile: ReadonlyArray<readonly [number, number]>;
  readonly params: OpenArchPrepParams;
}

/** Corner refinement at the margin crease (mm) — the `shoulderPrepMesh`
 * convention. */
const CORNER_REFINEMENT_MM = 0.05;
const DOME_RINGS = 8;

function dieProfile(p: OpenArchPrepParams): Array<[number, number]> {
  const mz = p.marginZMm;
  const prof: Array<[number, number]> = [[0, p.topZMm + p.domeMm]];
  for (let k = DOME_RINGS - 1; k >= 1; k--) {
    const a = (k / DOME_RINGS) * (Math.PI / 2);
    prof.push([p.topRadiusMm * Math.cos(a), p.topZMm + p.domeMm * Math.sin(a)]);
  }
  prof.push([p.topRadiusMm, p.topZMm]);
  const taper: [number, number] = [p.topRadiusMm - p.marginRadiusMm, p.topZMm - mz];
  const taperLen = Math.hypot(taper[0], taper[1]);
  prof.push([
    p.marginRadiusMm + (taper[0] / taperLen) * CORNER_REFINEMENT_MM,
    mz + (taper[1] / taperLen) * CORNER_REFINEMENT_MM,
  ]);
  prof.push([p.marginRadiusMm, mz]); // the margin ring
  prof.push([p.marginRadiusMm + CORNER_REFINEMENT_MM, mz]);
  const gingivalR = p.marginRadiusMm + p.shoulderMm;
  prof.push([gingivalR, mz]);
  for (let k = 1; k <= p.dropRings + 1; k++) {
    const t = k / (p.dropRings + 1);
    prof.push([gingivalR + t * p.dropMm, mz * (1 - t)]);
  }
  return prof;
}

function neighbourLift(x: number, y: number, p: OpenArchPrepParams): number {
  const n = p.neighbours;
  if (n === null) return 0;
  let lift = 0;
  for (const cx of [-n.centreMm, n.centreMm]) {
    const d = Math.hypot(x - cx, y) / n.radiusMm;
    if (d < 1) lift = Math.max(lift, n.heightMm * Math.sqrt(1 - d ** 4));
  }
  return lift;
}

/** The closed-form open-arch prep case — see this module's doc. */
export function openArchPrepCase(overrides: Partial<OpenArchPrepParams> = {}): OpenArchPrepCase {
  const p: OpenArchPrepParams = { ...OPEN_ARCH_PREP_DEFAULTS, ...overrides };
  const profile = dieProfile(p);
  const rings: Array<[number, number | null]> = profile.map(([r, z]) => [r, z]);
  const dropEnd = profile[profile.length - 1]![0];
  for (let r = dropEnd + p.gingivaStepMm; r <= p.outerMm + 1e-9; r += p.gingivaStepMm) rings.push([r, null]);
  // Rings are cut at `outerMm` (a profile ring beyond it is dropped too).
  const kept = rings.filter(([r]) => r <= p.outerMm + 1e-9);
  const n = p.segments;
  const positions: number[] = [];
  // Ring 0 is the apex (one vertex).
  positions.push(0, 0, kept[0]![1]!);
  for (let k = 1; k < kept.length; k++) {
    const [r, z] = kept[k]!;
    for (let s = 0; s < n; s++) {
      const th = (2 * Math.PI * s) / n;
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      positions.push(x, y, z ?? neighbourLift(x, y, p));
    }
  }
  const ring = (k: number, s: number): number => 1 + (k - 1) * n + (((s % n) + n) % n);
  const tris: number[] = [];
  for (let s = 0; s < n; s++) tris.push(0, ring(1, s), ring(1, s + 1));
  for (let k = 1; k < kept.length - 1; k++) {
    for (let s = 0; s < n; s++) {
      tris.push(ring(k, s), ring(k + 1, s), ring(k + 1, s + 1));
      tris.push(ring(k, s), ring(k + 1, s + 1), ring(k, s + 1));
    }
  }
  const marginK = profile.findIndex(([r, z]) => r === p.marginRadiusMm && z === p.marginZMm);
  const marginLoop: Vec3[] = [];
  for (let s = 0; s < n; s++) {
    const v = ring(marginK, s);
    marginLoop.push([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
  }
  return {
    scan: { positions: Float64Array.from(positions), indices: Uint32Array.from(tris) },
    marginLoop,
    insertionAxis: [0, 0, 1],
    profile: profile.filter(([r]) => r <= p.outerMm + 1e-9),
    params: p,
  };
}

/**
 * The closed-form volume of the die extracted from the symmetric profile:
 * the solid between the floor plane `floorZ` and the height field over the
 * regular n-gon of polygon radius `rimRadius` (a profile ring). Within a band
 * the height is linear in the polygon radius ρ and dA = 2cρ dρ with
 * c = (n/2)·sin(2π/n), so each band integrates exactly.
 */
export function dieVolumeAnalytic(
  profile: ReadonlyArray<readonly [number, number]>,
  segments: number,
  rimRadius: number,
  floorZ: number,
): number {
  const c = (segments / 2) * Math.sin((2 * Math.PI) / segments);
  let v = 0;
  for (let k = 0; k + 1 < profile.length; k++) {
    const [a, za] = profile[k]!;
    const [b, zb] = profile[k + 1]!;
    if (b > rimRadius + 1e-12) break;
    if (b === a) continue;
    // ∫_a^b 2ρ (z(ρ) − floor) dρ, z linear from za to zb.
    const m = (zb - za) / (b - a);
    const z0 = za - floorZ - m * a; // z(ρ) − floor = z0 + mρ
    v += z0 * (b * b - a * a) + ((2 * m) / 3) * (b ** 3 - a ** 3);
  }
  return c * v;
}

/**
 * A CLOSED capped frustum die whose margin is its bottom rim (the Phase 4
 * server crown fixture's shape): bottom ring radius `marginR` at `marginZ`,
 * top ring `topR` at `topZ`, both capped with a centre fan, outward wound.
 * Every vertex lies inside the margin footprint and above the depth floor, so
 * the whole solid is the kept surface. `topCentreZ` moves the top fan's apex
 * (below `marginZ` it pierces the bottom cap: a self-intersecting die).
 */
export function closedFrustumDie(
  opts: { segments?: number; marginR?: number; topR?: number; marginZ?: number; topZ?: number; topCentreZ?: number } = {},
): { die: IndexedMesh; marginLoop: Vec3[]; volumeMm3: number } {
  const n = opts.segments ?? 96;
  const marginR = opts.marginR ?? 1.2;
  const topR = opts.topR ?? 0.8;
  const marginZ = opts.marginZ ?? 0.5;
  const topZ = opts.topZ ?? 2.0;
  const positions: number[] = [];
  for (let s = 0; s < n; s++) {
    const th = (2 * Math.PI * s) / n;
    positions.push(marginR * Math.cos(th), marginR * Math.sin(th), marginZ);
  }
  for (let s = 0; s < n; s++) {
    const th = (2 * Math.PI * s) / n;
    positions.push(topR * Math.cos(th), topR * Math.sin(th), topZ);
  }
  const bottomCentre = 2 * n;
  const topCentre = 2 * n + 1;
  positions.push(0, 0, marginZ, 0, 0, opts.topCentreZ ?? topZ);
  const tris: number[] = [];
  for (let s = 0; s < n; s++) {
    const sn = (s + 1) % n;
    tris.push(s, sn, n + sn, s, n + sn, n + s);
    tris.push(bottomCentre, sn, s);
    tris.push(topCentre, n + s, n + sn);
  }
  const marginLoop: Vec3[] = [];
  for (let s = 0; s < n; s++) marginLoop.push([positions[s * 3]!, positions[s * 3 + 1]!, positions[s * 3 + 2]!]);
  // Similar n-gon cross-sections: V = h/3 · (A₁ + A₂ + √(A₁A₂)).
  const c = (n / 2) * Math.sin((2 * Math.PI) / n);
  const a1 = c * marginR * marginR;
  const a2 = c * topR * topR;
  const volumeMm3 = ((topZ - marginZ) / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
  return { die: { positions: Float64Array.from(positions), indices: Uint32Array.from(tris) }, marginLoop, volumeMm3 };
}
