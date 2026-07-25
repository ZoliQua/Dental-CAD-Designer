// packages/kernel/src/cavity/innerSurface.ts
//
// Phase 5 Task 3: the INLAY/ONLAY inner (fit) surface — the cavity analogue of
// the crown intaglio (offset/innerSurfaceSolid.ts's `buildInnerSurface`). It
// produces the two-zone cement-gap offset OFF THE CAVITY SURFACE + a SOLID
// undercut blockout (draft-close along the insertion axis) + a SKIRT stitching
// the fit-surface boundary EXACTLY onto the cavity-outline polyline (the ≤10 µm
// margin-fit acceptance currency).
//
// ## The geometric insight (verified, then exploited)
//
// An inlay's fit surface is the SAME operation as the crown intaglio: the level
// set `F(x) = signedDistance(x) - gap(h(x)) = 0`, the surface `gap` mm OUTSIDE
// the closed tooth solid — on the cavity VOID side. The fixture tooth-with-
// cavity is a closed solid; the cavity is a CONCAVE feature of it, so
// `signedDistance > 0` (outside the solid) is the void the inlay occupies, and
// `{F = 0}` is the fit surface `gap` mm out into that void from the cavity
// walls/floor. `h(x)` is the along-surface height above the cavity OUTLINE,
// measured at the grid point's FOOTPOINT (the P4 T3 review lesson — evaluating
// `h` at the footpoint, an on-surface point, ELIMINATES the grid-vs-footpoint
// displacement term rather than merely bounding it). So the two-zone gap field
// (`twoZoneGapField`), the footpoint height field (`distanceToClosedPolyline`
// at the closest surface point), the axis-frame rotation, the marching-cubes
// extraction, the skirt zipper, and the outward-orient are all REUSED from the
// crown ops (imported, not re-implemented — see the REUSE map at each import).
//
// ## What genuinely DIFFERS from the crown (extended here, not forked)
//
//   1. DRAFT-CLOSE DIRECTION — VERIFIED IDENTICAL, not assumed. Both the crown
//      and the inlay WITHDRAW along +Z (the crown lifts off the stump; the
//      inlay lifts out of the pocket — the fixture's insertion axis is +Z
//      lift-out, seating -Z). The draft-close is a per-column running MINIMUM
//      looking in the +withdrawal direction: `G[z] = min(F[z], G[z+1])`,
//      iterating from the grid top DOWN — SAME code, SAME direction as
//      buildInnerSurface. Proof it is right for a POCKET (not merely copied):
//      a negative-taper wall (cavity WIDER at the floor, undercut) has, at a
//      lateral column between the opening rim and the wider floor edge, TOOTH
//      above (the overhanging rim, `F <= 0`) and VOID below (the bulge,
//      `F > 0`); the running-min looking up pulls the tooth value DOWN onto the
//      void cell, FILLING the undercut so the fit surface goes vertical and the
//      inlay withdraws. A positive-taper (drafted) wall has void above / tooth
//      below, so the running-min changes NOTHING (no over-fill). Both directions
//      are pinned FALSIFIABLY in innerSurface.analytic.test.ts (zero undercut on
//      the drafted fixture; the blockout demonstrably fills the negative-taper
//      variant, whose UN-blocked offset scans nonzero). A wrong direction
//      (looking -Z, the seating direction) would silently INVERT this — fill
//      the drafted cavity and leave the undercut — which the falsifiable pair
//      would catch.
//
//   2. THE CROP — an OUTLINE-DISTANCE band, not a horizontal plane. The crown
//      crops the field with ONE clean plane just beyond a roughly-PLANAR margin
//      (`worldZ < zCut`), trading the thin near-margin band for a ruled skirt.
//      A true MOD cavity OUTLINE is highly NON-PLANAR and BREAKS THROUGH the
//      proximal faces — it runs along the occlusal table (z = tableZ) on the
//      buccal/lingual margins but DROPS to the gingival floor at each proximal
//      box (the "U"), opening in TWO directions (occlusal +Z AND proximal ±X).
//      A single z-plane cannot separate "fit surface" from "roll-over past the
//      outline" for such a boundary. Instead we crop by the SAME footpoint
//      height field the gap uses: a cell whose footpoint is within
//      `SKIRT_BAND` of the outline (`h < SKIRT_BAND`) is cropped to +Inf. This
//      cuts a thin, outline-shape-agnostic band around the ENTIRE 3-D outline
//      (occlusal margins, proximal U's, and the convex rim roll-over) at once,
//      leaving a clean single-loop patch a small distance INSIDE the outline;
//      the skirt then spans that band to the exact outline. This is the ONE
//      place the crown's plane-crop does NOT transfer — documented as such.
//
//   3. THE ROI + FOOTPRINT CROP — the CAVITY surface, not the whole tooth. The
//      ROI is the CAVITY REGION's bbox (the triangles `classifyCavityRegions`
//      encloses within the outline — Task 2), grown by the offset band. The
//      precise per-cell crop keeps a cell ONLY when its FOOTPOINT (the closest
//      surface point, which `signedClosestPoint` already returns with its
//      triangle index) lies on a CAVITY triangle. This is what makes the fit
//      surface the offset of the CAVITY surface SPECIFICALLY: a plane/polygon
//      band cannot separate the cavity wall's offset from the surrounding
//      intact tooth's offset near the opening (both sit at `sd = gap`), and it
//      FAILS on a negative-taper wall whose cavity surface bulges OUTSIDE the
//      opening rectangle — but the footpoint-on-a-cavity-triangle test is exact
//      for either taper. Reuses Task 2's `classifyCavityRegions` (the cavity is
//      the region enclosed by the SAME outline), run once internally.
//
// ## @errorBound
//
// The offset MAGNITUDE bound is inherited VERBATIM from the crown op (the field
// `F = signedDistance - gap(h)` is identical): the flat marginal/cement zones
// hold to `pitchMm/2 + eps_f32` (marching-cubes chord bound of a 1-Lipschitz
// field + the reused Float32-grid term, `offsetErrorBoundMm`); the BLEND zone
// holds to the Lipschitz-inflated `(1 + Lgap)/(1 - Lgap) * pitchMm/2 + eps_f32`
// with `Lgap = 1.5 * (cementGapMm - marginalGapMm) / blendWidthMm` (see
// innerSurfaceOffset.ts's `@errorBound` for the full derivation, incl. why the
// FOOTPOINT height-field evaluation eliminates the grid-vs-footpoint term). The
// BLOCKOUT adds a pitch-scaled POSITION error on the draft-fill walls (the
// running-minimum crop is grid-quantized — the fill wall lands within
// `pitchMm/2` of the true draft plane). The height field's Euclidean-chord vs
// geodesic-arc residual is a POSITION error on the blend/spacer LINE (never an
// offset magnitude error) and is 0 on a ruled (straight) wall — which a
// cavity's drafted axial wall exactly is. The SKIRT adds NO approximation to
// the margin fit (its bottom rim vertices ARE the outline points). The
// MARGIN-FIT and SELF-CONSISTENCY residuals are MEASURED (not bounded a
// priori) and reported by the caller/gate — see this module's tests.
//
// Determinism: same mesh + params -> byte-identical output (every stage is
// deterministic Float64/Float32-storage math; pinned by a committed sha256 hash
// in innerSurface.analytic.test.ts, the same pure-Float64 op pinning precedent
// cavity/regions.ts follows — no test-fixtures/golden entry).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { weldVertices } from '../intake/weld.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { sdfGridDims } from '../sdf/grid.ts';
import { marchingCubes, MIN_PITCH_MM, PitchTooSmallError, type ScalarGrid } from '../offset/marchingCubes.ts';
import {
  EmptyOffsetResultError,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
} from '../offset/offsetMesh.ts';
// REUSE (offset/innerSurfaceOffset.ts): the two-zone gap field + the footpoint
// height field + the blend-zone Lipschitz — the SAME clinical-gap formulation
// as the crown intaglio, byte-for-byte.
import {
  BlendWidthTooNarrowError,
  blendZoneLipschitz,
  distanceToClosedPolyline,
  twoZoneGapField,
  type InnerSurfaceGapParams,
} from '../offset/innerSurfaceOffset.ts';
// REUSE (offset/innerSurfaceSolid.ts): the axis-frame rotation, the footprint
// mask primitives, the skirt zipper, the outward-orient flip, and the
// outline-dedup epsilon — the SAME crown machinery (exported for this reuse,
// kept out of the kernel's public index).
import {
  applyR,
  applyRT,
  axisFrame,
  dedupLoop,
  flipOutwardIfNeeded,
  rotateMesh,
  skirtToMargin,
  MARGIN_DEDUP_EPSILON_MM,
  type AxisFrame,
} from '../offset/innerSurfaceSolid.ts';
// REUSE (cavity/regions.ts, Task 2): the cavity region enclosed by the SAME
// outline — the exact footprint the fit surface is the offset of.
import { classifyCavityRegions } from './regions.ts';

/** Slices computed between event-loop yields (pure scheduling — see
 * offset/innerSurfaceSolid.ts's identical constant; changes no computed value). */
const SDF_SLICES_PER_YIELD = 4;

/** "No data / no crossing" sentinel (`+Infinity`) — the SAME marker the crown
 * op and sdf/grid.ts use: marching cubes SKIPS edges touching it, leaving the
 * fit surface OPEN there (the skirt seals it). Written for cells outside the
 * cavity footprint AND for cells within `SKIRT_BAND` of the outline. */
const CROP_OUTSIDE = Number.POSITIVE_INFINITY;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Optional progress/cancellation hooks — a WORKER passes these to report
 * progress and cooperatively cancel across the field-grid loop. They affect NO
 * computed value, so passing them (or not) yields a byte-identical mesh (the
 * worker's byte-identity contract — same shape as InnerSurfaceSolidHooks). */
export interface CavityInnerSurfaceHooks {
  /** Called with a fraction in [0, 1] at phase boundaries and between slices. */
  readonly onProgress?: (fraction: number) => void;
  /** Awaited between field slices and at phase boundaries — should THROW to
   * cancel (e.g. the worker's JobCancelledError). */
  readonly checkCancel?: () => Promise<void>;
}

export interface CavityInnerSurfaceParams extends InnerSurfaceGapParams {
  /** Voxel pitch, mm — REQUIRED (no kernel default; clinical default lives in
   * clinical-profiles' `DEFAULT_OFFSET_VOXEL_PITCH_MM`). */
  readonly pitchMm: number;
  /** The DENSE, on-mesh, CLOSED cavity OUTLINE ring (the fixture
   * `cavityOutline` / a confirmed margin's `resampledPoints`, per
   * margin/band.ts's CHORD-CAP rule) — the height field measures distance to
   * THIS polyline, and the skirt bottom rim IS it. */
  readonly cavityOutline: readonly Vec3[];
  /** Insertion axis (the inlay's draw / lift-out direction) — normalized
   * internally. The blockout draft-closes the cavity void along this axis. */
  readonly insertionAxis: Vec3;
}

export interface CavityInnerSurfaceResult {
  /** The finished cavity fit surface (world frame): a two-zone offset off the
   * cavity walls/floor, undercut-blocked, with its single boundary loop
   * stitched exactly onto the cavity-outline polyline. OPEN (that one boundary
   * = the outline) — the inlay shell (Task 6) caps it against the occlusal
   * patch (Task 4) at the outline band. */
  readonly mesh: IndexedMesh;
  readonly stats: ReturnType<typeof analyzeMesh>;
  /** Worst-case (blend-zone) offset error bound, mm — see @errorBound. */
  readonly errorBoundMm: number;
  /** Tighter flat-zone (marginal/cement) bound, mm. */
  readonly flatZoneErrorBoundMm: number;
  /** Outline points the skirt bottom rim was built from (the finished
   * boundary-loop length). */
  readonly marginVertexCount: number;
  /** Triangles in the blocked offset patch (before the skirt). */
  readonly patchTriangleCount: number;
  readonly skirtTriangleCount: number;
  readonly marginalGapMm: number;
  readonly cementGapMm: number;
  readonly spacerStartMm: number;
  readonly blendWidthMm: number;
  readonly pitchMm: number;
}

function validateParams(params: CavityInnerSurfaceParams): void {
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, cavityOutline, insertionAxis } = params;
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`buildCavityInnerSurface: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }
  if (!(Number.isFinite(marginalGapMm) && marginalGapMm >= 0)) {
    throw new TypeError(`buildCavityInnerSurface: marginalGapMm must be finite and >= 0, got ${marginalGapMm}`);
  }
  if (!(Number.isFinite(cementGapMm) && cementGapMm >= 0)) {
    throw new TypeError(`buildCavityInnerSurface: cementGapMm must be finite and >= 0, got ${cementGapMm}`);
  }
  if (!(Number.isFinite(spacerStartMm) && spacerStartMm > 0)) {
    throw new TypeError(`buildCavityInnerSurface: spacerStartMm must be finite and > 0, got ${spacerStartMm}`);
  }
  if (!(Number.isFinite(blendWidthMm) && blendWidthMm > 0)) {
    throw new TypeError(`buildCavityInnerSurface: blendWidthMm must be finite and > 0, got ${blendWidthMm}`);
  }
  const lgap = blendZoneLipschitz({ marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm });
  if (!(lgap < 1)) {
    throw new BlendWidthTooNarrowError(blendWidthMm, Math.abs(cementGapMm - marginalGapMm));
  }
  if (!cavityOutline || cavityOutline.length < 3) {
    throw new TypeError(`buildCavityInnerSurface: cavityOutline must have >= 3 points, got ${cavityOutline?.length ?? 0}`);
  }
  const len = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(len > 0)) {
    throw new TypeError('buildCavityInnerSurface: insertionAxis must be a non-zero vector');
  }
}

/** The CAVITY REGION's bbox in the ROTATED (axis = +Z) frame — the bbox of the
 * vertices of the `cavitySet` triangles (the surface enclosed by the outline).
 * Sizes the grid tightly to the cavity (walls + floor), excluding the cusps
 * above and the base below; the precise per-cell crop is the footpoint test. */
function cavityRegionBboxAxisFrame(meshRot: IndexedMesh, cavitySet: Uint8Array): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (v: number): void => {
    const x = meshRot.positions[v * 3]!;
    const y = meshRot.positions[v * 3 + 1]!;
    const z = meshRot.positions[v * 3 + 2]!;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };
  const triCount = meshRot.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    if (cavitySet[t] !== 1) continue;
    grow(meshRot.indices[t * 3]!);
    grow(meshRot.indices[t * 3 + 1]!);
    grow(meshRot.indices[t * 3 + 2]!);
  }
  return { min, max };
}

interface BuiltFieldPatch {
  patch: IndexedMesh; // rotated (axis) frame
  flatZoneErrorBoundMm: number;
  errorBoundMm: number;
}

/** Offset + draft-close blockout in the rotated frame, returning the extracted
 * (rotated-frame) cavity fit-surface patch. Marching cubes is at iso = 0. */
async function buildBlockedCavityPatch(
  meshRot: IndexedMesh,
  cavitySet: Uint8Array,
  gapParams: InnerSurfaceGapParams,
  pitchMm: number,
  outlineRot: readonly Vec3[],
  roi: { min: Vec3; max: Vec3 },
  hooks?: CavityInnerSurfaceHooks,
): Promise<BuiltFieldPatch> {
  const bvh = buildBvh(meshRot);
  const pseudonormals = computePseudonormals(meshRot);

  const maxGapMm = Math.max(gapParams.marginalGapMm, gapParams.cementGapMm);
  const spec = offsetGridSpec({ min: roi.min, max: roi.max }, maxGapMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const sliceCells = nx * ny;

  // SKIRT_BAND (the h-crop): a cell whose FOOTPOINT is within this distance of
  // the outline is cropped to +Inf — cutting a thin, outline-shape-agnostic
  // band around the ENTIRE 3-D (non-planar, break-through) outline, so the
  // marching-cubes patch ends in a clean single loop a small distance inside
  // the outline; the skirt spans that band to the exact outline. Sized like the
  // crown's `cleanCutSlack` to clear the offset roll-over (radius ~ maxGap) plus
  // MC discretization.
  const skirtBandMm = maxGapMm + 3 * pitchMm;

  const grid = new Float32Array(cellCount);
  for (let z = 0; z < nz; z++) {
    const worldZ = origin[2] + z * pitchMm;
    const zBase = z * sliceCells;
    for (let iy = 0; iy < ny; iy++) {
      const worldY = origin[1] + iy * pitchMm;
      const rowBase = zBase + iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        const point: Vec3 = [origin[0] + ix * pitchMm, worldY, worldZ];
        const closest = signedClosestPoint(meshRot, bvh, pseudonormals, point);
        // PRECISE CROP: keep the cell ONLY when its footpoint lies on a CAVITY
        // triangle (the fit surface is the offset of the CAVITY surface
        // specifically — the surrounding intact tooth's offset is excluded, for
        // either taper sign — see this module's doc, difference #3).
        if (cavitySet[closest.triangleIndex] !== 1) {
          grid[rowBase + ix] = CROP_OUTSIDE;
          continue;
        }
        // Height field at the FOOTPOINT (on the cavity surface) — the P4 T3
        // lesson: constant along the normal through it, so it removes the
        // grid-vs-footpoint displacement term (see @errorBound).
        const h = distanceToClosedPolyline(closest.point, outlineRot);
        if (h < skirtBandMm) {
          grid[rowBase + ix] = CROP_OUTSIDE; // the skirt band around the outline
          continue;
        }
        grid[rowBase + ix] = closest.signedDistance - twoZoneGapField(h, gapParams);
      }
    }
    if (hooks?.checkCancel) await hooks.checkCancel();
    hooks?.onProgress?.(0.05 + 0.75 * ((z + 1) / nz)); // field grid: 0.05 -> 0.80
    if (z % SDF_SLICES_PER_YIELD === SDF_SLICES_PER_YIELD - 1) await yieldToEventLoop();
  }

  // BLOCKOUT: per-column running minimum from the top DOWN — G[z] = min(F[z],
  // G[z+1]) — draft-closing the cavity void along +Z (= the insertion / lift-out
  // axis). VERIFIED-identical to the crown direction (see this module's doc):
  // it fills a negative-taper undercut (tooth above / void below) and leaves a
  // drafted wall unchanged. `+Inf` (cropped) cells never lower a real value, so
  // they are inert to the running min.
  for (let z = nz - 2; z >= 0; z--) {
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
 * Builds the full inlay/onlay inner (fit) surface (two-zone cement-gap offset
 * off the cavity surface + solid undercut blockout + skirt-to-outline) — see
 * this module's doc for the formulation, the VERIFIED draft-close direction,
 * the outline-distance crop, and @errorBound. `mesh` is the FULL closed tooth-
 * with-cavity solid. Returns an OPEN patch whose single boundary loop == the
 * cavity-outline polyline.
 *
 * Deterministic: same mesh + params -> byte-identical output.
 *
 * @throws {TypeError} for invalid pitch/gaps/spacer/outline/axis.
 * @throws {PitchTooSmallError} / {BlendWidthTooNarrowError} / {NonWatertightMeshError}
 * / {SdfGridTooLargeError} / {EmptyOffsetResultError} / {NoBoundaryLoopError}.
 */
export async function buildCavityInnerSurface(
  mesh: IndexedMesh,
  params: CavityInnerSurfaceParams,
  hooks?: CavityInnerSurfaceHooks,
): Promise<CavityInnerSurfaceResult> {
  validateParams(params);
  const { pitchMm, marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm, cavityOutline, insertionAxis } = params;
  const gapParams: InnerSurfaceGapParams = { marginalGapMm, cementGapMm, spacerStartMm, blendWidthMm };

  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0);

  // The CAVITY region enclosed by the outline (Task 2) — its triangles are the
  // exact footprint the fit surface is the offset of. `classifyCavityRegions`
  // runs on the ORIGINAL mesh + outline + axis; `rotateMesh` preserves triangle
  // indices, so `cavitySet` applies unchanged in the rotated frame.
  const regions = classifyCavityRegions(mesh, cavityOutline, insertionAxis);
  const triCount = mesh.indices.length / 3;
  const cavitySet = new Uint8Array(triCount);
  for (const t of regions.cavity.triangleIndices) cavitySet[t] = 1;

  const frame: AxisFrame = axisFrame(insertionAxis);
  const axisUnit = frame.w;

  // Rotate the tooth solid + outline so the insertion axis is +Z.
  const meshRot = rotateMesh(mesh, frame);
  const outlineRot: Vec3[] = cavityOutline.map((p) => applyR(frame, p));

  const roi = cavityRegionBboxAxisFrame(meshRot, cavitySet);
  hooks?.onProgress?.(0.05);

  const built = await buildBlockedCavityPatch(meshRot, cavitySet, gapParams, pitchMm, outlineRot, roi, hooks);
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

  // Skirt the patch boundary onto the EXACT (deduplicated) cavity-outline points
  // — the finished boundary loop then == the outline polyline (margin fit -> 0).
  const outlineDedup = dedupLoop(cavityOutline, MARGIN_DEDUP_EPSILON_MM);
  // ARC-LENGTH skirt pairing (not the crown's index pairing): the break-through
  // MOD outline is non-planar, so index pairing fabricates skirt triangles that
  // span the proximal-U notch (facing-undercut). See SkirtPairing's doc.
  const { mesh: combined, skirtTriangleCount } = skirtToMargin(patchWorld, outlineDedup, axisUnit, 'arcLength');

  // Consistently orient (patch + skirt are one component), then flip the whole
  // surface OUTWARD (into the void, away from the tooth) if its axis-most
  // triangle (the floor) points inward — the offset patch's MC winding is
  // outward, so the reference triangle fixes the global sign deterministically.
  const oriented = orientNormalsConsistently(combined).mesh;
  const finalMesh = flipOutwardIfNeeded(oriented, axisUnit);
  const stats = analyzeMesh(finalMesh);
  hooks?.onProgress?.(1);

  return {
    mesh: finalMesh,
    stats,
    errorBoundMm: built.errorBoundMm,
    flatZoneErrorBoundMm: built.flatZoneErrorBoundMm,
    marginVertexCount: outlineDedup.length,
    patchTriangleCount,
    skirtTriangleCount,
    marginalGapMm,
    cementGapMm,
    spacerStartMm,
    blendWidthMm,
    pitchMm,
  };
}
