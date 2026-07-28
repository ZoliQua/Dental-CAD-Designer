// packages/kernel/src/bridge/connector.ts
//
// Phase 6 Task 4 — the BRIDGE CONNECTOR op. A connector is the bar of material
// joining two adjacent bridge units (abutment↔pontic, pontic↔pontic); its
// MINIMUM cross-sectional area along the connector axis is a fracture-strength
// gate (posterior 9 / anterior 7 mm² — the profile targets). This module ships,
// in the P5/P6 "validate the instrument BEFORE it judges any construction"
// discipline, three tightly-coupled pieces:
//
//   1. PROFILES — editable 2D closed cross-section polylines (in the connector
//      section-plane's (e1,e2) local frame), VALIDATED closed / simple
//      (non-self-intersecting) / consistently-wound (the margin/validate.ts
//      precedent, in 2D), plus a documented parametric DEFAULT (an elliptical
//      section — the classic connector shape) whose polygon area is closed-form.
//   2. THE LOFT — a deterministic watertight ruled solid between the two
//      profiles. Correspondence rule (the P5 T3 arcLength-pairing lesson): the
//      two profiles are paired BY INDEX and MUST therefore have EQUAL vertex
//      counts and consistent winding; the arc-length parametrization is carried
//      by the DEFAULT profiles (identical angular sampling ⇒ identical fractional
//      arc positions), and an editable caller supplies matched-count profiles (or
//      resamples to a common count first). Typed errors on every degenerate case.
//   3. THE AREA INSTRUMENT — two halves, one authoritative. The gate VERDICT is
//      driven by a mesh-sampled, never-over-reporting lower bound on the ACTUAL
//      triangulated solid's minimum cross-section area; a closed-form quadratic
//      minimum is the VALIDATION oracle (and an audit field), not the verdict.
//      (a) The IDEAL ruled-ring section area is EXACTLY a QUADRATIC in the axial
//      parameter t∈[0,1] (each ring vertex R_i(t)=(1−t)A_i+t·B_i is linear in t,
//      so each shoelace term is quadratic) ⇒ `analyticConnectorMinArea` computes
//      its continuous minimum in CLOSED FORM. This validates the instrument
//      against known analytic areas but is NOT what ships: the real triangulated
//      ruled surface of a twisted connector bows INWARD, so its true waist can lie
//      BELOW the ideal N-gon-ring minimum. (b) `sampleConnectorCrossSectionAreas`
//      sections the ACTUAL solid mesh at dense interior stations (bracketed by the
//      two exact profile caps) and subtracts a rigorous station margin — its
//      `guaranteedLowerBoundMm2` is `measureConnectorMinArea`'s `minAreaMm2`, the
//      value the gate consumes. Its station-spacing HAZARD is made concrete: a
//      waist BETWEEN sample stations makes the naive sampled-min OVER-report the
//      true min (by up to the station margin) — which is exactly WHY the shipped
//      value subtracts that margin.
//
// @errorBound THE GATE VALUE — `MeasureConnectorMinAreaResult.minAreaMm2` =
// `sampled.guaranteedLowerBoundMm2` — is a PROVEN LOWER BOUND on the actual
// triangulated connector solid's minimum cross-section area; it never
// over-reports. It is `sampled.minAreaMm2 − sampled.stationMarginMm2`, where the
// margin is the rigorous second-difference bound `max_k |A_{k−1} − 2A_k +
// A_{k+1}| / 8` (see `sampleConnectorCrossSectionAreas`'s doc for why this binds
// the MESH's own per-segment quadratic area function exactly, robust to concavity
// and to twist). The EXACT closed-form minimum of the IDEAL ruled ring
// (`analytic.minAreaMm2`) is Float64-exact but describes the ideal N-gon ring, not
// the manufactured triangulated solid — it is reported as the closed-form
// VALIDATION oracle + a journaled audit field, NOT the verdict; for an untwisted
// connector the two agree to `sampledVsAnalyticMaxAbsMm2` (the wall-diagonal
// tessellation term, ~0 for a constant prism, sub-0.01 mm² at realistic segment
// counts — three orders of magnitude below the 9 mm² gate). PRECONDITION (guarded,
// see below): the never-over-report proof requires each sampled section to be a
// SINGLE SIMPLE polygon (so |shoelace| = enclosed area and the constant-second-
// difference structure holds); `measureConnectorMinArea` REFUSES (throws
// `NonSimpleConnectorSectionError`) rather than report a bogus area when an
// (adversarial) editable PAIRING produces a self-intersecting ruled surface whose
// perpendicular section is non-simple.
//
// Pure, deterministic, Float64 (CLAUDE.md invariant 1/2). No manifold-3d boundary
// (the union of unit+connector solids is Task 6, through the manifold wrapper);
// this op only CONSTRUCTS a watertight connector solid + MEASURES its section
// area. `.ts` relative imports (reachable from the Node worker entry's closure —
// CLAUDE.md's Import-extension convention).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { normalizePlane, type Plane } from '../section/plane.ts';
import { sectionMesh } from '../section/polyline.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A 2D point (mm) in a connector section plane's (e1,e2) local frame. */
export type Vec2 = readonly [number, number];

/** A closed 2D cross-section profile — an ordered ring of (e1,e2) points; the
 * loop is IMPLIED (the last point connects back to the first — the first point
 * is NOT repeated at the end, matching `section/polyline.ts`'s convention). */
export type ConnectorProfile2D = readonly Vec2[];

/** The connector's local frame: an axis (unit, from unit A toward unit B), an
 * origin ON the axis at the profileA plane (axial station s=0), an orthonormal
 * in-plane basis (e1,e2 ⟂ axis), and the axial span to the profileB plane
 * (s=`spanMm`). A 2D profile point (u,v) maps to 3D at station s as
 * `origin + s·axis + u·e1 + v·e2`. Built by `buildConnectorFrame`. */
export interface ConnectorFrame {
  readonly originMm: Vec3;
  readonly axis: Vec3;
  readonly e1: Vec3;
  readonly e2: Vec3;
  readonly spanMm: number;
}

/** The result of validating a single profile. `ccw` is the winding sign of the
 * shoelace signed area in the (e1,e2) frame (true = counter-clockwise). */
export interface ConnectorProfileInfo {
  readonly vertexCount: number;
  readonly signedAreaMm2: number;
  readonly ccw: boolean;
}

export interface LoftConnectorResult {
  readonly mesh: IndexedMesh;
  readonly profileACcw: boolean;
  readonly profileBCcw: boolean;
  readonly vertexCount: number;
}

/** The quadratic `A(t) = a·t² + b·t + c` (mm², t∈[0,1]) that the ruled-loft
 * cross-section area follows EXACTLY (see this module's doc). */
export interface ConnectorAreaQuadratic {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** The closed-form minimum of the area quadratic over t∈[0,1] — the exact gate
 * value. `atT` is the argmin (0/1 endpoint or the interior vertex −b/2a). */
export interface ConnectorAnalyticMinArea {
  readonly minAreaMm2: number;
  readonly atT: number;
  readonly atStationMm: number;
  readonly quadratic: ConnectorAreaQuadratic;
}

/** The SAMPLED instrument — sections the REAL triangulated solid at dense
 * stations (plus the two exact profile caps). Its raw `minAreaMm2` is the live
 * readout; `guaranteedLowerBoundMm2` is the fail-safe gate value (see the module
 * @errorBound + `sampleConnectorCrossSectionAreas`'s doc for the rigorous
 * second-difference station margin). */
export interface SampledConnectorAreas {
  readonly stationCount: number;
  readonly stationSpacingMm: number;
  /** Raw min over the sampled stations (the two profile caps + the interior mesh
   * sections) — CAN over-report the true min by up to `stationMarginMm2` when a
   * waist falls between stations (the hazard the guaranteed bound covers). */
  readonly minAreaMm2: number;
  readonly minStationMm: number;
  /** Per-station section areas (mm²): index 0 = profile-A cap (t=0, exact),
   * 1..stationCount = interior MESH sections, last = profile-B cap (t=1, exact).
   * Equally spaced in the axial parameter (`Δt = 1/(stationCount+1)`). */
  readonly areasMm2: readonly number[];
  /** The station positions (mm along the axis from `origin`), aligned with
   * `areasMm2` (0 and `spanMm` are the caps). */
  readonly stationsMm: readonly number[];
  /** The rigorous station margin (mm²) — `max_k |A_{k−1} − 2A_k + A_{k+1}| / 8`
   * over the equally-spaced samples. For the real solid's per-segment quadratic
   * cross-section-area function this bounds EXACTLY the amount the section can
   * dip below the nearest sampled value between two stations (see the sampler's
   * doc). */
  readonly stationMarginMm2: number;
  /** `minAreaMm2 − stationMarginMm2` — provably ≤ the true minimum cross-section
   * area of the actual triangulated solid (never over-reports). THE GATE VALUE. */
  readonly guaranteedLowerBoundMm2: number;
  /** Whether EVERY interior mesh section was a SINGLE SIMPLE polygon — the
   * precondition of the never-over-report proof (see the module @errorBound). A
   * self-intersecting ruled surface (from an adversarial editable PAIRING)
   * produces a non-simple section (multiple loops or a self-crossing loop), for
   * which `guaranteedLowerBoundMm2` is meaningless; `measureConnectorMinArea`
   * throws `NonSimpleConnectorSectionError` in that case rather than report it. */
  readonly sectionsSimple: boolean;
  /** The first station (mm) whose section was non-simple, or `null` if all
   * simple. */
  readonly firstNonSimpleStationMm: number | null;
}

export interface MeasureConnectorMinAreaResult {
  /** THE GATE VALUE — the fail-safe lower bound on the actual solid's minimum
   * cross-section area (`sampled.guaranteedLowerBoundMm2`); never over-reports. */
  readonly minAreaMm2: number;
  readonly atStationMm: number;
  /** The exact closed-form minimum of the IDEAL ruled-ring cross-section area
   * (a quadratic; see this module's @errorBound). Equals `minAreaMm2` to the
   * tessellation term for an untwisted connector; the gate uses the fail-safe
   * mesh bound above, which additionally captures any real inward bow of a
   * twisted ruled surface. */
  readonly analytic: ConnectorAnalyticMinArea;
  readonly sampled: SampledConnectorAreas;
  /** `max_k |meshSection_k − analyticArea(station_k)|` — the wall-diagonal
   * tessellation term (mm²); ~0 for a constant prism, grows with axial twist. */
  readonly sampledVsAnalyticMaxAbsMm2: number;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class NonClosedProfileError extends Error {
  constructor(vertexCount: number) {
    super(`connector: a closed cross-section profile needs >= 3 vertices, got ${vertexCount}`);
    this.name = 'NonClosedProfileError';
  }
}

export class DegenerateProfileError extends Error {
  constructor(signedAreaMm2: number) {
    super(`connector: profile is degenerate (near-zero area ${signedAreaMm2} mm² — collinear/collapsed)`);
    this.name = 'DegenerateProfileError';
  }
}

export class SelfIntersectingProfileError extends Error {
  readonly edgeA: readonly [number, number];
  readonly edgeB: readonly [number, number];
  constructor(edgeA: readonly [number, number], edgeB: readonly [number, number]) {
    super(`connector: profile self-intersects (edge ${edgeA[0]}-${edgeA[1]} crosses edge ${edgeB[0]}-${edgeB[1]})`);
    this.name = 'SelfIntersectingProfileError';
    this.edgeA = edgeA;
    this.edgeB = edgeB;
  }
}

export class ProfileVertexCountMismatchError extends Error {
  constructor(countA: number, countB: number) {
    super(`connector: the two loft profiles must have equal vertex counts (index-paired correspondence), got ${countA} and ${countB}`);
    this.name = 'ProfileVertexCountMismatchError';
  }
}

export class ProfileWindingMismatchError extends Error {
  constructor() {
    super('connector: the two loft profiles must have the SAME winding (both CCW or both CW) so corresponding vertices ring the same way');
    this.name = 'ProfileWindingMismatchError';
  }
}

/** Thrown by `measureConnectorMinArea` (and flagged by
 * `sampleConnectorCrossSectionAreas`) when a sampled perpendicular section of the
 * connector solid is NON-SIMPLE — either not a single closed loop, or a single
 * loop that self-crosses in 2D. This means the (editable) profile PAIRING
 * produced a SELF-INTERSECTING ruled surface (each profile is validated simple in
 * 2D, but the index-pairing between them is not): the shoelace of a non-simple
 * polygon is not its enclosed area, so the never-over-report lower-bound proof
 * (which needs a fixed simple-polygon cut-set — see the module @errorBound + the
 * sampler doc) lapses. The instrument REFUSES to report a bogus area. `stationMm`
 * is the first offending station. The default and moderate-twist envelope (a
 * simple ruled surface) never triggers this. */
export class NonSimpleConnectorSectionError extends Error {
  readonly stationMm: number;
  readonly loopCount: number;
  constructor(stationMm: number, loopCount: number) {
    super(
      `connector: the cross-section at station ${stationMm.toFixed(4)} mm is NON-SIMPLE ` +
        `(${loopCount} closed loop(s)${loopCount === 1 ? ', self-crossing' : ''}) — the profile PAIRING produces a ` +
        `self-intersecting ruled surface; the minimum-area guarantee requires simple sections. Refusing to report a bogus area.`,
    );
    this.name = 'NonSimpleConnectorSectionError';
    this.stationMm = stationMm;
    this.loopCount = loopCount;
  }
}

// ---------------------------------------------------------------------------
// Float64 vector helpers (module-local — the repo's per-module convention)
// ---------------------------------------------------------------------------

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function len3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** A profile point (u,v) placed in 3D at axial station `s`. */
function profilePointTo3D(frame: ConnectorFrame, p: Vec2, s: number): Vec3 {
  return add3(
    add3(frame.originMm, scale3(frame.axis, s)),
    add3(scale3(frame.e1, p[0]), scale3(frame.e2, p[1])),
  );
}

/** `cross2(p, q) = p.u·q.v − q.u·p.v` — the 2D scalar cross (shoelace term). */
function cross2(p: Vec2, q: Vec2): number {
  return p[0] * q[1] - q[0] * p[1];
}

// ---------------------------------------------------------------------------
// Profile validation (the margin/validate.ts precedent, in 2D)
// ---------------------------------------------------------------------------

/** Below this |signed area| (mm²) a profile is treated as degenerate — a
 * collapsed/collinear ring. 1e-9 mm² is far below any clinically-meaningful
 * connector section (the smallest plausible is ~1 mm²) yet far above Float64
 * shoelace noise at mm coordinate scale. */
export const CONNECTOR_PROFILE_MIN_AREA_MM2 = 1e-9;

/** Shoelace SIGNED area (mm²) of a closed 2D profile (positive = CCW). */
export function connectorProfileSignedArea(profile: ConnectorProfile2D): number {
  let a2 = 0;
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    a2 += cross2(profile[i]!, profile[(i + 1) % n]!);
  }
  return a2 / 2;
}

/** Do open 2D segments p1→p2 and p3→p4 cross at an interior point? Exact
 * orientation test (no tolerance — collinear touching is NOT a proper crossing;
 * shared endpoints of ADJACENT edges are excluded by the caller). */
function segmentsProperlyIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const o = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(p3, p4, p1);
  const d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3);
  const d4 = o(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Validate a caller-supplied (or default) connector cross-section profile:
 * closed (>= 3 vertices), simple (no two non-adjacent edges properly cross),
 * non-degenerate (|signed area| above the floor). Deterministic; returns the
 * winding. See this module's doc.
 *
 * @throws {NonClosedProfileError} for < 3 vertices.
 * @throws {DegenerateProfileError} for a near-zero-area (collapsed) profile.
 * @throws {SelfIntersectingProfileError} for a non-simple profile.
 */
export function validateConnectorProfile(profile: ConnectorProfile2D): ConnectorProfileInfo {
  const n = profile.length;
  if (n < 3) throw new NonClosedProfileError(n);
  // Self-intersection BEFORE the degenerate-area check: a self-crossing polygon
  // (e.g. a bowtie) can have zero NET signed area, so the crossing must be
  // diagnosed as the specific fault first. O(n²) non-adjacent edge-pair
  // proper-intersection scan (n tiny). Edge i is profile[i]→profile[i+1];
  // edges are adjacent iff they share a vertex.
  for (let i = 0; i < n; i++) {
    const a1 = profile[i]!;
    const a2 = profile[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue; // share a vertex ⇒ adjacent
      const b1 = profile[j]!;
      const b2 = profile[(j + 1) % n]!;
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) {
        throw new SelfIntersectingProfileError([i, (i + 1) % n], [j, (j + 1) % n]);
      }
    }
  }
  const signedAreaMm2 = connectorProfileSignedArea(profile);
  if (Math.abs(signedAreaMm2) < CONNECTOR_PROFILE_MIN_AREA_MM2) throw new DegenerateProfileError(signedAreaMm2);
  return { vertexCount: n, signedAreaMm2, ccw: signedAreaMm2 > 0 };
}

/**
 * The documented parametric DEFAULT connector profile — an ellipse (the classic
 * connector section) with the given semi-axes along e1 (buccolingual) and e2
 * (occlusogingival), sampled at `segments` equal ANGULAR steps. Vertex i is
 * `(semiE1·cos θ_i, semiE2·sin θ_i)` with `θ_i = 2πi/segments` — CCW, closed.
 *
 * The equal-angular sampling is the arc-length-correspondence carrier (this
 * module's doc): two default profiles with the SAME `segments` pair vertex-for-
 * vertex by identical fractional position. Closed-form polygon area:
 * `½·segments·semiE1·semiE2·sin(2π/segments)` (an inscribed ellipse polygon).
 *
 * @throws {RangeError} for non-positive semi-axes or `segments < 3`.
 */
export function makeEllipseConnectorProfile(semiE1Mm: number, semiE2Mm: number, segments: number): ConnectorProfile2D {
  if (!(semiE1Mm > 0 && semiE2Mm > 0)) throw new RangeError(`connector: ellipse semi-axes must be > 0, got ${semiE1Mm}, ${semiE2Mm}`);
  if (!(Number.isInteger(segments) && segments >= 3)) throw new RangeError(`connector: ellipse segments must be an integer >= 3, got ${segments}`);
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    out.push([semiE1Mm * Math.cos(theta), semiE2Mm * Math.sin(theta)]);
  }
  return out;
}

/** The closed-form polygon area (mm²) of `makeEllipseConnectorProfile(a,b,n)` —
 * `½·n·a·b·sin(2π/n)` — the analytic golden the area instrument is validated
 * against (an inscribed regular-in-angle ellipse polygon). */
export function ellipseConnectorProfileAreaMm2(semiE1Mm: number, semiE2Mm: number, segments: number): number {
  return 0.5 * segments * semiE1Mm * semiE2Mm * Math.sin((2 * Math.PI) / segments);
}

// ---------------------------------------------------------------------------
// The connector frame
// ---------------------------------------------------------------------------

/**
 * Build a `ConnectorFrame` from an origin on the axis (the profileA plane), the
 * axis direction (need not be unit — normalized here), and the axial span to the
 * profileB plane. The in-plane (e1,e2) basis is the canonical
 * `section/plane.ts#normalizePlane` frame for the axis normal — the SAME basis
 * the area instrument's `projectToPlaneXY` uses, so profiles and mesh sections
 * share one coordinate frame. Deterministic.
 *
 * @throws {DegeneratePlaneError} (section/plane.ts) if `axis` is (near-)zero.
 * @throws {RangeError} if `spanMm <= 0`.
 */
export function buildConnectorFrame(originMm: Vec3, axisMm: Vec3, spanMm: number): ConnectorFrame {
  if (!(spanMm > 0)) throw new RangeError(`connector: spanMm must be > 0, got ${spanMm}`);
  const plane: Plane = { point: originMm, normal: axisMm };
  const basis = normalizePlane(plane); // throws DegeneratePlaneError on a zero axis
  return { originMm, axis: basis.normal, e1: basis.e1, e2: basis.e2, spanMm };
}

// ---------------------------------------------------------------------------
// The loft (a deterministic watertight ruled solid)
// ---------------------------------------------------------------------------

/** Ear-clip a SIMPLE polygon given as 2D (u,v) into index triples into `poly`
 * (orientation-agnostic — normalizes to CCW). O(n²), n tiny. The same
 * well-established algorithm the section/cavity fixtures keep local (the
 * margin/validate.ts "small algorithm kept auditable in-file" convention). */
function earClip(poly: readonly Vec2[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) area2 += cross2(poly[i]!, poly[(i + 1) % n]!);
  if (area2 < 0) idx.reverse();
  const cross = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean => {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  const tris: [number, number, number][] = [];
  const v = idx.slice();
  let guard = 0;
  while (v.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!;
      const b = v[i]!;
      const c = v[(i + 1) % v.length]!;
      if (cross(poly[a]!, poly[b]!, poly[c]!) <= 0) continue;
      let anyInside = false;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        if (inTri(poly[p]!, poly[a]!, poly[b]!, poly[c]!)) {
          anyInside = true;
          break;
        }
      }
      if (anyInside) continue;
      tris.push([a, b, c]);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) tris.push([v[0]!, v[1]!, v[2]!]);
  return tris;
}

/**
 * Loft a deterministic watertight ruled solid between two closed profiles (the
 * connector). Correspondence rule (this module's doc): vertices are paired BY
 * INDEX, so the profiles MUST have equal vertex counts and the SAME winding.
 * Side walls connect corresponding edges; the two profile polygons are ear-clip
 * end caps. The raw triangle soup is run once through
 * `orientNormalsConsistently` (the fixture's assembly pattern) for a single
 * outward-wound watertight manifold. Deterministic, Float64.
 *
 * ## Simple-section precondition (the pairing, not just each profile)
 *
 * Each profile is validated SIMPLE in 2D, but their index-PAIRING is not: an
 * adversarial pairing (e.g. corresponding vertices that ring the two profiles in
 * crossing orders) yields a SELF-INTERSECTING ruled surface even from two simple
 * profiles. That surface is still a closed watertight mesh (this loft always
 * produces one), but its perpendicular sections become NON-SIMPLE — for which the
 * area instrument's never-over-report proof (which needs a fixed simple-polygon
 * cut-set, `|shoelace| = enclosed area`) lapses. This op does not reject such a
 * loft (the mesh is topologically valid); the AREA instrument
 * (`measureConnectorMinArea`) is where the guard lives — it checks each sampled
 * section is a single simple polygon and throws `NonSimpleConnectorSectionError`
 * rather than report a bogus area. The default + moderate-twist envelope produces
 * simple sections and is unaffected.
 *
 * @throws {ProfileVertexCountMismatchError} if the counts differ.
 * @throws {ProfileWindingMismatchError} if the windings differ.
 * @throws {NonClosedProfileError}/{DegenerateProfileError}/{SelfIntersectingProfileError}
 * (validation of each profile).
 */
export function loftConnectorProfiles(
  profileA: ConnectorProfile2D,
  profileB: ConnectorProfile2D,
  frame: ConnectorFrame,
): LoftConnectorResult {
  const infoA = validateConnectorProfile(profileA);
  const infoB = validateConnectorProfile(profileB);
  if (infoA.vertexCount !== infoB.vertexCount) {
    throw new ProfileVertexCountMismatchError(infoA.vertexCount, infoB.vertexCount);
  }
  if (infoA.ccw !== infoB.ccw) throw new ProfileWindingMismatchError();

  const n = infoA.vertexCount;
  // Vertices: ring A (station 0) then ring B (station span). 2N vertices.
  const positions: number[] = [];
  for (const p of profileA) {
    const q = profilePointTo3D(frame, p, 0);
    positions.push(q[0], q[1], q[2]);
  }
  for (const p of profileB) {
    const q = profilePointTo3D(frame, p, frame.spanMm);
    positions.push(q[0], q[1], q[2]);
  }
  const triangles: number[] = [];
  // Side walls: for edge i→(i+1), quad (A_i, A_j, B_j, B_i) → 2 tris.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ai = i;
    const aj = j;
    const bi = n + i;
    const bj = n + j;
    triangles.push(ai, aj, bj);
    triangles.push(ai, bj, bi);
  }
  // End caps: ear-clip each profile (indices map into ring A [0..n) / ring B [n..2n)).
  for (const [x, y, z] of earClip(profileA)) triangles.push(x, y, z);
  for (const [x, y, z] of earClip(profileB)) triangles.push(n + x, n + y, n + z);

  const oriented = orientNormalsConsistently({
    positions: new Float64Array(positions),
    indices: new Uint32Array(triangles),
  }).mesh;
  return { mesh: oriented, profileACcw: infoA.ccw, profileBCcw: infoB.ccw, vertexCount: n };
}

// ---------------------------------------------------------------------------
// The area instrument — the exact closed-form quadratic minimum
// ---------------------------------------------------------------------------

/**
 * The cross-section-area quadratic `A(t)=a·t²+b·t+c` (mm²) of the ruled loft
 * between `profileA` (t=0) and `profileB` (t=1), corresponding vertices paired
 * by index. Both profiles are taken with the SAME winding (a caller passes
 * matched-winding profiles; the SIGNED area is used, so a consistently-CW pair
 * yields a negative quadratic whose |·| is the area — `analyticConnectorMinArea`
 * takes absolute values). Derivation (this module's doc): `R_i(t)=A_i+t·D_i`
 * with `D_i=B_i−A_i`, `A(t)=½Σ cross2(R_i,R_{i+1})` expands term-by-term into
 * the closed-form coefficients below.
 *
 * @throws {ProfileVertexCountMismatchError} if the counts differ.
 */
export function connectorAreaQuadratic(profileA: ConnectorProfile2D, profileB: ConnectorProfile2D): ConnectorAreaQuadratic {
  const n = profileA.length;
  if (n !== profileB.length) throw new ProfileVertexCountMismatchError(n, profileB.length);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const Ai = profileA[i]!;
    const Aj = profileA[j]!;
    const Bi = profileB[i]!;
    const Bj = profileB[j]!;
    const Di: Vec2 = [Bi[0] - Ai[0], Bi[1] - Ai[1]];
    const Dj: Vec2 = [Bj[0] - Aj[0], Bj[1] - Aj[1]];
    c += cross2(Ai, Aj);
    b += cross2(Ai, Dj) + cross2(Di, Aj);
    a += cross2(Di, Dj);
  }
  return { a: a / 2, b: b / 2, c: c / 2 };
}

/** Minimum of |A(t)| over t∈[0,1] for the (consistently-signed) area quadratic —
 * candidates are the endpoints and, when the parabola opens toward the sign of
 * its values with an interior vertex, `t*=−b/2a`. Because a non-degenerate loft
 * keeps a single winding sign across [0,1] (the ruled rings never invert), |A|
 * has the same extremum structure as A itself; we minimize |A| over
 * {0, 1, clamp(−b/2a)}. */
function minAbsQuadratic(q: ConnectorAreaQuadratic): { value: number; atT: number } {
  const at = (t: number): number => Math.abs(q.a * t * t + q.b * t + q.c);
  let bestT = 0;
  let bestV = at(0);
  const v1 = at(1);
  if (v1 < bestV) {
    bestV = v1;
    bestT = 1;
  }
  if (q.a !== 0) {
    const tv = -q.b / (2 * q.a);
    if (tv > 0 && tv < 1) {
      const vv = at(tv);
      if (vv < bestV) {
        bestV = vv;
        bestT = tv;
      }
    }
  }
  return { value: bestV, atT: bestT };
}

/**
 * The EXACT continuous minimum cross-section area (mm²) of the ruled loft over
 * the whole connector — the gate value. Closed-form from `connectorAreaQuadratic`
 * (see this module's @errorBound: no station error, cannot over-report).
 */
export function analyticConnectorMinArea(
  profileA: ConnectorProfile2D,
  profileB: ConnectorProfile2D,
  spanMm: number,
): ConnectorAnalyticMinArea {
  const quadratic = connectorAreaQuadratic(profileA, profileB);
  const { value, atT } = minAbsQuadratic(quadratic);
  return { minAreaMm2: value, atT, atStationMm: atT * spanMm, quadratic };
}

// ---------------------------------------------------------------------------
// The secondary sampled instrument (mesh sectioning — live readout + hazard demo)
// ---------------------------------------------------------------------------

/** Project a section polyline's 3D points onto the frame's (e1,e2) — a 2D ring. */
function sectionPolylineUV(pointsFlat: Float64Array, e1: Vec3, e2: Vec3): Vec2[] {
  const m = pointsFlat.length / 3;
  const uv: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const x = pointsFlat[i * 3]!;
    const y = pointsFlat[i * 3 + 1]!;
    const z = pointsFlat[i * 3 + 2]!;
    uv.push([x * e1[0] + y * e1[1] + z * e1[2], x * e2[0] + y * e2[1] + z * e2[2]]);
  }
  return uv;
}

/** |shoelace area| (mm²) of a 2D ring. */
function ringAreaMm2(uv: readonly Vec2[]): number {
  let a2 = 0;
  const m = uv.length;
  for (let i = 0; i < m; i++) a2 += cross2(uv[i]!, uv[(i + 1) % m]!);
  return Math.abs(a2) / 2;
}

/** Is a closed 2D ring SIMPLE (no two non-adjacent edges properly cross)? The
 * same proper-intersection scan `validateConnectorProfile` uses. */
function closedRingIsSimple(uv: readonly Vec2[]): boolean {
  const n = uv.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = uv[i]!;
    const a2 = uv[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      if (segmentsProperlyIntersect(a1, a2, uv[j]!, uv[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

export interface SampleConnectorAreasOptions {
  /** Interior sampling stations along the axis (>= 1). Default 63. Stations are
   * strictly interior — `s_k = span·k/(stationCount+1)`, k=1..stationCount —
   * avoiding the caps (a perpendicular plane at s=0/span grazes a coplanar
   * cap → no reliable section). */
  readonly stationCount?: number;
}

/**
 * The sampled instrument: section the connector SOLID perpendicular to the axis
 * at `stationCount` dense INTERIOR stations, bracketed by the two EXACT profile
 * caps (`|A(0)| = |c|` and `|A(1)| = |a+b+c|` from `quadratic`) — the full sample
 * set is equally spaced in the axial parameter (`Δt = 1/(stationCount+1)`), which
 * is what makes the station-margin below rigorous. Deterministic; live-readout-
 * capable (runtime reported by the tests).
 *
 * ## The rigorous station margin (why second differences, not a Lipschitz guess)
 *
 * On the interior of a single ruled connector segment every section vertex moves
 * linearly with the axial parameter over a FIXED set of cut edges, so the real
 * triangulated solid's cross-section-area function `A_mesh(t)` is a single
 * QUADRATIC in `t` (each shoelace term is a product of two linear-in-t
 * coordinates), and the caps are its exact endpoint limits. For a quadratic
 * sampled at equal spacing `Δt`, the constant second difference is
 * `A_{k−1} − 2A_k + A_{k+1} = 2·A''·(Δt/2)²·2` and the MOST the curve can dip
 * below the nearer of two adjacent samples (a vertex exactly between them) is
 * `|A''|·(Δt/2)² = |secondDifference| / 8`. So `max_k |A_{k−1} − 2A_k + A_{k+1}|/8`
 * is a RIGOROUS, mesh-general bound on how far a between-station waist can lie
 * below the sampled min — `guaranteedLowerBoundMm2 = minAreaMm2 − thatMargin`
 * therefore provably never over-reports the actual solid's minimum. (Falsifiably
 * demonstrated in connector.test.ts: a waist between coarse stations makes the
 * raw sampled min over-report, and the guaranteed bound stays ≤ the true min.)
 */
export function sampleConnectorCrossSectionAreas(
  mesh: IndexedMesh,
  frame: ConnectorFrame,
  quadratic: ConnectorAreaQuadratic,
  options: SampleConnectorAreasOptions = {},
): SampledConnectorAreas {
  const stationCount = options.stationCount ?? 63;
  if (!(Number.isInteger(stationCount) && stationCount >= 1)) {
    throw new RangeError(`connector: stationCount must be an integer >= 1, got ${stationCount}`);
  }
  const span = frame.spanMm;
  const capA = Math.abs(quadratic.c); // |A(t=0)| — exact profile-A polygon area
  const capB = Math.abs(quadratic.a + quadratic.b + quadratic.c); // |A(t=1)|
  const stationsMm: number[] = [0];
  const areasMm2: number[] = [capA];
  // Simple-section guard: a valid (non-self-intersecting) ruled loft sections into
  // EXACTLY ONE simple closed loop per interior station; anything else means the
  // pairing self-intersects and the area/bound are bogus (see the module
  // @errorBound + the loft doc's simple-section precondition).
  let sectionsSimple = true;
  let firstNonSimpleStationMm: number | null = null;
  for (let k = 1; k <= stationCount; k++) {
    const s = (span * k) / (stationCount + 1);
    const point = add3(frame.originMm, scale3(frame.axis, s));
    const { polylines } = sectionMesh(mesh, { point, normal: frame.axis });
    const closedLoops = polylines.filter((pl) => pl.closed);
    let area = 0;
    for (const pl of closedLoops) area += ringAreaMm2(sectionPolylineUV(pl.points, frame.e1, frame.e2));
    // A simple connector section is one simple closed loop. More than one loop, or
    // a single self-crossing loop, flags a self-intersecting ruled surface.
    const simpleHere =
      closedLoops.length === 1 && closedRingIsSimple(sectionPolylineUV(closedLoops[0]!.points, frame.e1, frame.e2));
    if (!simpleHere && sectionsSimple) {
      sectionsSimple = false;
      firstNonSimpleStationMm = s;
    }
    stationsMm.push(s);
    areasMm2.push(area);
  }
  stationsMm.push(span);
  areasMm2.push(capB);

  let minAreaMm2 = Number.POSITIVE_INFINITY;
  let minStationMm = 0;
  for (let i = 0; i < areasMm2.length; i++) {
    if (areasMm2[i]! < minAreaMm2) {
      minAreaMm2 = areasMm2[i]!;
      minStationMm = stationsMm[i]!;
    }
  }
  // Rigorous second-difference station margin (see this function's doc).
  let stationMarginMm2 = 0;
  for (let k = 1; k < areasMm2.length - 1; k++) {
    const secondDiff = Math.abs(areasMm2[k - 1]! - 2 * areasMm2[k]! + areasMm2[k + 1]!) / 8;
    if (secondDiff > stationMarginMm2) stationMarginMm2 = secondDiff;
  }
  const stationSpacingMm = span / (stationCount + 1);
  return {
    stationCount,
    stationSpacingMm,
    minAreaMm2,
    minStationMm,
    areasMm2,
    stationsMm,
    stationMarginMm2,
    guaranteedLowerBoundMm2: minAreaMm2 - stationMarginMm2,
    sectionsSimple,
    firstNonSimpleStationMm,
  };
}

/**
 * Measure the connector's minimum cross-section area — THE GATE VALUE
 * (`sampled.guaranteedLowerBoundMm2`, the fail-safe mesh lower bound) PLUS the
 * closed-form validation oracle (`analytic`) PLUS the tessellation cross-check.
 * See this module's @errorBound. Deterministic.
 *
 * GUARD (the simple-section precondition): if any sampled section is non-simple
 * (a self-intersecting ruled surface from an adversarial editable pairing — see
 * the loft doc), the never-over-report bound is invalid, so this REFUSES rather
 * than report a bogus area.
 *
 * @throws {NonSimpleConnectorSectionError} if a sampled section is non-simple.
 */
export function measureConnectorMinArea(
  mesh: IndexedMesh,
  frame: ConnectorFrame,
  profileA: ConnectorProfile2D,
  profileB: ConnectorProfile2D,
  options: SampleConnectorAreasOptions = {},
): MeasureConnectorMinAreaResult {
  const analytic = analyticConnectorMinArea(profileA, profileB, frame.spanMm);
  const sampled = sampleConnectorCrossSectionAreas(mesh, frame, analytic.quadratic, options);
  if (!sampled.sectionsSimple) {
    // Determine the offending loop count at the first non-simple station for the
    // diagnostic (re-section once; cheap, only on the refusal path).
    const s = sampled.firstNonSimpleStationMm!;
    const point = add3(frame.originMm, scale3(frame.axis, s));
    const loopCount = sectionMesh(mesh, { point, normal: frame.axis }).polylines.filter((pl) => pl.closed).length;
    throw new NonSimpleConnectorSectionError(s, loopCount);
  }
  // Tessellation cross-check over the INTERIOR mesh sections only (indices 1..n-2;
  // 0 and last are the exact analytic caps): |meshSection_k − analytic(t_k)|.
  let maxAbs = 0;
  for (let k = 1; k < sampled.stationsMm.length - 1; k++) {
    const t = sampled.stationsMm[k]! / frame.spanMm;
    const ideal = Math.abs(analytic.quadratic.a * t * t + analytic.quadratic.b * t + analytic.quadratic.c);
    maxAbs = Math.max(maxAbs, Math.abs(sampled.areasMm2[k]! - ideal));
  }
  return {
    minAreaMm2: sampled.guaranteedLowerBoundMm2,
    atStationMm: sampled.minStationMm,
    analytic,
    sampled,
    sampledVsAnalyticMaxAbsMm2: maxAbs,
  };
}

/** Total axial length of a placed connector (mm) — convenience for callers
 * echoing the frame's span. */
export function connectorAxialLengthMm(frame: ConnectorFrame): number {
  return frame.spanMm * len3(frame.axis);
}
