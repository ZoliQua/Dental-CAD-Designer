// packages/kernel/src/anatomy/cervicalFit.ts
//
// Phase 10 Task 4 (ADR-023 Decision 2) — the CERVICAL FIT: moves a placed
// library template's cervical ring onto the EMERGENCE LOOP, so the crown
// emerges from the margin with full material thickness instead of the
// placement's cervix landing wherever the template's widest section put it.
// It runs after placement and before the contact morph, as its own journaled
// op (placement and morph are unchanged).
//
// ## The emergence loop
//
// The confirmed margin pushed OUTWARD, normal to the insertion axis, by
// `emergenceOffsetMm` (the caller passes the intaglio's marginal gap plus the
// material's minimum wall thickness, both from the profile — no clinical
// value is defaulted here). Each margin point keeps its own height along the
// axis, so a non-planar margin gives a non-planar emergence loop. Point i
// moves along the outward normal of the margin's projection (the
// perpendicular of the central difference p[i+1] − p[i−1]), so on a regular
// polygon it moves exactly radially.
//
// ## The fit
//
// Each ring vertex is paired, BY AZIMUTH around the axis through the margin
// centroid, with the point where the ray at its azimuth crosses the
// emergence loop (heights linear along the loop). Both the ring and the loop
// must be star-shaped around the centroid (their azimuths strictly monotone,
// one turn) — otherwise the pairing is ambiguous and the fit refuses
// (`CervicalFitError`). A deterministic RBF (rbf/rbf.ts: φ(r) = r with its
// affine term, direct solve) interpolates the ring displacements with ZERO
// displacement at the anchors: every template vertex in the band
// [B, B + `anchorBandMm`] above the BLEND HEIGHT B (the highest of the ring
// and its targets, plus `cervicalBlendMm`). The field moves only vertices
// BELOW B; at and above B the template is untouched, bit for bit.
//
// A fold the fit may cause in a thin or oddly-shaped template is NOT hidden:
// the shell's self-intersection and minimum-wall gates measure it.
//
// @errorBound The fitted ring versus the emergence loop: the larger of the
// greatest distance from a fitted ring vertex to the loop polyline and from
// a loop point to the fitted ring polyline (`errorBoundMm`). The vertex
// targets lie ON the loop (the RBF interpolates its controls to solver
// precision), so the bound is dominated by the chord between ring vertices —
// the ring's tessellation, which is the template's own resolution. Reported
// with the fit; the gates that read the crown measure the result anyway.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
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
}

export interface CervicalFitOptions {
  readonly cervicalBlendMm?: number;
  readonly anchorBandMm?: number;
  readonly maxAnchors?: number;
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
  readonly ringVertexCount: number;
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

/**
 * The emergence loop: `marginLoop` pushed outward, normal to `insertionAxis`,
 * by `offsetMm`, each point at its own height — see the module doc.
 *
 * @throws {CervicalFitError} 'degenerate-margin' (fewer than 3 points or a
 * zero tangent) or 'margin-not-star-shaped'.
 */
export function emergenceLoop(marginLoop: readonly Vec3[], insertionAxis: Vec3, offsetMm: number): Vec3[] {
  if (!(offsetMm > 0) || !Number.isFinite(offsetMm)) {
    throw new RangeError(`cervicalFit: emergence offset must be a positive finite mm value (got ${offsetMm})`);
  }
  const n = marginLoop.length;
  if (n < 3) throw new CervicalFitError('degenerate-margin', `${n} margin point(s)`);
  const axis = unitAxis(insertionAxis);
  const { u, v } = planeBasis(axis);
  const f: Frame = { c: centroidOf(marginLoop), axis, u, v };
  const q = marginLoop.map((p) => project(f, p));
  const orientation = windingOrientation(q);
  if (orientation === 0) {
    throw new CervicalFitError('margin-not-star-shaped', 'the margin does not wind once, monotonically, around its centroid');
  }
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = q[(i - 1 + n) % n]!, b = q[(i + 1) % n]!;
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.hypot(tx, ty);
    if (!(len > 0)) throw new CervicalFitError('degenerate-margin', `zero tangent at margin point ${i}`);
    // Outward normal of a counter-clockwise loop is (ty, −tx).
    const nx = (orientation * ty) / len, ny = (-orientation * tx) / len;
    const p = marginLoop[i]!;
    out.push([
      p[0] + offsetMm * (nx * u[0] + ny * v[0]),
      p[1] + offsetMm * (nx * u[1] + ny * v[1]),
      p[2] + offsetMm * (nx * u[2] + ny * v[2]),
    ]);
  }
  return out;
}

/** The point where the ray from the frame origin through 2-D `dir` crosses
 * the star-shaped loop (`q` its projection, `loop` its 3-D points). */
function rayHit(q: ReadonlyArray<readonly [number, number]>, loop: readonly Vec3[], dir: readonly [number, number]): Vec3 {
  const n = q.length;
  let best: Vec3 | null = null;
  let bestT = Infinity;
  for (let i = 0; i < n; i++) {
    const a = q[i]!, b = q[(i + 1) % n]!;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dir[0] * ey - dir[1] * ex;
    if (den === 0) continue;
    const s = (a[0] * dir[1] - a[1] * dir[0]) / den;
    const t = (a[0] * ey - a[1] * ex) / den;
    if (s < 0 || s > 1 || !(t > 0)) continue;
    // Star-shaped: one crossing; ties at a shared vertex give the same point.
    if (t < bestT) {
      bestT = t;
      const pa = loop[i]!, pb = loop[(i + 1) % n]!;
      best = [pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1]), pa[2] + s * (pb[2] - pa[2])];
    }
  }
  if (!best) throw new CervicalFitError('margin-not-star-shaped', 'a ring azimuth misses the emergence loop');
  return best;
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
  const { mesh, cervicalRing } = input;
  const loop = emergenceLoop(input.marginLoop, input.insertionAxis, input.emergenceOffsetMm);
  const ringProblem = closedEdgeLoopProblem(mesh, cervicalRing);
  if (ringProblem !== null) throw new CervicalFitError('ring-not-edge-loop', ringProblem);

  const axis = unitAxis(input.insertionAxis);
  const { u, v } = planeBasis(axis);
  const f: Frame = { c: centroidOf(input.marginLoop), axis, u, v };
  const loop2d = loop.map((p) => project(f, p));
  if (windingOrientation(loop2d) === 0) {
    throw new CervicalFitError('margin-not-star-shaped', 'the emergence loop does not wind once around the margin centroid');
  }
  const pos = mesh.positions;
  const ringPoints: Vec3[] = cervicalRing.map((r) => [pos[r * 3]!, pos[r * 3 + 1]!, pos[r * 3 + 2]!]);
  const ring2d = ringPoints.map((p) => project(f, p));
  if (windingOrientation(ring2d) === 0) {
    throw new CervicalFitError('ring-not-star-shaped', 'the placed cervical ring does not wind once around the margin centroid');
  }

  // Pair by azimuth.
  const ringTargets: Vec3[] = ring2d.map((d) => rayHit(loop2d, loop, d));
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
    anchorCount: anchors.length,
    movedVertexCount,
    marginCentroid: f.c,
    blendHeightMm,
    emergenceOffsetMm: input.emergenceOffsetMm,
    cervicalBlendMm: blendMm,
  };
}
