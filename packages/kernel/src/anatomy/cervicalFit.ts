// packages/kernel/src/anatomy/cervicalFit.ts
//
// Phase 10 Task 4 (ADR-023 Decision 2) — the CERVICAL FIT: moves a placed
// library template's cervical ring onto the EMERGENCE LOOP, so the crown
// emerges from the margin with full material thickness instead of the
// placement's cervix landing wherever the template's widest section put it.
// It runs after placement and before the contact morph, as its own journaled
// op (placement and morph are unchanged).
//
// ## The emergence outline (ADR-024 Decision 1, Phase 11 Task 1)
//
// Let P be the region the confirmed margin bounds, projected onto the plane
// normal to the insertion axis (origin at the margin centroid). The
// emergence outline is the boundary of P dilated by `emergenceOffsetMm` = d
// (the caller passes the intaglio's gap plus the material's minimum wall,
// both from the profile — no clinical value is defaulted here): the points
// exactly d from P, normal to the axis.
//
//  - It never folds. The fit requires P star-shaped around the centroid (the
//    margin's azimuths strictly monotone, one turn), and then so is P ⊕ D(d):
//    the outline has exactly one point per azimuth, at the radius
//    R(θ) = sup { t : dist(t·e(θ), P) ≤ d }. (ADR-023's pointwise offset —
//    each point moved along its own normal — folded on concavities tighter
//    than d and on point-to-point noise: on a real margin it reversed.)
//  - It is exact, in closed form. Along a ray, the points within d of one
//    margin segment form an interval (the ray inside the segment's capsule),
//    so R(θ) is the largest capsule exit over the segments: the larger root
//    of a quadratic for each end disk, and a linear solve for each offset
//    line, clipped to the segment's slab.
//  - Height (ADR-025 Decision 1): the outline point at azimuth θ takes the
//    margin's height where the ray at θ crosses the margin's projection
//    (linear along the crossed segment). The margin is star-shaped, so the
//    height is a CONTINUOUS function of θ, and at a margin point's own
//    azimuth it is exactly that point's height — ADR-023's "each point at
//    its own height", for every margin. (ADR-024 took the NEAREST margin
//    point's height, which steps inside a filled concavity — up to 163 µm on
//    real arch-case-01 tooth 11 — and is off a point's own height on any
//    non-circular, non-planar margin.)
//
// `emergenceLoop` returns R(θ) at every (deduplicated) margin point's
// azimuth — star-shaped by construction. The fit's ring targets are R(θ)
// evaluated exactly at each ring vertex's azimuth.
//
// ## The fit
//
// Each ring vertex is paired, BY AZIMUTH around the axis through the margin
// centroid, with the emergence outline's point at that azimuth. The ring and
// the margin must be star-shaped around the centroid (their azimuths
// strictly monotone, one turn) — otherwise the pairing is ambiguous and the
// fit refuses (`CervicalFitError`); the outline then is by construction. A deterministic RBF (rbf/rbf.ts: φ(r) = r with its
// affine term, direct solve) interpolates the ring displacements with ZERO
// displacement at the anchors: every template vertex in the band
// [B, B + `anchorBandMm`] above the BLEND HEIGHT B (the highest of the ring
// and its targets, plus `cervicalBlendMm`). The field moves only vertices
// BELOW B; at and above B the template is untouched, bit for bit.
//
// A fold the fit may cause in a thin or oddly-shaped template is NOT hidden:
// the shell's self-intersection and minimum-wall gates measure it.
//
// @errorBound The emergence outline itself: floating-point rounding only
// (closed form; asserted at 1e-12 mm against dist(·, P) = d). The fitted ring
// versus the emergence loop: the larger of the greatest distance from a
// fitted ring vertex to the loop polyline and from a loop point to the
// fitted ring polyline (`errorBoundMm`). The vertex targets lie ON the exact
// outline (the RBF interpolates its controls to solver precision), so the
// bound is dominated by the chord between ring vertices — the ring's
// tessellation, which is the template's own resolution — plus how far the
// outline bulges past the loop's chords between margin points (on the
// Phase 10 192-gon, d(1 − cos(π/192)) ≈ 0.09 µm). Reported with the fit; the
// gates that read the crown measure the result anyway.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { dedupLoop, MARGIN_DEDUP_EPSILON_MM } from '../offset/innerSurfaceSolid.ts';
import { fitRbf, evaluateRbf, type RbfControlPoint } from '../rbf/rbf.ts';
import { closedEdgeLoopProblem } from '../mesh/edgeLoop.ts';
import { DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM } from '../shell/shell.ts';
import { detAtan2 } from '../math/detMath.ts';

export { closedEdgeLoopProblem } from '../mesh/edgeLoop.ts';

/** How far above the ring (and its targets) the template starts to stay
 * fixed (mm) — an ALGORITHM default, journaled with the fit. About the
 * cervical third of an incisor crown: the contact level and above keep the
 * template's shape. */
export const DEFAULT_CERVICAL_BLEND_MM = 2.0;
/** Height of the anchor band above the blend line (mm). */
export const DEFAULT_CERVICAL_ANCHOR_BAND_MM = 1.0;
/** Cap on anchors (deterministic stride subsample) — bounds the dense solve. */
export const DEFAULT_CERVICAL_MAX_ANCHORS = 256;
/** Ring refinement rounds (ADR-025 Decision 2) — an ALGORITHM default: at
 * most 2³ = 8× the template's ring. */
export const DEFAULT_MAX_RING_REFINE_LEVELS = 3;

/** A design margin (mm) on top of the emergence offset's sum, so the
 * designed wall lies strictly above the minimum-wall gate's conservative
 * bound rather than ON it, where rounding decides — 1 µm, the display
 * resolution. */
export const CERVICAL_EMERGENCE_DESIGN_MARGIN_MM = 0.001;

/**
 * The emergence offset for a crown (mm): how far outside the margin, normal
 * to the axis, the fitted cervical ring sits. Built from the profile's
 * clinical values (passed in, never defaulted here):
 *
 *  - the LARGER of the marginal and cement gaps — the intaglio may stand off
 *    the die by either, so the wall above the ring is at least the offset
 *    minus this;
 *  - the material's minimum wall thickness;
 *  - the minimum-wall gate's fail-safe sampling margin
 *    ({@link DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM}): the gate subtracts
 *    its sample spacing before comparing, so the emergence wall is built to
 *    clear that conservative bound, not merely the nominal minimum;
 *  - {@link CERVICAL_EMERGENCE_DESIGN_MARGIN_MM}, so it clears it strictly.
 */
export function cervicalEmergenceOffsetMm(params: {
  readonly marginalGapMm: number;
  readonly cementGapMm: number;
  readonly minWallThicknessMm: number;
}): number {
  const { marginalGapMm, cementGapMm, minWallThicknessMm } = params;
  for (const [name, v] of Object.entries(params)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`cervicalEmergenceOffsetMm: ${name} must be a finite mm value ≥ 0 (got ${v})`);
  }
  return (
    Math.max(marginalGapMm, cementGapMm) +
    minWallThicknessMm +
    DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM +
    CERVICAL_EMERGENCE_DESIGN_MARGIN_MM
  );
}

export type CervicalFitErrorReason =
  | 'ring-not-edge-loop'
  | 'ring-not-star-shaped'
  | 'margin-not-star-shaped'
  | 'degenerate-margin'
  | 'no-anchors';

/** The fit refuses, with the reason (never a silent partial fit). */
export class CervicalFitError extends Error {
  readonly reason: CervicalFitErrorReason;
  constructor(reason: CervicalFitErrorReason, detail: string) {
    super(`cervicalFit: ${reason} — ${detail}`);
    this.name = 'CervicalFitError';
    this.reason = reason;
  }
}

export interface CervicalFitInput {
  /** The PLACED template (world space), closed. Not mutated. */
  readonly mesh: IndexedMesh;
  /** The template's cervical ring: ordered vertex indices forming a closed
   * edge loop of `mesh`. */
  readonly cervicalRing: readonly number[];
  /** The confirmed margin loop (closed polyline, world space). */
  readonly marginLoop: readonly Vec3[];
  /** Points occlusally; normalized here. */
  readonly insertionAxis: Vec3;
  /** Marginal gap + the material's minimum wall thickness (mm), from the
   * profile. */
  readonly emergenceOffsetMm: number;
  /** The fit's residual bound (mm), from the profile
   * (`CERVICAL_FIT_MAX_RESIDUAL_MM`; never defaulted here). When given, the
   * fit refines the cervical ring where its chords cannot follow the
   * outline within it (ADR-025 Decision 2); absent, the ring is used as is. */
  readonly maxResidualMm?: number;
}

export interface CervicalFitOptions {
  readonly cervicalBlendMm?: number;
  readonly anchorBandMm?: number;
  readonly maxAnchors?: number;
  /** Cap on ring refinement rounds (each can double an edge) — default
   * {@link DEFAULT_MAX_RING_REFINE_LEVELS}; journaled with the fit. */
  readonly maxRingRefineLevels?: number;
}

export interface CervicalFitResult {
  /** The fitted template: same topology, the cervical region moved. */
  readonly mesh: IndexedMesh;
  readonly emergenceLoop: Vec3[];
  /** The ring vertices' targets on the emergence loop, in ring order. */
  readonly ringTargets: Vec3[];
  /** @errorBound — see the module doc (mm). */
  readonly errorBoundMm: number;
  readonly ringToLoopMm: number;
  readonly loopToRingMm: number;
  /** Largest ring vertex displacement (mm) — how far the template was off. */
  readonly maxRingDisplacementMm: number;
  /** The ring vertex count after refinement (= `cervicalRing.length`). */
  readonly ringVertexCount: number;
  /** The (refined) cervical ring: its vertex indices in the output mesh, in
   * ring order — the morph's fixed vertices and the shell's trim ring. The
   * template's own ring when nothing was refined. */
  readonly cervicalRing: number[];
  /** Refinement rounds that split at least one edge (0: the ring as is). */
  readonly ringRefineLevels: number;
  readonly anchorCount: number;
  readonly movedVertexCount: number;
  /** The margin centroid the azimuths and heights are measured from. */
  readonly marginCentroid: Vec3;
  /** The blend line's height above the centroid along the axis (mm). */
  readonly blendHeightMm: number;
  readonly emergenceOffsetMm: number;
  readonly cervicalBlendMm: number;
}

function unitAxis(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (!(len > 0)) throw new TypeError('cervicalFit: insertionAxis must be non-zero');
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** A plane basis ⟂ `axis` (any; every result is basis-independent). */
function planeBasis(axis: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u: Vec3 = [ref[1] * axis[2] - ref[2] * axis[1], ref[2] * axis[0] - ref[0] * axis[2], ref[0] * axis[1] - ref[1] * axis[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  return { u, v };
}

function centroidOf(points: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}

interface Frame {
  readonly c: Vec3;
  readonly axis: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
}

function project(f: Frame, p: Vec3): [number, number] {
  const dx = p[0] - f.c[0], dy = p[1] - f.c[1], dz = p[2] - f.c[2];
  return [dx * f.u[0] + dy * f.u[1] + dz * f.u[2], dx * f.v[0] + dy * f.v[1] + dz * f.v[2]];
}

function heightOf(f: Frame, x: number, y: number, z: number): number {
  return (x - f.c[0]) * f.axis[0] + (y - f.c[1]) * f.axis[1] + (z - f.c[2]) * f.axis[2];
}

/** +1 / −1 for a strictly monotone, single-turn azimuth sequence around the
 * frame origin; 0 otherwise (not star-shaped). */
function windingOrientation(points2d: ReadonlyArray<readonly [number, number]>): 1 | -1 | 0 {
  const n = points2d.length;
  let total = 0;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points2d[i]!, b = points2d[(i + 1) % n]!;
    if (a[0] === 0 && a[1] === 0) return 0;
    let d = detAtan2(b[1], b[0]) - detAtan2(a[1], a[0]);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d <= -Math.PI) d += 2 * Math.PI;
    const s = Math.sign(d);
    if (s === 0) return 0;
    if (sign === 0) sign = s;
    else if (s !== sign) return 0;
    total += d;
  }
  if (Math.abs(Math.abs(total) - 2 * Math.PI) > 1e-6) return 0;
  return sign > 0 ? 1 : -1;
}

/** The margin without consecutive repeated points (within the weld
 * epsilon), the closing one included — the rule every margin consumer
 * applies (`dedupLoop`): a resampled margin shares a point at each segment
 * boundary, and a repeat would read as a zero azimuth step. */
function cleanMargin(marginLoop: readonly Vec3[]): Vec3[] {
  return marginLoop.length > 0 ? dedupLoop(marginLoop, MARGIN_DEDUP_EPSILON_MM) : [];
}

/** The largest t ≥ 0 at which the ray t·(ex, ey) is still within `d` of the
 * segment a–b — the exit from the segment's capsule (−∞ if the ray misses
 * it). The capsule is the union of the two end disks and the rectangle
 * between the offset lines, so its exit is the largest of theirs. */
function capsuleExit(ax: number, ay: number, bx: number, by: number, ex: number, ey: number, d: number): number {
  let best = -Infinity;
  const dd = d * d;
  // End disks: |t·e − p|² ≤ d², the larger root.
  for (const [px, py] of [[ax, ay], [bx, by]] as const) {
    const pe = px * ex + py * ey;
    const disc = pe * pe - (px * px + py * py - dd);
    if (disc >= 0) best = Math.max(best, pe + Math.sqrt(disc));
  }
  // The rectangle: 0 ≤ s·(x − a) ≤ L and |n·(x − a)| ≤ d along x = t·e.
  const sx = bx - ax, sy = by - ay;
  const len = Math.hypot(sx, sy);
  if (!(len > 0)) return best;
  const ux = sx / len, uy = sy / len;
  let lo = -Infinity, hi = Infinity;
  // Each constraint: low ≤ t·k − c ≤ high.
  const clip = (k: number, c: number, low: number, high: number): void => {
    if (k === 0) {
      if (-c < low || -c > high) hi = -Infinity;
      return;
    }
    const t0 = (low + c) / k, t1 = (high + c) / k;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  };
  clip(ux * ex + uy * ey, ux * ax + uy * ay, 0, len);
  clip(uy * ex - ux * ey, uy * ax - ux * ay, -d, d);
  if (lo <= hi) best = Math.max(best, hi);
  return best;
}

/**
 * The emergence outline's radius at the azimuth of the unit 2-D direction
 * `dir`, and its height — ADR-024 Decision 1 (see the module doc). `q` is the
 * margin projected into the frame (origin at its centroid, star-shaped
 * around it), `heights` the margin points' heights along the axis. Exported
 * for the kernel's own tests; not part of the package API.
 *
 * @errorBound floating-point rounding only (closed form).
 */
export function emergenceRadius(
  q: ReadonlyArray<readonly [number, number]>,
  heights: readonly number[],
  dir: readonly [number, number],
  d: number,
): { radius: number; height: number } {
  const n = q.length;
  const [ex, ey] = dir;
  let radius = -Infinity;
  let generator = -1;
  for (let i = 0; i < n; i++) {
    const a = q[i]!, b = q[(i + 1) % n]!;
    const t = capsuleExit(a[0], a[1], b[0], b[1], ex, ey, d);
    if (t > radius) {
      radius = t;
      generator = i;
    }
  }
  // The origin lies inside a star-shaped P, so every ray leaves some capsule
  // beyond it; anything else is a caller bug, not a clinical refusal.
  if (generator < 0 || !(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`cervicalFit: no emergence radius at direction (${ex}, ${ey}) — the margin frame is invalid`);
  }
  return { radius, height: marginHeightAt(q, heights, dir) };
}

/** The margin's height where the ray from the frame origin along the unit
 * `dir` crosses the margin's projection `q` (ADR-025 Decision 1): linear
 * along the crossed segment. `q` is star-shaped around the origin, so the
 * crossing is unique and the height continuous in azimuth; at a margin
 * point's own azimuth it is that point's height. A ray through a vertex
 * may land a rounding-hair outside both adjacent segments' parameter
 * ranges: the segment it misses least is taken (first on a tie), with its
 * parameter clamped to [0, 1] — both give the vertex's height. */
function marginHeightAt(q: ReadonlyArray<readonly [number, number]>, heights: readonly number[], dir: readonly [number, number]): number {
  const n = q.length;
  const [ex, ey] = dir;
  let bestMiss = Infinity;
  let height = NaN;
  for (let i = 0; i < n; i++) {
    const a = q[i]!, b = q[(i + 1) % n]!;
    const sx = b[0] - a[0], sy = b[1] - a[1];
    const den = ex * sy - ey * sx;
    if (den === 0) continue;
    const s = (a[0] * ey - a[1] * ex) / den;
    const t = (a[0] * sy - a[1] * sx) / den;
    if (!(t > 0)) continue;
    const miss = s < 0 ? -s : s > 1 ? s - 1 : 0;
    if (miss < bestMiss) {
      bestMiss = miss;
      const sc = Math.min(1, Math.max(0, s));
      const ha = heights[i]!, hb = heights[(i + 1) % n]!;
      height = ha + sc * (hb - ha);
      if (miss === 0) break;
    }
  }
  if (!Number.isFinite(height)) {
    throw new Error(`cervicalFit: the ray (${ex}, ${ey}) does not cross the margin — the margin frame is invalid`);
  }
  return height;
}

/** The margin in its frame, validated star-shaped: the shared front of
 * `emergenceLoop` and `fitCervicalRing`. */
interface MarginFrame {
  readonly f: Frame;
  readonly q: Array<[number, number]>;
  readonly heights: number[];
}

function marginFrame(marginLoopIn: readonly Vec3[], insertionAxis: Vec3, offsetMm: number): MarginFrame {
  if (!(offsetMm > 0) || !Number.isFinite(offsetMm)) {
    throw new RangeError(`cervicalFit: emergence offset must be a positive finite mm value (got ${offsetMm})`);
  }
  const marginLoop = cleanMargin(marginLoopIn);
  const n = marginLoop.length;
  if (n < 3) throw new CervicalFitError('degenerate-margin', `${n} margin point(s)`);
  const axis = unitAxis(insertionAxis);
  const { u, v } = planeBasis(axis);
  const f: Frame = { c: centroidOf(marginLoop), axis, u, v };
  const q = marginLoop.map((p) => project(f, p));
  if (windingOrientation(q) === 0) {
    throw new CervicalFitError('margin-not-star-shaped', 'the margin does not wind once, monotonically, around its centroid');
  }
  return { f, q, heights: marginLoop.map((p) => heightOf(f, p[0], p[1], p[2])) };
}

/** The outline point at the azimuth of the 2-D frame point (x, y) ≠ 0. */
function outlinePoint(m: MarginFrame, x: number, y: number, d: number): Vec3 {
  const len = Math.hypot(x, y);
  const ex = x / len, ey = y / len;
  const { radius, height } = emergenceRadius(m.q, m.heights, [ex, ey], d);
  const { c, axis, u, v } = m.f;
  const px = radius * ex, py = radius * ey;
  return [
    c[0] + (px * u[0] + py * v[0]) + height * axis[0],
    c[1] + (px * u[1] + py * v[1]) + height * axis[1],
    c[2] + (px * u[2] + py * v[2]) + height * axis[2],
  ];
}

/**
 * The emergence loop: the exact emergence outline (the margin's projection
 * dilated by `offsetMm`, normal to `insertionAxis`) sampled at every
 * deduplicated margin point's azimuth — see the module doc.
 *
 * @throws {CervicalFitError} 'degenerate-margin' (fewer than 3 points) or
 * 'margin-not-star-shaped' (the MARGIN; its outline is star-shaped by
 * construction).
 * @errorBound floating-point rounding only (closed form).
 */
export function emergenceLoop(marginLoopIn: readonly Vec3[], insertionAxis: Vec3, offsetMm: number): Vec3[] {
  const m = marginFrame(marginLoopIn, insertionAxis, offsetMm);
  return m.q.map(([x, y]) => outlinePoint(m, x, y, offsetMm));
}

function vertexOf(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

/** The outline point at the azimuth of 2-D frame point (x, y), in FRAME
 * coordinates (u, v, height). */
function outlineFrame(m: MarginFrame, x: number, y: number, d: number): Vec3 {
  const len = Math.hypot(x, y);
  const ex = x / len, ey = y / len;
  const { radius, height } = emergenceRadius(m.q, m.heights, [ex, ey], d);
  return [radius * ex, radius * ey, height];
}

function segmentDistance3(p: Vec3, a: Vec3, b: Vec3): number {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const ll = ex * ex + ey * ey + ez * ez;
  const s = ll > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / ll)) : 0;
  return Math.hypot(p[0] - a[0] - s * ex, p[1] - a[1] - s * ey, p[2] - a[2] - s * ez);
}

/** Per ring edge (vertex k → k+1): whether the chord between its two
 * outline targets lies farther than `bound` from the outline over the
 * edge's azimuth span — measured at the emergence-loop points inside the
 * span (a wedge test by cross products: no azimuth seam) and at the
 * outline point at the template edge midpoint's azimuth (which alone
 * decides an edge whose span holds no loop sample). Frame coordinates. */
function ringEdgesOverBound(
  m: MarginFrame,
  mesh: IndexedMesh,
  ring: readonly number[],
  loopFrame: readonly Vec3[],
  d: number,
  bound: number,
): boolean[] {
  const n = ring.length;
  const ring2d = ring.map((r) => project(m.f, vertexOf(mesh, r)));
  const orientation = windingOrientation(ring2d);
  const targets = ring2d.map(([x, y]) => outlineFrame(m, x, y, d));
  const out: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const a = ring2d[k]!, b = ring2d[(k + 1) % n]!;
    const ta = targets[k]!, tb = targets[(k + 1) % n]!;
    const pa = vertexOf(mesh, ring[k]!), pb = vertexOf(mesh, ring[(k + 1) % n]!);
    const [mx, my] = project(m.f, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
    let deviation = segmentDistance3(outlineFrame(m, mx, my, d), ta, tb);
    for (const p of loopFrame) {
      if (orientation * (a[0] * p[1] - a[1] * p[0]) < 0 || orientation * (p[0] * b[1] - p[1] * b[0]) < 0) continue;
      deviation = Math.max(deviation, segmentDistance3(p, ta, tb));
    }
    out.push(deviation > bound);
  }
  return out;
}

/**
 * Splits the ring edges flagged in `split` (edge k: ring vertex k → k+1) at
 * the TEMPLATE edge's midpoint, splitting each of the edge's two triangles
 * in two (winding kept). Every existing vertex keeps its position bit for
 * bit and each new vertex lies on its edge, so the template's shape is
 * unchanged (ADR-025 Decision 2). New vertices are appended in ring order;
 * the returned ring holds each one between its edge's ends. Exported for
 * the kernel's own tests; not part of the package API.
 */
export function splitRingEdges(
  mesh: IndexedMesh,
  ring: readonly number[],
  split: readonly boolean[],
): { mesh: IndexedMesh; ring: number[] } {
  const positions = Array.from(mesh.positions);
  const indices = Array.from(mesh.indices);
  const outRing: number[] = [];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k]!, b = ring[(k + 1) % n]!;
    outRing.push(a);
    if (!split[k]) continue;
    const v = positions.length / 3;
    for (let c = 0; c < 3; c++) positions.push((positions[a * 3 + c]! + positions[b * 3 + c]!) / 2);
    let found = 0;
    const triangleCount = indices.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      for (let e = 0; e < 3; e++) {
        const x = indices[t * 3 + e]!, y = indices[t * 3 + ((e + 1) % 3)]!;
        if (!((x === a && y === b) || (x === b && y === a))) continue;
        const c = indices[t * 3 + ((e + 2) % 3)]!;
        indices[t * 3] = x;
        indices[t * 3 + 1] = v;
        indices[t * 3 + 2] = c;
        indices.push(v, y, c);
        found++;
        break;
      }
    }
    if (found !== 2) throw new Error(`cervicalFit: internal — ring edge ${a}–${b} borders ${found} triangle(s), not 2`);
    outRing.push(v);
  }
  return { mesh: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) }, ring: outRing };
}

/**
 * Fits the placed template's cervical ring to the emergence loop — see the
 * module doc. Pure and deterministic.
 *
 * @throws {RangeError} a non-positive emergence offset or blend.
 * @throws {CervicalFitError} with its `reason`.
 */
export function fitCervicalRing(input: CervicalFitInput, options: CervicalFitOptions = {}): CervicalFitResult {
  const blendMm = options.cervicalBlendMm ?? DEFAULT_CERVICAL_BLEND_MM;
  const bandMm = options.anchorBandMm ?? DEFAULT_CERVICAL_ANCHOR_BAND_MM;
  const maxAnchors = options.maxAnchors ?? DEFAULT_CERVICAL_MAX_ANCHORS;
  if (!(blendMm > 0) || !(bandMm > 0) || !(maxAnchors >= 4)) {
    throw new RangeError('cervicalFit: cervicalBlendMm and anchorBandMm must be > 0 and maxAnchors ≥ 4');
  }
  const maxLevels = input.maxResidualMm === undefined ? 0 : (options.maxRingRefineLevels ?? DEFAULT_MAX_RING_REFINE_LEVELS);
  if (input.maxResidualMm !== undefined && !(input.maxResidualMm > 0 && Number.isFinite(input.maxResidualMm))) {
    throw new RangeError(`cervicalFit: maxResidualMm must be a positive finite mm value (got ${input.maxResidualMm})`);
  }
  if (!(Number.isInteger(maxLevels) && maxLevels >= 0)) {
    throw new RangeError(`cervicalFit: maxRingRefineLevels must be a non-negative integer (got ${maxLevels})`);
  }
  const m = marginFrame(input.marginLoop, input.insertionAxis, input.emergenceOffsetMm);
  const loop = m.q.map(([x, y]) => outlinePoint(m, x, y, input.emergenceOffsetMm));
  const ringProblem = closedEdgeLoopProblem(input.mesh, input.cervicalRing);
  if (ringProblem !== null) throw new CervicalFitError('ring-not-edge-loop', ringProblem);

  const f = m.f;
  // Star-shaped by construction (ADR-024): a violation is a kernel bug.
  if (windingOrientation(loop.map((p) => project(f, p))) === 0) {
    throw new Error('cervicalFit: internal — the emergence outline does not wind once around the margin centroid');
  }
  if (windingOrientation(input.cervicalRing.map((r) => project(f, vertexOf(input.mesh, r)))) === 0) {
    throw new CervicalFitError('ring-not-star-shaped', 'the placed cervical ring does not wind once around the margin centroid');
  }

  // ADR-025 Decision 2: split the ring edges whose chords cannot follow the
  // outline within the bound (the template's shape is unchanged by a split).
  let mesh = input.mesh;
  let cervicalRing: number[] = [...input.cervicalRing];
  let ringRefineLevels = 0;
  if (input.maxResidualMm !== undefined) {
    const bound = input.maxResidualMm;
    const loopFrame = loop.map((p): Vec3 => {
      const [x, y] = project(f, p);
      return [x, y, heightOf(f, p[0], p[1], p[2])];
    });
    for (let level = 0; level < maxLevels; level++) {
      const split = ringEdgesOverBound(m, mesh, cervicalRing, loopFrame, input.emergenceOffsetMm, bound);
      if (!split.some(Boolean)) break;
      ({ mesh, ring: cervicalRing } = splitRingEdges(mesh, cervicalRing, split));
      ringRefineLevels++;
    }
  }
  const pos = mesh.positions;
  const ringPoints: Vec3[] = cervicalRing.map((r) => vertexOf(mesh, r));
  const ring2d = ringPoints.map((p) => project(f, p));

  // Pair by azimuth: the exact outline at each ring vertex's azimuth.
  const ringTargets: Vec3[] = ring2d.map(([x, y]) => outlinePoint(m, x, y, input.emergenceOffsetMm));
  let topHeight = -Infinity;
  for (let i = 0; i < ringPoints.length; i++) {
    const p = ringPoints[i]!, t = ringTargets[i]!;
    topHeight = Math.max(topHeight, heightOf(f, p[0], p[1], p[2]), heightOf(f, t[0], t[1], t[2]));
  }
  const blendHeightMm = topHeight + blendMm;

  // Anchors: the band just above the blend line (stride-subsampled).
  const vertexCount = pos.length / 3;
  const band: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const h = heightOf(f, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
    if (h >= blendHeightMm && h <= blendHeightMm + bandMm) band.push(i);
  }
  const stride = Math.max(1, Math.ceil(band.length / maxAnchors));
  const anchors = band.filter((_, k) => k % stride === 0);
  if (anchors.length < 4) {
    throw new CervicalFitError(
      'no-anchors',
      `${anchors.length} template vertex(es) in the anchor band ${blendHeightMm.toFixed(3)}–${(blendHeightMm + bandMm).toFixed(3)} mm above the margin centroid — the template is too short for the blend`,
    );
  }

  const controls: RbfControlPoint[] = [];
  let maxRingDisplacementMm = 0;
  for (let i = 0; i < ringPoints.length; i++) {
    const p = ringPoints[i]!, t = ringTargets[i]!;
    const d: Vec3 = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
    maxRingDisplacementMm = Math.max(maxRingDisplacementMm, Math.hypot(d[0], d[1], d[2]));
    controls.push({ center: p, value: d });
  }
  for (const a of anchors) controls.push({ center: [pos[a * 3]!, pos[a * 3 + 1]!, pos[a * 3 + 2]!], value: [0, 0, 0] });
  const field = fitRbf(controls);

  const out = pos.slice();
  let movedVertexCount = 0;
  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
    if (heightOf(f, x, y, z) >= blendHeightMm) continue;
    const d = evaluateRbf(field, [x, y, z]);
    out[i * 3] = x + d[0];
    out[i * 3 + 1] = y + d[1];
    out[i * 3 + 2] = z + d[2];
    movedVertexCount++;
  }

  const fittedRing: Vec3[] = cervicalRing.map((r) => [out[r * 3]!, out[r * 3 + 1]!, out[r * 3 + 2]!]);
  let ringToLoopMm = 0;
  for (const p of fittedRing) ringToLoopMm = Math.max(ringToLoopMm, distanceToClosedPolyline(p, loop));
  let loopToRingMm = 0;
  for (const p of loop) loopToRingMm = Math.max(loopToRingMm, distanceToClosedPolyline(p, fittedRing));

  return {
    mesh: { positions: out, indices: mesh.indices },
    emergenceLoop: loop,
    ringTargets,
    errorBoundMm: Math.max(ringToLoopMm, loopToRingMm),
    ringToLoopMm,
    loopToRingMm,
    maxRingDisplacementMm,
    ringVertexCount: cervicalRing.length,
    cervicalRing,
    ringRefineLevels,
    anchorCount: anchors.length,
    movedVertexCount,
    marginCentroid: f.c,
    blendHeightMm,
    emergenceOffsetMm: input.emergenceOffsetMm,
    cervicalBlendMm: blendMm,
  };
}
