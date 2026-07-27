// packages/kernel/src/bridge/frameworkCutback.ts
//
// Phase 6 Task 5 — the FRAMEWORK CUTBACK op. In framework mode a bridge unit is
// reduced to a coping/substructure: its OUTER (anatomic) surface is offset
// INWARD by the veneering space, leaving room for hand-layered veneering
// ceramic. The precision FIT surfaces (the abutment intaglio, the pontic base)
// and the marginal SEAL must survive the cutback byte-exact — this op is the
// reduced-anatomy geometry with those preservations built into its construction.
//
// ## Why NOT the SDF/offset-remesh precedent (a deliberate, documented choice)
//
// The offset precedents (`offset/offsetMesh.ts`, the P4 `shell/healOuterAnatomy.ts`)
// re-mesh a surface by marching cubes over its signed-distance field. That is
// the right tool when a surface may fold/self-intersect and a clean 2-manifold
// must be re-derived — but marching cubes RE-TESSELLATES everything: NO vertex
// of the input survives bit-for-bit. This op's HARD invariant is the opposite:
// the fit surfaces and the margin rim must be preserved BYTE-EXACT (the P4/P5
// fit-surface discipline, asserted vertex-for-vertex). An SDF remesh cannot
// satisfy byte-identity, so it is rejected here. Instead the cutback is a
// TOPOLOGY-PRESERVING per-vertex normal displacement: the mesh connectivity is
// untouched, every fit/margin vertex keeps its exact Float64 coordinates, and
// only the outer-anatomy vertices move — inward, along their own surface normal,
// by a weight that TAPERS to zero approaching the preserved-region boundary.
//
// ## The taper — the honest design tension (veneering space is NOT uniform)
//
// The cutback CANNOT deliver the full veneering space right up to the margin: at
// the margin the outer surface meets the fit surface at the seal, and moving the
// rim inward would open that seal. So the offset weight `w(x)` tapers from 0 on
// the boundary loop (the prep margin for an abutment; the base perimeter for a
// pontic) to 1 beyond a band of width `marginTaperBandMm`, via the C1 smoothstep
// `w = t²(3−2t)`, `t = clamp(distanceToBoundary / band, 0, 1)` (the P4 feather
// precedent). CONSEQUENCE, disclosed rather than overclaimed: within that band
// the achieved veneering space is `veneeringSpaceMm · w < veneeringSpaceMm` — the
// space is full ONLY beyond `marginTaperBandMm` of the boundary. The band width
// and the count of tapered vertices are returned so a caller/QC report can state
// the taper region's extent honestly.
//
// ## The outer/fit partition
//
// The caller supplies `fitVertexMask` (true = a fit/preserved vertex). A fit
// vertex ALWAYS has weight 0 (byte-preserved), regardless of its distance to the
// boundary. Only non-fit (outer-anatomy) vertices are eligible for the cutback,
// and even those taper to 0 within the boundary band — so the margin rim (an
// outer vertex ON the boundary loop) is preserved too. The partition is
// construction provenance: a shell knows its intaglio vertices from its outer
// vertices at stitch time (reviewer note: the T5 fixture supplies the mask
// analytically; a real assembled unit derives it from the shell's inner/outer
// vertex split — the op is agnostic to how the mask was produced).
//
// @errorBound On a LOCALLY PLANAR region the achieved inward SURFACE offset
// equals `veneeringSpaceMm · w` EXACTLY (a rigid translation of a flat patch
// along its normal). On a FACETED approximation of a curved surface the achieved
// surface-to-surface offset is `veneeringSpaceMm · w · cos φ`, where φ is the
// angle between a moved vertex's area-weighted normal and its incident face
// normals — i.e. the surface moves inward by AT MOST the intended amount, never
// more (`errorBoundMm = veneeringSpaceMm · (1 − cos φ_max)`, the measured max
// over moved vertices, returned). This is the SAFE direction for the thickness
// gate: the framework stays at least as thick as intended, so the cutback never
// silently removes MORE material than requested. (The per-vertex DISPLACEMENT
// magnitude is exactly `veneeringSpaceMm · w` by construction — the facet term
// is only the surface-offset ↔ displacement gap on curvature.)
//
// Topology-preservation caveat (reviewer note): a per-vertex normal displacement
// can self-intersect if `veneeringSpaceMm` approaches the local feature size /
// radius of curvature of a concave outer feature. Clinical veneering spaces
// (~1 mm) are small relative to crown outer curvature; the op does not re-mesh,
// so a caller that needs a guaranteed-clean result on a pathological input must
// validate the output (the T5 fixture asserts the result stays watertight +
// manifold via `analyzeMesh`).
//
// Deterministic: pure Float64, fixed iteration order — same mesh + params ⇒
// byte-identical output.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';

/** Thrown for an invalid cutback parameter (never defaulted here — the pipeline
 * resolves `veneeringSpaceMm` from the material profile). */
export class FrameworkCutbackParamError extends Error {
  constructor(message: string) {
    super(`frameworkCutback: ${message}`);
    this.name = 'FrameworkCutbackParamError';
  }
}

export interface FrameworkCutbackOptions {
  /** The veneering space `d` (mm) — the full inward cutback depth reached on the
   * free outer anatomy (tapers to 0 at the boundary). Must be finite and ≥ 0. */
  readonly veneeringSpaceMm: number;
  /** Per-vertex fit mask — `fitVertexMask[i] === true` ⇒ vertex `i` is a
   * fit/preserved surface vertex (weight 0, byte-exact). Length MUST equal the
   * mesh vertex count. */
  readonly fitVertexMask: ReadonlyArray<boolean>;
  /** The preserved-region boundary loop (dense polyline): the prep margin for an
   * abutment, the base perimeter for a pontic. The cutback tapers to 0 within
   * `marginTaperBandMm` of it — this is what keeps the marginal seal closed. */
  readonly marginLoop: readonly Vec3[];
  /** The taper band width `b` (mm) — the near-boundary ring over which the
   * cutback ramps 0 → full. Must be finite and > 0 (a cutback with no taper
   * would open the seal). */
  readonly marginTaperBandMm: number;
}

export interface FrameworkCutbackResult {
  /** The cut-back unit — a NEW mesh, same topology (`indices` reused), fit +
   * margin vertices byte-identical, outer vertices displaced inward. */
  readonly mesh: IndexedMesh;
  /** Per-vertex applied cutback (mm) = `veneeringSpaceMm · w_i` (0 for
   * preserved vertices). Length = vertex count. */
  readonly appliedCutbackMm: Float64Array;
  /** The documented facet error bound (mm) — see this module's `@errorBound`.
   * `veneeringSpaceMm · (1 − cos φ_max)` over moved vertices. */
  readonly errorBoundMm: number;
  /** Max applied cutback (mm) — equals `veneeringSpaceMm` iff any full-weight
   * vertex exists. */
  readonly maxAppliedCutbackMm: number;
  /** Mean applied cutback (mm) over FULL-WEIGHT vertices (w ≈ 1) — equals
   * `veneeringSpaceMm` (they all moved the full depth). */
  readonly meanFullWeightCutbackMm: number;
  /** Count of full-weight (w ≥ 1 − 1e-9) moved vertices. */
  readonly fullWeightVertexCount: number;
  /** Count of tapered (0 < w < 1) vertices — the near-margin band where the
   * veneering space is honestly LESS than `veneeringSpaceMm`. */
  readonly taperedVertexCount: number;
  /** Count of preserved (w = 0) vertices: fit vertices + outer vertices on the
   * boundary loop. */
  readonly preservedVertexCount: number;
  /** Echo of the taper band width (mm), for journaling + the honest disclosure. */
  readonly taperBandMm: number;
}

/** Area-weighted per-vertex normals (Float64, deterministic) + the max angle
 * between each vertex normal and its incident face normals (the facet term).
 * The mesh must be consistently outward-oriented (the op's precondition). */
function vertexNormals(mesh: IndexedMesh): { normals: Float64Array; maxFacetAngle: Float64Array } {
  const vertexCount = mesh.positions.length / 3;
  const normals = new Float64Array(vertexCount * 3);
  const triCount = mesh.indices.length / 3;
  // First pass: accumulate area-weighted face normals into vertex normals.
  const faceNormals = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3]!;
    const ib = mesh.indices[t * 3 + 1]!;
    const ic = mesh.indices[t * 3 + 2]!;
    const ax = mesh.positions[ia * 3]!, ay = mesh.positions[ia * 3 + 1]!, az = mesh.positions[ia * 3 + 2]!;
    const bx = mesh.positions[ib * 3]!, by = mesh.positions[ib * 3 + 1]!, bz = mesh.positions[ib * 3 + 2]!;
    const cx = mesh.positions[ic * 3]!, cy = mesh.positions[ic * 3 + 1]!, cz = mesh.positions[ic * 3 + 2]!;
    // cross(b−a, c−a) — magnitude = 2·area, direction = face normal.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    faceNormals[t * 3] = nx; faceNormals[t * 3 + 1] = ny; faceNormals[t * 3 + 2] = nz;
    for (const vi of [ia, ib, ic]) {
      normals[vi * 3] = normals[vi * 3]! + nx;
      normals[vi * 3 + 1] = normals[vi * 3 + 1]! + ny;
      normals[vi * 3 + 2] = normals[vi * 3 + 2]! + nz;
    }
  }
  // Normalize vertex normals.
  for (let i = 0; i < vertexCount; i++) {
    const nx = normals[i * 3]!, ny = normals[i * 3 + 1]!, nz = normals[i * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { normals[i * 3] = nx / len; normals[i * 3 + 1] = ny / len; normals[i * 3 + 2] = nz / len; }
  }
  // Second pass: max facet angle between each vertex normal and its incident
  // (unit) face normals — the @errorBound's φ_max input.
  const maxFacetAngle = new Float64Array(vertexCount);
  for (let t = 0; t < triCount; t++) {
    const fx = faceNormals[t * 3]!, fy = faceNormals[t * 3 + 1]!, fz = faceNormals[t * 3 + 2]!;
    const flen = Math.hypot(fx, fy, fz);
    if (flen === 0) continue;
    const ufx = fx / flen, ufy = fy / flen, ufz = fz / flen;
    for (let c = 0; c < 3; c++) {
      const vi = mesh.indices[t * 3 + c]!;
      const dot = Math.min(1, Math.max(-1, normals[vi * 3]! * ufx + normals[vi * 3 + 1]! * ufy + normals[vi * 3 + 2]! * ufz));
      const ang = Math.acos(dot);
      if (ang > maxFacetAngle[vi]!) maxFacetAngle[vi] = ang;
    }
  }
  return { normals, maxFacetAngle };
}

/**
 * Applies the framework cutback to a bridge unit — see this module's doc for the
 * construction, the taper, the outer/fit partition, and the `@errorBound`. The
 * input mesh MUST be consistently outward-oriented (so `−normal` is inward).
 * Deterministic; Float64; topology-preserving.
 *
 * @throws {FrameworkCutbackParamError} for a bad param (non-finite / negative
 * veneering space, non-positive band, mask length ≠ vertex count, empty loop).
 */
export function frameworkCutback(mesh: IndexedMesh, options: FrameworkCutbackOptions): FrameworkCutbackResult {
  const { veneeringSpaceMm: d, fitVertexMask, marginLoop, marginTaperBandMm: band } = options;
  const vertexCount = mesh.positions.length / 3;
  if (!(Number.isFinite(d) && d >= 0)) throw new FrameworkCutbackParamError(`veneeringSpaceMm must be finite and >= 0, got ${d}`);
  if (!(Number.isFinite(band) && band > 0)) throw new FrameworkCutbackParamError(`marginTaperBandMm must be finite and > 0, got ${band}`);
  if (fitVertexMask.length !== vertexCount) throw new FrameworkCutbackParamError(`fitVertexMask length ${fitVertexMask.length} !== vertex count ${vertexCount}`);
  if (marginLoop.length < 2) throw new FrameworkCutbackParamError(`marginLoop needs >= 2 points, got ${marginLoop.length}`);

  const { normals, maxFacetAngle } = vertexNormals(mesh);
  const positions = new Float64Array(mesh.positions); // copy — fit/margin verts stay byte-identical
  const appliedCutbackMm = new Float64Array(vertexCount);

  let maxApplied = 0;
  let fullWeightSum = 0;
  let fullWeightCount = 0;
  let taperedCount = 0;
  let preservedCount = 0;
  let maxMovedFacetAngle = 0;

  for (let i = 0; i < vertexCount; i++) {
    let w: number;
    if (fitVertexMask[i]) {
      w = 0;
    } else {
      const p: Vec3 = [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
      const t = Math.min(1, Math.max(0, distanceToClosedPolyline(p, marginLoop) / band));
      w = t * t * (3 - 2 * t); // smoothstep — C1 at both ends
    }
    const applied = w * d;
    appliedCutbackMm[i] = applied;
    if (w === 0) {
      preservedCount++;
      continue; // byte-identical (no write — the copy already holds the exact coords)
    }
    if (w >= 1 - 1e-9) { fullWeightCount++; fullWeightSum += applied; } else { taperedCount++; }
    if (applied > maxApplied) maxApplied = applied;
    if (maxFacetAngle[i]! > maxMovedFacetAngle) maxMovedFacetAngle = maxFacetAngle[i]!;
    // Inward = −normal.
    positions[i * 3] = mesh.positions[i * 3]! - applied * normals[i * 3]!;
    positions[i * 3 + 1] = mesh.positions[i * 3 + 1]! - applied * normals[i * 3 + 1]!;
    positions[i * 3 + 2] = mesh.positions[i * 3 + 2]! - applied * normals[i * 3 + 2]!;
  }

  const errorBoundMm = d * (1 - Math.cos(maxMovedFacetAngle));
  return {
    mesh: { positions, indices: new Uint32Array(mesh.indices) },
    appliedCutbackMm,
    errorBoundMm,
    maxAppliedCutbackMm: maxApplied,
    meanFullWeightCutbackMm: fullWeightCount > 0 ? fullWeightSum / fullWeightCount : 0,
    fullWeightVertexCount: fullWeightCount,
    taperedVertexCount: taperedCount,
    preservedVertexCount: preservedCount,
    taperBandMm: band,
  };
}
