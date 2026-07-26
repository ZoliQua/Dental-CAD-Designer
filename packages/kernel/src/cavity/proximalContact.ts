// packages/kernel/src/cavity/proximalContact.ts
//
// Phase 5 Task 5: Class II PROXIMAL BOX CONTACT ADAPTATION — the inlay's
// proximal faces (the break-through free-boundary faces of the Task-4 occlusal
// patch) adapt to the neighbouring teeth at the profile's target penetration
// (`proximalContactPenetrationMm`, passed in by the stage — never read here),
// one adaptation per box (mesial + distal), while the cavity OUTLINE ring and
// the occlusal SEAM survive byte-exactly.
//
// ## The mechanism (brainstormed; chosen over a region-scoped RBF)
//
// A dedicated per-box 1-D BUMP displacement of the proximal face's occlusal
// top rim (the patch's proximal cross-section column), NOT the P4 T6
// region-scoped RBF morph. Why:
//
//  1. BYTE-EXACT pinning by construction beats approximate pinning by solve.
//     The task's hard invariant is a byte-identical outline ring (Task 6
//     stitches the patch to the Task-3 fit surface along it). An RBF pins its
//     zero-displacement anchors only to direct-solver precision (~1e-12
//     relative) — approximately zero, never byte-zero. Here the pinned set
//     (outline, seam, everything but the movable rim) is simply NEVER
//     WRITTEN: the adapted mesh is a copy whose only differing bytes are the
//     displaced rim vertices.
//  2. The deformation space is ONE CURVE per box. The Task-4 proximal face is
//     a strip between the proximal cross-section column (its top rim — whose
//     interior vertices are the face's ONLY non-outline vertices) and the
//     outline U (pinned). Everything the adaptation can legitimately move is
//     that rim; an (N+4)³ RBF solve over control points is strictly more
//     machinery for strictly less predictability.
//  3. ANALYTIC seam protection. A `seamAnchorBandMm` zero-displacement band
//     at both column ends pins every vertex referenced by any seam-boundary
//     triangle (the seam triangles reference at most the first interior
//     column vertex — one cross-step ≈ columnArc/crossSegments from the end;
//     the default band covers several cross-steps), so the G1 seam triangles
//     DO NOT MOVE — the re-measured seam dihedral is exactly the pre-
//     adaptation value. The bump weight sin²(π·(s−b)/(L−2b)) is 0 with ZERO
//     SLOPE at both support ends (C1 falloff into the pinned band).
//
// ## The contact drive (P4 anatomy/morph.ts parity, one documented fix)
//
// Per box: the DRIVEN vertex is the movable rim vertex of maximal bump weight
// (tie → lowest index). Its required TRAVEL along a FIXED approach direction
// n₀ is found by the P4 fixed-iteration Newton root-find on the neighbour's
// signed distance (target s = −targetPenetrationMm; `PROXIMAL_CONTACT_
// REFINEMENT_ITERATIONS` = 4 fixed steps — never a tolerance loop), CLAMPED
// each step to ±`maxTravelMm`. n₀ is the unit vector from the driven vertex
// toward its closest point on the neighbour when the start is OUTSIDE
// (s₀ ≥ 0), and its NEGATION when the start is INSIDE (s₀ < 0) — so moving
// +travel along n₀ always DECREASES the signed distance and the Newton update
// `travel += s + target` converges in both regimes (P4's refineContactTarget
// assumed an outside start; a pre-penetrating neighbour would diverge there —
// the sign fix is this module's one deviation, unit-tested by the
// negative-travel case). Every movable vertex k then moves by
// `n₀ · travel · w_k / w_driven`.
//
// ## Genuine measurement (the P4 T6 lesson — never a prescription re-read)
//
// The achieved contact is MEASURED on the ADAPTED mesh: signed closest-point
// distance of every proximal-face vertex (adapted rim + pinned outline U)
// against the neighbour mesh. Reported per box: the driven vertex's achieved
// signed distance + residual AND the face-wide minimum + residual. A clamped
// travel (unreachable target) yields an honestly LARGE residual + a
// `clampBound` flag (`clampedBoxes`) — never a silent "achieved".
//
// @errorBound The adaptation approximates the target contact: the driven
// vertex converges to the Newton root-find's fixed-iteration result (EXACT in
// one step on a locally flat neighbour face — the synthetic closed-form case
// measures residual ≈ 0 (fp rounding, < 1e-9 mm); on a curved neighbour the
// residual is bounded by the 4-step Newton on that curvature and is MEASURED,
// per box, never assumed). `errorBoundMm` on the result is the MAX over boxes
// of max(contactResidualMm, faceResidualMm) — conservative: a pinned rim that
// over-penetrates a too-close neighbour (the outline CANNOT retract — it is
// pinned by invariant) or a clamped unreachable target both surface as an
// honestly large bound for the downstream contact/interpenetration gates.
// Sign caveat: the signed distance takes its sign from the closest triangle's
// face normal (the P1 convention, mirrored from anatomy/morph.ts) — reliable
// on closed outward-wound neighbours, a conservative LOWER bound (may
// over-state penetration, never under-state) near the open boundaries of a
// cut neighbour patch.
//
// Determinism: pure Float64 function of (patch bytes, adaptation inputs,
// options); fixed iteration counts, ascending traversals, no randomness/time.
// Pinned by a committed sha256 in proximalContact.test.ts.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Bvh } from '../bvh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';

// ---------------------------------------------------------------------------
// Documented ALGORITHM parameters (NOT clinical values — the clinical target
// is the per-box `targetPenetrationMm`, resolved from the material profile by
// the stage). Each is echoed on the result for journaling.
// ---------------------------------------------------------------------------

/** Absolute cap (mm) on the driven vertex's travel toward (or away from) the
 * neighbour. 1.5: real interproximal gaps a Class II contact must close are
 * well under 1 mm (plus a 0.02 mm penetration target); a required travel
 * beyond 1.5 mm means the "neighbour" is not where a neighbour can be
 * (missing / mis-segmented scan) and an unbounded bulge past the cavity
 * outline would be unmanufacturable — so the travel CLAMPS and the box is
 * reported `clampBound` with its honestly-large measured residual (the
 * falsifiable-clamp contract), never silently "achieved". Deliberately
 * ABSOLUTE (not gap-relative like P4's `contactMaxExtraTravelMm`) so a
 * too-far neighbour is a warning, not a license for runaway geometry. */
export const DEFAULT_PROXIMAL_MAX_TRAVEL_MM = 1.5;

/** Zero-displacement anchor band (mm of rim arc length) at BOTH ends of the
 * proximal column — the seam/outline protection. Every seam-boundary triangle
 * references at most the FIRST interior column vertex (one cross-step ≈
 * columnArc/crossSegments ≈ 0.05 mm at the fixture's default density) — 0.3 mm
 * pins several cross-steps' worth of rim on each end, so NO seam-adjacent
 * vertex moves (the re-measured seam dihedral is exactly unchanged), while
 * leaving the central ~75% of the rim as the contact bulge's support. */
export const DEFAULT_SEAM_ANCHOR_BAND_MM = 0.3;

/** FIXED Newton step count for the travel root-find (determinism — the P4
 * `contactRefinementIterations` parity; exact in 1 step on a locally flat
 * neighbour face, 4 absorbs ordinary neighbour curvature). */
export const PROXIMAL_CONTACT_REFINEMENT_ITERATIONS = 4;

/** Approach-direction degeneracy threshold (mm): when the driven vertex's
 * closest-point offset is at or below this, the vertex is ON the neighbour
 * surface up to Float64 rounding and normalizing that offset would yield a
 * NOISE direction (measured ~1e-16 mm on an exact-contact start — a vector
 * parallel to the surface, which stalls the root-find) — so the inward
 * (−outwardNormal) fallback is used instead. 1e-9 sits ~6 orders above the
 * rounding noise and ~4 orders below any real interproximal gap feature. */
export const PROXIMAL_DIRECTION_DEGENERACY_EPS_MM = 1e-9;

// ---------------------------------------------------------------------------
// Typed errors — explicit fields only (NO TS constructor parameter properties:
// this module is inside the Node worker's strip-only-TS loader closure).
// ---------------------------------------------------------------------------

/** A column / free-run point is not a (bit-exact) vertex of the patch mesh —
 * the inputs must be the `ProximalFaceBoundary` arrays of the SAME
 * `buildOcclusalPatch` result whose mesh is being adapted (a caller bug, not
 * something to snap/repair silently). */
export class ProximalColumnNotOnPatchError extends Error {
  readonly label: string;
  readonly which: 'column' | 'freeRun';
  readonly pointIndex: number;
  readonly pointMm: Vec3;
  constructor(label: string, which: 'column' | 'freeRun', pointIndex: number, pointMm: Vec3) {
    super(
      `adaptProximalContacts: box "${label}" ${which} point ${pointIndex} (${pointMm.join(', ')}) is not a vertex of ` +
        `the patch mesh — pass the ProximalFaceBoundary of the SAME buildOcclusalPatch result being adapted`,
    );
    this.name = 'ProximalColumnNotOnPatchError';
    this.label = label;
    this.which = which;
    this.pointIndex = pointIndex;
    this.pointMm = pointMm;
  }
}

/** Two adaptations claimed overlapping movable vertex sets — each box must
 * adapt its OWN proximal column. */
export class ProximalColumnOverlapError extends Error {
  readonly labelA: string;
  readonly labelB: string;
  constructor(labelA: string, labelB: string) {
    super(`adaptProximalContacts: boxes "${labelA}" and "${labelB}" claim overlapping movable rim vertices — each box must adapt its own proximal column`);
    this.name = 'ProximalColumnOverlapError';
    this.labelA = labelA;
    this.labelB = labelB;
  }
}

/** A neighbour mesh has no triangles — a contact needs an actual surface
 * (with outward winding) to measure penetration against. */
export class ProximalNeighborMeshError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(`adaptProximalContacts: box "${label}" neighbour mesh has no triangles — a contact needs an actual outward-wound surface`);
    this.name = 'ProximalNeighborMeshError';
    this.label = label;
  }
}

/** The seam anchor band consumed the whole rim (no movable vertex remains) —
 * the column is too short for this band, or the band is misconfigured. */
export class ProximalBandTooWideError extends Error {
  readonly label: string;
  readonly columnArcLengthMm: number;
  readonly seamAnchorBandMm: number;
  constructor(label: string, columnArcLengthMm: number, seamAnchorBandMm: number) {
    super(
      `adaptProximalContacts: box "${label}" has no movable rim — the ${seamAnchorBandMm}mm seam anchor band (× 2) ` +
        `leaves nothing of the ${columnArcLengthMm}mm column arc; shorten the band or refine the column`,
    );
    this.name = 'ProximalBandTooWideError';
    this.label = label;
    this.columnArcLengthMm = columnArcLengthMm;
    this.seamAnchorBandMm = seamAnchorBandMm;
  }
}

// ---------------------------------------------------------------------------
// Inputs / results
// ---------------------------------------------------------------------------

/** One box adaptation: the face boundary (from `OcclusalPatchResult.
 * proximalFaces`), the neighbour surface, and the clinical target. `label` is
 * the caller's reporting key (the stage uses the paired neighbour's FDI side). */
export interface ProximalAdaptationInput {
  readonly label: string;
  readonly columnPoints: readonly Vec3[];
  readonly freeRunPoints: readonly Vec3[];
  /** Neighbour tooth surface — MUST have triangles and consistent OUTWARD
   * winding (see the sign caveat in @errorBound). */
  readonly neighborMesh: IndexedMesh;
  /** Target signed penetration into the neighbour, mm (profile:
   * `proximalContactPenetrationMm`). Positive = penetrate. */
  readonly targetPenetrationMm: number;
}

export interface ProximalContactOptions {
  /** Default `DEFAULT_PROXIMAL_MAX_TRAVEL_MM`. */
  readonly maxTravelMm?: number;
  /** Default `DEFAULT_SEAM_ANCHOR_BAND_MM`. */
  readonly seamAnchorBandMm?: number;
}

export interface ProximalBoxContactResult {
  readonly label: string;
  readonly targetPenetrationMm: number;
  /** Signed distance of the driven vertex to the neighbour BEFORE adaptation. */
  readonly initialSignedDistanceMm: number;
  /** The root-find's travel along the approach direction (mm; negative =
   * retracting from a pre-penetrating neighbour). */
  readonly travelMm: number;
  /** True iff the travel hit ±maxTravelMm — target NOT freely reached; a QC
   * warning, never a silent success. */
  readonly clampBound: boolean;
  /** The fixed unit approach direction n₀ (moving +travel decreases the
   * neighbour signed distance). */
  readonly approachDirection: Vec3;
  /** GENUINE achieved contact: signed closest-point distance of the ADAPTED
   * driven vertex to the neighbour mesh (negative = penetrating). */
  readonly achievedSignedDistanceMm: number;
  /** |achievedSignedDistance − (−target)| — the reported residual. */
  readonly contactResidualMm: number;
  /** GENUINE face-wide minimum signed distance over EVERY adapted proximal-
   * face vertex (moved rim + pinned outline U). */
  readonly faceMinSignedDistanceMm: number;
  /** |faceMinSignedDistance − (−target)| — the WORST deviation anywhere on
   * the face (≥ contactResidualMm when the rim is the deepest point; LARGER
   * when the PINNED rim penetrates a too-close neighbour — see @errorBound). */
  readonly faceResidualMm: number;
  /** Number of vertices whose position actually changed. */
  readonly movedVertexCount: number;
}

export interface ProximalContactResult {
  /** The adapted patch — a NEW mesh (the input is never mutated); byte-
   * identical to the input except the displaced rim vertices. */
  readonly mesh: IndexedMesh;
  readonly boxes: readonly ProximalBoxContactResult[];
  /** Labels of boxes whose travel was clamped (target unreachable) — a QC
   * warning the stage journals; empty when every box converged freely. */
  readonly clampedBoxes: readonly string[];
  /** Max over boxes of max(contactResidualMm, faceResidualMm) — see
   * @errorBound. `null` iff `adaptations` is empty. */
  readonly errorBoundMm: number | null;
  /** Echo of the documented algorithm parameters (journaling currency). */
  readonly maxTravelMm: number;
  readonly seamAnchorBandMm: number;
}

// ---------------------------------------------------------------------------
// Signed distance to an outward-wound mesh (mirrors anatomy/morph.ts — the P1
// distance-heatmap sign convention; see the sign caveat in @errorBound above).
// ---------------------------------------------------------------------------

function faceNormalUnnormalized(mesh: IndexedMesh, tri: number): Vec3 {
  const i0 = mesh.indices[tri * 3]!;
  const i1 = mesh.indices[tri * 3 + 1]!;
  const i2 = mesh.indices[tri * 3 + 2]!;
  const p = mesh.positions;
  const ax = p[i1 * 3]! - p[i0 * 3]!;
  const ay = p[i1 * 3 + 1]! - p[i0 * 3 + 1]!;
  const az = p[i1 * 3 + 2]! - p[i0 * 3 + 2]!;
  const bx = p[i2 * 3]! - p[i0 * 3]!;
  const by = p[i2 * 3 + 1]! - p[i0 * 3 + 1]!;
  const bz = p[i2 * 3 + 2]! - p[i0 * 3 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

interface SignedResult {
  readonly signedDistance: number;
  readonly closest: Vec3;
  readonly outwardNormal: Vec3;
}

function signedDistanceToMesh(point: Vec3, mesh: IndexedMesh, bvh: Bvh): SignedResult {
  const cp = closestPoint(mesh, bvh, point);
  const n = faceNormalUnnormalized(mesh, cp.triangleIndex);
  const nl = Math.hypot(n[0], n[1], n[2]);
  const outward: Vec3 = nl > 0 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 0, 0];
  const rel: Vec3 = [point[0] - cp.point[0], point[1] - cp.point[1], point[2] - cp.point[2]];
  const dotN = rel[0] * outward[0] + rel[1] * outward[1] + rel[2] * outward[2];
  const sign = dotN < 0 ? -1 : 1;
  return { signedDistance: sign * cp.distance, closest: [cp.point[0], cp.point[1], cp.point[2]], outwardNormal: outward };
}

function coordKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

/**
 * Adapts the patch's proximal box faces to their neighbours at the target
 * penetration — see this module's doc for the mechanism (per-box bump on the
 * proximal rim), the anchor set (outline + seam band pinned byte-exactly, by
 * construction), the genuine contact measurement, and `@errorBound`.
 * Deterministic, pure Float64; returns a NEW mesh (never mutates the input).
 *
 * @throws {TypeError} non-finite target / non-positive maxTravel / negative
 * band / column shorter than 3 points.
 * @throws {ProximalColumnNotOnPatchError} a column/free-run point is not a
 * patch vertex.
 * @throws {ProximalColumnOverlapError} two boxes claim the same rim.
 * @throws {ProximalNeighborMeshError} a neighbour mesh has no triangles.
 * @throws {ProximalBandTooWideError} the seam band leaves no movable rim.
 */
export function adaptProximalContacts(
  patchMesh: IndexedMesh,
  adaptations: readonly ProximalAdaptationInput[],
  options: ProximalContactOptions = {},
): ProximalContactResult {
  const maxTravelMm = options.maxTravelMm ?? DEFAULT_PROXIMAL_MAX_TRAVEL_MM;
  if (!(Number.isFinite(maxTravelMm) && maxTravelMm > 0)) {
    throw new TypeError(`adaptProximalContacts: maxTravelMm must be a positive finite number, got ${maxTravelMm}`);
  }
  const seamAnchorBandMm = options.seamAnchorBandMm ?? DEFAULT_SEAM_ANCHOR_BAND_MM;
  if (!(Number.isFinite(seamAnchorBandMm) && seamAnchorBandMm >= 0)) {
    throw new TypeError(`adaptProximalContacts: seamAnchorBandMm must be a non-negative finite number, got ${seamAnchorBandMm}`);
  }

  // Bit-exact coordinate → vertex index map (first-seen; the patch is built
  // with a shared-coordinate vertex table, so coordinates are unique).
  const vertexCount = patchMesh.positions.length / 3;
  const vmap = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const k = coordKey(patchMesh.positions[v * 3]!, patchMesh.positions[v * 3 + 1]!, patchMesh.positions[v * 3 + 2]!);
    if (!vmap.has(k)) vmap.set(k, v);
  }
  const resolve = (label: string, which: 'column' | 'freeRun', points: readonly Vec3[]): number[] =>
    points.map((p, i) => {
      const v = vmap.get(coordKey(p[0], p[1], p[2]));
      if (v === undefined) throw new ProximalColumnNotOnPatchError(label, which, i, p);
      return v;
    });

  // NEW mesh — the input is never mutated (immutable meshes).
  const positions = patchMesh.positions.slice();
  const indices = patchMesh.indices.slice();

  const claimed = new Map<number, string>(); // movable vertex → owning label
  const boxes: ProximalBoxContactResult[] = [];
  const clampedBoxes: string[] = [];
  let errorBoundMm: number | null = null;

  for (const box of adaptations) {
    if (!Number.isFinite(box.targetPenetrationMm)) {
      throw new TypeError(`adaptProximalContacts: box "${box.label}" targetPenetrationMm must be finite, got ${box.targetPenetrationMm}`);
    }
    if (box.columnPoints.length < 3) {
      throw new TypeError(`adaptProximalContacts: box "${box.label}" column must have >= 3 points (endpoints + movable interior), got ${box.columnPoints.length}`);
    }
    if (box.neighborMesh.indices.length === 0) {
      throw new ProximalNeighborMeshError(box.label);
    }
    const colIdx = resolve(box.label, 'column', box.columnPoints);
    const freeIdx = resolve(box.label, 'freeRun', box.freeRunPoints);

    // Arc-length parameters of the ORIGINAL column; bump weights with the
    // seam anchor band pinned at both ends (see module doc).
    const n = box.columnPoints.length;
    const arc = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      const a = box.columnPoints[k - 1]!;
      const b = box.columnPoints[k]!;
      arc[k] = arc[k - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const arcLen = arc[n - 1]!;
    const support = arcLen - 2 * seamAnchorBandMm;
    if (!(support > 0)) {
      throw new ProximalBandTooWideError(box.label, arcLen, seamAnchorBandMm);
    }
    const weights = new Float64Array(n); // endpoints stay 0 (outline vertices)
    let drivenK = -1;
    let wMax = 0;
    for (let k = 1; k < n - 1; k++) {
      const s = arc[k]!;
      if (s <= seamAnchorBandMm || s >= arcLen - seamAnchorBandMm) continue; // pinned band
      const t = (s - seamAnchorBandMm) / support;
      const w = Math.sin(Math.PI * t) ** 2;
      weights[k] = w;
      if (w > wMax) {
        wMax = w;
        drivenK = k;
      }
    }
    if (drivenK < 0 || !(wMax > 0)) {
      throw new ProximalBandTooWideError(box.label, arcLen, seamAnchorBandMm);
    }
    for (let k = 1; k < n - 1; k++) {
      if (weights[k]! > 0) {
        const owner = claimed.get(colIdx[k]!);
        if (owner !== undefined) throw new ProximalColumnOverlapError(owner, box.label);
        claimed.set(colIdx[k]!, box.label);
      }
    }

    // Fixed approach direction n₀ + fixed-iteration clamped Newton (module doc).
    const bvh = buildBvh(box.neighborMesh);
    const center = box.columnPoints[drivenK]!;
    const sd0 = signedDistanceToMesh(center, box.neighborMesh, bvh);
    let nx = sd0.closest[0] - center[0];
    let ny = sd0.closest[1] - center[1];
    let nz = sd0.closest[2] - center[2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl > PROXIMAL_DIRECTION_DEGENERACY_EPS_MM) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      // ON the surface (up to rounding — see PROXIMAL_DIRECTION_DEGENERACY_
      // EPS_MM): head inward, against the outward normal (the P4 fallback,
      // epsilon-guarded so fp noise never masquerades as a direction).
      nx = -sd0.outwardNormal[0];
      ny = -sd0.outwardNormal[1];
      nz = -sd0.outwardNormal[2];
    }
    if (sd0.signedDistance < 0) {
      // INSIDE the neighbour: center→closest points toward the EXIT, along
      // which the signed distance INCREASES — negate so +travel always
      // DECREASES it (the sign fix over P4's outside-start assumption).
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const n0: Vec3 = [nx, ny, nz];
    let travel = 0;
    let clampBound = false;
    for (let it = 0; it < PROXIMAL_CONTACT_REFINEMENT_ITERATIONS; it++) {
      const t: Vec3 = [center[0] + n0[0] * travel, center[1] + n0[1] * travel, center[2] + n0[2] * travel];
      const s = signedDistanceToMesh(t, box.neighborMesh, bvh).signedDistance;
      travel += s + box.targetPenetrationMm;
      if (travel > maxTravelMm) {
        travel = maxTravelMm;
        clampBound = true;
      } else if (travel < -maxTravelMm) {
        travel = -maxTravelMm;
        clampBound = true;
      }
    }

    // Displace the movable rim: n₀ · travel · w/wMax (driven vertex gets the
    // full travel). Count vertices whose position ACTUALLY changed.
    let movedVertexCount = 0;
    for (let k = 1; k < n - 1; k++) {
      const w = weights[k]!;
      if (!(w > 0)) continue;
      const v = colIdx[k]!;
      const d = (travel * w) / wMax;
      const x = positions[v * 3]! + n0[0] * d;
      const y = positions[v * 3 + 1]! + n0[1] * d;
      const z = positions[v * 3 + 2]! + n0[2] * d;
      if (!Object.is(x, positions[v * 3]) || !Object.is(y, positions[v * 3 + 1]) || !Object.is(z, positions[v * 3 + 2])) {
        movedVertexCount++;
      }
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
    }

    // GENUINE measurement on the ADAPTED positions (closest-point vs the
    // neighbour mesh — never a re-read of the prescribed displacement).
    const measureAt = (v: number): number =>
      signedDistanceToMesh([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!], box.neighborMesh, bvh).signedDistance;
    const achievedSignedDistanceMm = measureAt(colIdx[drivenK]!);
    let faceMin = achievedSignedDistanceMm;
    for (const v of colIdx) {
      const s = measureAt(v);
      if (s < faceMin) faceMin = s;
    }
    for (const v of freeIdx) {
      const s = measureAt(v);
      if (s < faceMin) faceMin = s;
    }
    const contactResidualMm = Math.abs(achievedSignedDistanceMm - -box.targetPenetrationMm);
    const faceResidualMm = Math.abs(faceMin - -box.targetPenetrationMm);
    const boxError = Math.max(contactResidualMm, faceResidualMm);
    if (errorBoundMm === null || boxError > errorBoundMm) errorBoundMm = boxError;
    if (clampBound) clampedBoxes.push(box.label);

    boxes.push({
      label: box.label,
      targetPenetrationMm: box.targetPenetrationMm,
      initialSignedDistanceMm: sd0.signedDistance,
      travelMm: travel,
      clampBound,
      approachDirection: n0,
      achievedSignedDistanceMm,
      contactResidualMm,
      faceMinSignedDistanceMm: faceMin,
      faceResidualMm,
      movedVertexCount,
    });
  }

  return {
    mesh: { positions, indices },
    boxes,
    clampedBoxes,
    errorBoundMm,
    maxTravelMm,
    seamAnchorBandMm,
  };
}
