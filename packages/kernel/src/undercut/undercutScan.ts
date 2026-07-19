// packages/kernel/src/undercut/undercutScan.ts
//
// Phase 2 Task 9: insertion-axis undercut scan — the primitive Phase 3's
// insertion-axis OPTIMIZATION consumes (hemisphere direction sampling over
// `undercutScanBatch`; the optimization loop itself is out of THIS task's
// scope — YAGNI per this task's brief guardrail). Per-triangle: is this
// triangle undercut relative to a candidate insertion direction, and if so,
// how much material ("blockout depth") is in the way.
//
// ## API shape: `(mesh, bvh, directionUnit)`, not `(mesh, directionUnit)`
//
// This task's brief prose describes the signature as `undercutScan(mesh,
// directionUnit)`, but every sibling BVH-consuming kernel primitive
// (`closestPoint`, `raycast` — bvh/closestPoint.ts, bvh/raycast.ts) takes an
// already-built `Bvh` as an explicit parameter, precisely so a caller
// running MANY queries against the same mesh (here: `undercutScanBatch`'s
// whole point — a Phase 3 hemisphere sweep, dozens of directions) builds the
// BVH exactly ONCE. Baking `buildBvh(mesh)` inside `undercutScan` itself
// would make that amortization impossible at the KERNEL layer (only
// achievable by callers who happen to also cache the Bvh themselves) and
// would silently reproduce the exact rebuild-per-call anti-pattern this
// task's guardrail calls out (kernel-workers/src/jobs/offset.ts's
// `buildBvh(mesh)` call, flagged in review) instead of following the
// established `closestPoint`/`raycast` shape. Deviating from the brief's
// literal signature here, in favor of matching this codebase's own
// established convention, is a deliberate documented judgment call — see
// this task's report for the same note.
//
// ## Undercut sign convention (resolved judgment call — read before using)
//
// The brief's prose states the boolean rule as "outward normal · d > 0
// ('facing away from insertion')" but ALSO gives a concrete worked example:
// "sphere with d = +z: lower hemisphere undercut". These two statements are
// mutually inconsistent: for a sphere centered at the origin, a lower-
// hemisphere point's outward normal has a NEGATIVE z-component (it points
// generally downward, away from the sphere's center, same sign as its own
// z-coordinate) — so `normal · (0,0,1) < 0` there, not `> 0`. Taking the
// concrete, independently-checkable worked example as authoritative (it is
// also the standard convention used by CNC/moldability "undercut/
// accessibility" analysis: a point is undercut relative to a tool/insertion
// direction `d` when its outward normal has a NEGATIVE component along `d`
// — i.e. the surface is not visible/reachable by a rigid tool or seating
// motion translating along `d`), this module implements the FACING half of
// the rule as:
//
//   triangle is UNDERCUT-BY-FACING w.r.t. `d`  <=>  normal · d < -UNDERCUT_BOUNDARY_EPSILON
//
// (see "Near-perpendicular triangles" below for the epsilon). This is the
// OPPOSITE sign from the brief's literal prose formula but matches its own
// sphere example exactly (verified in undercutScan.analytic.test.ts) and is
// what every other test case in this task (axis-aligned cylinder: zero
// undercut; tilted cylinder: an exact, tilt-independent half of the wall)
// was authored against.
//
// ## Occlusion as an INDEPENDENT undercut detector (facing-away OR occluded)
//
// Facing alone is a LOCAL, differential test — it says nothing about
// whether some OTHER part of the mesh stands in the way. A triangle whose
// own normal faces the "correct" way (`normal · d >= -UNDERCUT_BOUNDARY_EPSILON`,
// not undercut BY FACING) can still be genuinely inaccessible if it sits
// under an overhang/canopy: a separate mass of material further along `d`
// that a rigid tool would collide with before ever reaching this triangle.
// Per the brief's full semantics ("undercut ⟺ facing-away OR occluded"),
// this module ALSO undercuts a facing-correct triangle when the SAME `+d`
// ray this module already casts for depth (see "Depth" below) finds a
// genuine hit — i.e. there really is solid material directly ahead before
// open space. The full rule, unifying both cases into one computation
// (`depthMm` is computed identically either way — see "Depth" below):
//
//   triangle is UNDERCUT w.r.t. `d`  <=>  (normal · d < -UNDERCUT_BOUNDARY_EPSILON)  OR  (depthMm > 0)
//
// ### Cast direction judgment call: `+d`, not the brief's literal `-d`
//
// A draft of this extension read the brief's occlusion prose as "cast the
// occlusion ray along `-d`" and translated that LITERALLY into this
// module's own (sign-flipped, see above) `d`. That is wrong, and provably
// so: for ANY strictly-facing triangle of a closed/watertight mesh
// (`normal · d > 0`, not just `>= 0`), a ray biased and cast along `-d`
// starts on the LOCAL-SOLID side of the triangle's own plane (by
// definition of "facing": `d` points roughly outward, so `-d` points
// roughly inward) and, for a closed mesh, is GUARANTEED to eventually find
// SOME exit surface — turning every strictly-facing triangle of any closed
// mesh into a false undercut. Concretely: the sphere's UPPER hemisphere
// (`normal · d > 0` for `d = +z`) would flip from "never undercut"
// (verified, existing analytic test) to "100% undercut" (self-occluded by
// the LOWER hemisphere, found via the very same "ray re-enters the solid
// and exits through the mirrored point" mechanic this module's own depth
// doc already describes for the OPPOSITE, undercut-by-facing side) — and
// the unit cube's TOP face (existing hand-checkable test: only the BOTTOM
// face is undercut) would likewise flip to undercut, self-occluded by its
// own bottom face. Both are currently-passing, foundational tests this
// task's brief does not ask to change, so this reading cannot be right.
//
// This module already documents, at the top of this very section, that the
// brief's literal prose sign is the OPPOSITE of this module's `d` for the
// boolean rule (resolved by trusting the brief's own worked example over
// its prose formula). Applying that SAME established translation to the
// occlusion prose resolves the contradiction cleanly: the brief's "cast
// along `-d`" becomes, in THIS module's `d`, **cast along `+d`** — i.e. the
// EXACT SAME ray this module already casts to compute depth for a
// facing-away triangle, now ALSO cast (and its hit-or-miss outcome
// consulted, not just its distance) for every STRICTLY facing triangle
// (`normal · d > +UNDERCUT_BOUNDARY_EPSILON` — see "Near-perpendicular
// triangles" below for why the boundary band itself is excluded from this
// check, not just from the facing rule). This reading is independently
// confirmed correct: it makes the sphere's upper hemisphere and the cube's
// top face resolve to "not undercut" (nothing ahead along `+d`, matching
// their existing tests untouched) while still correctly flagging a genuine
// canopy (a SEPARATE mass of material further along `+d` — see
// undercutScan.overhang.test.ts's canopy case) and correctly leaving the
// axis-aligned cylinder's wall and the cube's own vertical side faces alone
// (both are boundary-band triangles — see below).
//
// ## Depth ("how much blockout") semantics
//
// For an undercut triangle, `depthMm` answers: "how much solid material
// lies directly ahead, along the insertion direction `d`, starting from a
// point on this triangle, before the mesh boundary is reached again" — i.e.
// exactly the material thickness that would need to be blocked out (filled,
// e.g. with wax) so a rigid tool/restoration could travel straight through
// along `d` without colliding with this surface. Computed by a real BVH
// raycast: from a SAMPLE POINT on the triangle (see "Sampling policy"
// below), cast a ray along `+d` (not `-d` — this is not a "visibility from
// the withdrawal side" cast, it is a "how thick is the solid I'm buried
// under" cast) and take the hit distance. A watertight, undercut point's
// `+d` ray is GUARANTEED to re-enter, then eventually re-exit, the solid
// (undercut means `d` points to the same side as the LOCAL inward normal, so
// infinitesimally past the sample point the ray is inside the solid; a
// closed bounded mesh must have a matching exit) — this is exactly what
// reproduces the brief's sphere spot-check ("depth at equator ~ 0, growing
// toward the pole": a lower-hemisphere sample point's `+d` ray re-enters the
// sphere and exits through the diametrically-mirrored upper-hemisphere
// point, at distance `2*|z|`, i.e. 0 at the equator, `2*radius` at the
// pole — see undercutScan.analytic.test.ts).
//
// `depthMm` is 0 for every NON-undercut triangle (this is Phase 3's
// contract: "non-undercut triangles have depth 0", verified by property
// test — every triangle's `+d` ray is now cast regardless of facing, since
// the SAME ray also drives the occlusion test above, but a triangle only
// ever STORES a nonzero `depthMm` when it ends up undercut, by either
// rule) and 0 for an undercut-by-facing triangle whose `+d` ray never
// re-hits the mesh (open/non-watertight input, or a genuine boundary edge)
// — treated as "no occluding surface found", not an error, since a
// production undercut scan must never crash on real (occasionally
// imperfectly watertight) scan data. For a facing-correct triangle, "the
// `+d` ray found no hit" IS precisely "not occluded" — there is no separate
// sentinel to reason about here, a miss and "genuinely not undercut" are
// the same fact.
//
// ## Near-perpendicular triangles: the boundary epsilon policy
//
// `normal · d` is a Float64 dot product of two already-unit-length
// vectors — for a triangle whose true geometric normal is EXACTLY
// perpendicular to `d` (e.g. an axis-aligned cylinder's wall scanned along
// its own axis), the computed value is not always exactly `0`: the normal
// itself came from a normalized cross product, which can accumulate
// rounding error up to roughly `1e-14`..`1e-13` at typical dental-scan
// coordinate magnitudes (a few ULPs per arithmetic step, compounding across
// `cross` + `normalizeOrZero` + `dot`). A bare `nd < 0` test is therefore
// NOT a safe proxy for "is this triangle genuinely facing away" right at
// the boundary — floating-point noise alone can push a mathematically-
// exactly-perpendicular triangle's computed `nd` to either side of `0`,
// nondeterministically with respect to the geometry (mesh winding order,
// vertex ordering, etc., not the actual tilt).
//
// `UNDERCUT_BOUNDARY_EPSILON` (`1e-12`) fixes this: any triangle with
// `|normal · d| < UNDERCUT_BOUNDARY_EPSILON` is classified NOT undercut BY
// FACING — deterministically and conservatively (it never CLAIMS a
// triangle is facing-away when the dot product is statistically
// indistinguishable from exact zero). `1e-12` is chosen to sit comfortably
// (1-2 orders of magnitude) above that `~1e-14..1e-13` rounding-noise
// ceiling while remaining many orders of magnitude below any physically
// meaningful near-perpendicular tilt (a genuine few-degree tilt already
// produces `|normal · d|` on the order of `1e-2` or larger) — i.e. this
// band only ever swallows FLOATING-POINT NOISE around a mathematically-
// exact-zero dot product, never a real, intentional near-grazing triangle.
//
// A triangle inside the band is ALSO exempt from the OCCLUSION rule (see
// "Occlusion as an INDEPENDENT undercut detector") — deliberately, not
// merely for symmetry. Right at `nd ~ 0`, `d` is (near-)TANGENT to the
// triangle's own plane, so a `+d` ray cast from a sample point on that
// triangle stays ON (or arbitrarily close to) that SAME plane rather than
// transversally leaving it — a genuine geometric degeneracy the existing
// `RAY_ORIGIN_BIAS_MM` self-intersection nudge cannot fix (the bias only
// pushes the origin a tiny distance FURTHER ALONG that same tangent plane,
// it does not change the ray's direction). Empirically (this module's own
// test suite), this degeneracy manifests as a SPURIOUS hit at the EXACT
// shared edge where a grazing triangle meets its immediately-adjacent,
// topologically-connected neighbor (a cube's vertical side wall meeting its
// own top face; an axis-aligned cylinder's wall meeting its own cap) — a
// real (non-near-zero-distance — the bias can't catch it) but geometrically
// meaningless "occlusion" by the mesh's own immediate neighbor at a
// zero-gap seam, not a genuine separate overhang. A genuinely grazing/
// zero-draft surface is, by long-standing manufacturing convention (and
// this module's OWN pre-existing `nd >= 0` rule, which this epsilon band
// only refines), simply NOT undercut — extending that same treatment to
// the occlusion rule is the consistent, honest choice here, verified
// against undercutScan.test.ts's cube side-wall test and
// undercutScan.overhang.test.ts's dedicated grazing-edge test (both of
// which reproduce this exact spurious-seam-hit failure if occlusion is
// instead checked for every `nd >= -UNDERCUT_BOUNDARY_EPSILON` triangle
// unconditionally) and undercutScan.analytic.test.ts's axis-aligned
// (`a = 0`) cylinder wall case (every wall triangle has `nd == 0` EXACTLY
// there, by construction — see that file's module doc).
//
// ## Sampling policy (@errorBound — sample-based occlusion, documented error character)
//
// `depthMm` — and, since this task's occlusion extension, the UNDERCUT
// BOOLEAN itself for a facing-correct/boundary triangle — is computed from
// a small, fixed set of SAMPLE POINTS per triangle, not a continuous
// per-point field:
//   - `'centroid'` (default): one ray, from the triangle's centroid.
//   - `'corners'`: FOUR rays (centroid + the 3 corners), `depthMm` = the
//     MAXIMUM hit distance across all sampled rays.
//
// This is fundamentally an APPROXIMATION with no fixed numeric error bound
// (unlike e.g. offsetMesh's `pitchMm/2 + eps_f32` — see offsetMesh.ts): a
// single sample per triangle can miss a genuine partial occlusion whose
// boundary crosses the triangle's interior between the sampled point(s) and
// an unsampled region (e.g. an overhang edge that clips one corner of a
// large triangle but not its centroid). The bound this introduces scales
// with TRIANGLE SIZE relative to the occluding feature's scale, not with any
// fixed epsilon — a well-tessellated mesh (every triangle far smaller than
// clinically relevant undercut/blockout features, which real intake-scan
// data satisfies) keeps this error small in practice, but no universal bound
// is claimed here. `'corners'` sampling (MAX over 4 samples) is strictly
// more conservative than `'centroid'` (never UNDER-reports relative to
// centroid-only, since centroid is one of its own samples) and catches any
// occlusion visible from a vertex even when the centroid isn't occluded —
// callers needing a defensible worst-case blockout number should prefer it;
// `'centroid'` is the default because it is 4x cheaper (a real concern:
// Phase 3's hemisphere sweep multiplies this by dozens of directions) and
// is what the "how deep, roughly" heatmap use case needs. Since occlusion
// is now sample-based too, `'corners'` can find a triangle undercut that
// `'centroid'` alone would MISS entirely (a corner is occluded even though
// the centroid isn't) — `'corners'` never under-reports the BOOLEAN either,
// same "strictly more conservative" relationship as the depth magnitude
// (see undercutScan.test.ts's updated sampling-policy property test).
//
// ## Ray origin epsilon policy (guardrail: self-intersection at the sample point)
//
// Every depth ray starts EXACTLY ON the mesh surface (a triangle's own
// centroid/corner) — casting `raycast(mesh, bvh, samplePoint, d)` directly
// from `samplePoint` risks the ray re-reporting its OWN triangle (or an
// adjacent coplanar-ish one sharing that point) as an immediate `t ~ 0` hit,
// which would silently corrupt every undercut triangle's depth to ~0
// regardless of true occlusion. This is exactly the same class of problem
// recursive-ray renderers solve with a "shadow ray bias": the ray's ACTUAL
// origin is offset `RAY_ORIGIN_BIAS_MM` further along `+d` from the sample
// point before casting, and that same bias is added BACK onto the reported
// hit distance (`depth = RAY_ORIGIN_BIAS_MM + hit.distance`) — so the bias
// only prevents self-intersection, it introduces no systematic
// under-measurement of the true depth (up to the bias's own negligible
// magnitude — see `RAY_ORIGIN_BIAS_MM`'s doc for why `1e-6` mm is
// comfortably below both this repo's µm (`1e-3` mm) clinical display
// resolution and any real Float64 rounding noise at mm-scale coordinates,
// while remaining ~9 orders of magnitude ABOVE that rounding noise so it
// reliably clears a grazing/edge-adjacent self-intersection — see
// undercutScan.test.ts's dedicated grazing-case test).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import { raycast } from '../bvh/raycast.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { cross, dot, normalizeOrZero, sub } from './vec.ts';

/** Bias applied along the cast direction before every depth raycast — see
 * this module's "Ray origin epsilon policy" doc above. `1e-6` mm (1 nm):
 * ~9 orders of magnitude above Float64 rounding noise at typical dental-scan
 * coordinate magnitudes (~1-100 mm; absolute rounding noise there is on the
 * order of `magnitude * 2.22e-16` ~ `2e-14..2e-15` mm), and ~3 orders of
 * magnitude below this repo's µm (`1e-3` mm) clinical display resolution —
 * i.e. large enough to reliably clear self-intersection, small enough to
 * never visibly perturb a reported depth. */
export const RAY_ORIGIN_BIAS_MM = 1e-6;

/** Triangles with `|normal · d| < UNDERCUT_BOUNDARY_EPSILON` are classified
 * NOT undercut BY FACING, and are ALSO excluded from the occlusion rule (a
 * `+d` ray is geometrically degenerate — near-tangent to the triangle's own
 * plane — right at this boundary) — see this module's "Near-perpendicular
 * triangles" doc above for the full derivation and rationale. `1e-12`:
 * comfortably above the `~1e-14..1e-13` Float64 rounding-noise ceiling of a
 * dot product between two already-normalized Vec3s at typical dental-scan
 * coordinate magnitudes, comfortably below any physically meaningful
 * near-grazing tilt (`~1e-2` or larger). */
export const UNDERCUT_BOUNDARY_EPSILON = 1e-12;

function validateMeshMatchesBvh(mesh: IndexedMesh, bvh: Bvh): void {
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount !== bvh.triangleCount) {
    throw new RangeError(
      `undercutScan: mesh has ${triangleCount} triangles but bvh was built for ${bvh.triangleCount} — this Bvh ` +
        `was not built from this mesh (or the mesh changed since).`,
    );
  }
}

function triangleVertices(mesh: IndexedMesh, triangleIndex: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[triangleIndex * 3]!;
  const i1 = mesh.indices[triangleIndex * 3 + 1]!;
  const i2 = mesh.indices[triangleIndex * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

/** Unit outward face normal (CCW-from-outside cross product, matching
 * `IndexedMesh`'s winding convention — see mesh/types.ts) — `[0,0,0]` for a
 * (defense-in-depth only; intake's `dropDegenerateTriangles` removes true
 * degenerates upstream) degenerate zero-area triangle, which then never
 * satisfies EITHER half of the undercut test below (its `nd` is exactly
 * `0`, inside `UNDERCUT_BOUNDARY_EPSILON`'s band — see that constant's doc:
 * the band excludes a triangle from both the facing AND the occlusion
 * rule). */
function triangleUnitNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalizeOrZero(cross(sub(b, a), sub(c, a)));
}

function centroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/** One biased depth raycast from `samplePoint` along `d` — see this
 * module's "Ray origin epsilon policy" doc. Returns 0 (not `null`/NaN) when
 * no occluding surface is found, per this module's documented "no error" contract. */
function depthFromSample(mesh: IndexedMesh, bvh: Bvh, samplePoint: Vec3, d: Vec3): number {
  const origin: Vec3 = [
    samplePoint[0] + d[0] * RAY_ORIGIN_BIAS_MM,
    samplePoint[1] + d[1] * RAY_ORIGIN_BIAS_MM,
    samplePoint[2] + d[2] * RAY_ORIGIN_BIAS_MM,
  ];
  const hit = raycast(mesh, bvh, origin, d);
  return hit ? RAY_ORIGIN_BIAS_MM + hit.distance : 0;
}

/** `depthFromSample` over the triangle's sampling-policy point set (see
 * this module's "Sampling policy" doc) — the MAXIMUM `+d` hit distance
 * across those samples, always cast along `d` (never `-d`; see "Occlusion
 * as an INDEPENDENT undercut detector" — the SAME cast drives both the
 * facing-away triangle's depth AND the facing-correct triangle's occlusion
 * check, unified into one computation). `0` iff every sample's ray found no
 * occluding surface. */
function maxDepthOverSamples(
  mesh: IndexedMesh,
  bvh: Bvh,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  sampling: UndercutSamplingPolicy,
  d: Vec3,
): number {
  let depth = depthFromSample(mesh, bvh, centroid(a, b, c), d);
  if (sampling === 'corners') {
    depth = Math.max(depth, depthFromSample(mesh, bvh, a, d), depthFromSample(mesh, bvh, b, d), depthFromSample(mesh, bvh, c, d));
  }
  return depth;
}

/** `'centroid'` (default): one depth sample per undercut triangle, at its
 * centroid. `'corners'`: 4 samples (centroid + the 3 corners), `depthMm` =
 * the MAXIMUM across them — see this module's "Sampling policy" doc for the
 * error-character tradeoff. */
export type UndercutSamplingPolicy = 'centroid' | 'corners';

export interface UndercutScanOptions {
  sampling?: UndercutSamplingPolicy;
}

export interface UndercutTriangleRange {
  /** Inclusive start triangle index. */
  readonly start: number;
  /** Exclusive end triangle index. */
  readonly end: number;
}

export interface UndercutScanRangeOutput {
  /** Full-mesh-sized (`mesh.indices.length / 3`) output array — only indices
   * in `[range.start, range.end)` are written; a caller scanning a mesh in
   * several range chunks (see this module's "Chunked range API" doc below)
   * passes the SAME two arrays to every chunk call, pre-allocated once. */
  readonly undercut: Uint8Array;
  readonly depthMm: Float64Array;
}

export interface UndercutScanRangeStats {
  /** Count of `undercut[t] === 1` within `[range.start, range.end)` only. */
  undercutCountInRange: number;
  /** Max `depthMm[t]` within `[range.start, range.end)` only (`0` if none
   * undercut in this range). */
  maxDepthMmInRange: number;
}

export interface UndercutScanResult {
  /** The (normalized) direction this scan was run against — normalized
   * internally, same convention as `raycast`'s `direction` handling
   * (bvh/raycast.ts), so a caller passing any non-zero-length vector gets
   * back the exact unit vector this scan actually used. */
  directionUnit: Vec3;
  triangleCount: number;
  /** Per-triangle undercut flag as `0`/`1` (not `boolean[]`) — compact,
   * directly transferable across a worker boundary (Comlink's structured
   * clone handles typed arrays zero-copy via transfer; a `boolean[]` would
   * not). `undercut[t] === 1` <=> `(normal[t] · directionUnit < -UNDERCUT_BOUNDARY_EPSILON)
   * OR (depthMm[t] > 0)` — facing-away OR occluded, see this module's
   * top-of-file "Undercut sign convention" / "Occlusion as an INDEPENDENT
   * undercut detector" docs. */
  undercut: Uint8Array;
  /** Per-triangle blockout depth, mm — `0` for every triangle with
   * `undercut[t] === 0` (property-tested), and for an undercut triangle
   * whose depth ray found no occluding surface. See this module's "Depth"
   * doc for the exact ray-cast semantics and the "Sampling policy" doc for
   * its documented (unbounded-in-the-worst-case, tessellation-scaled) error
   * character. */
  depthMm: Float64Array;
  undercutTriangleCount: number;
  /** `0` when `undercutTriangleCount === 0` (no undercut triangle to take a
   * max over). */
  maxDepthMm: number;
  sampling: UndercutSamplingPolicy;
}

function normalizeDirection(directionUnit: Vec3, callerName: string): Vec3 {
  const len = Math.hypot(directionUnit[0], directionUnit[1], directionUnit[2]);
  if (!(len > 0)) {
    throw new TypeError(`${callerName}: directionUnit must be a non-zero-length vector`);
  }
  return [directionUnit[0] / len, directionUnit[1] / len, directionUnit[2] / len];
}

function validateRange(range: UndercutTriangleRange, triangleCount: number): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > triangleCount || range.start > range.end) {
    throw new RangeError(
      `undercutScanRange: range [${range.start}, ${range.end}) is not a valid sub-range of [0, ${triangleCount})`,
    );
  }
}

/**
 * ## Chunked range API — the primitive `undercutScanBatch`/`undercutScan`
 * are built on, and what kernel-workers/src/jobs/undercut.ts drives directly
 * for REAL per-triangle-batch progress + cooperative cancellation within a
 * single direction. Intended audience: WORKER-SIDE chunking callers (this
 * function's `range` parameter exists FOR that use case) — a non-worker
 * caller that just wants a whole-mesh result should call `undercutScan`
 * below instead, not drive this function's chunk loop itself. Same split as
 * offset/marchingCubes.ts's
 * `marchingCubesSlab` vs. `marchingCubes` (that file's own doc: "the direct
 * entry point ... loops over marchingCubesSlab ... kernel-workers/src/jobs/
 * offset.ts drives the slab loop itself instead — real async cancellation
 * between slabs"): `undercutScan` (whole-mesh, ONE synchronous call, used
 * directly by kernel-level tests and any non-worker caller) loops over this
 * function internally; the JOB calls THIS function directly, chunk by
 * chunk, `await`ing a cancellation check between chunks — something no
 * purely-synchronous whole-mesh call could ever offer (`ctx.cancelled()` is
 * async — a real postMessage round trip — so genuine cooperative
 * cancellation needs an `await` point between chunks, not just a callback
 * invoked from inside one long synchronous loop).
 *
 * Computes undercut/depth for triangles `[range.start, range.end)` ONLY,
 * writing into the CALLER-supplied `out.undercut`/`out.depthMm` (both must
 * be sized to the WHOLE mesh's triangle count — `mesh.indices.length / 3` —
 * even though only the range's slice is touched here; a caller chunking a
 * scan allocates these ONCE and passes the SAME arrays to every chunk call).
 * Returns per-RANGE aggregate stats (not whole-mesh) so the caller can
 * accumulate `undercutTriangleCount`/`maxDepthMm` itself across chunks.
 *
 * Throws `RangeError` for a stale/mismatched `bvh` (same check as
 * `undercutScan`) or an out-of-bounds `range`. Throws `TypeError` for a
 * zero-length `directionUnit`.
 */
export function undercutScanRange(
  mesh: IndexedMesh,
  bvh: Bvh,
  directionUnit: Vec3,
  range: UndercutTriangleRange,
  out: UndercutScanRangeOutput,
  options: UndercutScanOptions = {},
): UndercutScanRangeStats {
  validateMeshMatchesBvh(mesh, bvh);
  const triangleCount = mesh.indices.length / 3;
  validateRange(range, triangleCount);
  const d = normalizeDirection(directionUnit, 'undercutScanRange');
  const sampling = options.sampling ?? 'centroid';

  let undercutCountInRange = 0;
  let maxDepthMmInRange = 0;

  for (let t = range.start; t < range.end; t++) {
    const [a, b, c] = triangleVertices(mesh, t);
    const n = triangleUnitNormal(a, b, c);
    const nd = dot(n, d);
    const undercutByFacing = nd < -UNDERCUT_BOUNDARY_EPSILON;
    // Occlusion is only checked for triangles STRICTLY facing (`nd >
    // +UNDERCUT_BOUNDARY_EPSILON`) — a triangle inside the boundary/grazing
    // band is excluded from BOTH rules, not just the facing one. This is
    // not merely "reuse the same epsilon for convenience": right at
    // `nd ~ 0`, `d` is (near-)TANGENT to the triangle's OWN plane, so a
    // `+d` ray from a sample point on that triangle stays on (or
    // arbitrarily close to) that triangle's own plane — a genuine geometric
    // degeneracy, not a self-intersection-bias problem the existing
    // `RAY_ORIGIN_BIAS_MM` nudge can fix. Concretely, this is exactly what
    // happens at a flat mesh seam (e.g. a cube's vertical side wall meeting
    // its top face at a shared edge, or an axis-aligned cylinder's wall
    // meeting a cap): the ray, moving along the wall's own plane, reaches
    // the EXACT shared edge with the adjacent, topologically-connected face
    // and registers a real (non-near-zero-distance, so the bias can't catch
    // it) but SPURIOUS "occlusion" — not a separate overhang, just the
    // mesh's own immediately-adjacent geometry at a zero-gap seam. See this
    // module's top-of-file "Near-perpendicular triangles" doc: a genuinely
    // grazing/zero-draft surface is, by long-standing manufacturing
    // convention (and this module's OWN pre-existing `nd >= 0` rule, which
    // this epsilon band only refines), simply NOT undercut — extending that
    // same treatment to the occlusion rule is the honest, consistent
    // choice, not a special case invented to dodge a failing test (verified
    // against undercutScan.test.ts's cube side-wall test and
    // undercutScan.overhang.test.ts's dedicated grazing-edge test, both of
    // which fail with a spurious same-plane seam hit if occlusion is
    // instead checked unconditionally for every `nd >= -EPSILON` triangle).
    const eligibleForOcclusion = nd > UNDERCUT_BOUNDARY_EPSILON;
    if (!undercutByFacing && !eligibleForOcclusion) {
      continue; // boundary/grazing band — not undercut by facing, and the occlusion ray is degenerate here. out.undercut[t]/out.depthMm[t] stay 0 (typed arrays zero-init).
    }
    // This SAME `+d` ray drives both the facing-away triangle's depth AND
    // the strictly-facing triangle's occlusion check (see "Occlusion as an
    // INDEPENDENT undercut detector").
    const depth = maxDepthOverSamples(mesh, bvh, a, b, c, sampling, d);
    if (undercutByFacing || depth > 0) {
      out.undercut[t] = 1;
      undercutCountInRange++;
      out.depthMm[t] = depth;
      if (depth > maxDepthMmInRange) maxDepthMmInRange = depth;
    }
    // else: not undercut — out.undercut[t] stays 0, out.depthMm[t] stays 0 (typed arrays zero-init).
  }

  return { undercutCountInRange, maxDepthMmInRange };
}

/**
 * Per-triangle insertion-axis undercut scan against a single direction —
 * see this module's top-of-file doc for the exact sign convention and depth
 * semantics. `bvh` MUST be `buildBvh(mesh)` (or a cached equivalent, e.g.
 * kernel-workers/src/jobs/bvh.ts's per-worker cache) — never rebuilt inside
 * this function, so a caller running many directions against the same mesh
 * (`undercutScanBatch` below, or a caller wiring its own loop) only pays the
 * BVH build cost once.
 *
 * ONE synchronous call over the whole mesh (loops over `undercutScanRange`
 * internally, single chunk `[0, triangleCount)`) — see that function's doc
 * for the chunked variant kernel-workers/src/jobs/undercut.ts drives itself
 * for real progress/cancellation.
 *
 * Throws `RangeError` if `bvh` wasn't built from a mesh with the same
 * triangle count as `mesh` (same "stale BVH" defense as `closestPoint`/
 * `raycast` — bvh/closestPoint.ts, bvh/raycast.ts). Throws `TypeError` if
 * `directionUnit` is the zero vector (no direction to scan against).
 */
export function undercutScan(
  mesh: IndexedMesh,
  bvh: Bvh,
  directionUnit: Vec3,
  options: UndercutScanOptions = {},
): UndercutScanResult {
  validateMeshMatchesBvh(mesh, bvh);
  const d = normalizeDirection(directionUnit, 'undercutScan');
  const sampling = options.sampling ?? 'centroid';
  const triangleCount = mesh.indices.length / 3;
  const undercut = new Uint8Array(triangleCount);
  const depthMm = new Float64Array(triangleCount);

  const { undercutCountInRange, maxDepthMmInRange } = undercutScanRange(
    mesh,
    bvh,
    d,
    { start: 0, end: triangleCount },
    { undercut, depthMm },
    { sampling },
  );

  return {
    directionUnit: d,
    triangleCount,
    undercut,
    depthMm,
    undercutTriangleCount: undercutCountInRange,
    maxDepthMm: maxDepthMmInRange,
    sampling,
  };
}

export interface UndercutScanBatchOptions extends UndercutScanOptions {
  /** Invoked synchronously after each direction's scan completes, with
   * `(done, total)` — the per-direction progress checkpoint this task's
   * brief asks for at the kernel layer. kernel-workers/src/jobs/undercut.ts
   * does NOT call this function (it drives `undercutScanRange` itself,
   * chunk by chunk, both within and across directions — see that file's
   * module doc) precisely to additionally report PER-TRIANGLE-BATCH
   * progress WITHIN a direction and support real `await`ed cancellation
   * between chunks, neither of which this synchronous, whole-direction-at-a-
   * time callback can offer. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * `undercutScan` for every direction in `directions`, against the SAME
 * `bvh` (built exactly once by the caller) — this is the amortization this
 * task's brief calls out for Phase 3's hemisphere sweep ("batch API
 * matters"): a dozens-of-directions sweep over a quarter-million-triangle
 * arch/prep mesh must not rebuild the BVH per direction (see this file's
 * top-of-file doc's "API shape" note for why `undercutScan` itself takes a
 * pre-built `bvh` rather than a raw `mesh`, precisely so this function's
 * loop body can be a single `undercutScan` call with no rebuild anywhere in
 * it).
 */
export function undercutScanBatch(
  mesh: IndexedMesh,
  bvh: Bvh,
  directions: readonly Vec3[],
  options: UndercutScanBatchOptions = {},
): UndercutScanResult[] {
  const { onProgress, ...scanOptions } = options;
  const results: UndercutScanResult[] = new Array(directions.length);
  for (let i = 0; i < directions.length; i++) {
    results[i] = undercutScan(mesh, bvh, directions[i]!, scanOptions);
    onProgress?.(i + 1, directions.length);
  }
  return results;
}
