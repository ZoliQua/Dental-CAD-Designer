// packages/kernel/src/anatomy/placement.ts
//
// Phase 4 Task 5 — ANATOMY PLACEMENT solver. Deterministic, closed-form
// transform solve that positions a library tooth (an anatomical mesh + its
// canonical local frame + landmarks) into a case: it builds a TARGET frame
// in case/world space from the confirmed margin, the insertion axis, the two
// neighbour teeth and the antagonist, then aligns the library tooth's
// canonical frame to that target frame and scales it anisotropically to fill
// the inter-neighbour (mesial-distal) and margin-to-antagonist
// (occluso-gingival) space.
//
// ## Why this lives in the kernel (not cad-pipeline)
//
// Both `@dqcad/cad-pipeline`'s anatomy-placement STAGE and
// `@dqcad/kernel-workers`' `placeAnatomy` worker job need this solve, and
// neither package may import the other (eslint boundaries: each imports only
// `kernel`/`io`/`shared-types`). The heavy-math-in-kernel, orchestration-in-
// cad-pipeline, worker-job-calls-kernel split mirrors `buildInnerSurface`
// exactly (Task 3/4). The solve reads ONLY case GEOMETRY — no clinical
// parameters (gaps/thresholds/thicknesses) enter here, so CLAUDE.md
// invariant 7 ("clinical defaults only in clinical-profiles") is not in play;
// the only constants are documented GEOMETRIC fallbacks (see below).
//
// ## The target frame (each axis' derivation)
//
//  - **occluso-gingival (`og`)**: the insertion axis (the crown's confirmed
//    seating/draw direction — Phase 3), normalised. It points OCCLUSALLY by
//    the same convention `innerSurface` relies on. When an antagonist is
//    present its sign is re-oriented to point toward the opposing arch (the
//    physical occlusal direction), so a sign-flipped insertion axis can never
//    silently place the tooth upside-down; without an antagonist the
//    insertion-axis sign is trusted as-is.
//  - **mesial-distal (`md`)**: the vector from the MESIAL neighbour's
//    bounding centroid to the DISTAL neighbour's bounding centroid (the M-D
//    line through the restoration site), projected into the plane ⟂ `og` and
//    normalised. The caller identifies which neighbour is mesial vs distal
//    (an FDI-numbering decision, not geometry — see the cad-pipeline stage).
//  - **bucco-lingual (`bl`)**: `og × md`. This makes the target frame
//    right-handed with the SAME axis correspondence as the canonical frame
//    (whose documented convention is right-handed: MD×BL = OG). Consequence:
//    once `md` points distally and `og` points occlusally, `bl` is FORCED to
//    point buccally — the buccal/lingual orientation needs no separate datum.
//
// Target **origin** = the margin loop's centroid (`computeMarginLoopFrame`):
// the cervical seat where the crown meets the prep, which is exactly where a
// library tooth's canonical origin sits (its mesh rises from the cervical
// margin toward the incisal/occlusal).
//
// ## The two scale factors (+ the third, dependent, axis)
//
//  - **`scaleMesialDistal`** = (target M-D width) / (native M-D width).
//    Target M-D width is the PROXIMAL GAP between the neighbours: the distal
//    neighbour's most-mesial extent minus the mesial neighbour's most-distal
//    extent, both projected on `md` — the free inter-proximal space the crown
//    must fill. If that gap is non-positive (crowded/overlapping neighbour
//    scans) it falls back to the neighbour centroid-to-centroid distance
//    along `md`. Native M-D width is the library mesh's own extent along its
//    canonical `mesialDistal` axis.
//  - **`scaleOcclusoGingival`** = (target O-G height) / (native O-G height).
//    Target O-G height is the distance from the margin centroid, along `og`,
//    to the NEAREST antagonist surface directly over the site (antagonist
//    vertices within the margin's own lateral radius of the `og` axis, on the
//    occlusal side). Native O-G height is the library mesh's extent along its
//    canonical `occlusoGingival` axis. **Antagonist-absent fallback**: with
//    no antagonist there is no opposing datum, so O-G is scaled by the SAME
//    factor as M-D (uniform in-plane×height scale → the library tooth's
//    natural proportions are preserved, never anisotropically distorted).
//  - **`scaleBuccoLingual`** = `scaleMesialDistal`. The case constrains M-D
//    (neighbours) and O-G (antagonist) but nothing constrains bucco-lingual
//    depth, so B-L reuses the M-D factor, preserving the library tooth's own
//    M-D:B-L cross-section ratio.
//
// ## The transform (reusing register/kabsch + register/transform)
//
// The rigid canonical→target frame alignment is recovered with the kernel's
// existing closed-form `coarseAlignFromPointTriples` (Kabsch), fed the two
// frames' axis-tip triples — NOT a re-implemented rotation solve. The
// anisotropic scale is then composed around the target origin
// (`multiplyMat4`). The net transform is exactly
// `M = R_target · S · R_canonicalᵀ`, `t = origin − M·originCanonical`, an
// affine (positive-determinant, so triangle winding is preserved) map applied
// to a COPY of the shared, immutable library mesh (`applyMat4ToPoint` per
// vertex) — the library asset is never mutated.
//
// @errorBound EXACT (Float64, machine precision — `coarseAlignFromPointTriples`
// recovers the frame rotation to ~1e-13 for orthonormal triads; every other
// step is direct arithmetic). Placement is a deterministic geometric HEURISTIC
// for the initial pose, not an approximation of a continuous quantity — the
// downstream adaptation/morphing stage refines it — so `RestorationStageResult`
// carries a `null` errorBound for it.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { coarseAlignFromPointTriples } from '../register/kabsch.ts';
import {
  applyMat4ToPoint,
  composeRigid,
  multiplyMat4,
  type Mat3,
  type Mat4,
} from '../register/transform.ts';
import { computeMarginLoopFrame } from '../margin/band.ts';

/** A library tooth's canonical local frame — structurally the tooth-library
 * `CanonicalFrame` (origin + three unit, mutually-orthogonal, right-handed
 * axes; sign convention: `mesialDistal`→distal, `buccoLingual`→buccal,
 * `occlusoGingival`→occlusal). Duplicated here rather than imported because
 * `kernel` may not depend on `tooth-library` (layer rule) — the same "mirror
 * the shape across a forbidden boundary" precedent as `shared-types`'
 * `MarginAnchor` vs the kernel's `SurfacePoint`. */
export interface CanonicalFrameAxes {
  readonly origin: Vec3;
  readonly mesialDistal: Vec3;
  readonly buccoLingual: Vec3;
  readonly occlusoGingival: Vec3;
}

/** The solved placement, as a fully-parameterised target frame + anisotropic
 * scale. `buildPlacementTransform` turns this into the 4×4; the manual-override
 * helpers (`translatePlacement`/`rotatePlacement`/`rescalePlacement`/
 * `solveLandmarkHandleTranslation`) return a NEW `PlacementFrame` (immutable
 * value semantics) so the UI can drive position/rotation/scale/handle edits
 * deterministically off the solved auto-placement. */
export interface PlacementFrame {
  readonly originMm: Vec3;
  /** World-space unit axes (right-handed: `md × bl = og`). */
  readonly mesialDistal: Vec3;
  readonly buccoLingual: Vec3;
  readonly occlusoGingival: Vec3;
  readonly scaleMesialDistal: number;
  readonly scaleBuccoLingual: number;
  readonly scaleOcclusoGingival: number;
}

export interface AnatomyPlacementInput {
  readonly canonicalFrame: CanonicalFrameAxes;
  /** The library tooth mesh — its positions supply the native M-D/O-G extents.
   * Never mutated (immutable shared asset). */
  readonly libraryMesh: IndexedMesh;
  /** The confirmed margin loop (dense, on-surface, DEDUPLICATED by the
   * caller — e.g. `marginLoopPolyline`). Supplies the target origin + lateral
   * radius. */
  readonly marginLoop: readonly Vec3[];
  /** Insertion axis — the crown draw direction (occlusally-pointing). */
  readonly insertionAxis: Vec3;
  /** Flat xyz positions of the MESIAL neighbour tooth (world space). */
  readonly mesialNeighborPositions: Float64Array;
  /** Flat xyz positions of the DISTAL neighbour tooth (world space). */
  readonly distalNeighborPositions: Float64Array;
  /** Flat xyz positions of the antagonist / opposing arch (world space), or
   * `null` if none is assigned — triggers the documented O-G fallback. */
  readonly antagonistPositions: Float64Array | null;
}

/** Measured quantities the solve produced — reported/journaled by the caller
 * (not part of the transform, but the evidence for it). */
export interface AnatomyPlacementMeasurements {
  readonly nativeMesialDistalWidthMm: number;
  readonly nativeOcclusoGingivalHeightMm: number;
  readonly targetMesialDistalWidthMm: number;
  /** `null` when the antagonist was absent (O-G used the M-D fallback). */
  readonly targetOcclusoGingivalHeightMm: number | null;
  readonly usedProximalGap: boolean;
  readonly antagonistUsed: boolean;
  readonly occlusoGingivalReoriented: boolean;
}

export interface AnatomyPlacementSolution {
  readonly frame: PlacementFrame;
  readonly measurements: AnatomyPlacementMeasurements;
}

/** A projected 1-D extent along a scale axis smaller than this (mm) is treated
 * as degenerate — 1e-9 mm (1 pm), far below any real tooth dimension and any
 * clinically meaningful length, comfortably above Float64 rounding noise at
 * dental-scan coordinate magnitudes. Guards the scale-factor divisions. */
export const PLACEMENT_MIN_EXTENT_MM = 1e-9;

/** Max deviation from unit length / from perpendicular (dot) a frame axis
 * triple may have and still count as orthonormal — see `assertFrameValid`.
 * Generous enough for ordinary Float64 rounding in a hand-authored frame,
 * tight enough to catch a genuinely skewed/mislabeled triple (matches
 * tooth-library `schema.ts`'s `FRAME_UNIT_LENGTH_TOLERANCE` magnitude). */
export const FRAME_ORTHONORMAL_TOLERANCE = 1e-6;
/** An orthonormal RIGHT-handed frame has `det(md,bl,og) = +1`; a LEFT-handed
 * (mirrored) one has `-1`. This threshold cleanly separates them: any proper
 * orthonormal frame is well above it, any mirrored one is negative. */
export const FRAME_MIN_RIGHT_HANDED_DET = 0.5;

export class DegeneratePlacementError extends Error {
  constructor(message: string) {
    super(`anatomy/placement: ${message}`);
    this.name = 'DegeneratePlacementError';
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scaleVec(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalizeOrThrow(a: Vec3, what: string): Vec3 {
  const len = norm(a);
  if (!(len > PLACEMENT_MIN_EXTENT_MM)) {
    throw new DegeneratePlacementError(`${what} is a (near-)zero vector, cannot normalise`);
  }
  return [a[0] / len, a[1] / len, a[2] / len];
}

function det3(md: Vec3, bl: Vec3, og: Vec3): number {
  // det of the matrix whose COLUMNS are md, bl, og  ==  md · (bl × og).
  return dot(md, cross(bl, og));
}

/**
 * Assert a frame's three axes form a RIGHT-HANDED orthonormal triad — each unit
 * length and mutually perpendicular to `FRAME_ORTHONORMAL_TOLERANCE`, and
 * `det(md,bl,og) > FRAME_MIN_RIGHT_HANDED_DET` (> 0, i.e. NOT a mirror). This is
 * the placement CHOKE POINT's defence (CLAUDE.md "no silent data mutation"): a
 * left-handed canonical asset frame — which `tooth-library`'s
 * `assertOrthonormalFrame` does NOT catch (it never checks the determinant) —
 * or a manual override that fed a non-proper rotation into `rotatePlacement`
 * would otherwise be silently MIRRORED by the Kabsch alignment (which always
 * returns the closest PROPER rotation, so it maps a left-handed triad to its
 * mirror image rather than erroring). Validated for BOTH the canonical and the
 * target frame in `buildPlacementTransform`, so it covers the bad-asset AND the
 * corrupted-override cases with one guard.
 *
 * @throws {DegeneratePlacementError} if the triple is not unit-length, not
 * mutually orthogonal, or not right-handed.
 */
export function assertFrameValid(md: Vec3, bl: Vec3, og: Vec3, what: string): void {
  const axes: Array<[string, Vec3]> = [
    ['mesialDistal', md],
    ['buccoLingual', bl],
    ['occlusoGingival', og],
  ];
  for (const [name, axis] of axes) {
    if (Math.abs(norm(axis) - 1) > FRAME_ORTHONORMAL_TOLERANCE) {
      throw new DegeneratePlacementError(`${what}.${name} must be unit length, got length ${norm(axis)}`);
    }
  }
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      const [na, a] = axes[i]!;
      const [nb, b] = axes[j]!;
      if (Math.abs(dot(a, b)) > FRAME_ORTHONORMAL_TOLERANCE) {
        throw new DegeneratePlacementError(`${what}.${na} and ${what}.${nb} must be orthogonal, got dot ${dot(a, b)}`);
      }
    }
  }
  const det = det3(md, bl, og);
  if (!(det > FRAME_MIN_RIGHT_HANDED_DET)) {
    throw new DegeneratePlacementError(
      `${what} must be RIGHT-handed (det(md,bl,og) > 0), got det ${det} — a left-handed/mirrored frame would silently mirror the placed tooth`,
    );
  }
}

function centroidOfPositions(positions: Float64Array): Vec3 {
  const n = positions.length / 3;
  if (n < 1) throw new DegeneratePlacementError('neighbour position array is empty');
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3]!;
    cy += positions[i * 3 + 1]!;
    cz += positions[i * 3 + 2]!;
  }
  return [cx / n, cy / n, cz / n];
}

/** Min/max of `positions` projected onto unit `axis`. */
function projectionExtent(positions: Float64Array, axis: Vec3): { min: number; max: number } {
  const n = positions.length / 3;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = positions[i * 3]! * axis[0] + positions[i * 3 + 1]! * axis[1] + positions[i * 3 + 2]! * axis[2];
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return { min, max };
}

/**
 * Solve the deterministic auto-placement target frame + anisotropic scale from
 * case geometry — see this module's doc for each axis' and scale factor's
 * derivation. Pure function of its inputs (no randomness, no clock).
 *
 * @throws {DegeneratePlacementError} if the insertion axis is (near-)zero, the
 * neighbour M-D line is parallel to `og` (no well-defined M-D direction), or a
 * native library extent is degenerate.
 */
export function solveAnatomyPlacement(input: AnatomyPlacementInput): AnatomyPlacementSolution {
  const { canonicalFrame, libraryMesh, marginLoop, insertionAxis } = input;

  // Origin: the confirmed margin's centroid (the cervical seat).
  const marginFrame = computeMarginLoopFrame(marginLoop);
  const originMm = marginFrame.centroidMm;

  // Occluso-gingival: insertion axis, re-oriented toward the antagonist when
  // one is present (the physical occlusal direction) so a sign-flipped axis
  // cannot place the tooth upside-down.
  let og = normalizeOrThrow(insertionAxis, 'insertionAxis');
  const mesialCentroid = centroidOfPositions(input.mesialNeighborPositions);
  const distalCentroid = centroidOfPositions(input.distalNeighborPositions);

  // Lateral radius of the margin about the og axis — the window used to find
  // the antagonist surface directly over the site (case-derived, not a magic
  // constant).
  let lateralRadiusMm = 0;
  for (const p of marginLoop) {
    const rel = sub(p, originMm);
    const perp = sub(rel, scaleVec(og, dot(rel, og)));
    const d = norm(perp);
    if (d > lateralRadiusMm) lateralRadiusMm = d;
  }

  let occlusoGingivalReoriented = false;
  let targetOgHeightMm: number | null = null;
  let antagonistUsed = false;
  const anta = input.antagonistPositions;
  if (anta && anta.length >= 3) {
    // Antagonist vertices within the lateral window, on the occlusal side.
    // First pass with the current og sign to find the site's opposing
    // centroid, used to fix og's sign, then re-measure the nearest surface.
    const siteCentroid = antagonistSiteCentroid(anta, originMm, og, lateralRadiusMm);
    if (siteCentroid && dot(sub(siteCentroid, originMm), og) < 0) {
      og = scaleVec(og, -1);
      occlusoGingivalReoriented = true;
    }
    const nearest = nearestAntagonistHeight(anta, originMm, og, lateralRadiusMm);
    if (nearest !== null && nearest > PLACEMENT_MIN_EXTENT_MM) {
      targetOgHeightMm = nearest;
      antagonistUsed = true;
    }
  }

  // Mesial-distal: neighbour centroid line, orthogonalised against og.
  const mdRaw = sub(distalCentroid, mesialCentroid);
  const mdProj = sub(mdRaw, scaleVec(og, dot(mdRaw, og)));
  const md = normalizeOrThrow(mdProj, 'mesial-distal neighbour line (parallel to the insertion axis?)');
  // Bucco-lingual forced by right-handedness (md × bl = og  ⇒  bl = og × md).
  const bl = normalizeOrThrow(cross(og, md), 'bucco-lingual axis');

  // Native library extents along its own canonical axes.
  const nativeMd = projectionExtent(libraryMesh.positions, canonicalFrame.mesialDistal);
  const nativeOg = projectionExtent(libraryMesh.positions, canonicalFrame.occlusoGingival);
  const nativeMdWidth = nativeMd.max - nativeMd.min;
  const nativeOgHeight = nativeOg.max - nativeOg.min;
  if (!(nativeMdWidth > PLACEMENT_MIN_EXTENT_MM)) {
    throw new DegeneratePlacementError('library mesh has a degenerate mesial-distal extent');
  }
  if (!(nativeOgHeight > PLACEMENT_MIN_EXTENT_MM)) {
    throw new DegeneratePlacementError('library mesh has a degenerate occluso-gingival extent');
  }

  // Target M-D width: the proximal gap between neighbours along md.
  const mesialExtent = projectionExtent(input.mesialNeighborPositions, md);
  const distalExtent = projectionExtent(input.distalNeighborPositions, md);
  const proximalGap = distalExtent.min - mesialExtent.max;
  let targetMdWidth: number;
  let usedProximalGap: boolean;
  if (proximalGap > PLACEMENT_MIN_EXTENT_MM) {
    targetMdWidth = proximalGap;
    usedProximalGap = true;
  } else {
    // Overlapping/crowded neighbour scans: fall back to centroid separation.
    targetMdWidth = Math.abs(dot(sub(distalCentroid, mesialCentroid), md));
    usedProximalGap = false;
    if (!(targetMdWidth > PLACEMENT_MIN_EXTENT_MM)) {
      throw new DegeneratePlacementError('neighbours coincide along the mesial-distal axis; no space to fill');
    }
  }

  const scaleMesialDistal = targetMdWidth / nativeMdWidth;
  const scaleBuccoLingual = scaleMesialDistal;
  const scaleOcclusoGingival =
    targetOgHeightMm !== null ? targetOgHeightMm / nativeOgHeight : scaleMesialDistal;

  return {
    frame: {
      originMm,
      mesialDistal: md,
      buccoLingual: bl,
      occlusoGingival: og,
      scaleMesialDistal,
      scaleBuccoLingual,
      scaleOcclusoGingival,
    },
    measurements: {
      nativeMesialDistalWidthMm: nativeMdWidth,
      nativeOcclusoGingivalHeightMm: nativeOgHeight,
      targetMesialDistalWidthMm: targetMdWidth,
      targetOcclusoGingivalHeightMm: targetOgHeightMm,
      usedProximalGap,
      antagonistUsed,
      occlusoGingivalReoriented,
    },
  };
}

/** Centroid of antagonist vertices within `lateralRadiusMm` of the `og` axis
 * through `origin` — used only to fix `og`'s SIGN (which half-space the
 * opposing arch is in). `null` if the window is empty. */
function antagonistSiteCentroid(
  positions: Float64Array,
  origin: Vec3,
  og: Vec3,
  lateralRadiusMm: number,
): Vec3 | null {
  const n = positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let count = 0;
  const r2 = lateralRadiusMm * lateralRadiusMm;
  for (let i = 0; i < n; i++) {
    const v: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const rel = sub(v, origin);
    const along = dot(rel, og);
    const perpX = rel[0] - og[0] * along;
    const perpY = rel[1] - og[1] * along;
    const perpZ = rel[2] - og[2] * along;
    if (perpX * perpX + perpY * perpY + perpZ * perpZ <= r2) {
      cx += v[0];
      cy += v[1];
      cz += v[2];
      count++;
    }
  }
  if (count === 0) return null;
  return [cx / count, cy / count, cz / count];
}

/** Distance from `origin` along `+og` to the NEAREST antagonist vertex within
 * `lateralRadiusMm` of the `og` axis that lies on the occlusal side
 * (`og·(v−origin) > 0`) — the opposing biting surface over the site. `null` if
 * the window has no occlusal-side vertex. */
function nearestAntagonistHeight(
  positions: Float64Array,
  origin: Vec3,
  og: Vec3,
  lateralRadiusMm: number,
): number | null {
  const n = positions.length / 3;
  let best = Infinity;
  const r2 = lateralRadiusMm * lateralRadiusMm;
  for (let i = 0; i < n; i++) {
    const relX = positions[i * 3]! - origin[0];
    const relY = positions[i * 3 + 1]! - origin[1];
    const relZ = positions[i * 3 + 2]! - origin[2];
    const along = relX * og[0] + relY * og[1] + relZ * og[2];
    if (along <= 0) continue;
    const perpX = relX - og[0] * along;
    const perpY = relY - og[1] * along;
    const perpZ = relZ - og[2] * along;
    if (perpX * perpX + perpY * perpY + perpZ * perpZ <= r2 && along < best) {
      best = along;
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** Outer product `a ⊗ b` as a row-major `Mat3`. */
function outer(a: Vec3, b: Vec3): Mat3 {
  return [
    [a[0] * b[0], a[0] * b[1], a[0] * b[2]],
    [a[1] * b[0], a[1] * b[1], a[1] * b[2]],
    [a[2] * b[0], a[2] * b[1], a[2] * b[2]],
  ];
}

function addMat3(a: Mat3, b: Mat3, c: Mat3): Mat3 {
  return [
    [a[0][0] + b[0][0] + c[0][0], a[0][1] + b[0][1] + c[0][1], a[0][2] + b[0][2] + c[0][2]],
    [a[1][0] + b[1][0] + c[1][0], a[1][1] + b[1][1] + c[1][1], a[1][2] + b[1][2] + c[1][2]],
    [a[2][0] + b[2][0] + c[2][0], a[2][1] + b[2][1] + c[2][1], a[2][2] + b[2][2] + c[2][2]],
  ];
}

function mat3TimesVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Build the 4×4 (column-major, `SceneNode.transform` convention) mapping the
 * library asset's OWN coordinates onto the placed pose — see this module's doc
 * for the `M = R_target · S · R_canonicalᵀ` derivation. Reuses
 * `coarseAlignFromPointTriples` (Kabsch) for the rigid frame alignment and
 * `multiplyMat4` for composing the anisotropic scale about the target origin.
 */
export function buildPlacementTransform(frame: PlacementFrame, canonical: CanonicalFrameAxes): Mat4 {
  // CHOKE POINT: both frames must be right-handed orthonormal, else the Kabsch
  // alignment silently mirrors the tooth (see `assertFrameValid`). Covers a
  // left-handed asset AND a manual-override-corrupted target frame.
  assertFrameValid(canonical.mesialDistal, canonical.buccoLingual, canonical.occlusoGingival, 'canonicalFrame');
  assertFrameValid(frame.mesialDistal, frame.buccoLingual, frame.occlusoGingival, 'placementFrame');
  const oc = canonical.origin;
  // Canonical axis-tip triple → target axis-tip triple. Both are orthonormal
  // triads related by a pure rotation, so Kabsch recovers it exactly.
  const srcTips: [Vec3, Vec3, Vec3] = [
    add(oc, canonical.mesialDistal),
    add(oc, canonical.buccoLingual),
    add(oc, canonical.occlusoGingival),
  ];
  const dstTips: [Vec3, Vec3, Vec3] = [
    add(frame.originMm, frame.mesialDistal),
    add(frame.originMm, frame.buccoLingual),
    add(frame.originMm, frame.occlusoGingival),
  ];
  const rigid = coarseAlignFromPointTriples(srcTips, dstTips).transform;

  // Scale about the target origin in the target frame:
  //   x ↦ origin + R_t · S · R_tᵀ · (x − origin)
  // linear part L = Σ s_i (axis_i ⊗ axis_i).
  const L = addMat3(
    scaleMat3(outer(frame.mesialDistal, frame.mesialDistal), frame.scaleMesialDistal),
    scaleMat3(outer(frame.buccoLingual, frame.buccoLingual), frame.scaleBuccoLingual),
    scaleMat3(outer(frame.occlusoGingival, frame.occlusoGingival), frame.scaleOcclusoGingival),
  );
  const translation = sub(frame.originMm, mat3TimesVec(L, frame.originMm));
  const scaleMat4 = composeRigid(L, translation);

  return multiplyMat4(scaleMat4, rigid);
}

function scaleMat3(m: Mat3, s: number): Mat3 {
  return [
    [m[0][0] * s, m[0][1] * s, m[0][2] * s],
    [m[1][0] * s, m[1][1] * s, m[1][2] * s],
    [m[2][0] * s, m[2][1] * s, m[2][2] * s],
  ];
}

/**
 * Apply `transform` to a COPY of `mesh` — returns a NEW immutable
 * `IndexedMesh` (the shared library asset is never mutated). Winding is
 * preserved (the placement transform has positive determinant).
 */
export function placeMesh(mesh: IndexedMesh, transform: Mat4): IndexedMesh {
  const n = mesh.positions.length / 3;
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < n; i++) {
    const p = applyMat4ToPoint(transform, [
      mesh.positions[i * 3]!,
      mesh.positions[i * 3 + 1]!,
      mesh.positions[i * 3 + 2]!,
    ]);
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  }
  return { positions, indices: mesh.indices.slice() };
}

// ---------------------------------------------------------------------------
// Manual-override API — position / rotation / scale + anatomical landmark
// handles. Each returns a NEW PlacementFrame; `buildPlacementTransform`
// re-solves the transform from it. All deterministic (pure arithmetic).
// ---------------------------------------------------------------------------

/** Translate the whole placement by `deltaMm` (world space). */
export function translatePlacement(frame: PlacementFrame, deltaMm: Vec3): PlacementFrame {
  return { ...frame, originMm: add(frame.originMm, deltaMm) };
}

/** Rotate the placement's axes by a rotation `Mat3` (row-major) about
 * `pivotMm` (default: the placement origin). The axes stay orthonormal iff
 * `rotation` is a proper rotation. */
export function rotatePlacement(frame: PlacementFrame, rotation: Mat3, pivotMm?: Vec3): PlacementFrame {
  const pivot = pivotMm ?? frame.originMm;
  const rotatedOrigin = add(pivot, mat3TimesVec(rotation, sub(frame.originMm, pivot)));
  return {
    ...frame,
    originMm: rotatedOrigin,
    mesialDistal: mat3TimesVec(rotation, frame.mesialDistal),
    buccoLingual: mat3TimesVec(rotation, frame.buccoLingual),
    occlusoGingival: mat3TimesVec(rotation, frame.occlusoGingival),
  };
}

/** Multiply the placement's anisotropic scale factors (M-D, B-L, O-G). */
export function rescalePlacement(
  frame: PlacementFrame,
  factors: { md?: number; bl?: number; og?: number },
): PlacementFrame {
  return {
    ...frame,
    scaleMesialDistal: frame.scaleMesialDistal * (factors.md ?? 1),
    scaleBuccoLingual: frame.scaleBuccoLingual * (factors.bl ?? 1),
    scaleOcclusoGingival: frame.scaleOcclusoGingival * (factors.og ?? 1),
  };
}

/**
 * Anatomical landmark HANDLE: re-solve the placement so that the library
 * landmark at `landmarkAssetPoint` (asset-space) lands exactly at `targetMm`
 * (world), keeping orientation and scale fixed — i.e. a pure translation of
 * the frame origin. Because translating the origin shifts every placed vertex
 * by the same delta, the dragged landmark lands on target EXACTLY.
 */
export function solveLandmarkHandleTranslation(
  frame: PlacementFrame,
  canonical: CanonicalFrameAxes,
  landmarkAssetPoint: Vec3,
  targetMm: Vec3,
): PlacementFrame {
  const transform = buildPlacementTransform(frame, canonical);
  const current = applyMat4ToPoint(transform, landmarkAssetPoint);
  return translatePlacement(frame, sub(targetMm, current));
}
