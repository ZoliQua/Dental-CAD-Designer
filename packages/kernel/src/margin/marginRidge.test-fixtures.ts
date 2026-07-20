// packages/kernel/src/margin/marginRidge.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the margin/ test suite — mirrors curvature/
// curvature.test-fixtures.ts's / undercut/undercut.test-fixtures.ts's
// convention (not exported from packages/kernel/src/index.ts).
//
// ## Why NOT the existing `standin-prep-die`/`buildStandinPrepDie` fixture
//
// This task's brief calls for "the standin-prep-die (truncated cone WITH a
// shoulder!)" as the analytic fixture, but the ALREADY-CHECKED-IN
// `test-fixtures/standin-scans/standin-prep-die.stl`
// (`scripts/generate-fixtures.ts`'s `buildStandinPrepDie`) is, BY ITS OWN
// module doc, a solid whose radius-vs-height profile is a "non-increasing,
// piecewise-linear CONCAVE function of z... which makes the solid of
// revolution CONVEX" — i.e. it has NO concave feature anywhere (verified
// independently below, this file's "turning direction" derivation, applied
// to that fixture's own profile: every corner turns LEFT/convex). A real
// shoulder margin is the OPPOSITE: a CONCAVE crease (see this module's doc
// below for the derivation) — walking it needs a fixture that actually HAS
// one. `shoulderPrepMesh` below is that fixture: a genuine, closed-form,
// solid-of-revolution die with exactly ONE concave crease (the margin) and
// two convex ones (a rim above and below it, matching real anatomy's own
// "shoulder is the only concave feature near the prep" shape), at an EXACTLY
// known (radius, height) — see this file's doc below.
//
// ## Turning-direction derivation (concave vs convex), general form
//
// For a solid of revolution's PROFILE curve (r(z) or, more generally, a
// piecewise-linear (r,z) polyline), traced so that increasing arc length
// always has a positive z-COMPONENT wherever the segment isn't perfectly
// horizontal (this file's convention, matching curvature.test-fixtures.ts's
// `buildStandinPrepDie`/`buildCylinder` profiles), MATERIAL (the solid's
// interior, toward the axis) is ALWAYS on the LEFT of the direction of
// travel — a short proof: for a segment with tangent `(dr, dz)`, `dz > 0`,
// "left" (rotate 90 deg CCW) is `(-dz, dr)`, whose `r`-component is `-dz <
// 0` — i.e. left always points toward smaller `r` (the axis / the
// material), for ANY `dr`. A corner where the tangent direction turns LEFT
// (2D cross product `d1 x d2 > 0`) is therefore CONVEX (material curves away
// from the turn — e.g. the top rim of a cup, or a table edge); a corner that
// turns RIGHT (`d1 x d2 < 0`) is CONCAVE (material fills the reflex side —
// e.g. the inside corner of a stair step, where a horizontal tread meets a
// vertical riser going up). Verified against two independent, hand-checkable
// cases in this task's report: a literal 2D stair-step (concave at the
// tread/riser inside corner, convex at the riser/next-tread outside corner)
// and `buildStandinPrepDie`'s own profile (every corner turns left — convex
// throughout, matching that function's own doc).
//
// ## `shoulderPrepMesh`'s profile (bottom to top, z=0 at the base)
//
//   P0 = (gingivalRadius, 0)              bottom rim (cap -> wall corner: CONVEX)
//   P1 = (gingivalRadius, marginHeightMm) top of the gingival collar
//        wall P0->P1: tangent (0,1)
//   P1 -> P2: the flat SHOULDER SHELF, tangent (-1,0) — corner at P1
//        (wall -> shelf): CONVEX (`d1=(0,1) x d2=(-1,0) = 1 > 0`)
//   P2 = (marginRadiusMm, marginHeightMm) — THE MARGIN. Corner at P2 (shelf
//        -> taper): CONCAVE (`d1=(-1,0) x d2=(taperDr,taperDz), taperDz>0 =>
//        cross = -taperDz < 0`) — this is the fixture's one and only
//        concave feature, and it sits at EXACTLY
//        `(r, z) = (marginRadiusMm, marginHeightMm)` by construction: the
//        polygon profile is revolved with NO further subdivision along its
//        OWN edges (only circumferentially), so every P2-ring vertex is an
//        EXACT point on the analytic margin circle (not merely close to
//        it — see this file's own "exact ring" note below).
//   P2 -> P3: taper wall, tangent normalize(topRadiusMm - marginRadiusMm,
//        totalHeightMm - marginHeightMm) (`dr < 0`, `dz > 0`).
//   P3 = (topRadiusMm, totalHeightMm)     occlusal top rim (taper -> cap
//        corner: CONVEX, same proof form as P0's).
//
// **Exact ring, not an approximation**: because `revolveProfile` only
// subdivides CIRCUMFERENTIALLY (never along a profile edge), every vertex of
// the P2 ring sits at `(marginRadiusMm*cos(theta), marginRadiusMm*sin(theta),
// marginHeightMm)` EXACTLY (Float64 `cos`/`sin` rounding only, ~1e-15
// relative) — unlike a curved analytic shape (sphere/cylinder), there is no
// separate "mesh only approximates the true surface" error term to derive
// for the SHARP-corner variant: a walk that correctly stays on the P2 ring
// tracks the analytic margin circle up to floating-point noise alone. See
// marginRidge.analytic.test.ts for the measured number.
//
// ## Filleted variant (`filletRadiusMm > 0`)
//
// Replaces the sharp P2 corner with a circular-arc blend of radius
// `filletRadiusMm`, tangent to both the shelf and the taper — a standard
// tangent-circle construction (this file's `filletCorner`, worked out
// directly from the two tangent LINES' direction vectors, not a canned
// library routine). The blend's two tangent points are each within
// `filletRadiusMm` of the nominal sharp corner `P2` (a fillet strictly
// SHRINKS the reflex corner, never moves the blend outside the triangle the
// two original tangent lines and the corner form) — so
// marginRidge.analytic.test.ts's filleted-variant tolerance is simply the
// sharp-case tolerance PLUS `filletRadiusMm` (plus a small slack factor for
// the discrete curvature estimator's own resolution-dependent behavior at a
// small-radius feature — see that test file for the exact derivation), not
// a fresh closed-form re-derivation of the blended arc's own curve.
import type { IndexedMesh } from '../mesh/types.ts';

type Vec2 = readonly [number, number]; // (r, z)
type Vec3 = readonly [number, number, number];

function meshFromLists(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/** `6 * signed volume` — same divergence-theorem formula
 * undercut.test-fixtures.ts's `sixSignedVolume` uses (reproduced locally,
 * not imported — see that file's own doc for why TEST-ONLY fixture files in
 * this repo keep this kind of tiny helper self-contained rather than
 * cross-importing). */
function sixSignedVolume(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): number {
  let sum = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = positions[ia]!;
    const b = positions[ib]!;
    const c = positions[ic]!;
    sum += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum;
}

function ensureOutwardWinding(
  positions: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
): (readonly [number, number, number])[] {
  if (sixSignedVolume(positions, triangles) >= 0) return triangles.slice();
  return triangles.map(([a, b, c]) => [a, c, b] as const);
}

/**
 * Revolves a (r,z) profile polyline (bottom to top, `profile[0].r` and
 * `profile[last].r` need not be 0 — capped with a center-vertex fan at each
 * end regardless) around the Z axis into a closed, watertight solid —
 * `segments` circumferential samples, winding self-corrected via signed
 * volume (see `ensureOutwardWinding`) so this file never has to hand-verify
 * CCW orientation for an arbitrarily-shaped (possibly locally concave)
 * profile.
 */
function revolveProfile(profile: readonly Vec2[], segments: number): IndexedMesh {
  if (profile.length < 2) {
    throw new RangeError(`revolveProfile: profile needs >= 2 points, got ${profile.length}`);
  }
  const ringCount = profile.length;
  const positions: Vec3[] = [];
  const ringIndex = (ring: number, seg: number): number => ring * segments + seg;
  for (let r = 0; r < ringCount; r++) {
    const [radius, z] = profile[r]!;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
    }
  }
  const bottomCenterIndex = positions.length;
  positions.push([0, 0, profile[0]![1]]);
  const topCenterIndex = positions.length;
  positions.push([0, 0, profile[ringCount - 1]![1]]);

  const triangles: [number, number, number][] = [];
  for (let r = 0; r < ringCount - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      triangles.push([a, b, c]);
      triangles.push([a, c, d]);
    }
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s)]);
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([topCenterIndex, ringIndex(ringCount - 1, s), ringIndex(ringCount - 1, sNext)]);
  }
  return meshFromLists(positions, ensureOutwardWinding(positions, triangles));
}

function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function normalize2(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1]);
  return [v[0] / len, v[1] / len];
}

/**
 * Tangent-circle fillet of radius `fr` blending the corner at `corner`
 * between the incoming segment (arriving FROM `prevPoint`) and the outgoing
 * segment (leaving TOWARD `nextPoint`) — see this file's module doc,
 * "Filleted variant". Returns `{ tangentIn, tangentOut, arcPoints }`:
 * `tangentIn`/`tangentOut` are the two points where the fillet meets the
 * original straight segments (replacing `corner` in the final profile —
 * caller splices `arcPoints` in between), `arcPoints` is a short polyline
 * approximation of the arc itself (`arcSegments` samples, excluding the two
 * tangent points' exact duplicates) for the revolved mesh to use directly.
 *
 * Derivation: the incoming line is `{corner + t*(-dIn) : t >= 0}` (`dIn` =
 * unit direction FROM `prevPoint` TO `corner`, i.e. the corner is at `t=0`
 * walking backward along it); the outgoing line is `{corner + t*dOut : t >=
 * 0}` (`dOut` = unit direction FROM `corner` TO `nextPoint`). A circle of
 * radius `fr` tangent to both, on the MATERIAL side of each (see module doc
 * for which side that is — always the side the fixture's own concave corner
 * needs, since this helper is only ever called on `shoulderPrepMesh`'s one
 * concave corner), has its center at perpendicular distance `fr` from each
 * line; solved directly (2 linear equations in the two tangent-length
 * unknowns) rather than via a generic library routine, so the exact
 * geometry stays auditable in this file.
 */
function filletCorner(
  prevPoint: Vec2,
  corner: Vec2,
  nextPoint: Vec2,
  fr: number,
  arcSegments: number,
): { tangentIn: Vec2; tangentOut: Vec2; arcPoints: Vec2[] } {
  const dIn = normalize2(sub2(corner, prevPoint)); // direction of travel arriving at corner
  const dOut = normalize2(sub2(nextPoint, corner)); // direction of travel leaving corner
  // Material-side perpendicular (see module doc: "left" of the direction of
  // travel is always the material side for a dz>=0 segment; for the
  // horizontal shelf segment specifically material is BELOW, i.e. -z, which
  // is exactly "left of dIn" when dIn=(-1,0): rotate (-1,0) 90 CCW = (0,-1).
  // General 90-CCW rotation of (x,y) is (-y,x) — used for BOTH lines so the
  // same "left of direction of travel" rule applies uniformly.
  const leftOf = (d: Vec2): Vec2 => [-d[1], d[0]];
  const nIn = leftOf(dIn); // material-side unit normal to the incoming line
  const nOut = leftOf(dOut); // material-side unit normal to the outgoing line

  // Center C satisfies: C = corner - tIn*dIn + fr*nIn  (a point on the
  // incoming line, offset fr toward material) AND C = corner + tOut*dOut +
  // fr*nOut (a point on the outgoing line, offset fr toward material), for
  // some tIn, tOut >= 0 (how far back along each line the tangent point
  // sits). Two vector equations (4 scalar, r and z), two unknowns (tIn,
  // tOut) — solved via the z-components alone when dIn.z or dOut.z is
  // nonzero, generally via a 2x2 linear solve on (r,z) simultaneously.
  // -tIn*dIn + fr*nIn = tOut*dOut + fr*nOut
  // -tIn*dIn - tOut*dOut = fr*nOut - fr*nIn
  const rhs: Vec2 = [fr * (nOut[0] - nIn[0]), fr * (nOut[1] - nIn[1])];
  // Solve [-dIn, -dOut] * [tIn, tOut]^T = rhs (2x2 linear system).
  const m00 = -dIn[0];
  const m01 = -dOut[0];
  const m10 = -dIn[1];
  const m11 = -dOut[1];
  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < 1e-12) {
    throw new Error('filletCorner: incoming/outgoing directions are parallel — cannot fillet');
  }
  const tIn = (rhs[0] * m11 - m01 * rhs[1]) / det;
  const tOut = (m00 * rhs[1] - rhs[0] * m10) / det;

  const tangentIn: Vec2 = [corner[0] - tIn * dIn[0], corner[1] - tIn * dIn[1]];
  const tangentOut: Vec2 = [corner[0] + tOut * dOut[0], corner[1] + tOut * dOut[1]];
  const center: Vec2 = [tangentIn[0] + fr * nIn[0], tangentIn[1] + fr * nIn[1]];

  const startAngle = Math.atan2(tangentIn[1] - center[1], tangentIn[0] - center[0]);
  let endAngle = Math.atan2(tangentOut[1] - center[1], tangentOut[0] - center[0]);
  // Sweep the SHORT way (the fillet blends a single corner, never more than
  // a half turn) — normalize endAngle to within +/-PI of startAngle.
  while (endAngle - startAngle > Math.PI) endAngle -= 2 * Math.PI;
  while (endAngle - startAngle < -Math.PI) endAngle += 2 * Math.PI;

  const arcPoints: Vec2[] = [];
  for (let i = 1; i < arcSegments; i++) {
    const t = i / arcSegments;
    const angle = startAngle + (endAngle - startAngle) * t;
    arcPoints.push([center[0] + fr * Math.cos(angle), center[1] + fr * Math.sin(angle)]);
  }
  return { tangentIn, tangentOut, arcPoints };
}

export interface ShoulderPrepMeshOptions {
  gingivalRadiusMm?: number;
  marginRadiusMm?: number;
  topRadiusMm?: number;
  marginHeightMm?: number;
  totalHeightMm?: number;
  segments?: number;
  /** > 0 blends the margin corner with a tangent-circle fillet of this
   * radius — see this file's module doc, "Filleted variant". `0` (default)
   * keeps the sharp, EXACT-ring corner. */
  filletRadiusMm?: number;
  /** SHARP variant only (`filletRadiusMm === 0`): inserts one extra profile
   * ring this many mm before P2 (along the shelf) and one this many mm
   * after P2 (along the taper), TIGHTENING the local one-ring neighborhood
   * `computeCurvature`'s cotan-Laplacian estimator averages over at the
   * corner. Without this, a sharp corner whose only adjacent rings are the
   * FAR-AWAY P1/P3 (0.5-6.5mm away at this file's defaults) reads as only
   * mildly curved (discrete mean curvature is the fixed dihedral-angle
   * "bend" divided by a LOCAL area/edge-length scale — a distant one-ring
   * measures that same fixed bend against a much LARGER effective radius,
   * under-estimating the crease's true, resolution-dependent sharpness —
   * measured directly: default `0` here reads `k2 ~= -0.28` at the P2 ring,
   * comfortably BELOW `MARGIN_MIN_RIDGE_STRENGTH`'s -3 floor, i.e. an
   * under-refined sharp corner is invisible to the ridge walk). Default
   * `0.05` (comparable to the real arch-case-01 upperjaw's own near-margin
   * triangle scale) brings the SAME fixed corner up to `k2` in the tens,
   * matching the real-prep evidence's own order of magnitude (this task's
   * report). This is a TESSELLATION-density knob, not a geometry change —
   * the analytic margin location stays EXACTLY `(marginRadiusMm,
   * marginHeightMm)` regardless (see module doc, "exact ring"). */
  cornerRefinementMm?: number;
}

export interface ShoulderPrepMesh {
  mesh: IndexedMesh;
  /** The analytic margin circle's radius (mm) and height (mm, Z) — for the
   * SHARP variant (`filletRadiusMm === 0`) this is the EXACT location of
   * every P2-ring vertex (see module doc); for the filleted variant it is
   * the nominal (pre-fillet) corner location the blended arc sits within
   * `filletRadiusMm` of (see `filletCorner`'s doc). */
  marginRadiusMm: number;
  marginHeightMm: number;
  filletRadiusMm: number;
}

/**
 * A shoulder-margin crown-prep die, as a closed solid of revolution — see
 * this file's module doc for the exact profile and the concave-corner
 * derivation. Defaults chosen to be anatomically plausible (a ~22mm margin
 * circumference, mid-range for the "15-35mm incisor" guardrail this task's
 * brief cites) while keeping the mesh small/fast for a test suite.
 */
export function shoulderPrepMesh(opts: ShoulderPrepMeshOptions = {}): ShoulderPrepMesh {
  const gingivalRadiusMm = opts.gingivalRadiusMm ?? 4;
  const marginRadiusMm = opts.marginRadiusMm ?? 3.5;
  const topRadiusMm = opts.topRadiusMm ?? 2;
  const marginHeightMm = opts.marginHeightMm ?? 1.5;
  const totalHeightMm = opts.totalHeightMm ?? 8;
  const segments = opts.segments ?? 128;
  const filletRadiusMm = opts.filletRadiusMm ?? 0;
  const cornerRefinementMm = opts.cornerRefinementMm ?? 0.05;

  if (!(gingivalRadiusMm > marginRadiusMm)) {
    throw new RangeError('shoulderPrepMesh: gingivalRadiusMm must be > marginRadiusMm (a real shelf, not zero-width)');
  }
  if (!(marginRadiusMm > topRadiusMm)) {
    throw new RangeError('shoulderPrepMesh: marginRadiusMm must be > topRadiusMm (a real taper)');
  }
  if (!(totalHeightMm > marginHeightMm && marginHeightMm > 0)) {
    throw new RangeError('shoulderPrepMesh: requires 0 < marginHeightMm < totalHeightMm');
  }

  const p0: Vec2 = [gingivalRadiusMm, 0];
  const p1: Vec2 = [gingivalRadiusMm, marginHeightMm];
  const p2: Vec2 = [marginRadiusMm, marginHeightMm];
  const p3: Vec2 = [topRadiusMm, totalHeightMm];

  let profile: Vec2[];
  if (filletRadiusMm <= 0) {
    if (cornerRefinementMm > 0) {
      const shelfLen = gingivalRadiusMm - marginRadiusMm;
      const taperDir = normalize2(sub2(p3, p2));
      if (!(cornerRefinementMm < shelfLen)) {
        throw new RangeError(
          `shoulderPrepMesh: cornerRefinementMm (${cornerRefinementMm}) must be < the shelf length (${shelfLen})`,
        );
      }
      const preP2: Vec2 = [p2[0] + cornerRefinementMm, p2[1]]; // cornerRefinementMm back toward P1 along the shelf
      const postP2: Vec2 = [p2[0] + taperDir[0] * cornerRefinementMm, p2[1] + taperDir[1] * cornerRefinementMm];
      profile = [p0, p1, preP2, p2, postP2, p3];
    } else {
      profile = [p0, p1, p2, p3];
    }
  } else {
    const { tangentIn, tangentOut, arcPoints } = filletCorner(p1, p2, p3, filletRadiusMm, 12);
    profile = [p0, p1, tangentIn, ...arcPoints, tangentOut, p3];
  }

  const mesh = revolveProfile(profile, segments);
  return { mesh, marginRadiusMm, marginHeightMm, filletRadiusMm };
}
