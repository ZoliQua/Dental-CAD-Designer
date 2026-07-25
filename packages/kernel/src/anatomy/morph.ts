// packages/kernel/src/anatomy/morph.ts
//
// Phase 4 Task 6 — ADAPTATION / MORPHING: deform the placed library tooth
// (Task 5 output) to the patient so it makes correct contacts, via a
// RADIAL-BASIS-FUNCTION deformation (rbf/rbf.ts) driven by constraint points
// and solved with the deterministic direct solver (rbf/solve.ts). This is the
// journal-reproducibility bar of the phase (CLAUDE.md invariant 2): same
// constraints + params + kernel version ⇒ byte-identical morphed mesh.
//
// ## What the morph must achieve (clinical targets, from the profile)
//
//  (a) PROXIMAL contacts — the mesial + distal contact loci penetrate the
//      neighbour crowns by `proximalContactPenetrationMm` (profile: 0.02 mm).
//  (b) ANTAGONIST contact — the occlusal contact locus meets the opposing
//      arch at `occlusalContactMm` (profile: 0 mm — just touching).
//  (c) CERVICAL / margin seal — the tooth's cervical collar (a band of tooth
//      vertices within `cervicalSealBandMm` of the confirmed margin loop) is
//      pinned as FIXED (zero-displacement) control points, so Task 4's ≤10 µm
//      marginal seal survives the morph. Verified: `marginSealMaxDeviationMm`.
//
// ## Control-point construction
//
// Two classes of RBF control point:
//   • CONTACT controls (nonzero prescribed displacement): one per active
//     contact — the tooth surface vertex closest to the other mesh. Its
//     displacement is `strength · (T − c)`, where `T` is a target position on
//     the contact-approach line driven to the target penetration by a FIXED-
//     count root-find against the other mesh's signed-distance field (see
//     `refineContactTarget`). Because the RBF INTERPOLATES its controls
//     exactly, that vertex lands ON `T` (to solver precision) — the achieved
//     penetration equals what the root-find achieved, and the residual we
//     REPORT is the true surface-to-surface min distance vs target.
//   • ANCHOR controls (zero displacement): (i) the cervical seal band (c) and
//     (ii) FAR-FIELD anchors — tooth vertices farther than
//     `contactInfluenceRadiusMm` from every contact vertex. The far-field
//     anchors LOCALIZE the deformation (a contact adjustment bulges only its
//     ~contactInfluenceRadiusMm pocket, not the whole crown) AND, being
//     distributed over the 3-D tooth shell, make the control set unisolvent
//     for the degree-1 polynomial (the cervical ring alone is coplanar).
//
// ## The determinism-safe interactive split (plan / solve)
//
// `planAnatomyMorph` does the geometry-dependent, heavier work ONCE (build the
// contact BVHs, select contact vertices, root-find the targets, pick anchors).
// `solveAnatomyMorph(plan, strengths)` scales the contact displacements by the
// per-contact STRENGTH sliders, fits the RBF, applies it, and measures the
// residuals — this is the fast path the sliders re-run (< 500 ms target): no
// BVH rebuild, no full closest-point batch, just an (N+4)³ direct solve + an
// O(V·N) field apply. Both halves are pure/deterministic.
//
// @errorBound The morph is an APPROXIMATION of the target contacts: moving one
// control point perturbs the field globally, and the surface-to-surface closest
// approach shifts as the surface deforms. The achieved-vs-target penetration is
// MEASURED per contact — at the contact vertex (`contactResidualMm`) AND over
// its whole facing region (`regionResidualMm`). The downstream `errorBoundMm`
// is `max(maxContactResidual, max regionResidual)`, so a region that
// over-penetrates while the contact vertices sit on target CANNOT report a
// deceptively small bound to the contact/interpenetration gate (conservative by
// construction — see the open-patch sign caveat on `signedDistanceToMesh`: it
// can over-report, never silently under-report). Typical residual on the
// synthetic analytic case is < 1 µm; on real curved/unsegmented neighbours it
// is bounded by the fixed-iteration, CLAMPED root-find (a clamped, unachieved
// contact is flagged in `clampedContacts`, never a silent success).
//
// Marginal seal: preservation is proven by TWO genuine (non-tautological)
// measurements — the fitted field's displacement AT the confirmed margin
// polyline (which are NOT control points) and the actual motion of NON-anchor
// cervical surface vertices (the surface between the pins) — NOT by measuring
// the pinned anchors (which are 0 by construction). See `marginSealMaxDeviation-
// Mm` / `marginSealAtFinishLineMm` / `marginSealBetweenPinsMm`.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import { fitRbf, applyRbfDisplacement, evaluateRbf, type RbfControlPoint, type RbfField } from '../rbf/rbf.ts';

export type MorphContactKind = 'proximalMesial' | 'proximalDistal' | 'antagonist';

/** One opposing surface the morph makes contact against. `mesh` MUST have
 * triangles and consistent OUTWARD winding (the intake pipeline's
 * `orientNormalsConsistently` guarantees this) — the signed distance is
 * classified by the closest triangle's face normal, mirroring the P1
 * distance-heatmap job's `signed` option. */
export interface MorphContactInput {
  readonly kind: MorphContactKind;
  readonly mesh: IndexedMesh;
  /** Target signed penetration into `mesh`, mm (proximal: +proximalContact-
   * PenetrationMm; antagonist: occlusalContactMm). Positive = penetrate. */
  readonly targetPenetrationMm: number;
}

export interface MorphOptions {
  /** Tooth vertices within this distance of the margin loop are pinned as
   * fixed cervical-seal anchors — preserves Task 4's marginal seal. 0.6 mm: a
   * cervical collar wide enough to capture the tooth's cervical vertex ring,
   * narrow enough not to over-constrain the axial walls. */
  readonly cervicalSealBandMm: number;
  /** Radius of the deformation "pocket" around each contact: a tooth vertex is
   * eligible as a FAR-FIELD anchor only if farther than this from EVERY
   * contact vertex. 2.0 mm ≈ a proximal/occlusal contact facet's reach —
   * localizes the bulge to the contact zone. */
  readonly contactInfluenceRadiusMm: number;
  /** Cap on cervical-seal anchors (subsampled by stride) — bounds the direct
   * solve size N. */
  readonly maxCervicalAnchors: number;
  /** Minimum cervical anchors. If the seal BAND (vertices within
   * `cervicalSealBandMm` of the margin loop) yields fewer than this, the
   * closest-to-the-loop tooth vertices are added up to this count — so the
   * cervical collar is ALWAYS pinned (its displacement stays ~0), even when a
   * coarse initial placement leaves the tooth's cervical edge more than
   * `cervicalSealBandMm` from the confirmed finish line (real cases). Without
   * this the seal-band metric would be vacuously 0 over an empty set. */
  readonly minCervicalAnchors: number;
  /** Cap on far-field anchors (subsampled by stride) — bounds N so the (N+4)³
   * solve stays interactive (< 500 ms). */
  readonly maxFarFieldAnchors: number;
  /** FIXED number of contact-target root-find steps (NOT a tolerance loop —
   * determinism). Each step is one closest-point query + a linear step along
   * the other mesh's outward normal; 4 converges the target on ordinary
   * neighbour curvature. */
  readonly contactRefinementIterations: number;
  /** Tooth vertices within `contactFacingRadiusMm` of a contact vertex form
   * that contact's "facing region" — the vertex set the residual/heatmap min
   * distance is measured over. */
  readonly contactFacingRadiusMm: number;
  /** Safety bound on the contact root-find: the contact vertex may travel at
   * most `initialGap + targetPenetration + this` toward the other surface. A
   * clean contact needs travel ≈ `initialGap + targetPenetration`; this margin
   * absorbs neighbour curvature. It CAPS divergence on ill-formed (open, rough,
   * unsegmented) real neighbour patches, where the per-step signed distance can
   * be unreliable — so a bad contact surface produces a bounded residual
   * (reported via `@errorBound`), never a runaway displacement. */
  readonly contactMaxExtraTravelMm: number;
  /** Width of the cervical MEASUREMENT band (mm) — tooth vertices within this
   * of the margin loop that are NOT anchors form the "surface between the pins"
   * whose displacement is the genuine seal check. Wider than the pinning band
   * so it captures non-anchor cervical surface. */
  readonly cervicalSealMeasureBandMm: number;
}

/** Documented ALGORITHM defaults (NOT clinical — the clinical targets are the
 * per-contact `targetPenetrationMm`, which come from the profile). Each is
 * journaled by the stage so a replay reproduces the exact geometry. */
export const DEFAULT_MORPH_OPTIONS: MorphOptions = {
  cervicalSealBandMm: 0.6,
  contactInfluenceRadiusMm: 2.0,
  maxCervicalAnchors: 96,
  minCervicalAnchors: 48,
  maxFarFieldAnchors: 160,
  contactRefinementIterations: 4,
  contactFacingRadiusMm: 1.5,
  contactMaxExtraTravelMm: 0.2,
  cervicalSealMeasureBandMm: 1.5,
};

export class MorphContactMeshError extends Error {
  constructor(kind: MorphContactKind) {
    super(`anatomy/morph: contact "${kind}" mesh has no triangles — a contact needs an actual surface (with outward winding) to measure penetration against`);
    this.name = 'MorphContactMeshError';
  }
}

export class MorphNoAnchorsError extends Error {
  constructor() {
    super('anatomy/morph: no fixed anchor control points were selected (cervical band + far field both empty) — the deformation would be unconstrained; check the margin loop and options');
    this.name = 'MorphNoAnchorsError';
  }
}

export interface AnatomyMorphInput {
  /** The placed library tooth (Task 5 output). NEVER mutated. */
  readonly placedMesh: IndexedMesh;
  /** The confirmed margin loop (dense, deduplicated) — the cervical seal locus. */
  readonly marginLoop: readonly Vec3[];
  readonly contacts: readonly MorphContactInput[];
  readonly options?: Partial<MorphOptions>;
}

interface ContactPlan {
  readonly kind: MorphContactKind;
  readonly contactVertexIndex: number;
  readonly center: Vec3;
  /** Displacement at STRENGTH 1 (center → refined target). */
  readonly fullDisplacement: Vec3;
  readonly targetPenetrationMm: number;
  readonly mesh: IndexedMesh;
  readonly bvh: Bvh;
  readonly facingVertexIndices: Int32Array;
  /** True if the root-find hit the `contactMaxExtraTravelMm` clamp (target not
   * freely reachable) — surfaced as a QC warning. */
  readonly clampBound: boolean;
}

/** The geometry-dependent morph plan (from `planAnatomyMorph`) — reused across
 * slider re-solves. Holds the placed geometry, the per-contact plans (incl.
 * their BVHs for residual measurement), the anchor centers, and the options. */
export interface AnatomyMorphPlan {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  readonly contacts: readonly ContactPlan[];
  readonly anchorCenters: Float64Array; // k×3, all zero-displacement
  readonly cervicalAnchorCount: number;
  readonly farFieldAnchorCount: number;
  readonly sealBandVertexIndices: Int32Array;
  /** The confirmed margin polyline (flat xyz) — the marginal-seal locus. It is
   * NOT a control point of the RBF, so evaluating the fitted field at these
   * points is a genuine (non-tautological) measurement of how far the morph
   * moves the finish line between the pinned cervical vertices — see
   * `marginSealMaxDeviationMm`. */
  readonly marginLoopFlat: Float64Array;
  /** Cervical-region tooth vertices that are NOT anchors — the "surface between
   * the pins". Their measured displacement is the second, independent seal
   * check (see `marginSealMaxDeviationMm`). May be empty if the cervical region
   * is fully pinned. */
  readonly sealMeasureVertexIndices: Int32Array;
  readonly options: MorphOptions;
}

/** Per-contact strength [0..1] (the UI sliders). Omitted contact ⇒ 1 (full). */
export interface MorphStrengths {
  readonly proximalMesial?: number;
  readonly proximalDistal?: number;
  readonly antagonist?: number;
}

export interface MorphContactResult {
  readonly kind: MorphContactKind;
  readonly strength: number;
  readonly targetPenetrationMm: number;
  /** Signed distance of the contact VERTEX to the other mesh after morphing
   * (negative = penetrating). */
  readonly achievedSignedDistanceMm: number;
  /** |achievedSignedDistance − (−target)| — the reported residual. */
  readonly contactResidualMm: number;
  /** Min signed distance over the contact's facing region (most-penetrating
   * point) — a heatmap summary reusing `closestPoint`. SEE the sign caveat on
   * `signedDistanceToMesh`: on an OPEN neighbour patch this is a lower bound and
   * may over-state penetration. */
  readonly regionMinSignedDistanceMm: number;
  readonly regionMeanSignedDistanceMm: number;
  readonly regionRmsSignedDistanceMm: number;
  readonly facingVertexCount: number;
  /** |regionMinSignedDistance − (−target)| — the WORST deviation from the target
   * anywhere in the facing region (≥ `contactResidualMm`, which is the single
   * contact vertex only). Feeds the conservative `errorBoundMm`. */
  readonly regionResidualMm: number;
  /** True if the contact-target root-find was CLAMPED (`contactMaxExtraTravelMm`
   * bound hit) — the desired penetration could NOT be freely reached, so this
   * contact's fit is capped/unachieved. A downstream consumer / the UI must
   * treat a clamped contact as a WARNING, not a silent success. */
  readonly clampBound: boolean;
}

export interface AnatomyMorphResult {
  readonly mesh: IndexedMesh;
  readonly contacts: readonly MorphContactResult[];
  /** Max over active contacts of the single-vertex `contactResidualMm`. `null`
   * if no active contacts. Kept for diagnostics; the DOWNSTREAM error bound is
   * `errorBoundMm` (which also accounts for region over-penetration). */
  readonly maxContactResidualMm: number | null;
  /** The @errorBound fed downstream: `max(maxContactResidual, max region
   * residual)` — so a case where the contact vertices sit on target but the
   * region over-penetrates elsewhere CANNOT report a deceptively small bound to
   * the contact/interpenetration gate. Conservative by construction (see the
   * open-patch sign caveat: it can over-report, never silently under-report).
   * `null` if no active contacts. */
  readonly errorBoundMm: number | null;
  /** The kinds of contacts whose root-find was CLAMPED (unachieved target) —
   * empty when every contact converged freely. A non-empty list is a QC
   * warning the stage journals. */
  readonly clampedContacts: readonly MorphContactKind[];
  /** Max deviation of the marginal-seal locus under the morph — the MAX of two
   * genuine, non-tautological measurements: (a) the fitted field's displacement
   * evaluated AT the confirmed margin polyline points (which are NOT RBF control
   * points), and (b) the actual displacement of NON-anchor cervical tooth
   * vertices (the surface between the pins). Proves the ≤10 µm marginal seal is
   * preserved without measuring only the pinned anchors (which are 0 by
   * construction). */
  readonly marginSealMaxDeviationMm: number;
  /** Component (a) above — field displacement at the confirmed finish line. */
  readonly marginSealAtFinishLineMm: number;
  /** Component (b) above — displacement of non-anchor cervical surface vertices
   * (`NaN`-safe: 0 when there are no such vertices). */
  readonly marginSealBetweenPinsMm: number;
  readonly controlPointCount: number;
}

// --- signed distance to an outward-wound triangle mesh (mirrors heatmap job) ---
//
// SIGN CAVEAT (important for reading the region metrics below): the sign comes
// from the CLOSEST TRIANGLE's face normal (the P1 distance-heatmap convention),
// which is reliable on a closed, consistently-outward-wound mesh but UNRELIABLE
// near the OPEN BOUNDARIES of a cut/rough patch — there the closest feature is a
// boundary edge whose adjacent face normal need not point "outward" in the
// inside/outside sense, so a point just outside the patch can read as negative
// (spurious penetration). Consequence: on an OPEN neighbour patch (e.g. a real
// arch-ball submesh), `regionMinSignedDistanceMm` is a LOWER BOUND on the true
// signed distance and may over-state penetration. This is deliberately the SAFE
// direction for the QC error bound (it can over-report, never silently
// under-report, contact error — a fail-safe for a downstream contact gate); on
// a WATERTIGHT neighbour (a full scan) the sign is trustworthy.

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
  /** Unit OUTWARD normal at the closest triangle. */
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

// --- contact-target root find (FIXED iterations — determinism) ---

/**
 * Drive a target position `T` (starting at the contact vertex `center`) to the
 * point where the other mesh's signed distance equals `−targetPenetration`,
 * with a FIXED number of steps along a FIXED approach direction.
 *
 *  - `n₀` — the unit vector from the contact vertex toward its closest point on
 *    the other surface — is computed ONCE and held fixed. `T` therefore only
 *    ever moves along `n₀`, so its position is a single scalar `travel`:
 *    `T = center + travel · n₀`. Fixing the direction (rather than re-taking
 *    the surface's face normal each step) makes the root-find robust when the
 *    closest triangle jumps between iterations (open/rough real patches).
 *  - Each step is a Newton update `travel += s + target` (`s` = signed distance
 *    at the current `T`), driving `s → −target`. Exact in ONE step on a locally
 *    flat surface; a few steps absorb curvature.
 *  - `travel` is CLAMPED to `[travelLo, travelHi]` every step: a clean contact
 *    needs `travel ≈ initialGap + target`; the clamp (see
 *    `contactMaxExtraTravelMm`) CAPS divergence on ill-formed neighbour patches
 *    so a bad contact surface yields a bounded residual, never a runaway.
 *
 * Not a tolerance loop — the count is fixed (`contactRefinementIterations`), so
 * the arithmetic is byte-reproducible.
 */
function refineContactTarget(
  center: Vec3,
  mesh: IndexedMesh,
  bvh: Bvh,
  targetPen: number,
  iterations: number,
  maxExtraTravel: number,
): { target: Vec3; clampBound: boolean } {
  const cp0 = closestPoint(mesh, bvh, center);
  let nx = cp0.point[0] - center[0];
  let ny = cp0.point[1] - center[1];
  let nz = cp0.point[2] - center[2];
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 0) {
    nx /= nl;
    ny /= nl;
    nz /= nl;
  } else {
    const o = signedDistanceToMesh(center, mesh, bvh).outwardNormal;
    nx = -o[0];
    ny = -o[1];
    nz = -o[2];
  }
  const n0: Vec3 = [nx, ny, nz];
  const g0 = signedDistanceToMesh(center, mesh, bvh).signedDistance;
  // A clean contact needs travel = g0 + targetPen; bound the search around it.
  const travelHi = Math.max(0, g0) + targetPen + maxExtraTravel;
  const travelLo = Math.min(0, g0) - maxExtraTravel;
  let travel = 0;
  let clampBound = false;
  for (let it = 0; it < iterations; it++) {
    const t: Vec3 = [center[0] + n0[0] * travel, center[1] + n0[1] * travel, center[2] + n0[2] * travel];
    const s = signedDistanceToMesh(t, mesh, bvh).signedDistance;
    travel += s + targetPen;
    if (travel > travelHi) {
      travel = travelHi;
      clampBound = true;
    } else if (travel < travelLo) {
      travel = travelLo;
      clampBound = true;
    }
  }
  const target: Vec3 = [center[0] + n0[0] * travel, center[1] + n0[1] * travel, center[2] + n0[2] * travel];
  return { target, clampBound };
}

function minDistanceToLoop(px: number, py: number, pz: number, loop: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const dx = px - loop[i]![0];
    const dy = py - loop[i]![1];
    const dz = pz - loop[i]![2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Deterministic stride subsample of `indices` down to at most `max` entries
 * (evenly spaced, first element always kept). */
function strideSubsample(indices: number[], max: number): number[] {
  if (indices.length <= max || max <= 0) return indices.slice(0, Math.max(0, indices.length));
  const out: number[] = [];
  const stride = indices.length / max;
  for (let i = 0; i < max; i++) {
    out.push(indices[Math.floor(i * stride)]!);
  }
  return out;
}

/**
 * Build the geometry-dependent morph plan — see this module's doc. Pure,
 * deterministic. Heavy work (BVH builds, contact-vertex selection, target
 * root-find, anchor selection) happens here, ONCE; `solveAnatomyMorph` is the
 * cheap slider path.
 *
 * @throws {MorphContactMeshError} if a contact mesh has no triangles.
 * @throws {MorphNoAnchorsError} if no fixed anchors could be selected.
 */
export function planAnatomyMorph(input: AnatomyMorphInput): AnatomyMorphPlan {
  const options: MorphOptions = { ...DEFAULT_MORPH_OPTIONS, ...input.options };
  const positions = input.placedMesh.positions;
  const indices = input.placedMesh.indices;
  const vCount = positions.length / 3;

  const contacts: ContactPlan[] = [];
  const contactVertexSet = new Set<number>();
  for (const contact of input.contacts) {
    if (contact.mesh.indices.length === 0) throw new MorphContactMeshError(contact.kind);
    const bvh = buildBvh(contact.mesh);
    // Contact vertex = tooth vertex with the smallest distance to `mesh`
    // (lowest index wins on an exact tie — deterministic).
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let v = 0; v < vCount; v++) {
      const cp = closestPoint(contact.mesh, bvh, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
      if (cp.distance < bestDist) {
        bestDist = cp.distance;
        bestIdx = v;
      }
    }
    const center: Vec3 = [positions[bestIdx * 3]!, positions[bestIdx * 3 + 1]!, positions[bestIdx * 3 + 2]!];
    const { target, clampBound } = refineContactTarget(
      center,
      contact.mesh,
      bvh,
      contact.targetPenetrationMm,
      options.contactRefinementIterations,
      options.contactMaxExtraTravelMm,
    );
    const fullDisplacement: Vec3 = [target[0] - center[0], target[1] - center[1], target[2] - center[2]];

    // Facing region: tooth vertices within contactFacingRadiusMm of the center.
    const facing: number[] = [];
    const fr2 = options.contactFacingRadiusMm * options.contactFacingRadiusMm;
    for (let v = 0; v < vCount; v++) {
      const dx = positions[v * 3]! - center[0];
      const dy = positions[v * 3 + 1]! - center[1];
      const dz = positions[v * 3 + 2]! - center[2];
      if (dx * dx + dy * dy + dz * dz <= fr2) facing.push(v);
    }
    contactVertexSet.add(bestIdx);
    contacts.push({
      kind: contact.kind,
      contactVertexIndex: bestIdx,
      center,
      fullDisplacement,
      targetPenetrationMm: contact.targetPenetrationMm,
      mesh: contact.mesh,
      bvh,
      facingVertexIndices: Int32Array.from(facing),
      clampBound,
    });
  }

  // Cervical-seal band: tooth vertices within cervicalSealBandMm of the margin.
  // Every vertex's distance to the loop is measured once (reused for the
  // nearest-N fallback below).
  const loopDist = new Float64Array(vCount);
  const sealBand: number[] = [];
  for (let v = 0; v < vCount; v++) {
    const d = minDistanceToLoop(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!, input.marginLoop);
    loopDist[v] = d;
    if (d <= options.cervicalSealBandMm && !contactVertexSet.has(v)) sealBand.push(v);
  }
  // Guarantee the cervical collar is pinned even when a coarse placement leaves
  // the tooth's cervical edge farther than the band from the confirmed finish
  // line (real cases): if the band is too small, add the closest-to-the-loop
  // tooth vertices up to `minCervicalAnchors`. Deterministic (distance sort,
  // vertex-index tie-break).
  let sealSetVerts = sealBand;
  if (sealBand.length < options.minCervicalAnchors) {
    const candidates: number[] = [];
    for (let v = 0; v < vCount; v++) if (!contactVertexSet.has(v)) candidates.push(v);
    candidates.sort((a, b) => (loopDist[a]! - loopDist[b]!) || (a - b));
    sealSetVerts = candidates.slice(0, Math.min(options.minCervicalAnchors, candidates.length));
  }

  // Far-field anchors: tooth vertices > contactInfluenceRadiusMm from EVERY
  // contact vertex AND not in the seal band (avoid double-pinning / duplicate
  // control centers). The seal-band + far-field union is the fixed-anchor set.
  const infl2 = options.contactInfluenceRadiusMm * options.contactInfluenceRadiusMm;
  const sealSet = new Set(sealSetVerts);
  const farField: number[] = [];
  for (let v = 0; v < vCount; v++) {
    if (sealSet.has(v) || contactVertexSet.has(v)) continue;
    let ok = true;
    for (const c of contacts) {
      const dx = positions[v * 3]! - c.center[0];
      const dy = positions[v * 3 + 1]! - c.center[1];
      const dz = positions[v * 3 + 2]! - c.center[2];
      if (dx * dx + dy * dy + dz * dz <= infl2) {
        ok = false;
        break;
      }
    }
    if (ok) farField.push(v);
  }

  const cervicalAnchors = strideSubsample(sealSetVerts, options.maxCervicalAnchors);
  const farFieldAnchors = strideSubsample(farField, options.maxFarFieldAnchors);
  const anchorIndices = [...cervicalAnchors, ...farFieldAnchors];
  if (anchorIndices.length === 0) throw new MorphNoAnchorsError();

  const anchorCenters = new Float64Array(anchorIndices.length * 3);
  for (let i = 0; i < anchorIndices.length; i++) {
    const v = anchorIndices[i]!;
    anchorCenters[i * 3] = positions[v * 3]!;
    anchorCenters[i * 3 + 1] = positions[v * 3 + 1]!;
    anchorCenters[i * 3 + 2] = positions[v * 3 + 2]!;
  }

  // Seal MEASUREMENT set (NON-tautological): cervical-region tooth vertices —
  // within `cervicalSealMeasureBandMm` of the margin — that are NOT anchors.
  // These are the "surface between the pins": their measured displacement is a
  // genuine seal check (unlike the anchors, which are 0 by construction).
  const anchorSet = new Set(anchorIndices);
  const sealMeasure: number[] = [];
  for (let v = 0; v < vCount; v++) {
    if (anchorSet.has(v) || contactVertexSet.has(v)) continue;
    if (loopDist[v]! <= options.cervicalSealMeasureBandMm) sealMeasure.push(v);
  }

  const marginLoopFlat = new Float64Array(input.marginLoop.length * 3);
  for (let i = 0; i < input.marginLoop.length; i++) {
    marginLoopFlat[i * 3] = input.marginLoop[i]![0];
    marginLoopFlat[i * 3 + 1] = input.marginLoop[i]![1];
    marginLoopFlat[i * 3 + 2] = input.marginLoop[i]![2];
  }

  return {
    positions,
    indices,
    contacts,
    anchorCenters,
    cervicalAnchorCount: cervicalAnchors.length,
    farFieldAnchorCount: farFieldAnchors.length,
    sealBandVertexIndices: Int32Array.from(sealSetVerts),
    marginLoopFlat,
    sealMeasureVertexIndices: Int32Array.from(sealMeasure),
    options,
  };
}

function clampStrength(s: number | undefined): number {
  if (s === undefined) return 1;
  if (!Number.isFinite(s)) return 1;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

function strengthFor(kind: MorphContactKind, strengths: MorphStrengths | undefined): number {
  if (!strengths) return 1;
  if (kind === 'proximalMesial') return clampStrength(strengths.proximalMesial);
  if (kind === 'proximalDistal') return clampStrength(strengths.proximalDistal);
  return clampStrength(strengths.antagonist);
}

/**
 * Solve + apply the morph for a set of per-contact STRENGTHS (see this
 * module's doc for the interactive split). Deterministic; the slider path.
 * Returns a NEW immutable mesh (never mutates the plan's positions) + the
 * measured contact residuals + the margin-seal deviation.
 */
export function solveAnatomyMorph(plan: AnatomyMorphPlan, strengths?: MorphStrengths): AnatomyMorphResult {
  const controls: RbfControlPoint[] = [];
  const perContactStrength: number[] = [];
  for (const c of plan.contacts) {
    const strength = strengthFor(c.kind, strengths);
    perContactStrength.push(strength);
    controls.push({
      center: c.center,
      value: [c.fullDisplacement[0] * strength, c.fullDisplacement[1] * strength, c.fullDisplacement[2] * strength],
    });
  }
  const k = plan.anchorCenters.length / 3;
  for (let i = 0; i < k; i++) {
    controls.push({
      center: [plan.anchorCenters[i * 3]!, plan.anchorCenters[i * 3 + 1]!, plan.anchorCenters[i * 3 + 2]!],
      value: [0, 0, 0],
    });
  }

  const field = fitRbf(controls);
  const morphedPositions = applyRbfDisplacement(field, plan.positions);
  const mesh: IndexedMesh = { positions: morphedPositions, indices: plan.indices.slice() };

  // Per-contact residual + facing-region heatmap stats (reuses closestPoint).
  const contactResults: MorphContactResult[] = [];
  let maxContactResidual: number | null = null;
  let errorBound: number | null = null;
  const clampedContacts: MorphContactKind[] = [];
  for (let ci = 0; ci < plan.contacts.length; ci++) {
    const c = plan.contacts[ci]!;
    const vi = c.contactVertexIndex;
    const vpos: Vec3 = [morphedPositions[vi * 3]!, morphedPositions[vi * 3 + 1]!, morphedPositions[vi * 3 + 2]!];
    const achieved = signedDistanceToMesh(vpos, c.mesh, c.bvh).signedDistance;
    const residual = Math.abs(achieved - -c.targetPenetrationMm);

    let regionMin = Infinity;
    let sum = 0;
    let sumSq = 0;
    const fCount = c.facingVertexIndices.length;
    for (let f = 0; f < fCount; f++) {
      const fv = c.facingVertexIndices[f]!;
      const fp: Vec3 = [morphedPositions[fv * 3]!, morphedPositions[fv * 3 + 1]!, morphedPositions[fv * 3 + 2]!];
      const sd = signedDistanceToMesh(fp, c.mesh, c.bvh).signedDistance;
      if (sd < regionMin) regionMin = sd;
      sum += sd;
      sumSq += sd * sd;
    }
    const regionMean = fCount > 0 ? sum / fCount : achieved;
    const regionRms = fCount > 0 ? Math.sqrt(sumSq / fCount) : Math.abs(achieved);
    const regionMinSigned = fCount > 0 ? regionMin : achieved;
    // Worst deviation from target anywhere in the region (≥ contactResidual).
    const regionResidual = Math.abs(regionMinSigned - -c.targetPenetrationMm);

    if (maxContactResidual === null || residual > maxContactResidual) maxContactResidual = residual;
    const contactError = Math.max(residual, regionResidual);
    if (errorBound === null || contactError > errorBound) errorBound = contactError;
    // Only a contact actually being pushed (nonzero strength) can be "unachieved".
    if (c.clampBound && perContactStrength[ci]! > 0) clampedContacts.push(c.kind);

    contactResults.push({
      kind: c.kind,
      strength: perContactStrength[ci]!,
      targetPenetrationMm: c.targetPenetrationMm,
      achievedSignedDistanceMm: achieved,
      contactResidualMm: residual,
      regionMinSignedDistanceMm: regionMinSigned,
      regionMeanSignedDistanceMm: regionMean,
      regionRmsSignedDistanceMm: regionRms,
      facingVertexCount: fCount,
      regionResidualMm: regionResidual,
      clampBound: c.clampBound && perContactStrength[ci]! > 0,
    });
  }

  // Margin-seal deviation — TWO genuine (non-tautological) measurements:
  //  (a) the fitted field's displacement AT the confirmed margin polyline
  //      points, which are NOT RBF control points (the finish-line locus);
  const marginPointCount = plan.marginLoopFlat.length / 3;
  let sealAtFinishLine = 0;
  for (let i = 0; i < marginPointCount; i++) {
    const p: Vec3 = [plan.marginLoopFlat[i * 3]!, plan.marginLoopFlat[i * 3 + 1]!, plan.marginLoopFlat[i * 3 + 2]!];
    const d = evaluateFieldMagnitude(field, p);
    if (d > sealAtFinishLine) sealAtFinishLine = d;
  }
  //  (b) the actual displacement of NON-anchor cervical tooth vertices — the
  //      surface BETWEEN the pins (0 when the region is fully pinned).
  let sealBetweenPins = 0;
  for (let i = 0; i < plan.sealMeasureVertexIndices.length; i++) {
    const v = plan.sealMeasureVertexIndices[i]!;
    const dx = morphedPositions[v * 3]! - plan.positions[v * 3]!;
    const dy = morphedPositions[v * 3 + 1]! - plan.positions[v * 3 + 1]!;
    const dz = morphedPositions[v * 3 + 2]! - plan.positions[v * 3 + 2]!;
    const d = Math.hypot(dx, dy, dz);
    if (d > sealBetweenPins) sealBetweenPins = d;
  }

  return {
    mesh,
    contacts: contactResults,
    maxContactResidualMm: maxContactResidual,
    errorBoundMm: errorBound,
    clampedContacts,
    marginSealMaxDeviationMm: Math.max(sealAtFinishLine, sealBetweenPins),
    marginSealAtFinishLineMm: sealAtFinishLine,
    marginSealBetweenPinsMm: sealBetweenPins,
    controlPointCount: controls.length,
  };
}

/** Magnitude of the fitted field's displacement at `p` (helper for the
 * finish-line seal measurement). */
function evaluateFieldMagnitude(field: RbfField, p: Vec3): number {
  const d = evaluateRbf(field, p);
  return Math.hypot(d[0], d[1], d[2]);
}

/**
 * Convenience: plan + solve at the given strengths (default: full strength on
 * every contact). Deterministic. For interactive slider re-solves, call
 * `planAnatomyMorph` once and `solveAnatomyMorph(plan, strengths)` per change.
 */
export function morphAnatomy(input: AnatomyMorphInput, strengths?: MorphStrengths): AnatomyMorphResult {
  const plan = planAnatomyMorph(input);
  return solveAnatomyMorph(plan, strengths);
}
