// packages/kernel/src/spline/marginLine.ts
//
// Phase 2 Task 5 / Phase 3 Task 1: converting a `SurfaceSpline` to/from
// shared-types' `MarginLine` shape.
//
// `MarginLine` (packages/shared-types/src/index.ts, schemaVersion 2 —
// Phase 3 Task 1's type evolution):
//
//   interface MarginAnchor {
//     position: Vec3;
//     triangleIndex: number;
//     barycentric: readonly [number, number, number];
//   }
//   interface MarginLine {
//     anchors: readonly MarginAnchor[];
//     closed: boolean;
//     resampledPoints?: readonly Vec3[];
//   }
//
// ## Lossless: `MarginAnchor` IS the `SurfacePoint` currency, plus an exact
// float-precision echo
//
// A `SurfaceSpline`'s control points are `SurfacePoint`s (triangle +
// barycentric — geodesic/types.ts), i.e. ARBITRARY points on the surface,
// exactly like `geodesic/snapPolyline.ts`'s anchors. Phase 2's original
// `MarginLine` (schemaVersion 1) only had `vertexAnchors: readonly
// number[]` — a single NEAREST-vertex index per control point, with no
// representation for "on this triangle, at these barycentric weights" — so
// `toMarginLine`/`fromMarginLine` used to be lossy in one direction (see
// this file's git history / docs/plans/phase-2-kernel-core.md Task 5 for
// the original writeup, and apps/client/src/engine/
// caseDocumentMigration.ts for the schemaVersion 1 -> 2 migration this
// evolution required). `MarginAnchor` carries the EXACT same
// `(triangleIndex, barycentric)` pair `SurfacePoint` does, so this adapter
// is now a straight, lossless field rename/reshape in BOTH directions —
// `toMarginLine` needs no heuristic "nearest vertex" choice, and
// `fromMarginLine` needs no BVH re-projection to RECONSTRUCT its result — a
// bare call (`fromMarginLine(marginLine)`, no second argument) remains a
// pure function of `MarginLineLike` alone, exactly as before. `position` is
// carried through as a redundant, always-in-sync echo (recomputed via
// `evaluateSurfacePoint` on the way out, never independently trusted for
// reconstruction on the way back in — see `fromMarginLine`'s doc).
//
// ## Fix batch (Task-11-final-review Important 9): an OPTIONAL `mesh`
// argument closes the validation/reconstruction trust gap
//
// `margin/validate.ts`'s `validateMarginLine` deliberately validates ONLY
// ambient `position`s, never `(triangleIndex, barycentric)` (see that
// module's own doc for why) — which means a document whose
// `(triangleIndex, barycentric)` pair is corrupted, but whose `position`
// echo is untouched, validates "clean". `fromMarginLine` is the one place
// that actually TRUSTS `(triangleIndex, barycentric)` for reconstruction, so
// it is where such a corruption would silently produce a DIFFERENT curve —
// up to a raw, unthrown `NaN` for an out-of-range `triangleIndex`. When a
// caller has a `mesh` on hand, passing it as `fromMarginLine`'s second
// argument closes that gap: every anchor's `triangleIndex` is bounds-checked
// and its reconstructed position is verified to agree with the stored
// `position` echo, BEFORE any `SurfacePoint[]` is returned — see
// `MarginAnchorMismatchError`'s doc.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { evaluateSurfacePoint } from '../geodesic/surfacePoint.ts';
import type { SurfacePoint } from '../geodesic/types.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';

/** The subset of shared-types' `MarginAnchor` this adapter reads/writes —
 * duplicated locally (not imported from `@dqcad/shared-types`), matching
 * `intake/types.ts`'s established "structural twin" convention (that
 * module's `TriangleSoup` is a deliberate structural twin of `@dqcad/io`'s
 * `RawTriangleSoup` for the same reason: the `boundaries/dependencies` lint
 * policy technically ALLOWS `kernel -> shared-types`, but no file in this
 * package actually takes that dependency — `packages/kernel/package.json`
 * has zero workspace `dependencies` today, and this adapter doesn't need to
 * be the first). Structurally identical to `@dqcad/shared-types`'
 * `MarginAnchor` (verified by marginLine.test.ts's exact field-shape test).
 */
export interface MarginAnchorLike {
  readonly position: Vec3;
  readonly triangleIndex: number;
  readonly barycentric: readonly [number, number, number];
}

/** The subset of shared-types' `MarginLine` this adapter reads/writes — see
 * `MarginAnchorLike`'s doc for the "structural twin" convention this
 * follows. Structurally identical to `@dqcad/shared-types`' `MarginLine`
 * (verified by marginLine.test.ts's exact field-shape test), so a
 * `MarginLine` value is always assignable here and vice versa without a
 * cast. */
export interface MarginLineLike {
  readonly anchors: readonly MarginAnchorLike[];
  readonly closed: boolean;
  readonly resampledPoints?: readonly Vec3[];
}

function toSurfacePoint(anchor: MarginAnchorLike): SurfacePoint {
  return { triangleIndex: anchor.triangleIndex, barycentric: anchor.barycentric };
}

/**
 * Converts a `SurfaceSpline`-shaped control-point list (any ordered
 * `SurfacePoint[]` — deliberately not typed against `SurfaceSpline` itself,
 * so a caller can also convert a partially-built or a geodesic-mode control
 * point list with the same function) to `MarginLineLike`. Lossless in both
 * directions (see this module's top doc) — `position` is the evaluated
 * ambient point for each `SurfacePoint`, `triangleIndex`/`barycentric` carry
 * through exactly.
 */
export function toMarginLine(
  mesh: IndexedMesh,
  controlPoints: readonly SurfacePoint[],
  closed: boolean,
  resampledPoints?: readonly Vec3[],
): MarginLineLike {
  const anchors: MarginAnchorLike[] = controlPoints.map((sp) => ({
    position: evaluateSurfacePoint(mesh, sp),
    triangleIndex: sp.triangleIndex,
    barycentric: sp.barycentric,
  }));
  return resampledPoints === undefined ? { anchors, closed } : { anchors, closed, resampledPoints };
}

/** Which check `MarginAnchorMismatchError` failed — see that class's doc.
 * `'outOfRange'`: `triangleIndex` does not name a real triangle of the mesh
 * passed to `fromMarginLine` (the underlying bug this guards: an
 * out-of-range index reads `undefined` off `mesh.indices`, which
 * `geodesic/surfacePoint.ts`'s non-null-asserted indexing then propagates to
 * `NaN` silently, rather than failing loudly). `'positionMismatch'`: the
 * stored `position` echo disagrees with `evaluateSurfacePoint(mesh,
 * {triangleIndex, barycentric})` by more than
 * `MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM` — a VALID triangle, but a
 * `barycentric` (or `position`) that does not actually correspond to it. */
export type MarginAnchorMismatchKind = 'outOfRange' | 'positionMismatch';

/**
 * Thrown by `fromMarginLine` (only when its optional `mesh` argument is
 * supplied — see that function's doc) when an anchor's `(triangleIndex,
 * barycentric)` does not trustworthily name the same point as its stored
 * `position` echo — Task-11-final-review Important 9: this validator
 * (`validateMarginLine`, margin/validate.ts) deliberately checks ONLY
 * ambient `position`s (see that module's own doc for why), so a document
 * with a corrupted `(triangleIndex, barycentric)` pair but an untouched,
 * plausible-looking `position` passes validation "clean" — `fromMarginLine`
 * is the one place in this codebase that actually TRUSTS
 * `(triangleIndex, barycentric)` as authoritative (see this function's own
 * doc for why: it reconstructs geometry FROM that pair, discarding
 * `position`), so it is the place a silent mismatch would do real damage
 * (a reconstructed curve silently different from the one `position` alone
 * would describe) — up to and including a raw `NaN` propagating out of
 * `evaluateSurfacePoint` for an out-of-range `triangleIndex` with no error
 * at all (`geodesic/surfacePoint.ts`'s `triangleVertexIndices` indexes
 * `mesh.indices` with a non-null assertion; out-of-range reads `undefined`,
 * and `undefined * weight` is `NaN`, not a thrown error). */
export class MarginAnchorMismatchError extends Error {
  readonly index: number;
  readonly kind: MarginAnchorMismatchKind;
  constructor(index: number, kind: MarginAnchorMismatchKind, detail: string) {
    super(`fromMarginLine: anchors[${index}]: ${detail}`);
    this.name = 'MarginAnchorMismatchError';
    this.index = index;
    this.kind = kind;
  }
}

/** Agreement tolerance (mm) between an anchor's stored `position` echo and
 * its `(triangleIndex, barycentric)`-reconstructed position — reuses
 * `intake/weld.ts`'s `MESH_WELD_EPSILON_MM` (1e-6mm), the same "genuinely
 * the same point, not merely nearby" tight tolerance `margin/validate.ts`'s
 * on-surface check already established for exactly this kind of comparison
 * (see that module's "On-surface" doc: a LEGITIMATELY produced `position` —
 * always `evaluateSurfacePoint(mesh, sp)` at write time, per `toMarginLine`
 * — agrees with a fresh re-evaluation up to ordinary Float64
 * barycentric-combination rounding only, ~1e-13..1e-15mm at dental-scan
 * coordinate magnitudes, comfortably under 1e-6mm; a genuinely corrupted
 * `barycentric`/`position` pair is expected to disagree by orders of
 * magnitude more). Reusing the established constant rather than minting a
 * fresh one, per this file's own "structural twin" precedent for avoiding
 * ad hoc duplicate magic numbers. */
export const MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM = MESH_WELD_EPSILON_MM;

/**
 * Reconstructs an ordered `SurfacePoint[]` (suitable as `fitSurfaceSpline`'s
 * `points` input after evaluating each to an ambient `Vec3`, or directly as
 * `SurfaceSpline.controlPoints`) from a `MarginLineLike`'s `anchors` —
 * `triangleIndex`/`barycentric` are read straight through (no BVH
 * re-projection needed: see this module's top doc for why this is now
 * lossless and pure). `position` is intentionally IGNORED for the
 * RECONSTRUCTION itself (as `vertexAnchors` was under the old scheme) — it
 * is a redundant echo of `evaluateSurfacePoint(mesh, {triangleIndex,
 * barycentric})` against whichever mesh the CALLER already knows is the
 * correct target; trusting `triangleIndex`/`barycentric` directly is what
 * "mesh-tied via the restoration's target mesh contentHash context"
 * (shared-types' `MarginAnchor` doc) means in practice — the caller is
 * responsible for passing anchors alongside the SAME mesh content they were
 * produced against.
 *
 * `mesh` is OPTIONAL and, when omitted, this function behaves exactly as
 * before — a pure function of `marginLine` alone, no validation, callable
 * with no `Bvh`/`IndexedMesh` in hand at all (see this module's top doc:
 * several real callers genuinely have no mesh reference at this point).
 * **When `mesh` IS supplied** (Task-11-final-review Important 9 — "where the
 * mesh is available"), every anchor is checked BEFORE any reconstruction is
 * returned: `triangleIndex` must name a real triangle of `mesh`, and
 * `position` must agree with `evaluateSurfacePoint(mesh, {triangleIndex,
 * barycentric})` within `MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM` — see
 * `MarginAnchorMismatchError`'s doc for why this specific pair of checks
 * closes the validation/reconstruction TRUST gap `validateMarginLine`
 * (margin/validate.ts) cannot close on its own.
 *
 * @throws {RangeError} if `marginLine.anchors` is empty.
 * @throws {MarginAnchorMismatchError} if `mesh` is supplied and any anchor's
 * `triangleIndex` is out of range, or its stored `position` disagrees with
 * its `(triangleIndex, barycentric)`-reconstructed position beyond
 * `MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM`.
 */
export function fromMarginLine(marginLine: MarginLineLike, mesh?: IndexedMesh): { controlPoints: SurfacePoint[]; closed: boolean } {
  if (marginLine.anchors.length === 0) {
    throw new RangeError('fromMarginLine: marginLine.anchors must have at least 1 entry');
  }
  if (mesh) {
    const triangleCount = mesh.indices.length / 3;
    for (let i = 0; i < marginLine.anchors.length; i++) {
      const anchor = marginLine.anchors[i]!;
      if (!Number.isInteger(anchor.triangleIndex) || anchor.triangleIndex < 0 || anchor.triangleIndex >= triangleCount) {
        throw new MarginAnchorMismatchError(
          i,
          'outOfRange',
          `triangleIndex ${anchor.triangleIndex} is out of range for a mesh with ${triangleCount} triangles`,
        );
      }
      const reconstructed = evaluateSurfacePoint(mesh, toSurfacePoint(anchor));
      const deviationMm = Math.hypot(
        reconstructed[0] - anchor.position[0],
        reconstructed[1] - anchor.position[1],
        reconstructed[2] - anchor.position[2],
      );
      // `!(deviationMm <= tolerance)` (not `deviationMm > tolerance`)
      // deliberately also catches `NaN` (e.g. a barycentric weight that is
      // itself `NaN`/`Infinity`) — `NaN > x` is always `false`, which would
      // otherwise let a non-finite deviation slip through silently, exactly
      // the failure mode this check exists to close.
      if (!(deviationMm <= MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM)) {
        throw new MarginAnchorMismatchError(
          i,
          'positionMismatch',
          `stored position disagrees with the (triangleIndex, barycentric)-reconstructed position by ${deviationMm}mm, exceeding the ${MARGIN_ANCHOR_AGREEMENT_TOLERANCE_MM}mm tolerance`,
        );
      }
    }
  }
  const controlPoints = marginLine.anchors.map(toSurfacePoint);
  return { controlPoints, closed: marginLine.closed };
}
