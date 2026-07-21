// packages/kernel/src/blockout/blockoutPreview.ts
//
// Phase 3 Task 10: undercut blockout PREVIEW ("virtual wax").
//
// ## Scope boundary — DISPLAY-ONLY this phase (read before touching this file)
//
// This module produces a small, DISCONNECTED patch mesh that shows roughly
// where, and how much, material would need to be blocked out (filled with
// wax, in the lab analog this feature is named after) to eliminate undercut
// along a candidate insertion axis. It is:
//   - NOT a watertight solid (no boolean union with the prep/die — that
//     needs a proper offset-surface/SDF construction, not a raw per-vertex
//     displaced patch — see "@errorBound" below for exactly why this patch
//     cannot safely stand in for one).
//   - NEVER fed back into any other kernel geometry op — see
//     `BlockoutPreviewMesh`'s branding below (mirrors decimate.ts's
//     `RenderOnlyMesh`: nested one level down, so it does not structurally
//     match `IndexedMesh` and cannot be passed where a real mesh is
//     expected, at compile time).
//   - NOT editable (no brush/sculpt tools operate on it this phase).
//
// The REAL blockout is PLAN.md §5 Phase 4's job — a construction STEP of
// the inner-surface stage ("prep region inside margin → offset ... →
// undercut blockout relative to insertion axis → skirt to margin line"),
// unioned into a single watertight solid there. This module exists so the
// insertion-axis tool (Phase 3 Task 9) can show the clinician, DURING axis
// selection, roughly how much wax a candidate axis would require — pure
// decision-support, never a fabrication input this phase.
//
// ## Construction — sweep each undercut vertex to its own visibility horizon
//
// Two DIFFERENT granularities of the same underlying "how much solid stands
// in the way along `d`" quantity (undercut/undercutScan.ts's `depthMm`) are
// used here, deliberately:
//
// 1. **Triangle SELECTION** (which patch of the region needs blocking out
//    at all): `undercutScanIndices(mesh, bvh, d, region.triangleIndices)` —
//    the EXACT SAME triangle-level scan (sign convention, occlusion rule,
//    boundary-epsilon policy, sampling policy — see that module's top-of-
//    file doc, cited not re-derived here) the axis tool's own live undercut
//    heatmap already runs. A region triangle is SELECTED iff
//    `undercut[t] === 1 AND depthMm[t] > thresholdMm` (PLAN.md §3's
//    "Undercut blockout threshold" — see clinical-profiles'
//    `DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM`, 0 by default: any measurable
//    undercut needs blocking out, before this threshold is raised for a
//    coarser preview). Strict `>`: at the default 0mm threshold, a
//    triangle whose own `depthMm` measured exactly `0` (undercut BY FACING
//    only, ray found no occluding surface — undercutScan.ts's documented
//    "open boundary" case) has nothing this module can construct a horizon
//    FROM, so it is correctly excluded, not force-included at zero height.
//
// 2. **Vertex DISPLACEMENT** (how the selected patch's SHAPE actually
//    changes): for every UNIQUE vertex of every selected triangle, a FRESH,
//    independent depth sample is taken FROM THAT VERTEX'S OWN POSITION —
//    `sampleDepthAlongAxis(mesh, bvh, vertexPosition, d)` (undercut/
//    undercutScan.ts's public per-point primitive, the exact same biased
//    `+d` raycast `depthFromSample` uses for a triangle's own centroid/
//    corner samples, now reused at VERTEX granularity). The displaced
//    position is:
//
//      displacedVertex = originalVertex + d * depthAtVertex
//
//    This is NOT the same as translating the owning triangle rigidly by its
//    own (triangle-level) `depthMm` — that would leave the triangle's shape
//    AND NORMAL unchanged (still facing exactly as far away as before, just
//    relocated in space), which cannot eliminate undercut by construction.
//    Each vertex getting its OWN horizon distance is what lets the
//    displaced patch's local orientation actually change — the triangles
//    connecting three independently-displaced vertices generally acquire a
//    DIFFERENT normal than their un-displaced originals, tangent-or-outward
//    along `d` wherever the true horizon surface itself is smooth (proven
//    exactly, not just argued, on the tilted-cylinder analytic fixture —
//    see blockoutPreview.analytic.test.ts).
//
// ### Winding is REVERSED relative to the source triangles — a measured
// necessity, not a cosmetic choice
//
// For a smoothly-VARYING per-vertex depth field (the realistic case — see
// "@errorBound" below for the pathological case), sliding three vertices
// along the SAME direction `d` by DIFFERENT amounts is, to first order, a
// SHEAR of the local triangle, not a reflection — it does NOT by itself
// flip which way the triangle faces. Physically this is expected: the
// original undercut triangle's outward normal already satisfies `normal ·
// d < 0` (it faces AWAY from the withdrawal direction — that is what made
// it undercut); a shear-dominated displacement leaves that same sense
// intact. But the ROLE of this surface has changed: it no longer bounds the
// PREP (facing away from `d`, into the cavity) — it now bounds the newly
// added WAX FILL, whose outward face (away from the wax, into the now-open
// space above it) must satisfy `normal · d > 0`. Keeping the SOURCE
// triangles' winding therefore leaves the preview patch systematically
// INSIDE-OUT relative to the volume it is meant to represent — MEASURED
// directly (not merely argued): on the tilted-cylinder analytic fixture,
// re-scanning the un-flipped preview patch reports the SAME
// `undercutTriangleCount` as the source selection (every displaced triangle
// still "facing away", `depthMm` uniformly `0` since the isolated patch has
// nothing left to self-occlude), while re-scanning the SAME patch with each
// triangle's winding reversed (corners 1 and 2 swapped) reports ZERO
// undercut, exactly (see blockoutPreview.analytic.test.ts's "winding must
// be reversed" test for the measured numbers on both fixtures this task
// uses). This module reverses winding accordingly when building the output
// mesh below.
//
// ### Why "sweep to the visibility horizon" is the right description
//
// `depthFromSample`'s own contract (undercut/undercutScan.ts): for a sample
// point `p` on the undercut surface, `depth = RAY_ORIGIN_BIAS_MM +
// hit.distance`, where `hit` is the FIRST re-entry of `p`'s `+d`-biased ray
// into open space past the occluding solid. Because the ray's actual origin
// is `p + d * RAY_ORIGIN_BIAS_MM` and the reported `depth` adds that same
// bias back, the point `p + d * depth` is — up to the bias's own negligible
// magnitude (`RAY_ORIGIN_BIAS_MM = 1e-6` mm, undercut/undercutScan.ts's own
// doc) — EXACTLY the point where the `+d` ray first exits the solid: the
// first point, looking straight down the insertion axis from "above" (i.e.
// from `+d`-infinity), at which the surface becomes visible again. That is
// the visibility horizon, by definition. Displacing a vertex to exactly
// that point is exactly "fill with wax up to the roofline" — the displaced
// surface sits ON the horizon, not merely somewhere-past-the-solid.
//
// ## `@errorBound` — TWO independent, DOCUMENTED (not hidden) approximation
// sources; no fixed numeric bound
//
// This is fundamentally an approximation, same "no universal bound claimed"
// character as undercutScan.ts's own "Sampling policy" doc (cited, not
// re-derived) — TWO sources, not one:
//
// 1. **Selection error** — inherited verbatim from `undercutScanIndices`'s
//    own sampling-policy bound (a single centroid, or 4 corner+centroid,
//    samples per triangle; can miss a genuine partial occlusion whose
//    boundary crosses a triangle's interior between sampled points). Scales
//    with triangle size relative to the occluding feature's scale, same as
//    that module's own documented character.
//
// 2. **Displacement incoherence** — NEW to this module: because every
//    vertex's depth sample is an INDEPENDENT ray with no shared continuity
//    constraint, two adjacent vertices whose true horizons lie on
//    TOPOLOGICALLY UNRELATED parts of the mesh (e.g. either side of a sharp
//    "cliff edge" in the horizon surface, where an infinitesimal move of
//    the sample point flips which distant patch of geometry the ray first
//    reaches) can be displaced to two very different neighborhoods, even
//    though they started adjacent. There is NO global smoothness guarantee
//    on the resulting patch — this is a genuinely unbounded-in-the-worst-
//    case error, not merely a large constant. On a well-tessellated real
//    scan mesh with no undercut cavity narrower than the local triangle
//    size (this repo's normal dental-scan resolution), adjacent vertices'
//    horizons vary smoothly in practice and the preview reads as a coherent
//    wax patch (see blockoutPreview.analytic.test.ts's self-consistency
//    measurement for a concrete, MEASURED number) — but this is an
//    empirical observation on realistic geometry, not a formal guarantee.
//    This — not implementation laziness — is exactly WHY this module's
//    output is branded `BlockoutPreviewMesh` and stays display-only: a
//    fabrication-grade solid blockout (Phase 4) needs a construction that
//    IS globally smooth by design (an offset-surface/SDF sweep, matching
//    `offset/offsetMesh.ts`'s own documented, bounded error character), not
//    this preview's raw per-vertex raycast patch.
//
// 3. **Composite-interaction gap** — also NEW to this module, and DISTINCT
//    from (1)/(2) above: every self-consistency measurement this module
//    relies on (see blockoutPreview.analytic.test.ts, cited in (2) above)
//    re-scans the DISPLACED PATCH IN ISOLATION — it checks that the patch
//    doesn't occlude ITSELF. It never checks the other direction: whether
//    introducing the wax bulge changes occlusion for ORIGINAL-MESH
//    triangles OUTSIDE the selected region. A prep with a tight
//    adjacent-tooth contact or a tight opposing-wall clearance could have
//    its virtual wax bulge close that gap and create a NEW undercut (or a
//    new insertion collision) against geometry the region scan never
//    considered — this is a KNOWN, UNTESTED interaction, not merely an
//    unmeasured one. It is acceptable for THIS phase because the preview
//    is display-only decision support (see this module's top-of-file scope
//    boundary) — but it is explicitly NOT acceptable to carry into Phase
//    4's real solid blockout: that construction (PLAN.md §5's "prep region
//    inside margin → offset → undercut blockout relative to insertion axis
//    → skirt to margin line", unioned into a watertight solid) MUST account
//    for composite interaction with the surrounding case geometry — e.g. by
//    re-running the undercut/collision scan against the FULL case (target
//    scan + antagonist, not just the selected region) after the blockout
//    solid is unioned in, not only against the isolated patch. Flagging
//    this explicitly for whoever implements Phase 4's blockout stage.
//
// ## Determinism
//
// Pure function of `(mesh, bvh, region, directionUnit, thresholdMm,
// options)` — no randomness, no `Date.now()`, no worker-scheduling
// dependence (same invariant as every other kernel op — CLAUDE.md
// invariant 2).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { undercutScanIndices, sampleDepthAlongAxis, type UndercutSamplingPolicy } from '../undercut/undercutScan.ts';
import { triangleAreaMm2, triangleVertexPositions } from './vec.ts';

/**
 * A triangle-index SUBSET of a mesh (region to search for undercut over) —
 * deliberately a MINIMAL structural shape (not an import of
 * `axis/roi.ts`'s `AxisRegion`, to keep this module decoupled from the axis/
 * module — see this repo's "duplicate the trivial shape at a module
 * boundary" convention, e.g. state/axisStore.ts's own doc): any
 * `AxisRegion` (the ROI a caller typically already has, via
 * `extractMarginRegion`) satisfies this structurally, no adapter needed.
 */
export interface BlockoutRegion {
  readonly triangleIndices: Uint32Array | readonly number[];
}

/**
 * A display-only blockout preview mesh (this module's HARD INVARIANT — see
 * top-of-file "Scope boundary" doc: never a watertight solid, never fed
 * back into any other kernel geometry op). Deliberately NOT itself an
 * `IndexedMesh` — see `decimate.ts`'s `RenderOnlyMesh` doc for why nesting
 * the real mesh one level down (not merely adding a brand field) is what
 * makes TypeScript's structural typing actually reject this at a kernel op
 * boundary, at compile time, not just in a lint rule or a runtime check.
 */
export interface BlockoutPreviewMesh {
  readonly previewMesh: IndexedMesh;
}

/** Wraps a plain `IndexedMesh` as a `BlockoutPreviewMesh` — the one place
 * this module is allowed to assert "this mesh is preview-only from here
 * on". Exported so tests can construct one directly. */
export function toBlockoutPreviewMesh(mesh: IndexedMesh): BlockoutPreviewMesh {
  return { previewMesh: mesh };
}

export interface BlockoutPreviewOptions {
  /** Passed through to the triangle-SELECTION scan only (`undercutScanIndices`)
   * — see this module's top-of-file doc, point 1. Per-vertex displacement
   * sampling (point 2) is always a single point (a vertex IS a point;
   * `'corners'` has no meaning there). Default `'centroid'`, matching
   * `undercutScanIndices`'s own default. */
  sampling?: UndercutSamplingPolicy;
}

export interface BlockoutPreviewResult {
  mesh: BlockoutPreviewMesh;
  /** Normalized (same convention as `undercutScanIndices`'s own
   * `directionUnit`). */
  directionUnit: Vec3;
  thresholdMm: number;
  /** `region.triangleIndices.length` — informational (UI coverage
   * display). */
  regionTriangleCount: number;
  /** Count of region triangles that passed BOTH the undercut AND
   * `depthMm[t] > thresholdMm` selection tests (point 1 above). `0` iff the
   * preview mesh is empty (no-undercut / all-below-threshold case). */
  blockoutTriangleCount: number;
  /** Unique vertex count of the preview mesh (`0` iff
   * `blockoutTriangleCount === 0`). */
  vertexCount: number;
  /** Max per-vertex displacement DISTANCE actually applied, mm (`0` iff
   * `blockoutTriangleCount === 0`) — the deepest single wax point in the
   * preview. */
  maxDisplacementMm: number;
  /** Depth-weighted undercut area over the SELECTED triangles, mm^3 (sum of
   * `area(t) * depthMm[t]` — the SAME "how much wax, roughly" quantity
   * `axis/suggestInsertionAxis.ts`'s own `scoreMm3` reports, using the
   * TRIANGLE-level selection depth, not the vertex-level displacement — see
   * that module's doc for the physical interpretation). An APPROXIMATE UI
   * readout ("~X mm³ of material would need blocking out"), NOT a real
   * solid volume — this module produces no solid (see top-of-file "Scope
   * boundary"). `0` iff `blockoutTriangleCount === 0`. */
  approxVolumeMm3: number;
}

function validateMeshMatchesBvh(mesh: IndexedMesh, bvh: Bvh): void {
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount !== bvh.triangleCount) {
    throw new RangeError(
      `blockoutPreview: mesh has ${triangleCount} triangles but bvh was built for ${bvh.triangleCount} — this Bvh ` +
        `was not built from this mesh (or the mesh changed since).`,
    );
  }
}

function emptyResult(directionUnit: Vec3, thresholdMm: number, regionTriangleCount: number): BlockoutPreviewResult {
  return {
    mesh: toBlockoutPreviewMesh({ positions: new Float64Array(0), indices: new Uint32Array(0) }),
    directionUnit,
    thresholdMm,
    regionTriangleCount,
    blockoutTriangleCount: 0,
    vertexCount: 0,
    maxDisplacementMm: 0,
    approxVolumeMm3: 0,
  };
}

/**
 * `blockoutPreview(mesh, bvh, region, directionUnit, thresholdMm, options)`
 * — this task's brief describes the signature as `(mesh, region, axis,
 * thresholdMm)`; this module takes an already-built `bvh` as an explicit
 * parameter instead, for the SAME reason `undercutScan`'s own top-of-file
 * doc gives (undercut/undercutScan.ts's "API shape" note, cited not
 * re-derived): every sibling BVH-consuming kernel primitive in this repo
 * takes a pre-built `Bvh`, precisely so a caller running this alongside a
 * live undercut-heatmap recompute (the axis tool's own established
 * pattern) never rebuilds it.
 *
 * @throws {RangeError} if `bvh` wasn't built from `mesh`, or `thresholdMm`
 * is not a finite number.
 * @throws {TypeError} if `directionUnit` is the zero vector (surfaced by
 * the underlying `undercutScanIndices` call).
 */
export function blockoutPreview(
  mesh: IndexedMesh,
  bvh: Bvh,
  region: BlockoutRegion,
  directionUnit: Vec3,
  thresholdMm: number,
  options: BlockoutPreviewOptions = {},
): BlockoutPreviewResult {
  validateMeshMatchesBvh(mesh, bvh);
  if (!Number.isFinite(thresholdMm)) {
    throw new RangeError(`blockoutPreview: thresholdMm must be a finite number, got ${thresholdMm}`);
  }
  const sampling = options.sampling ?? 'centroid';

  const scan = undercutScanIndices(mesh, bvh, directionUnit, region.triangleIndices, { sampling });
  const d = scan.directionUnit;
  const regionTriangleCount = region.triangleIndices.length;

  // 1. Triangle SELECTION — see this module's top-of-file doc, point 1.
  const selectedLocal: number[] = [];
  for (let i = 0; i < regionTriangleCount; i++) {
    if (scan.undercut[i] === 1 && scan.depthMm[i]! > thresholdMm) {
      selectedLocal.push(i);
    }
  }
  if (selectedLocal.length === 0) {
    return emptyResult(d, thresholdMm, regionTriangleCount);
  }

  // 2. Gather the unique ORIGINAL-mesh vertex set of every selected
  // triangle, building a local (preview-mesh) index remap — and
  // accumulate the depth-weighted-area readout using the TRIANGLE-level
  // (selection-scan) depth, per this module's doc.
  const vertexRemap = new Map<number, number>(); // original vertex index -> local (preview) index
  const localToOriginal: number[] = [];
  const previewIndices = new Uint32Array(selectedLocal.length * 3);
  let approxVolumeMm3 = 0;
  for (let k = 0; k < selectedLocal.length; k++) {
    const i = selectedLocal[k]!;
    const t = region.triangleIndices[i]!;
    const [a, b, c] = triangleVertexPositions(mesh, t);
    approxVolumeMm3 += triangleAreaMm2(a, b, c) * scan.depthMm[i]!;
    // Corner order (0, 2, 1) — REVERSED relative to the source triangle's
    // own (0, 1, 2) winding — see this module's top-of-file "Winding is
    // REVERSED" doc for the measured reason: the displaced patch bounds the
    // newly added WAX, not the original cavity, and a smoothly-varying
    // displacement field does not itself flip a triangle's facing sense.
    const localOf = (corner: number): number => {
      const originalVertex = mesh.indices[t * 3 + corner]!;
      let local = vertexRemap.get(originalVertex);
      if (local === undefined) {
        local = localToOriginal.length;
        localToOriginal.push(originalVertex);
        vertexRemap.set(originalVertex, local);
      }
      return local;
    };
    previewIndices[k * 3] = localOf(0);
    previewIndices[k * 3 + 1] = localOf(2);
    previewIndices[k * 3 + 2] = localOf(1);
  }

  // 3. Per-UNIQUE-vertex displacement — see this module's top-of-file doc,
  // point 2 (independent horizon sample per vertex, not inherited from the
  // owning triangle).
  const vertexCount = localToOriginal.length;
  const previewPositions = new Float64Array(vertexCount * 3);
  let maxDisplacementMm = 0;
  for (let v = 0; v < vertexCount; v++) {
    const originalVertex = localToOriginal[v]!;
    const px = mesh.positions[originalVertex * 3]!;
    const py = mesh.positions[originalVertex * 3 + 1]!;
    const pz = mesh.positions[originalVertex * 3 + 2]!;
    const depth = sampleDepthAlongAxis(mesh, bvh, [px, py, pz], d);
    if (depth > maxDisplacementMm) maxDisplacementMm = depth;
    previewPositions[v * 3] = px + d[0] * depth;
    previewPositions[v * 3 + 1] = py + d[1] * depth;
    previewPositions[v * 3 + 2] = pz + d[2] * depth;
  }

  return {
    mesh: toBlockoutPreviewMesh({ positions: previewPositions, indices: previewIndices }),
    directionUnit: d,
    thresholdMm,
    regionTriangleCount,
    blockoutTriangleCount: selectedLocal.length,
    vertexCount,
    maxDisplacementMm,
    approxVolumeMm3,
  };
}
