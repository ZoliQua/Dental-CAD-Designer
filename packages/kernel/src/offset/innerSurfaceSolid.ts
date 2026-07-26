// packages/kernel/src/offset/innerSurfaceSolid.ts
//
// Phase 4 Task 4: the FULL crown inner-surface (intaglio / fit surface)
// construction — Task 3's two-zone cement-gap offset (innerSurfaceOffset.ts)
// EXTENDED with the two deliverables Task 4 owns:
//
//   1. REAL SOLID UNDERCUT BLOCKOUT (self-consistent — re-scanning the result
//      along the insertion axis finds ZERO undercut, by construction).
//   2. SKIRT-TO-MARGIN — the inner surface's open boundary is trimmed to, and
//      stitched exactly onto, the confirmed margin polyline (the marginal
//      seal), so the margin-fit gap goes to ZERO at the margin (Task 4's
//      ≤10 µm phase acceptance criterion).
//
// Task 3's `innerSurfaceOffsetRoi` is untouched (still the offset-only op the
// display path uses); this module is a NEW op that produces the SOLID-
// consistent, margin-sealed intaglio the crown shell (Task 7) is built from.
//
// ## The blockout formulation: draft-close the cement-gap field along the axis
//
// The undercut-free requirement is, precisely: the crown must withdraw along
// the insertion axis `d` without any part of the intaglio catching on the
// die. Equivalently, the region the crown wraps (the cement-gap cavity,
// `F(x) = signedDistance(x) - gap(h(x)) < 0`) must be "draft-closed" along
// `d` — closed under moving in `-d` (down toward the margin). We enforce this
// as a MORPHOLOGICAL operation on the field, in a frame rotated so the
// insertion axis is `+Z`:
//
//     G_block(x) = min over t >= 0 of F(x + t*d)
//
// A short proof this is EXACTLY draft-closed (self-consistent by
// construction): for any x and any s > 0,
//
//     G_block(x - s*d) = min_{t>=0} F(x - s*d + t*d) = min_{u>=-s} F(x + u*d)
//                      <= min_{u>=0} F(x + u*d) = G_block(x).
//
// So `{G_block <= 0}` is closed under stepping in `-d` (a point in the cavity
// stays in the cavity all the way down its axis column). Its upper boundary —
// the extracted intaglio surface `{G_block = 0}` — is therefore SINGLE-VALUED
// along every axis column: no overhang, no re-entrant, no self-occlusion. A
// `+d` visibility ray from any surface point leaves the (downward-closed)
// solid immediately and never re-enters, and every surface normal has
// `normal . d >= 0`. Both halves of undercutScan.ts's undercut test
// (`normal . d < 0` OR occluded) are thus false by construction — see
// innerSurfaceSolid.selfconsistency.test.ts for the MEASURED residual (which
// is not exactly zero: marching-cubes discretization of the draft-closed
// field leaves a small, pitch-scaled residual near the crop/skirt seam,
// reported honestly there, NOT claimed to be zero).
//
// In the `+Z`-is-`d` frame the sweep is a per-column running minimum from the
// top of the grid down to the margin plane (`G[z] = min(F[z], G[z+1])`),
// which is O(cells), exact, and deterministic. Below the margin plane the
// field is cropped to "outside" so the intaglio never extends past the
// margin (the skirt seals it there).
//
// ## Dense field (NOT banded) — accuracy over speed
//
// The offset-only op (`innerSurfaceOffsetRoi`) samples a THIN BAND around the
// surface (fast) and marks everything else with a `+Infinity` sentinel. That
// is correct for a plain offset (the surface stays in the band) but NOT for
// the blockout: a draft-fill wall generally leaves the original surface's
// band, so the running-minimum needs a correctly-SIGNED field in the whole
// ROI, not a sentinel outside a thin shell. This module therefore samples the
// field DENSELY (real `signedDistance` at every ROI cell). That is the slower,
// correct choice (CLAUDE.md's overriding rule) — the always-on tests use a
// compact die at a coarse pitch to stay fast; a clinical-pitch run is gated
// (`RUN_INNER_SURFACE_ACCEPTANCE`), same convention as Task 3.
//
// ## Skirt-to-margin (the ≤10 µm construction-fidelity target)
//
// After the blocked intaglio patch is extracted and rotated back to world, it
// is an OPEN cup whose single boundary loop sits near the margin plane. The
// skirt STITCHES that boundary loop onto the confirmed margin polyline (the
// dense `resampledPoints`, per margin/band.ts's CHORD-CAP rule — NEVER anchor
// chords): the skirt's bottom rim vertices ARE the margin points, so the
// finished inner surface's boundary loop == the margin polyline EXACTLY (up to
// Float64 noise). The margin-fit gate then measures ~0 not because it is told
// to, but because the geometry genuinely coincides — a construction-fidelity
// target, reachable regardless of scan gingiva (see the brief's framing:
// Phase 3's tracked-pending margin issue is about DETECTING the margin under
// gingiva; this is CONSTRUCTING a boundary onto an already-confirmed margin).
//
// Both the patch boundary loop and the margin loop encircle the insertion
// axis, so they are stitched by a deterministic azimuth zipper (advance the
// loop whose next vertex has the smaller azimuth around the axis; ties broken
// by index). The patch boundary vertices are REUSED (shared indices), so the
// patch's former boundary edges become interior and the ONLY remaining
// boundary is the margin loop — no T-junctions, no double seam.
//
// @errorBound The offset magnitude inherits Task 3's bound verbatim (the
// dense field changes nothing about the chord bound): flat zones hold to
// `pitchMm/2 + eps_f32`, the blend zone to the Lipschitz-inflated bound (see
// innerSurfaceOffset.ts's `@errorBound`). The BLOCKOUT adds a pitch-scaled
// POSITION error on the draft-fill walls (the running-minimum's crop is
// quantized to the grid — the fill wall lands within `pitchMm/2` of the true
// draft plane, same character as the offset chord bound). The SKIRT adds NO
// approximation to the margin fit: the boundary vertices are the margin points
// themselves. The MARGIN-FIT and SELF-CONSISTENCY residuals are MEASURED, not
// bounded a priori, and reported by the caller/gate (see this module's tests).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { destinationVertex } from '../halfedge/iterate.ts';
import { findBoundaryLoops } from '../halfedge/iterate.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { weldVertices, MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { orthonormalBasis } from '../axis/hemisphere.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { sdfGridDims } from '../sdf/grid.ts';
import { marchingCubes, MIN_PITCH_MM, PitchTooSmallError, type ScalarGrid } from './marchingCubes.ts';
import {
  EmptyOffsetResultError,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
} from './offsetMesh.ts';
import {
  BlendWidthTooNarrowError,
  blendZoneLipschitz,
  computeTwoZoneSdfGridSlice,
  type InnerSurfaceGapParams,
} from './innerSurfaceOffset.ts';

/** Slices computed between event-loop yields (pure scheduling — see
 * innerSurfaceOffset.ts's identical constant). */
const SDF_SLICES_PER_YIELD = 4;

/** Sentinel written BELOW the margin plane: `+Infinity`, the SAME "no data /
 * no crossing" marker sdf/grid.ts's banded fill uses — marching cubes SKIPS
 * edges touching it (never interpolates across it), so the intaglio is left
 * OPEN at the margin (the skirt seals it) rather than capped by a flat bottom.
 * The dense field ABOVE the margin carries real signed values, so this
 * sentinel never appears inside the swept/blocked region. */
const CROP_OUTSIDE = Number.POSITIVE_INFINITY;

/** Margin-loop dedup epsilon — the mesh weld epsilon (margin `resampledPoints`
 * share an exact point at every segment boundary; see margin/band.ts).
 * Exported: the cavity inner-surface op (cavity/innerSurface.ts) reuses the
 * SAME dedup epsilon for the cavity outline (the shared skirt machinery). */
export const MARGIN_DEDUP_EPSILON_MM = MESH_WELD_EPSILON_MM;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How far (multiples of the max margin radius) beyond the margin the prep ROI
 * reaches horizontally — captures the whole prep tooth while excluding
 * neighbours on a full arch. An ALGORITHMIC default (not a clinical value). */
export const INNER_SURFACE_ROI_RADIUS_FACTOR = 1.6;

export interface InnerSurfaceSolidParams extends InnerSurfaceGapParams {
  /** Voxel pitch, mm — REQUIRED (clinical default lives in clinical-profiles). */
  readonly pitchMm: number;
  /** Dense on-surface margin loop (`resampledPoints`, CHORD-CAP) — the skirt
   * bottom rim, and the height field's reference. */
  readonly marginLoop: readonly Vec3[];
  /** Insertion axis (crown draw/withdrawal direction) — normalized internally.
   * The blockout draft-closes the cement-gap cavity along this axis. */
  readonly insertionAxis: Vec3;
}

/** Optional progress/cancellation hooks — a WORKER (kernel-workers) passes
 * these to report progress and cooperatively cancel across the field-grid
 * loop. They affect NO computed value, so passing them (or not) yields a
 * byte-identical mesh — the worker's byte-identity contract. */
export interface InnerSurfaceSolidHooks {
  /** Called with a fraction in [0, 1] at phase boundaries and between field
   * slices. */
  readonly onProgress?: (fraction: number) => void;
  /** Awaited between field slices and at phase boundaries — should THROW to
   * cancel (e.g. the worker's JobCancelledError). */
  readonly checkCancel?: () => Promise<void>;
}

export interface InnerSurfaceSolidResult {
  /** The finished intaglio patch (world frame): a two-zone offset, undercut-
   * blocked, with its boundary loop stitched exactly onto the margin polyline.
   * OPEN (single boundary = the margin loop) — the crown shell (Task 7) caps
   * it against the outer anatomy at the margin band. */
  readonly mesh: IndexedMesh;
  readonly stats: ReturnType<typeof analyzeMesh>;
  /** Worst-case (blend-zone) offset error bound, mm — see @errorBound. */
  readonly errorBoundMm: number;
  /** Tighter flat-zone (marginal/cement) bound, mm. */
  readonly flatZoneErrorBoundMm: number;
  /** Count of margin points the skirt bottom rim was built from (the finished
   * boundary-loop length). */
  readonly marginVertexCount: number;
  /** Count of triangles in the blocked offset patch (before the skirt) — the
   * blockout's coverage, for reporting. */
  readonly patchTriangleCount: number;
  readonly skirtTriangleCount: number;
  readonly marginalGapMm: number;
  readonly cementGapMm: number;
  readonly spacerStartMm: number;
  readonly blendWidthMm: number;
  readonly pitchMm: number;
}

function validateParams(params: InnerSurfaceSolidParams): void {
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, marginLoop, insertionAxis } = params;
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`innerSurfaceSolid: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  if (!(Number.isFinite(marginalGapMm) && marginalGapMm >= 0)) {
    throw new TypeError(`innerSurfaceSolid: marginalGapMm must be finite and >= 0, got ${marginalGapMm}`);
  }
  if (!(Number.isFinite(cementGapMm) && cementGapMm >= 0)) {
    throw new TypeError(`innerSurfaceSolid: cementGapMm must be finite and >= 0, got ${cementGapMm}`);
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`innerSurfaceSolid: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`innerSurfaceSolid: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const lgap = blendZoneLipschitz({ marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm });
  if (!(lgap < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (!marginLoop || marginLoop.length < 3) {
    throw new TypeError(`innerSurfaceSolid: marginLoop must have >= 3 points, got ${marginLoop?.length ?? 0}`);
  }
  const len = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(len > 0)) {
    throw new TypeError('innerSurfaceSolid: insertionAxis must be a non-zero vector');
  }
}

/** A rotation expressed as its three orthonormal ROW vectors `{u, v, w}`:
 * `applyR(p) = (p.u, p.v, p.w)` maps world -> the frame where `+Z` is `w`
 * (the insertion axis); `applyRT` is its inverse (transpose).
 *
 * NOTE (shared crown/cavity primitive): `AxisFrame` + `axisFrame`/`applyR`/
 * `applyRT`/`rotateMesh` are exported so the cavity inner-surface op
 * (cavity/innerSurface.ts) rotates into the SAME insertion-axis frame with the
 * SAME arithmetic — reuse, not a re-implementation. Kept out of the kernel's
 * public index (internal shared helpers, imported by relative path only). */
export interface AxisFrame {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly w: Vec3;
}

export function axisFrame(insertionAxis: Vec3): AxisFrame {
  const len = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  const w: Vec3 = [insertionAxis[0] / len, insertionAxis[1] / len, insertionAxis[2] / len];
  const { u, v } = orthonormalBasis(w);
  return { u, v, w };
}

export function applyR(f: AxisFrame, p: Vec3): Vec3 {
  return [
    p[0] * f.u[0] + p[1] * f.u[1] + p[2] * f.u[2],
    p[0] * f.v[0] + p[1] * f.v[1] + p[2] * f.v[2],
    p[0] * f.w[0] + p[1] * f.w[1] + p[2] * f.w[2],
  ];
}

export function applyRT(f: AxisFrame, q: Vec3): Vec3 {
  return [
    q[0] * f.u[0] + q[1] * f.v[0] + q[2] * f.w[0],
    q[0] * f.u[1] + q[1] * f.v[1] + q[2] * f.w[1],
    q[0] * f.u[2] + q[1] * f.v[2] + q[2] * f.w[2],
  ];
}

export function rotateMesh(mesh: IndexedMesh, f: AxisFrame): IndexedMesh {
  const n = mesh.positions.length / 3;
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < n; i++) {
    const q = applyR(f, [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]);
    positions[i * 3] = q[0];
    positions[i * 3 + 1] = q[1];
    positions[i * 3 + 2] = q[2];
  }
  return { positions, indices: mesh.indices.slice() };
}

/** The prep-region ROI bbox in the ROTATED (axis = `+Z`) frame: the margin
 * loop's bbox unioned with every prep vertex ABOVE the margin plane AND within
 * `INNER_SURFACE_ROI_RADIUS_FACTOR * maxMarginRadius` of the margin axis (so a
 * full-arch scan's neighbours are excluded — the ROI hugs the one prep tooth). */
function prepRoiBboxAxisFrame(
  prepRot: IndexedMesh,
  loopRot: readonly Vec3[],
): { min: Vec3; max: Vec3; centroidZ: number } {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of loopRot) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const n = loopRot.length;
  cx /= n;
  cy /= n;
  cz /= n;
  let maxR = 0;
  for (const p of loopRot) {
    const r = Math.hypot(p[0] - cx, p[1] - cy);
    if (r > maxR) maxR = r;
  }
  const radiusLimit = INNER_SURFACE_ROI_RADIUS_FACTOR * maxR;
  const radiusLimitSq = radiusLimit * radiusLimit;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number): void => {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };
  for (const p of loopRot) grow(p[0], p[1], p[2]);
  const vCount = prepRot.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const x = prepRot.positions[v * 3]!;
    const y = prepRot.positions[v * 3 + 1]!;
    const z = prepRot.positions[v * 3 + 2]!;
    if (z < cz) continue; // below the margin plane
    const rSq = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (rSq > radiusLimitSq) continue; // beyond the prep tooth (neighbour)
    grow(x, y, z);
  }
  return { min, max, centroidZ: cz };
}

/** Ordered vertex-index loops from the boundary halfedges (findBoundaryLoops
 * returns HALFEDGE loops — map each to its destination vertex). */
function boundaryVertexLoops(mesh: IndexedMesh): number[][] {
  const hm = buildHalfedge(mesh);
  const heLoops = findBoundaryLoops(hm);
  return heLoops.map((loop) => loop.map((he) => destinationVertex(hm, he)));
}

/** Deduplicates consecutive near-identical loop points (within `eps`),
 * including the closing wraparound — same rule as margin/band.ts's
 * `marginLoopPolyline` (`resampledPoints` share a point at every segment
 * boundary). Guards the skirt against degenerate (zero-length) triangles. */
export function dedupLoop(loop: readonly Vec3[], eps: number): Vec3[] {
  const d3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const out: Vec3[] = [loop[0]!];
  for (let i = 1; i < loop.length; i++) {
    if (d3(out[out.length - 1]!, loop[i]!) > eps) out.push(loop[i]!);
  }
  if (out.length > 1 && d3(out[out.length - 1]!, out[0]!) <= eps) out.pop();
  return out;
}

/** Even-odd ray-cast point-in-polygon test (2D, the axis-frame x/y plane). */
export function pointInPolygon2d(px: number, py: number, poly: readonly [number, number][]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]![0], yi = poly[i]![1];
    const xj = poly[j]![0], yj = poly[j]![1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Min squared distance from `(px, py)` to the CLOSED polyline `poly` (2D). */
export function distSqToPolyline2d(px: number, py: number, poly: readonly [number, number][]): number {
  let min = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const ax = poly[i]![0], ay = poly[i]![1];
    const bx = poly[(i + 1) % n]![0], by = poly[(i + 1) % n]![1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + t * dx - px, cy = ay + t * dy - py;
    const d = cx * cx + cy * cy;
    if (d < min) min = d;
  }
  return min;
}

interface BuiltFieldPatch {
  patch: IndexedMesh; // rotated (axis) frame
  flatZoneErrorBoundMm: number;
  errorBoundMm: number;
}

/** Offset + draft-close blockout in the rotated frame, returning the extracted
 * (rotated-frame) intaglio patch. Marching cubes is at iso = 0. */
async function buildBlockedPatch(
  prepRot: IndexedMesh,
  gapParams: InnerSurfaceGapParams,
  pitchMm: number,
  marginLoopRot: readonly Vec3[],
  roi: { min: Vec3; max: Vec3; centroidZ: number },
  hooks?: InnerSurfaceSolidHooks,
): Promise<BuiltFieldPatch> {
  const bvh = buildBvh(prepRot);
  const pseudonormals = computePseudonormals(prepRot);

  const maxGapMm = Math.max(gapParams.marginalGapMm, gapParams.cementGapMm);
  const spec = offsetGridSpec({ min: roi.min, max: roi.max }, maxGapMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const sliceCells = nx * ny;

  // FOOTPRINT crop + CLEAN HIGH-PLANE crop. Two problems on a real (full-arch,
  // NON-PLANAR-margin) scan:
  //   (a) the ROI bbox still contains adjacent teeth, which would each grow
  //       their own intaglio cup (extra boundary loops, wrecking the fit);
  //   (b) cropping the field AT the (non-planar) margin — whether by a single
  //       mid-margin plane or a per-column staircase — leaves a ragged,
  //       FRAGMENTED marching-cubes boundary (many tiny loops).
  // Fix (a): restrict the field to the tooth's own horizontal FOOTPRINT — a
  // cell is kept iff its (x, y) (axis frame) is INSIDE the margin polygon OR
  // within `cropBandMm` of it (the outward cement-gap band); neighbours are
  // "no-data" (+Inf). Fix (b): crop the field with ONE clean plane placed just
  // ABOVE the ENTIRE margin (`zCut = maxMarginZ + cleanCutSlack`), so the
  // patch ends in ONE clean cross-section loop well clear of the margin; the
  // SKIRT then spans from that clean loop down to the exact (non-planar) margin
  // polyline (the marginal seal). This trades the two-zone offset detail in the
  // thin `[margin, zCut]` band for a ruled skirt there (a linear gap ramp to 0
  // — an acceptable marginal transition), in exchange for a robust single
  // boundary loop on real geometry; keep `cleanCutSlack` small to keep that
  // band thin.
  const cropBandMm = maxGapMm + 3 * pitchMm;
  const cleanCutSlack = 3 * pitchMm;
  let maxMarginZ = -Infinity;
  for (const p of marginLoopRot) if (p[2] > maxMarginZ) maxMarginZ = p[2];
  const zCut = maxMarginZ + cleanCutSlack;
  const marginZIndex = Math.max(0, Math.ceil((zCut - origin[2]) / pitchMm));

  const loop2d: [number, number][] = marginLoopRot.map((p) => [p[0], p[1]]);
  const band2 = cropBandMm * cropBandMm;
  const mask2d = new Uint8Array(sliceCells);
  for (let iy = 0; iy < ny; iy++) {
    const wy = origin[1] + iy * pitchMm;
    for (let ix = 0; ix < nx; ix++) {
      const wx = origin[0] + ix * pitchMm;
      mask2d[iy * nx + ix] = pointInPolygon2d(wx, wy, loop2d) || distSqToPolyline2d(wx, wy, loop2d) <= band2 ? 1 : 0;
    }
  }
  const mask3d = new Uint8Array(cellCount);
  for (let z = 0; z < nz; z++) mask3d.set(mask2d, z * sliceCells);

  const grid = new Float32Array(cellCount);
  for (let z = 0; z < nz; z++) {
    const worldZ = origin[2] + z * pitchMm;
    if (worldZ < zCut) {
      // Below the clean cut plane: "no-data" (+Inf) — the intaglio ends in a
      // clean single loop at zCut; the skirt seals from there to the margin.
      grid.fill(CROP_OUTSIDE, z * sliceCells, (z + 1) * sliceCells);
    } else {
      grid.set(
        computeTwoZoneSdfGridSlice(prepRot, bvh, pseudonormals, dims, origin, pitchMm, z, mask3d, gapParams, marginLoopRot),
        z * sliceCells,
      );
    }
    if (hooks?.checkCancel) await hooks.checkCancel();
    hooks?.onProgress?.(0.05 + 0.75 * ((z + 1) / nz)); // field grid: 0.05 -> 0.80
    if (z % SDF_SLICES_PER_YIELD === SDF_SLICES_PER_YIELD - 1) await yieldToEventLoop();
  }

  // Blockout: per-column running minimum from the top down to the clean cut
  // plane — G[z] = min(F[z], G[z+1]) — draft-closing the cement-gap cavity
  // along +Z (= the insertion axis). See module doc for the correctness proof.
  for (let z = nz - 2; z >= marginZIndex; z--) {
    const base = z * sliceCells;
    const above = base + sliceCells;
    for (let i = 0; i < sliceCells; i++) {
      const a = grid[above + i]!;
      if (a < grid[base + i]!) grid[base + i] = a;
    }
  }

  const fieldGrid: ScalarGrid = { grid, dims, origin, pitchMm };
  const soup = marchingCubes(fieldGrid, 0);
  if (soup.triangleCount === 0) {
    throw new EmptyOffsetResultError(0);
  }
  const welded = weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });

  const maxAbs = maxAbsCoordOf({ min: roi.min, max: roi.max }, spec.padding);
  const flatZoneErrorBoundMm = offsetErrorBoundMm(pitchMm, maxAbs);
  const f32Terms = flatZoneErrorBoundMm - pitchMm / 2;
  const lgap = blendZoneLipschitz(gapParams);
  const errorBoundMm = ((1 + lgap) / (1 - lgap)) * (pitchMm / 2) + f32Terms;

  return { patch: welded, flatZoneErrorBoundMm, errorBoundMm };
}

/**
 * Stitches the intaglio patch's margin-side boundary loop onto the margin
 * polyline, returning the combined (patch + skirt) mesh. Both loops encircle
 * the insertion axis; stitched by a deterministic azimuth zipper.
 *
 * `marginLoopWorld` are the EXACT confirmed margin points (world frame) — the
 * skirt bottom rim, so the finished boundary == the margin polyline.
 */
/** How the skirt zipper pairs the patch boundary ring against the target
 * (margin/outline) ring.
 *
 *  - `'index'` (DEFAULT — the crown): advance whichever ring is behind in
 *    normalized INDEX fraction (i/M vs j/N). Robust for a roughly-planar margin
 *    whose two rings are near-uniformly distributed; the crown ships on this and
 *    stays byte-identical (omitting the option ⇒ 'index').
 *  - `'arcLength'` (the CAVITY — Phase 5 Task 3): advance by normalized 3-D
 *    ARC-LENGTH fraction. A true MOD cavity OUTLINE is non-planar and BREAKS
 *    THROUGH the proximal faces (the "U" drops 3+ mm), so its points are NOT
 *    proportionally distributed in index vs the patch boundary's MC points —
 *    index pairing then fabricates skirt triangles that SPAN the notch (they
 *    tilt into facing-undercut). Arc-length pairing matches the two near-parallel
 *    offset curves into a THIN, draft-safe ribbon (measured: whole-mesh undercut
 *    142 → 0 on the drafted MOD fixture — see cavity/innerSurface.analytic.test.ts).
 *    This is the ONE place the crown skirt did NOT transfer cleanly; parameterized
 *    here rather than forked. */
export type SkirtPairing = 'index' | 'arcLength';

export function skirtToMargin(
  patchWorld: IndexedMesh,
  marginLoopWorld: readonly Vec3[],
  axisUnit: Vec3,
  pairing: SkirtPairing = 'index',
): { mesh: IndexedMesh; skirtTriangleCount: number } {
  // Margin centre + a tangent basis (u, v) perpendicular to the axis, for a
  // consistent azimuth measurement of both loops.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of marginLoopWorld) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const nMargin = marginLoopWorld.length;
  cx /= nMargin;
  cy /= nMargin;
  cz /= nMargin;
  const { u, v } = orthonormalBasis(axisUnit);
  const projAz = (p: Vec3): number => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    const pu = dx * u[0] + dy * u[1] + dz * u[2];
    const pv = dx * v[0] + dy * v[1] + dz * v[2];
    return Math.atan2(pv, pu);
  };

  const patchVertexCount = patchWorld.positions.length / 3;
  const loops = boundaryVertexLoops(patchWorld);
  if (loops.length === 0) {
    throw new NoBoundaryLoopError();
  }
  // The margin-side opening: the boundary loop whose centroid is nearest the
  // margin centroid (the intaglio's only large opening; a small ROI side-crop,
  // if any, sits elsewhere).
  const vpos = (i: number): Vec3 => [patchWorld.positions[i * 3]!, patchWorld.positions[i * 3 + 1]!, patchWorld.positions[i * 3 + 2]!];
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < loops.length; k++) {
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (const vi of loops[k]!) {
      const p = vpos(vi);
      lx += p[0];
      ly += p[1];
      lz += p[2];
    }
    const m = loops[k]!.length;
    const score = Math.hypot(lx / m - cx, ly / m - cy, lz / m - cz);
    // Prefer the largest loop near the margin (tie-break toward more points).
    const adj = score - loops[k]!.length * 1e-9;
    if (adj < bestScore) {
      bestScore = adj;
      best = k;
    }
  }
  const patchLoopRaw = loops[best]!;

  // Keep each ring in its NATURAL cyclic order (so a skirt edge between
  // consecutive patch-loop vertices is a REAL patch boundary edge — reusing
  // it makes the patch's former boundary interior, keeping the mesh manifold;
  // re-sorting by azimuth would fabricate non-edges and tear topology). Only
  // NORMALIZE each ring's orientation to CCW-around-the-axis and ALIGN their
  // start points, then zipper in natural order.
  const projUV = (p: Vec3): [number, number] => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
  };
  const signedArea = (uv: readonly [number, number][]): number => {
    let a = 0;
    const n = uv.length;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = uv[k]!;
      const [x1, y1] = uv[(k + 1) % n]!;
      a += x0 * y1 - x1 * y0;
    }
    return a * 0.5;
  };

  const patchOrder = [...patchLoopRaw];
  if (signedArea(patchOrder.map((vi) => projUV(vpos(vi)))) < 0) patchOrder.reverse();

  let marginIdx = marginLoopWorld.map((_, idx) => idx);
  if (signedArea(marginIdx.map((idx) => projUV(marginLoopWorld[idx]!))) < 0) marginIdx.reverse();

  // Align the margin ring's start to the patch ring's start (nearest azimuth).
  const p0az = projAz(vpos(patchOrder[0]!));
  let startK = 0;
  let bestDiff = Infinity;
  for (let k = 0; k < marginIdx.length; k++) {
    let d = Math.abs(projAz(marginLoopWorld[marginIdx[k]!]!) - p0az);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < bestDiff) {
      bestDiff = d;
      startK = k;
    }
  }
  marginIdx = [...marginIdx.slice(startK), ...marginIdx.slice(0, startK)];

  // Append the margin vertices after the patch vertices.
  const M = patchOrder.length;
  const N = marginIdx.length;
  const combinedPositions = new Float64Array((patchVertexCount + N) * 3);
  combinedPositions.set(patchWorld.positions, 0);
  for (let idx = 0; idx < N; idx++) {
    const p = marginLoopWorld[marginIdx[idx]!]!;
    const base = (patchVertexCount + idx) * 3;
    combinedPositions[base] = p[0];
    combinedPositions[base + 1] = p[1];
    combinedPositions[base + 2] = p[2];
  }
  const marginVi = (idx: number): number => patchVertexCount + idx; // local margin index -> combined vertex

  // Per-ring "position after advancing k steps" in [0, 1] — INDEX fraction
  // ((k)/count) for the crown, or normalized cumulative 3-D ARC-LENGTH fraction
  // for the cavity (see `SkirtPairing`'s doc). Precomputed so the zipper below
  // is O(M + N).
  const cumFractions = (count: number, posAt: (k: number) => Vec3): number[] => {
    if (pairing === 'index') {
      const f = new Array<number>(count + 1);
      for (let k = 0; k <= count; k++) f[k] = k / count;
      return f;
    }
    const cum = new Array<number>(count + 1);
    cum[0] = 0;
    for (let k = 1; k <= count; k++) {
      const a = posAt((k - 1) % count);
      const b = posAt(k % count);
      cum[k] = cum[k - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const total = cum[count]!;
    if (total > 0) for (let k = 0; k <= count; k++) cum[k]! /= total;
    return cum;
  };
  const fracP = cumFractions(M, (k) => vpos(patchOrder[k]!));
  const fracM = cumFractions(N, (k) => marginLoopWorld[marginIdx[k]!]!);

  // Zipper: advance whichever CCW ring is behind in its normalized position
  // (`fracP[i+1]` vs `fracM[j+1]`). Strictly monotone — never backtracks — so
  // it yields a clean, manifold annulus; both rings start aligned (above), so
  // proportional correspondence pairs them without crossing. Deterministic.
  const skirtTris: number[] = [];
  let i = 0;
  let j = 0;
  while (i < M || j < N) {
    const pCur = patchOrder[i % M]!;
    const mCur = marginVi(j % N);
    const advanceP = j >= N || (i < M && fracP[i + 1]! <= fracM[j + 1]!);
    if (advanceP) {
      const pNext = patchOrder[(i + 1) % M]!;
      skirtTris.push(pCur, mCur, pNext);
      i++;
    } else {
      const mNext = marginVi((j + 1) % N);
      skirtTris.push(pCur, mNext, mCur);
      j++;
    }
  }

  // Winding: the skirt triangles above are built to a consistent-DEGREE
  // annulus (each shared edge degree 2), but their winding is not yet
  // globally consistent with the patch. `buildInnerSurface` runs
  // `orientNormalsConsistently` (+ an outward flip) on the combined mesh —
  // patch and skirt are one connected component, so one flood fill makes the
  // whole intaglio consistently oriented, deterministically.
  const combinedIndices = new Uint32Array(patchWorld.indices.length + skirtTris.length);
  combinedIndices.set(patchWorld.indices, 0);
  combinedIndices.set(skirtTris, patchWorld.indices.length);

  return { mesh: { positions: combinedPositions, indices: combinedIndices }, skirtTriangleCount: skirtTris.length / 3 };
}

/** Flips EVERY triangle's winding if the surface's occlusal-most triangle
 * (the one whose normal is most parallel to the axis — the intaglio's occlusal
 * cap) points INWARD (`normal . axis < 0`). The offset patch's MC winding is
 * outward (+∇F, away from the die), so this pins the whole consistently-
 * oriented surface to that outward sign, deterministically (max |normal.axis|,
 * ties broken by lowest triangle index). */
export function flipOutwardIfNeeded(mesh: IndexedMesh, axisUnit: Vec3): IndexedMesh {
  const triCount = mesh.indices.length / 3;
  let bestT = 0;
  let bestAbs = -1;
  let bestDot = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3]!;
    const ib = mesh.indices[t * 3 + 1]!;
    const ic = mesh.indices[t * 3 + 2]!;
    const ax = mesh.positions[ia * 3]!, ay = mesh.positions[ia * 3 + 1]!, az = mesh.positions[ia * 3 + 2]!;
    const bx = mesh.positions[ib * 3]!, by = mesh.positions[ib * 3 + 1]!, bz = mesh.positions[ib * 3 + 2]!;
    const cx = mesh.positions[ic * 3]!, cy = mesh.positions[ic * 3 + 1]!, cz = mesh.positions[ic * 3 + 2]!;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const dot = (nx * axisUnit[0] + ny * axisUnit[1] + nz * axisUnit[2]) / len;
    const abs = Math.abs(dot);
    if (abs > bestAbs) {
      bestAbs = abs;
      bestDot = dot;
      bestT = t;
    }
  }
  void bestT;
  if (bestDot >= 0) return mesh;
  const flipped = mesh.indices.slice();
  for (let t = 0; t < triCount; t++) {
    const tmp = flipped[t * 3 + 1]!;
    flipped[t * 3 + 1] = flipped[t * 3 + 2]!;
    flipped[t * 3 + 2] = tmp;
  }
  return { positions: mesh.positions, indices: flipped };
}

/** Thrown when the blocked intaglio patch has no boundary loop to skirt (a
 * closed patch — should never happen given the margin-plane crop; a loud,
 * typed failure rather than a silently unsealed inner surface). */
export class NoBoundaryLoopError extends Error {
  constructor() {
    super('innerSurfaceSolid: the blocked intaglio patch has no boundary loop to skirt to the margin (expected an open cup)');
    this.name = 'NoBoundaryLoopError';
  }
}

/**
 * Builds the full crown inner surface (two-zone offset + solid undercut
 * blockout + skirt-to-margin) — see this module's doc for the formulation,
 * the draft-close correctness proof, the skirt construction, and @errorBound.
 * `mesh` is the FULL prep/die. Returns an OPEN patch whose single boundary
 * loop == the margin polyline.
 *
 * Deterministic: same mesh + params -> byte-identical output.
 *
 * @throws {TypeError} for invalid pitch/gaps/spacer/loop/axis.
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} / {NonWatertightMeshError}
 * / {SdfGridTooLargeError} / {EmptyOffsetResultError} / {NoBoundaryLoopError}.
 */
export async function buildInnerSurface(
  mesh: IndexedMesh,
  params: InnerSurfaceSolidParams,
  hooks?: InnerSurfaceSolidHooks,
): Promise<InnerSurfaceSolidResult> {
  validateParams(params);
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, marginLoop, insertionAxis } = params;
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };

  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0);

  const frame = axisFrame(insertionAxis);
  const axisUnit = frame.w;

  // Rotate the prep + margin loop so the insertion axis is +Z.
  const prepRot = rotateMesh(mesh, frame);
  const marginLoopRot: Vec3[] = marginLoop.map((p) => applyR(frame, p));

  const roi = prepRoiBboxAxisFrame(prepRot, marginLoopRot);
  hooks?.onProgress?.(0.05);

  const built = await buildBlockedPatch(prepRot, gapParams, pitchMm, marginLoopRot, roi, hooks);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.9); // blockout MC done; skirt + orient next

  // Rotate the patch back to world (apply R^T to every vertex).
  const pwPositions = new Float64Array(built.patch.positions.length);
  const pvCount = built.patch.positions.length / 3;
  for (let i = 0; i < pvCount; i++) {
    const q = applyRT(frame, [built.patch.positions[i * 3]!, built.patch.positions[i * 3 + 1]!, built.patch.positions[i * 3 + 2]!]);
    pwPositions[i * 3] = q[0];
    pwPositions[i * 3 + 1] = q[1];
    pwPositions[i * 3 + 2] = q[2];
  }
  const patchWorld: IndexedMesh = { positions: pwPositions, indices: built.patch.indices.slice() };
  const patchTriangleCount = patchWorld.indices.length / 3;

  // Skirt the patch boundary onto the EXACT (deduplicated) confirmed margin
  // points — the finished boundary loop then == the margin polyline.
  const marginDedup = dedupLoop(marginLoop, MARGIN_DEDUP_EPSILON_MM);
  const { mesh: combined, skirtTriangleCount } = skirtToMargin(patchWorld, marginDedup, axisUnit);

  // Make the patch+skirt (one connected component) consistently oriented, then
  // flip the whole surface OUTWARD (away from the die) if its occlusal-most
  // triangle points inward — the offset patch's MC winding is outward, so the
  // reference triangle fixes the global sign deterministically.
  const oriented = orientNormalsConsistently(combined).mesh;
  const finalMesh = flipOutwardIfNeeded(oriented, axisUnit);
  const stats = analyzeMesh(finalMesh);
  hooks?.onProgress?.(1);

  return {
    mesh: finalMesh,
    stats,
    errorBoundMm: built.errorBoundMm,
    flatZoneErrorBoundMm: built.flatZoneErrorBoundMm,
    marginVertexCount: marginDedup.length,
    patchTriangleCount,
    skirtTriangleCount,
    marginalGapMm,
    cementGapMm,
    spacerStartMm,
    blendWidthMm,
    pitchMm,
  };
}
