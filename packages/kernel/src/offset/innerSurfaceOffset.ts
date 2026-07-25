// packages/kernel/src/offset/innerSurfaceOffset.ts
//
// Phase 4 Task 3: the crown INNER-SURFACE (intaglio / cement-gap) geometry —
// a spatially-VARYING, two-zone outward offset of the prep surface with a
// C1-smooth blend between the zones, extracted by the same SDF -> marching
// cubes machinery `offsetMesh`/`offsetMeshRoi` use, restricted to the prep
// ROI. This is the "cement-gap offset inner surface" PLAN.md §4 Phase 4
// stage 1 opens with, and clinically the crown's fit surface:
//
//   - MARGINAL-GAP zone: offset `marginalGapMm` (tight, ~20µm) from the
//     prep, in a band from the margin up to the SPACER-START line
//     (`spacerStartMm`, ~0.8mm above the margin, measured ALONG the surface).
//   - CEMENT-GAP zone: offset `cementGapMm` (~50µm) above the spacer line.
//   - A C1-smooth blend across the spacer line — no step/discontinuity.
//
// ## The formulation: a VARIABLE-iso level set F(x) = 0
//
// A constant-iso offset (`offsetMesh` at iso = d) gives ONE gap everywhere;
// two zones need the offset target to vary in space. We extract the surface
//
//     F(x) = signedDistance(x) - gap(h(x)) = 0
//
// where `gap(h)` is a C1 scalar RAMP from `marginalGapMm` (near margin,
// below the spacer line) to `cementGapMm` (above it), and `h(x)` measures
// "height above the margin, along the surface" (see the next section). This
// is exactly a constant-iso offset with a spatially-modulated iso value: we
// build the grid `G(x) = signedDistance(x) - gap(h(x))` and run marching
// cubes at iso = 0. The blend is BUILT IN to `gap`'s ramp (a smoothstep
// across `blendWidthMm` centred on `spacerStartMm`), so the extracted
// surface transitions smoothly with no MC-side special-casing.
//
// Sign: the crown fit surface sits OUTSIDE the prep by the (positive) gap —
// `signedDistance > 0` is outside (sdf/signedDistance.ts), so `{F = 0}` is
// the locus `gap(h)` mm OUTSIDE the prep. An outward offset, per the crown's
// clinical geometry (the cement gap is the space the crown stands off the
// die).
//
// ## The height field `h(x)`: EUCLIDEAN distance to the margin loop — the
// documented design decision (own it; see the brief's central question)
//
// "Height above the margin along the surface" for an arbitrary grid point
// `x` has two natural realisations, weighed here against the overriding
// "accuracy over speed, and the marginal band MUST hug the margin" rule:
//
//   (A) TRUE geodesic distance from the margin loop over the prep surface,
//       extended off-surface to grid points (closest-point extension). Most
//       faithful to "along the surface", but needs (a) a geodesic field
//       solve from the whole loop and (b) an off-surface extension to every
//       band grid point — substantial machinery, and the only discrete
//       geodesic this kernel has (`marginRegionVertexBall`, axis/roi.ts) is
//       a graph (edge-walk) distance that OVER-estimates true geodesic by a
//       tessellation-dependent factor, re-introducing an error term of its
//       own.
//
//   (B) Height above the margin PLANE along the insertion axis
//       (`dot(x - marginCentroid, axis)`). Trivial, but the brief's own
//       warning: it DEGRADES on a non-planar margin — a point sitting
//       exactly ON a dipping margin reads a non-zero (even negative) height,
//       so the tight marginal band would NOT hug the margin. Clinically the
//       worst place to be wrong (the marginal gap must be tight AT the
//       margin, all the way round).
//
//   (C) [CHOSEN] EUCLIDEAN distance to the margin loop polyline (the dense
//       `resampledPoints`, per margin/band.ts's CHORD-CAP rule), evaluated at
//       the grid point's FOOTPOINT on the prep — `h = min over loop segments
//       of dist(footpoint(x), segment)`, where `footpoint(x)` is the closest
//       surface point `signedClosestPoint` already computes for the SDF value
//       (so evaluating `h` there is free). Evaluating at the footpoint, not
//       the grid sample `x`, makes `gap` a property of the SURFACE LOCATION
//       (constant along the normal through it) rather than of the off-surface
//       grid point — which REMOVES the grid-vs-footpoint displacement term
//       (see @errorBound) instead of merely bounding it. Properties:
//
//       1. h = 0 EXACTLY on the margin loop, for ANY loop shape (planar or
//          not) — so the marginal band genuinely hugs the margin, closing
//          proxy (B)'s degradation completely. This is the property that
//          matters most clinically, and it holds by construction.
//       2. On a straight (ruled) axial wall — which a prep's near-margin
//          wall essentially is — the nearest loop point to a wall point at
//          along-surface distance `s` is the loop point directly "below" it,
//          and the straight-line distance to it EQUALS `s`. So on the
//          analytic shoulder-prep die (a cone wall above a circular margin)
//          `h` is the along-surface distance EXACTLY (proven in
//          innerSurfaceOffset.analytic.test.ts against the closed-form
//          circle), giving a clean analytic golden with no proxy error term.
//       3. In general `h` (a chord) is a LOWER bound on true geodesic arc
//          length from the margin (chord <= arc): so the spacer line sits at
//          geodesic distance >= `spacerStartMm`, i.e. the tight marginal
//          zone is never SMALLER than nominal — the clinically safe
//          direction (a slightly taller tight band, never a shorter one).
//          The deviation is second order in curvature, `O(kappa^2 s^3)`, and
//          bounded within the near-margin band (see @errorBound).
//       4. Naturally defined in ALL of space (no off-surface extension step)
//          and cheap (point-to-polyline), so it adds no geodesic-solver
//          machinery and stays fully deterministic (Float64, no iteration).
//
// The one honest limitation of (C): Euclidean distance can SHORT-CUT across
// space (a point far from the margin along the surface but near it through
// the air — e.g. across a deep occlusal box). This only matters where it
// would pull a point that should be in the CEMENT zone back into the
// MARGINAL zone. Inside the near-margin band this cannot happen for a valid
// prep (the axial wall does not fold back within `spacerStartMm` of its own
// margin); ABOVE the blend the gap is already saturated at `cementGapMm`, so
// the exact `h` value there is irrelevant (it is clamped). Documented, not
// hidden — see @errorBound and the analytic test's "monotonic across the
// spacer line" assertion, which is what would break if a short-cut reached
// into the band.
//
// ## @errorBound (carried in the result; surfaced by Task 4's margin-fit
// gate / the QcReport per PLAN §6.6)
//
// The normal offset error at a produced vertex decomposes as:
//
//   - OFFSET (SDF -> MC) term. In a CONSTANT zone (`gap` locally constant —
//     the whole marginal zone and the whole cement zone) `G = signedDistance
//     - const` is 1-Lipschitz, so the marching-cubes chord bound is exactly
//     `pitchMm / 2` (identical to `offsetMesh`'s derivation — see its
//     @errorBound). WITHIN the blend `gap(h(x))` varies, so `G` is
//     `(1 + Lgap)`-Lipschitz with `Lgap = 1.5 * (cementGapMm - marginalGapMm)
//     / blendWidthMm` (1.5 = max |smoothstep'|); the vertex-to-true-surface
//     distance is then bounded by `(1 + Lgap)/(1 - Lgap) * pitchMm/2` (chord
//     bound divided by the field's minimum gradient `1 - Lgap`). The result
//     reports this WORST-CASE (blend) bound as `errorBoundMm`; the flat-zone
//     measurements (marginal, cement) hold to the tighter `pitchMm/2`.
//   - HEIGHT-FIELD term. Because `h` is evaluated at the FOOTPOINT (an
//     on-surface point), there is NO grid-vs-footpoint displacement term: the
//     naive alternative of evaluating `h` at the off-surface grid point `x`
//     would perturb `h` by up to `|signedDistance(x)| <= cementGapMm` (~50µm),
//     which inside the blend inflates the effective gap error by up to
//     `Lgap * cementGapMm` (~7.5µm at the standard gaps) — that term is
//     ELIMINATED here, not merely bounded, by using `footpoint(x)`. What
//     REMAINS is only the intrinsic arc-vs-chord approximation of using
//     Euclidean distance for along-surface distance: `h` (a chord between two
//     on-surface points) under-estimates geodesic arc length by at most
//     `(kappa_max / 24) * s^3` over the band, which shifts the spacer LINE's
//     position along the wall, not the offset magnitude, and always in the
//     safe direction (item 3 above). For the analytic cone die it is 0
//     (item 2). This residual is a POSITION error on the blend, not an offset
//     error, and is reported separately by the caller where relevant.
//   - Float32 grid storage + mu-clamp epsilon: identical to `offsetMesh`'s
//     `eps_f32` term (reused verbatim via `offsetErrorBoundMm`).
//
// ## Output: an OPEN patch (uncleaned), exactly like `offsetMeshRoi`
//
// Cropping to the prep ROI produces an OPEN inner-surface patch (a boundary
// loop near the margin, where the ROI crops); `cleanupMesh`'s watertight
// validator would reject it, so — as in `offsetMeshRoi` — only
// `weldVertices` runs and `stats.watertight` is expected `false`. A later
// Phase 4 stage (Task 4+) skirts this patch to the margin line and stitches
// it into the closed crown shell; Task 3 delivers the two-zone offset
// surface itself.
//
// @errorBound See the "@errorBound" section above (offset chord bound with
// the blend-zone Lipschitz inflation, plus the height-field arc-vs-chord
// position bound and the reused Float32 term).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { weldVertices } from '../intake/weld.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { markCandidateCells, sdfGridDims } from '../sdf/grid.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { marchingCubes, MIN_PITCH_MM, PitchTooSmallError, type ScalarGrid } from './marchingCubes.ts';
import {
  EmptyOffsetResultError,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
} from './offsetMesh.ts';

/** How many SDF z-slices `innerSurfaceOffsetRoi` computes between event-loop
 * yields — mirrors offsetMesh.ts's `SDF_SLICES_PER_YIELD` (same rationale:
 * keep a hosting event loop alive across a long synchronous grid fill; pure
 * scheduling, changes no computed value). */
const SDF_SLICES_PER_YIELD = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Default C1 blend width (mm) across the spacer-start line — an ALGORITHMIC
 * default kept in the kernel (same "documented param default lives in the
 * kernel" judgment call as `AXIS_DEFAULT_ROI_RADIUS_MM` / `OFFSET_BAND_MARGIN_PITCHES`),
 * NOT a clinical gap/thickness/offset (CLAUDE.md invariant 7 governs those —
 * the two GAPS and the spacer START come from the profile; how GRADUAL the
 * transition between them is, is a smoothing choice this constant sets).
 *
 * `0.3 mm`: wide enough that the blend-zone Lipschitz factor
 * `Lgap = 1.5 * (cementGapMm - marginalGapMm) / blendWidthMm` stays small
 * (0.15 at the standard-zirconia gaps, keeping the worst-case error-bound
 * inflation `(1+Lgap)/(1-Lgap) ~= 1.35` — see this module's @errorBound),
 * narrow enough that both zones keep real extent on a clinically short prep
 * (the transition occupies `spacerStartMm +/- 0.15 mm`, i.e. 0.65-0.95 mm
 * above the margin — comfortably inside the 0.5-1.0 mm spacer-start range of
 * PLAN.md §3). Overridable via `InnerSurfaceOffsetParams.blendWidthMm`. */
export const INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM = 0.3;

/** Max |smoothstep'| on [0,1]: `smoothstep(t) = 3t^2 - 2t^3`,
 * `smoothstep'(t) = 6t(1-t)`, maximised at `t = 1/2` where it equals 1.5 —
 * the constant in the blend-zone Lipschitz factor (see @errorBound). */
const MAX_SMOOTHSTEP_DERIVATIVE = 1.5;

/** Thrown when `blendWidthMm` is so narrow that the blend-zone field is no
 * longer well-posed for a bounded offset — `Lgap = 1.5 * dGap / blendWidthMm
 * >= 1` means `G`'s gradient can vanish inside the blend and the
 * chord-bound-over-gradient error estimate diverges. Rejected loudly (rather
 * than silently emitting a surface whose documented @errorBound no longer
 * holds), mirroring marchingCubes.ts's `PitchTooSmallError` discipline. */
export class BlendWidthTooNarrowError extends Error {
  constructor(blendWidthMm: number, dGapMm: number) {
    super(
      `innerSurfaceOffset: blendWidthMm (${blendWidthMm} mm) is too narrow for the gap step ` +
        `${dGapMm} mm — needs blendWidthMm > ${MAX_SMOOTHSTEP_DERIVATIVE * dGapMm} mm so the blend-zone ` +
        `Lipschitz factor stays < 1 and the offset's @errorBound remains finite (see BlendWidthTooNarrowError's doc)`,
    );
    this.name = 'BlendWidthTooNarrowError';
  }
}

/** The two-zone gap parameters — the clinical gaps + spacer line (from the
 * material profile) and the (algorithmic) blend width. `marginalGapMm` and
 * `cementGapMm` are BOTH REQUIRED (no kernel default — see CLAUDE.md
 * invariant 7); asserted present/finite by `innerSurfaceOffsetRoi`. */
export interface InnerSurfaceGapParams {
  /** Tight offset at/near the margin, mm (profile `marginalGapMm`). */
  readonly marginalGapMm: number;
  /** Offset above the spacer line, mm (profile `cementGapMm`). */
  readonly cementGapMm: number;
  /** Along-surface height above the margin where the cement gap begins, mm
   * (profile `spacerStartMm`) — the blend is centred here. */
  readonly spacerStartMm: number;
  /** C1 blend width across the spacer line, mm — default
   * `INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM`. */
  readonly blendWidthMm: number;
}

/** `smoothstep(t) = 3t^2 - 2t^3` clamped to [0,1] — the classic C1 Hermite
 * ramp (`smoothstep'(0) = smoothstep'(1) = 0`, so a piecewise join to
 * constants on either side is C1). */
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * The spatially-varying gap `gap(h)`, mm, as a function of along-surface
 * height above the margin `h` — `marginalGapMm` for `h` below the blend,
 * `cementGapMm` above it, a C1 smoothstep across `[spacerStartMm -
 * blendWidthMm/2, spacerStartMm + blendWidthMm/2]` in between. Monotone in
 * `h` when `cementGapMm >= marginalGapMm` (the clinical case). C1 in `h`
 * (smoothstep's zero end-derivatives make the joins to the flat zones C1).
 */
export function twoZoneGapField(h: number, params: InnerSurfaceGapParams): number {
  const { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm } = params;
  const half = blendWidthMm / 2;
  const t = (h - (spacerStartMm - half)) / blendWidthMm;
  return marginalGapMm + (cementGapMm - marginalGapMm) * smoothstep(t);
}

/** Squared distance from point `p` to segment `[a, b]` (all Float64) — the
 * per-segment kernel of `distanceToClosedPolyline`. */
function pointSegmentDistanceSq(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 0 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a[0] + t * abx - p[0];
  const cy = a[1] + t * aby - p[1];
  const cz = a[2] + t * abz - p[2];
  return cx * cx + cy * cy + cz * cz;
}

/**
 * Euclidean distance from `p` to the CLOSED polyline through `loop` (segment
 * `loop[i] -> loop[(i+1) % n]` for every `i`, including the wraparound) — the
 * height field `h(x)` this module's design (option C) uses. Exact (Float64,
 * no iteration). `loop` must have >= 2 points.
 */
export function distanceToClosedPolyline(p: Vec3, loop: readonly Vec3[]): number {
  const n = loop.length;
  let minSq = Infinity;
  for (let i = 0; i < n; i++) {
    const d = pointSegmentDistanceSq(p, loop[i]!, loop[(i + 1) % n]!);
    if (d < minSq) minSq = d;
  }
  return Math.sqrt(minSq);
}

export interface InnerSurfaceOffsetParams extends InnerSurfaceGapParams {
  /** Voxel pitch, mm — REQUIRED (no kernel default; clinical default lives
   * in packages/clinical-profiles's `DEFAULT_OFFSET_VOXEL_PITCH_MM`). */
  readonly pitchMm: number;
  /** The margin loop, DENSE and on-surface (`resampledPoints`, per
   * margin/band.ts's CHORD-CAP rule) — the height field measures distance to
   * THIS polyline. */
  readonly marginLoop: readonly Vec3[];
  /** Tight world-space mm ROI to restrict SDF sampling to (the prep region
   * above the margin) — REQUIRED, padded internally by the same
   * `offsetGridSpec` band rule `offsetMeshRoi` uses. */
  readonly roiBboxMm: { readonly min: Vec3; readonly max: Vec3 };
}

export interface InnerSurfaceOffsetResult {
  /** The two-zone inner-surface patch: welded, generally OPEN (see module
   * doc — `stats.watertight` is expected `false` for a cropped ROI). */
  readonly mesh: IndexedMesh;
  /** `analyzeMesh` over the welded (uncleaned) mesh. */
  readonly stats: ReturnType<typeof analyzeMesh>;
  /** WORST-CASE (blend-zone) offset error bound, mm — see this module's
   * @errorBound. The flat marginal/cement zones hold to the tighter
   * `pitchMm/2` (+ eps_f32). */
  readonly errorBoundMm: number;
  /** The tighter flat-zone bound (`pitchMm/2` + eps_f32) — surfaced
   * separately so a caller measuring in a constant zone (marginal, cement)
   * can assert against the bound that actually applies there. */
  readonly flatZoneErrorBoundMm: number;
  /** Echo of the gap params, for journaling. */
  readonly marginalGapMm: number;
  readonly cementGapMm: number;
  readonly spacerStartMm: number;
  readonly blendWidthMm: number;
  readonly pitchMm: number;
}

function validateParams(params: InnerSurfaceOffsetParams): void {
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, marginLoop } = params;
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  if (!(Number.isFinite(marginalGapMm) && marginalGapMm >= 0)) {
    throw new TypeError(`innerSurfaceOffset: marginalGapMm must be finite and >= 0, got ${marginalGapMm}`);
  }
  if (!(Number.isFinite(cementGapMm) && cementGapMm >= 0)) {
    throw new TypeError(`innerSurfaceOffset: cementGapMm must be finite and >= 0, got ${cementGapMm}`);
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`innerSurfaceOffset: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const dGap = Math.abs(cementGapMm - marginalGapMm);
  if (blendWidthMm <= MAX_SMOOTHSTEP_DERIVATIVE * dGap) {
    throw new BlendWidthTooNarrowError(blendWidthMm, dGap);
  }
  if (!marginLoop || marginLoop.length < 2) {
    throw new TypeError(`innerSurfaceOffset: marginLoop must have >= 2 points, got ${marginLoop?.length ?? 0}`);
  }
}

/** The blend-zone Lipschitz factor `Lgap` and the resulting worst-case bound
 * inflation — see this module's @errorBound. Exported for tests. */
export function blendZoneLipschitz(params: InnerSurfaceGapParams): number {
  return (MAX_SMOOTHSTEP_DERIVATIVE * Math.abs(params.cementGapMm - params.marginalGapMm)) / params.blendWidthMm;
}

/**
 * Computes ONE z-slice of the two-zone field grid `G(x) = signedDistance(x)
 * - gap(h(x))` — the primitive both `innerSurfaceOffsetRoi` (below) and
 * kernel-workers/src/jobs/innerSurface.ts drive, so the two paths are
 * byte-identical (same primitive, same iteration order). Mirrors
 * sdf/grid.ts's `computeSdfGridSlice` exactly, but subtracts the gap field
 * from each candidate cell's signed distance; a non-candidate cell (mask 0)
 * stays `+Infinity` (subtracting a finite gap from +Inf is still +Inf, so
 * the marching-cubes sentinel policy is preserved). Float32 storage, same
 * documented boundary as sdf/grid.ts.
 */
export function computeTwoZoneSdfGridSlice(
  mesh: IndexedMesh,
  bvh: ReturnType<typeof buildBvh>,
  pseudonormals: ReturnType<typeof computePseudonormals>,
  dims: readonly [number, number, number],
  origin: Vec3,
  pitchMm: number,
  z: number,
  candidateMask: Uint8Array,
  gapParams: InnerSurfaceGapParams,
  marginLoop: readonly Vec3[],
): Float32Array {
  const [nx, ny] = dims;
  const slice = new Float32Array(nx * ny);
  const worldZ = origin[2] + z * pitchMm;
  const zBase = z * ny * nx;
  for (let iy = 0; iy < ny; iy++) {
    const worldY = origin[1] + iy * pitchMm;
    const rowBase = zBase + iy * nx;
    for (let ix = 0; ix < nx; ix++) {
      if (candidateMask[rowBase + ix] === 0) {
        slice[iy * nx + ix] = Number.POSITIVE_INFINITY;
        continue;
      }
      const worldX = origin[0] + ix * pitchMm;
      const point: Vec3 = [worldX, worldY, worldZ];
      const closest = signedClosestPoint(mesh, bvh, pseudonormals, point);
      // Evaluate the height field at the FOOTPOINT (closest.point, ON the
      // prep) — NOT the grid sample `point` — so `gap` reflects the SURFACE
      // location's height above the margin, constant along the normal through
      // it. This REMOVES the grid-vs-footpoint displacement term (up to
      // |signedDistance| <= cementGapMm) that evaluating at the grid point
      // would leak into the blend-zone offset error — see this module's
      // @errorBound (HEIGHT-FIELD term).
      const h = distanceToClosedPolyline(closest.point, marginLoop);
      slice[iy * nx + ix] = closest.signedDistance - twoZoneGapField(h, gapParams);
    }
  }
  return slice;
}

/**
 * Builds the two-zone crown inner-surface offset, restricted to `roiBboxMm`
 * (the prep region above the margin) — see this module's doc for the
 * formulation, the height-field design decision, and @errorBound. `mesh` is
 * the FULL prep/die (every distance query runs against all of it — only the
 * SAMPLED GRID DOMAIN is the ROI, exactly as in `offsetMeshRoi`). Returns an
 * OPEN, welded patch (no `cleanupMesh` — see module doc).
 *
 * Deterministic: same mesh + params -> byte-identical output (every stage is
 * deterministic Float64/Float32-storage math; pinned by a double-run hash in
 * innerSurfaceOffset.analytic.test.ts).
 *
 * @throws {TypeError} for invalid pitch/gaps/spacer/loop.
 * @throws {PitchTooSmallError} if `pitchMm < MIN_PITCH_MM`.
 * @throws {BlendWidthTooNarrowError} if the blend is too narrow for the gap step.
 * @throws {NonWatertightMeshError} (sdf/pseudonormals.ts) if `mesh` is open.
 * @throws {SdfGridTooLargeError} (sdf/grid.ts) if the ROI grid exceeds the guard.
 * @throws {EmptyOffsetResultError} if no F = 0 crossing exists in the ROI.
 */
export async function innerSurfaceOffsetRoi(
  mesh: IndexedMesh,
  params: InnerSurfaceOffsetParams,
): Promise<InnerSurfaceOffsetResult> {
  validateParams(params);
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, marginLoop, roiBboxMm } = params;
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };

  // Stage 0: BVH + pseudonormals (the watertight gate) over the FULL mesh.
  const bvh = buildBvh(mesh);
  const pseudonormals = computePseudonormals(mesh);

  // Stage 1: two-zone field grid over the ROI. Band/padding sized for the
  // LARGEST gap (the target crossing sits at signedDistance in
  // [marginalGapMm, cementGapMm]) so every F = 0 crossing cell is fully
  // sampled and the MC sentinel policy holds (same margin rule offsetMesh
  // uses; see OFFSET_BAND_MARGIN_PITCHES).
  const maxGapMm = Math.max(marginalGapMm, cementGapMm);
  const spec = offsetGridSpec(roiBboxMm, maxGapMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask = markCandidateCells(mesh, dims, origin, pitchMm, spec.bandMm);
  for (let z = 0; z < nz; z++) {
    grid.set(
      computeTwoZoneSdfGridSlice(mesh, bvh, pseudonormals, dims, origin, pitchMm, z, mask, gapParams, marginLoop),
      z * ny * nx,
    );
    if (z % SDF_SLICES_PER_YIELD === SDF_SLICES_PER_YIELD - 1) await yieldToEventLoop();
  }
  const fieldGrid: ScalarGrid = { grid, dims, origin, pitchMm };

  // Stage 2: marching cubes at iso = 0 (F = signedDistance - gap = 0).
  const soup = marchingCubes(fieldGrid, 0);
  if (soup.triangleCount === 0) {
    throw new EmptyOffsetResultError(0);
  }

  // Stage 3: weld ONLY (open patch — see module doc).
  const welded = weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });
  const stats = analyzeMesh(welded);

  const maxAbs = maxAbsCoordOf({ min: roiBboxMm.min, max: roiBboxMm.max }, spec.padding);
  const flatZoneErrorBoundMm = offsetErrorBoundMm(pitchMm, maxAbs);
  const f32Terms = flatZoneErrorBoundMm - pitchMm / 2;
  const lgap = blendZoneLipschitz(gapParams);
  const inflation = (1 + lgap) / (1 - lgap);
  const errorBoundMm = inflation * (pitchMm / 2) + f32Terms;

  return {
    mesh: welded,
    stats,
    errorBoundMm,
    flatZoneErrorBoundMm,
    marginalGapMm,
    cementGapMm,
    spacerStartMm,
    blendWidthMm,
    pitchMm,
  };
}
