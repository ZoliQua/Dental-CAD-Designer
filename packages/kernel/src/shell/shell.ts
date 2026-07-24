// packages/kernel/src/shell/shell.ts
//
// Phase 4 Task 7 — CROWN SHELL construction + wall-thickness measurement +
// auto-thicken. Turns the morphed outer anatomy (Task 6) and the intaglio
// inner surface (Task 4) into a SINGLE WATERTIGHT crown shell, measures the
// minimum wall thickness across it, and (on explicit request) thickens
// walls that fall below the material minimum.
//
// ## The shell join — outer + inner joined at the margin band (the seam)
//
// The crown shell is topologically a hollow solid (genus 0): the OUTER
// anatomy surface is its exterior, the INNER intaglio surface is its
// interior (the fit surface that seats on the die), and the two are joined
// along the MARGIN — the crown's finish-line edge. Both surfaces are open:
//
//   • the outer anatomy is an occlusally-capped dome whose single open
//     boundary is its CERVICAL rim (near the margin);
//   • the inner intaglio (buildInnerSurface, Task 4) is an occlusally-capped
//     cup whose single open boundary IS the confirmed margin polyline (the
//     skirt's bottom rim — the ≤10 µm marginal seal).
//
// `constructShell` bridges those two rims with a MARGIN-BAND ribbon (the
// seam): a ruled annulus stitched by the same deterministic azimuth-fraction
// zipper `offset/innerSurfaceSolid.ts`'s skirt uses (advance whichever ring
// is behind in normalized arc-position; strictly monotone, so it never
// backtracks and is robust to a jagged marching-cubes intaglio rim whose
// per-vertex azimuth is non-monotone). This generalizes `margin/band.ts`'s
// `marginLoopMesh` (a ribbon between a loop and its OWN normal-offset copy)
// to a ribbon between the TWO DISTINCT rims a real crown has — the outer
// cervical rim and the inner margin rim, which are generally different loops
// (different vertex counts, offset by the marginal wall thickness), so a
// fixed ±h collar cannot bridge them.
//
// ## Consuming the CLOSED morphed tooth (the pipeline connection)
//
// The outer anatomy from Task 6 (`anatomy/morph.ts`) is a CLOSED watertight
// solid — it inherits the placed library tooth's topology — so it has no open
// cervical rim. `constructShell` detects a closed outer (zero boundary loops)
// and TRIMS it to an open-cervical dome first (`trimClosedOuterToMargin`): a
// ROBUST PLANE CLIP (Sutherland–Hodgman, splitting crossed triangles with
// manifold-consistent shared split vertices) keeping the occlusal half-space of
// the plane a small offset (`marginTrimOffsetMm`) OCCLUSAL to the finish line ⟂
// the insertion axis. The offset is what makes the trim robust on a REAL
// morphed outer whose cervical surface wiggles across the exact margin plane
// (Task 12b: a cut AT the finish line fragments into many loops; a cut a hair
// above lands on the clean axial wall → one rim). Only the OUTER is cut; the
// inner intaglio is stitched to its EXACT margin rim, so the ≤10 µm marginal
// seal is preserved untouched (the shell's finish-line edge IS the inner's
// margin rim, and the seam band forms the small marginal collar). This — with
// the Task-12b `healOuterAnatomy` heal that removes the RBF's self-intersections
// upstream — is what lets the real pipeline run closed morphed tooth →
// watertight crown shell. A caller may still pass a hand-built OPEN dome (one
// rim already) — the trim is skipped.
//
// The stitched surface is a closed 2-manifold; it is then passed through the
// manifold-3d wrapper (`boolean/manifold.ts`'s `cleanupMesh`) — which
// CONSTRUCTS a manifold-3d `Manifold` (validating the oriented-2-manifold
// invariant and collapsing degenerate slivers the stitch may create) and
// returns the cleaned solid. `cleanupMesh` THROWS `NonManifoldInputError`
// if the stitched mesh is not a valid closed 2-manifold, so a non-watertight
// stitch can never masquerade as a shell — and `constructShell` additionally
// re-runs `analyzeMesh` on the RESULT and throws `ShellNotWatertightError`
// unless it is watertight and single-component. (Repair-before-boolean: the
// stitch is watertight BY CONSTRUCTION, so no intake repair is needed before
// the wrapper; a caller feeding a topologically broken outer/inner gets a
// loud typed failure, never a silent bad shell.)
//
// ## Determinism across the WASM boundary
//
// The stitch is pure Float64 and deterministic; the ONLY nondeterminism risk
// is the manifold-3d Float32 round-trip inside `cleanupMesh`, whose output
// hash depends on the manifold-3d WASM BUILD (not just the inputs). Same
// inputs + same manifold-3d version ⇒ byte-identical shell (proven by the
// determinism test); a manifold-3d build change is caught by the
// manifoldVersion-guarded golden (test/golden/kernel-ops.test.ts), NOT
// mistaken for a kernel regression.
//
// ## Wall-thickness measurement (fail-safe: never silently pass a thin wall)
//
// `measureWallThickness` measures the minimum wall thickness as the
// closest-point distance BETWEEN the inner and outer surfaces. Two distinct
// error sources, handled separately so the gate stays fail-safe:
//
//   1. THROUGH-MATERIAL vs straight-line. The straight-line nearest-surface
//      distance is a LOWER BOUND on the true through-material wall thickness
//      (any path through the wall is at least as long as the straight-line
//      gap) — so along THIS dimension the measure over-reports thinness. NB
//      this lower-bound property is specifically about the through-material
//      dimension; it does NOT cover the sampling error below.
//   2. DISCRETE SAMPLING. Sampling only at vertices could MISS a thin spot
//      mid-triangle (the distance field is 1-Lipschitz, so a between-samples
//      point can be below the sampled min by up to the sample spacing — the
//      DANGEROUS direction: the gate could over-report the minimum and pass a
//      sub-threshold wall). This is defended in TWO layers: (a) every triangle
//      of BOTH surfaces is GRID-SAMPLED at ≤ `maxSampleSpacingMm` (default
//      0.1 mm, a fifth of the 0.5 mm minimum), not just at vertices, so the
//      residual gap is small and bounded; and (b) the achieved spacing is
//      reported as `sampleSpacingMm`, which `minWallThicknessGate` SUBTRACTS
//      from the measured minimum before comparing to the threshold — so a wall
//      that could be thinner than the threshold WITHIN sampling error fails.
//
// @errorBound The pointwise distance is EXACT Float64 (bvh/closestPoint is
// exact closest-point-on-triangle, no Float32 anywhere here — the shell mesh
// this measures is the manifold-3d OUTPUT, but the thickness scan runs on the
// Float64 inner/outer INPUT surfaces, not through manifold-3d). The residual
// approximation is the sampling gap `sampleSpacingMm` (≤ `maxSampleSpacingMm`,
// or larger only where the per-triangle subdivision cap binds — reported
// honestly), which the gate folds into pass/fail as above and surfaces to the
// QC report.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { MeshStats } from '../intake/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint, closestPointBatch } from '../bvh/closestPoint.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { orthonormalBasis } from '../axis/hemisphere.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { cleanupMesh } from '../boolean/manifold.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the outer anatomy or inner surface does not present exactly
 * one usable open boundary loop to stitch (a closed mesh has none; a badly
 * cropped one may have several). The shell join expects an OPEN outer dome
 * (single cervical rim) and an OPEN inner cup (single margin rim); anything
 * else is a loud typed failure, never a silently unsealed shell. */
export class ShellBoundaryError extends Error {
  constructor(which: 'outer' | 'inner', loopCount: number) {
    super(
      `constructShell: the ${which} surface has ${loopCount} boundary loop(s); the shell join needs exactly one open rim to ` +
        `stitch (an OPEN ${which === 'outer' ? 'occlusally-capped anatomy dome (cervical rim)' : 'intaglio cup (margin rim)'}).`,
    );
    this.name = 'ShellBoundaryError';
  }
}

/** Thrown when the constructed shell, AFTER the manifold-3d cleanup pass,
 * fails re-validation (not watertight, or more than one connected
 * component). A false "watertight" claim on a QC-gated solid is the worst
 * possible outcome (CLAUDE.md invariant 4), so this fails loudly with the
 * measured stats rather than returning a bad shell. */
export class ShellNotWatertightError extends Error {
  readonly stats: MeshStats;
  constructor(stats: MeshStats) {
    super(
      `constructShell: the constructed shell is not a watertight single-component solid after manifold cleanup ` +
        `(watertight=${stats.watertight}, manifoldEdges=${stats.manifoldEdges}, boundaryEdgeCount=${stats.boundaryEdgeCount}, ` +
        `componentCount=${stats.componentCount}) — refusing to return a non-watertight shell.`,
    );
    this.name = 'ShellNotWatertightError';
    this.stats = stats;
  }
}

// ---------------------------------------------------------------------------
// constructShell
// ---------------------------------------------------------------------------

export interface ConstructShellParams {
  /** Insertion axis (crown draw direction), points occlusally — normalized
   * internally. Gives the azimuth zipper a stable rotation axis for measuring
   * each rim's arc-position, and (for a CLOSED outer) the trim direction. */
  readonly insertionAxis: Vec3;
  /** The confirmed margin loop (dense polyline). REQUIRED when the OUTER
   * anatomy is a CLOSED solid (the morphed library tooth, Task 6 output) —
   * the outer is trimmed to an open-cervical dome at this margin BEFORE
   * stitching (see this module's doc, "Consuming the CLOSED morphed tooth").
   * Ignored when the outer already presents a single open cervical rim (a
   * hand-built dome). */
  readonly marginLoop?: readonly Vec3[];
  /** Height (mm) of the marginal trim band: the CLOSED outer is plane-clipped
   * at a plane `marginTrimOffsetMm` OCCLUSAL to the finish line (default
   * {@link DEFAULT_MARGIN_TRIM_OFFSET_MM}). A small positive offset is what
   * makes the trim ROBUST on a real morphed outer: the cervical surface of an
   * RBF-morphed (or SDF-re-meshed) tooth wiggles ACROSS the exact margin plane
   * (some non-anchor cervical vertices move sub-margin), so a cut AT the finish
   * line fragments into many tiny loops; a cut a hair above it lands on the
   * clean, monotone axial wall and yields ONE cervical rim. The seam band then
   * bridges that rim DOWN to the intaglio's EXACT margin rim, so the finish-line
   * seal is untouched (only the outer is cut, above the margin). See
   * `trimClosedOuterToMargin`'s `@errorBound`. Ignored for an already-open
   * outer. */
  readonly marginTrimOffsetMm?: number;
}

export interface ConstructShellHooks {
  /** Fraction in [0, 1] at phase boundaries. */
  readonly onProgress?: (fraction: number) => void;
  /** Awaited at phase boundaries — should THROW to cancel. Affects no
   * computed value (byte-identity contract). */
  readonly checkCancel?: () => Promise<void>;
}

export interface ConstructShellResult {
  /** The watertight crown shell (manifold-3d cleaned). A NEW immutable mesh. */
  readonly mesh: IndexedMesh;
  readonly stats: MeshStats;
  /** Triangles in the margin-band seam ribbon (outer rim ↔ inner rim). */
  readonly seamTriangleCount: number;
  readonly outerRimVertexCount: number;
  readonly innerRimVertexCount: number;
  /** Shell volume, mm³ (signed volume from analyzeMesh; always > 0 here). */
  readonly volumeMm3: number;
  /** The OUTER surface actually stitched — the trimmed open-cervical dome when
   * the input outer was a closed solid, else the input outer verbatim. This
   * (NOT the un-trimmed closed tooth, whose sub-margin cap sits coplanar with
   * the margin and reads a spurious 0-thickness shelf) is what
   * `measureWallThickness` must be run against. */
  readonly outerUsedMesh: IndexedMesh;
}

function normalizeAxis(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) throw new TypeError('constructShell: insertionAxis must be a non-zero vector');
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Ordered vertex-index boundary loops (map each halfedge boundary loop to
 * its destination vertices — mirrors innerSurfaceSolid.ts's
 * `boundaryVertexLoops`). */
function boundaryVertexLoops(mesh: IndexedMesh): number[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) => loop.map((he) => destinationVertex(hm, he)));
}

/** The single open rim of `mesh` to stitch: the boundary loop with the most
 * vertices (the main opening). Throws {@link ShellBoundaryError} if there is
 * none. Extra small loops (if any) are left for the manifold cleanup to
 * reject as boundary — a loud failure, never a silent hole. */
function pickRim(mesh: IndexedMesh, which: 'outer' | 'inner'): number[] {
  const loops = boundaryVertexLoops(mesh);
  if (loops.length === 0) throw new ShellBoundaryError(which, 0);
  let best = loops[0]!;
  for (const l of loops) if (l.length > best.length) best = l;
  return best;
}

function meshVertex(mesh: IndexedMesh, i: number): Vec3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}

/** Thrown when the OUTER anatomy is a closed solid but no `marginLoop` was
 * supplied to trim it to — the pipeline's morphed tooth is closed, so the
 * shell stage must pass the confirmed margin (CLAUDE.md invariant 7: it is a
 * required input, never guessed). */
export class ShellClosedOuterNeedsMarginError extends Error {
  constructor() {
    super(
      'constructShell: the outer anatomy is a CLOSED solid (a morphed library tooth) but no marginLoop was supplied ' +
        'to trim it to an open-cervical dome — pass params.marginLoop (the confirmed margin polyline).',
    );
    this.name = 'ShellClosedOuterNeedsMarginError';
  }
}

/** Default marginal trim band height (mm) — see `ConstructShellParams.
 * marginTrimOffsetMm`. 0.05 mm (50 µm) is small enough to be a negligible
 * marginal collar yet reliably clears the cervical wiggle band of a morphed /
 * SDF-re-meshed outer (empirically robust across the morph + heal + control
 * closed-outer cases). Algorithmic (a trim resolution), not clinical — kept in
 * the kernel like {@link DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM}. */
export const DEFAULT_MARGIN_TRIM_OFFSET_MM = 0.05;

/**
 * Trims a CLOSED outer anatomy solid (the morphed library tooth — closed
 * because it inherits the placed library tooth's watertight topology, see
 * anatomy/morph.ts) to an OPEN-CERVICAL dome by a ROBUST PLANE CLIP: keeps the
 * OCCLUSAL half-space of the plane through `marginCentroid + offsetMm · axis`
 * ⟂ the insertion axis, SPLITTING every triangle the plane crosses (new edge-
 * intersection vertices are keyed by the sorted endpoint-index pair, so the two
 * triangles sharing a cut edge get the BIT-IDENTICAL split vertex — the cut is
 * 2-manifold, never a T-junction) and compacting to the surviving vertices. The
 * kept surface is the crown's outer contour with a single clean open cervical
 * rim; `constructShell` then stitches that rim to the inner intaglio's exact
 * margin rim, so the intaglio (and its ≤10 µm marginal seal) is preserved
 * UNTOUCHED — only the outer is cut, ABOVE the finish line. Deterministic.
 *
 * ## Why the OFFSET (not a cut at the finish line)
 *
 * An RBF-morphed (or SDF-re-meshed) closed tooth does NOT present a clean ring
 * at the finish-line plane: the morph pins the cervical seal but non-anchor
 * cervical vertices between the pins move, some sub-margin, so the surface
 * WIGGLES across the exact margin plane — a cut there fragments into many tiny
 * boundary loops (measured: 18 loops on the diagnostic morph), which the stitch
 * cannot seal (the earlier centroid-discard trim hit the SAME wall — a barely-
 * moved cap flips from discarded to kept). Cutting a hair (`offsetMm`) occlusal
 * to the finish line lands on the clean, monotone axial wall → exactly ONE
 * cervical rim → a watertight stitch. The seam band spans the small (`offsetMm`-
 * tall) gap DOWN to the EXACT margin rim, forming the marginal collar.
 *
 * A plane through the margin CENTROID (not a per-point staircase) keeps the cut
 * a single clean loop even for a non-planar margin.
 *
 * @errorBound The outer anatomy WITHIN `offsetMm` of the finish line is not
 * reproduced from the morphed surface; it is replaced by the ruled seam band
 * (a straight ribbon from the trimmed rim to the exact margin rim). So the
 * outer shape is approximated over a marginal band of height ≤ `offsetMm`
 * (default 50 µm). This is ABOVE the finish line and OUTWARD of the intaglio —
 * it never perturbs the fit surface or the ≤10 µm seal (measured: the confirmed
 * margin points stay on the shell surface to ≤10 µm). Surfaced by the shell
 * stage as the marginal-band trim height.
 */
function trimClosedOuterToMargin(
  outer: IndexedMesh,
  marginLoop: readonly Vec3[],
  axisUnit: Vec3,
  offsetMm: number,
): IndexedMesh {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of marginLoop) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const n = marginLoop.length;
  cx /= n;
  cy /= n;
  cz /= n;
  // Plane point = margin centroid pushed OCCLUSALLY by offsetMm along the axis.
  const px = cx + axisUnit[0] * offsetMm;
  const py = cy + axisUnit[1] * offsetMm;
  const pz = cz + axisUnit[2] * offsetMm;

  const pos = outer.positions;
  const idx = outer.indices;
  const vCount = pos.length / 3;
  const triCount = idx.length / 3;

  // Signed distance of every vertex to the trim plane (occlusal side ≥ 0).
  const sd = new Float64Array(vCount);
  for (let v = 0; v < vCount; v++) {
    sd[v] = (pos[v * 3]! - px) * axisUnit[0] + (pos[v * 3 + 1]! - py) * axisUnit[1] + (pos[v * 3 + 2]! - pz) * axisUnit[2];
  }

  const keptPositions: number[] = [];
  const keepRemap = new Int32Array(vCount).fill(-1);
  const keepVertex = (v: number): number => {
    if (keepRemap[v] === -1) {
      keepRemap[v] = keptPositions.length / 3;
      keptPositions.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    }
    return keepRemap[v]!;
  };
  // Edge-intersection vertices, keyed by the SORTED endpoint pair so both
  // triangles sharing a cut edge resolve to the identical new vertex (manifold).
  const edgeVertex = new Map<number, number>();
  const splitVertex = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * vCount + hi;
    const existing = edgeVertex.get(key);
    if (existing !== undefined) return existing;
    const da = sd[lo]!;
    const db = sd[hi]!;
    const s = da / (da - db); // da, db straddle 0 ⇒ s ∈ (0, 1)
    const nv = keptPositions.length / 3;
    keptPositions.push(
      pos[lo * 3]! + (pos[hi * 3]! - pos[lo * 3]!) * s,
      pos[lo * 3 + 1]! + (pos[hi * 3 + 1]! - pos[lo * 3 + 1]!) * s,
      pos[lo * 3 + 2]! + (pos[hi * 3 + 2]! - pos[lo * 3 + 2]!) * s,
    );
    edgeVertex.set(key, nv);
    return nv;
  };

  const keptIndices: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const tri = [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!];
    // Sutherland–Hodgman clip of the triangle against the plane (keep ≥ 0),
    // preserving the original winding order.
    const poly: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const da = sd[a]!;
      const db = sd[b]!;
      if (da >= 0) poly.push(keepVertex(a));
      if (da >= 0 !== db >= 0) poly.push(splitVertex(a, b));
    }
    if (poly.length < 3) continue;
    // Fan-triangulate the kept (convex, since a triangle ∩ half-space is convex)
    // polygon.
    for (let k = 1; k + 1 < poly.length; k++) {
      keptIndices.push(poly[0]!, poly[k]!, poly[k + 1]!);
    }
  }
  return { positions: new Float64Array(keptPositions), indices: Uint32Array.from(keptIndices) };
}

/**
 * Builds the margin-band seam: a ruled annulus stitching the outer rim
 * (indices into `outer`) to the inner rim (indices into `inner`), returning
 * the COMBINED (outer verts, then inner verts) mesh with the outer + inner
 * triangles + the seam triangles. Both rims encircle the insertion axis; the
 * zipper advances whichever ring is behind in normalized arc-position (i/M vs
 * j/N) — strictly monotone, deterministic. Rings are first oriented CCW
 * around the axis and aligned at their nearest-azimuth start so the pairing
 * never crosses.
 */
function stitchMarginBand(
  outer: IndexedMesh,
  outerRim: number[],
  inner: IndexedMesh,
  innerRim: number[],
  axisUnit: Vec3,
): { mesh: IndexedMesh; seamTriangleCount: number } {
  const outerV = outer.positions.length / 3;
  const positions = new Float64Array(outer.positions.length + inner.positions.length);
  positions.set(outer.positions, 0);
  positions.set(inner.positions, outer.positions.length);

  const op = (i: number): Vec3 => meshVertex(outer, i);
  const ip = (i: number): Vec3 => meshVertex(inner, i);

  // Common center + tangent basis (from the inner/margin rim — the sealed,
  // clinically-anchored loop) for a consistent azimuth of both rings.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const vi of innerRim) {
    const p = ip(vi);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= innerRim.length;
  cy /= innerRim.length;
  cz /= innerRim.length;
  const { u, v } = orthonormalBasis(axisUnit);
  const projUV = (p: Vec3): [number, number] => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
  };
  const az = (p: Vec3): number => {
    const [pu, pv] = projUV(p);
    return Math.atan2(pv, pu);
  };
  const signedArea = (idxs: number[], get: (i: number) => Vec3): number => {
    let a = 0;
    const n = idxs.length;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = projUV(get(idxs[k]!));
      const [x1, y1] = projUV(get(idxs[(k + 1) % n]!));
      a += x0 * y1 - x1 * y0;
    }
    return a * 0.5;
  };

  const outerOrder = [...outerRim];
  if (signedArea(outerOrder, op) < 0) outerOrder.reverse();
  let innerOrder = [...innerRim];
  if (signedArea(innerOrder, ip) < 0) innerOrder.reverse();

  // Align the inner ring's start to the outer ring's start (nearest azimuth).
  const a0 = az(op(outerOrder[0]!));
  let startK = 0;
  let bestDiff = Infinity;
  for (let k = 0; k < innerOrder.length; k++) {
    let d = Math.abs(az(ip(innerOrder[k]!)) - a0);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < bestDiff) {
      bestDiff = d;
      startK = k;
    }
  }
  innerOrder = [...innerOrder.slice(startK), ...innerOrder.slice(0, startK)];

  const M = outerOrder.length;
  const N = innerOrder.length;
  const innerVi = (idx: number): number => outerV + innerOrder[idx % N]!;

  // Combined triangles: outer + inner (re-indexed) + seam.
  const seamTris: number[] = [];
  let i = 0;
  let j = 0;
  while (i < M || j < N) {
    const oCur = outerOrder[i % M]!;
    const iCur = innerVi(j);
    const advanceO = j >= N || (i < M && (i + 1) / M <= (j + 1) / N);
    if (advanceO) {
      const oNext = outerOrder[(i + 1) % M]!;
      seamTris.push(oCur, iCur, oNext);
      i++;
    } else {
      const iNext = innerVi(j + 1);
      seamTris.push(oCur, iNext, iCur);
      j++;
    }
  }

  const indices = new Uint32Array(outer.indices.length + inner.indices.length + seamTris.length);
  indices.set(outer.indices, 0);
  for (let t = 0; t < inner.indices.length; t++) indices[outer.indices.length + t] = inner.indices[t]! + outerV;
  indices.set(seamTris, outer.indices.length + inner.indices.length);

  return { mesh: { positions, indices }, seamTriangleCount: seamTris.length / 3 };
}

/** Flips every triangle's winding (in place on a copy) — used to pin the
 * shell to outward orientation (positive signed volume). */
function flipWinding(mesh: IndexedMesh): IndexedMesh {
  const idx = mesh.indices.slice();
  for (let t = 0; t < idx.length / 3; t++) {
    const tmp = idx[t * 3 + 1]!;
    idx[t * 3 + 1] = idx[t * 3 + 2]!;
    idx[t * 3 + 2] = tmp;
  }
  return { positions: mesh.positions, indices: idx };
}

/**
 * Constructs the watertight crown shell from the outer anatomy + inner
 * intaglio, joined at the margin band — see this module's doc for the full
 * construction, the manifold-wrapper validation, and the determinism story.
 * Deterministic: same inputs + same manifold-3d version ⇒ byte-identical shell.
 *
 * @throws {ShellBoundaryError} if the outer/inner surface lacks a single open rim.
 * @throws {ShellClosedOuterNeedsMarginError} if the outer is a closed solid
 * but no `marginLoop` was supplied to trim it to.
 * @throws {NonManifoldInputError} (from the wrapper) if the stitched surface
 * is not a valid closed 2-manifold.
 * @throws {ShellNotWatertightError} if the cleaned shell is not a watertight
 * single-component solid.
 */
export async function constructShell(
  outerMesh: IndexedMesh,
  innerMesh: IndexedMesh,
  params: ConstructShellParams,
  hooks?: ConstructShellHooks,
): Promise<ConstructShellResult> {
  const axisUnit = normalizeAxis(params.insertionAxis);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0);

  // Consuming the CLOSED morphed tooth: the outer anatomy from Task 6 is a
  // watertight solid (it inherits the placed library tooth's topology), so it
  // has NO open cervical rim to stitch. Trim it to an open-cervical dome at
  // the confirmed margin first — only the outer is cut; the inner intaglio
  // (and its ≤10 µm seal) is left untouched, so the shell's finish-line edge
  // is the inner's exact margin rim. A hand-built OPEN dome (already one rim)
  // skips the trim.
  const outerIsClosed = boundaryVertexLoops(outerMesh).length === 0;
  let outerForStitch = outerMesh;
  if (outerIsClosed) {
    if (!params.marginLoop || params.marginLoop.length < 3) {
      throw new ShellClosedOuterNeedsMarginError();
    }
    const trimOffsetMm = params.marginTrimOffsetMm ?? DEFAULT_MARGIN_TRIM_OFFSET_MM;
    outerForStitch = trimClosedOuterToMargin(outerMesh, params.marginLoop, axisUnit, trimOffsetMm);
  }

  const outerRim = pickRim(outerForStitch, 'outer');
  const innerRim = pickRim(innerMesh, 'inner');
  hooks?.onProgress?.(0.15);

  const { mesh: stitched, seamTriangleCount } = stitchMarginBand(outerForStitch, outerRim, innerMesh, innerRim, axisUnit);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.4);

  // One connected component (outer + seam + inner) — make it consistently
  // oriented, then pin to OUTWARD (positive signed volume) so the manifold
  // wrapper and every downstream consumer see one deterministic global sign.
  const oriented = orientNormalsConsistently(stitched).mesh;
  const orientedStats = analyzeMesh(oriented);
  const outwardOriented =
    orientedStats.signedVolumeMm3 !== null && orientedStats.signedVolumeMm3 < 0 ? flipWinding(oriented) : oriented;
  hooks?.onProgress?.(0.55);

  // Re-validate + clean via the manifold-3d wrapper. Throws
  // NonManifoldInputError if the stitch is not a valid closed 2-manifold.
  const shell = await cleanupMesh(outwardOriented);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.9);

  const stats = analyzeMesh(shell);
  if (!stats.watertight || stats.componentCount !== 1) {
    throw new ShellNotWatertightError(stats);
  }
  hooks?.onProgress?.(1);

  return {
    mesh: shell,
    stats,
    seamTriangleCount,
    outerRimVertexCount: outerRim.length,
    innerRimVertexCount: innerRim.length,
    volumeMm3: stats.signedVolumeMm3 ?? 0,
    outerUsedMesh: outerForStitch,
  };
}

// ---------------------------------------------------------------------------
// Wall thickness
// ---------------------------------------------------------------------------

/** Cosine threshold classifying a wall sample as OCCLUSAL vs AXIAL: the wall
 * direction (sample → nearest point on the opposing surface) is occlusal
 * (measured along the insertion axis) if |direction · axis| ≥ this (≈ 45°). */
const OCCLUSAL_WALL_COS = Math.SQRT1_2;

/** Default target spacing (mm) between wall-thickness samples — a small
 * fraction of the 0.5 mm zirconia minimum, so the discrete-sampling gap the
 * gate subtracts as a fail-safe margin stays small. */
export const DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM = 0.1;

/** Cap on per-triangle grid subdivisions (bounds the sample count on very
 * large/coarse triangles; the achieved spacing is reported and may exceed the
 * target only when this cap binds — surfaced honestly). */
const MAX_THICKNESS_SUBDIV = 32;

export interface WallThicknessOptions {
  /** Insertion axis (occlusal direction) — required to classify occlusal vs
   * axial walls. Omit to classify everything as axial. */
  readonly insertionAxis?: Vec3;
  /** Confirmed margin polyline — samples within `marginExclusionMm` of it are
   * EXCLUDED from the minimum (the crown feathers to ~0 thickness at the
   * finish-line edge by design; that edge is a marginal-integrity concern,
   * not a wall-too-thin defect). Omit to include every sample. */
  readonly marginLoop?: readonly Vec3[];
  /** Distance (mm) from the margin polyline within which samples are excluded
   * (default 0 — no exclusion; a caller with a feather margin sets this). */
  readonly marginExclusionMm?: number;
  /** Target spacing (mm) between samples (default
   * {@link DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM}). Each triangle of BOTH
   * surfaces is grid-sampled at ≤ this spacing so a thin spot BETWEEN vertices
   * cannot be missed; the ACHIEVED spacing is reported as `sampleSpacingMm`
   * (the gate subtracts it as a fail-safe margin). */
  readonly maxSampleSpacingMm?: number;
}

export interface WallThicknessResult {
  /** Minimum wall thickness (mm) over all INCLUDED samples, both directions —
   * a conservative lower bound of the true through-material thickness. */
  readonly minThicknessMm: number;
  /** Minimum over occlusal-classified samples (Infinity if none). */
  readonly minOcclusalThicknessMm: number;
  /** Minimum over axial-classified samples (Infinity if none). */
  readonly minAxialThicknessMm: number;
  /** World position of the thinnest included sample. */
  readonly minPoint: Vec3;
  /** Included sample count (both surfaces). */
  readonly sampleCount: number;
  /** Samples excluded by the margin band. */
  readonly excludedCount: number;
  /** Per-INNER-vertex thickness (mm) — the heatmap over the intaglio; the
   * raw inner→outer distance at each inner vertex (excluded vertices keep
   * their true distance, not masked). Length = inner vertex count. */
  readonly perInnerVertexMm: Float64Array;
  /** Localization resolution (mm): the max sampled-vertex spacing — see the
   * module `@errorBound`. The distance VALUE is exact Float64. */
  readonly sampleSpacingMm: number;
  /** The measurement's error bound surfaced to the QC report — the sampling
   * resolution (`sampleSpacingMm`); the thickness value itself is exact and
   * conservative (a lower bound). */
  readonly errorBoundMm: number;
}

/**
 * Measures the crown-shell wall thickness as the inner↔outer closest-surface
 * distance. Each triangle of BOTH surfaces is GRID-SAMPLED at ≤
 * `maxSampleSpacingMm` (not just at vertices), so a thin spot between vertices
 * cannot slip through; the min is taken over both directions (the conservative
 * choice). The achieved sample spacing is reported so the gate can subtract it
 * as a fail-safe margin. See this module's doc + `@errorBound`. Pure,
 * deterministic, exact Float64 at each sampled point.
 */
export function measureWallThickness(
  innerMesh: IndexedMesh,
  outerMesh: IndexedMesh,
  options: WallThicknessOptions = {},
): WallThicknessResult {
  const axis = options.insertionAxis ? normalizeAxis(options.insertionAxis) : null;
  const marginLoop = options.marginLoop;
  const exclusion = options.marginExclusionMm ?? 0;
  const maxSpacing = options.maxSampleSpacingMm ?? DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM;
  const excluded = (p: Vec3): boolean =>
    marginLoop !== undefined && exclusion > 0 && distanceToClosedPolyline(p, marginLoop) < exclusion;

  const bvhOuter = buildBvh(outerMesh);
  const bvhInner = buildBvh(innerMesh);

  // Per-inner-vertex heatmap (vertex-resolution inner→outer distance).
  const innerVertRes = closestPointBatch(outerMesh, bvhOuter, innerMesh.positions);
  const perInnerVertexMm = new Float64Array(innerVertRes.length);
  for (let i = 0; i < innerVertRes.length; i++) perInnerVertexMm[i] = innerVertRes[i]!.distance;

  let minThicknessMm = Infinity;
  let minOcclusalThicknessMm = Infinity;
  let minAxialThicknessMm = Infinity;
  let minPoint: Vec3 = [0, 0, 0];
  let sampleCount = 0;
  let excludedCount = 0;
  let achievedSpacingMm = 0;

  const consider = (sample: Vec3, near: readonly [number, number, number], dist: number): void => {
    if (excluded(sample)) {
      excludedCount++;
      return;
    }
    sampleCount++;
    if (dist < minThicknessMm) {
      minThicknessMm = dist;
      minPoint = sample;
    }
    // Occlusal iff the wall direction (sample → nearest opposing point) runs
    // along the insertion axis.
    let occlusal = false;
    if (axis) {
      const dx = near[0] - sample[0];
      const dy = near[1] - sample[1];
      const dz = near[2] - sample[2];
      const len = Math.hypot(dx, dy, dz);
      if (len > 0) {
        const dot = Math.abs((dx * axis[0] + dy * axis[1] + dz * axis[2]) / len);
        occlusal = dot >= OCCLUSAL_WALL_COS;
      }
    }
    if (occlusal) {
      if (dist < minOcclusalThicknessMm) minOcclusalThicknessMm = dist;
    } else if (dist < minAxialThicknessMm) {
      minAxialThicknessMm = dist;
    }
  };

  // Grid-sample every triangle of `source` at ≤ maxSpacing and query the
  // opposite surface. Shared edges/vertices are re-sampled across adjacent
  // triangles — harmless for a MINIMUM.
  const sampleSurface = (source: IndexedMesh, oppMesh: IndexedMesh, oppBvh: ReturnType<typeof buildBvh>): void => {
    const triCount = source.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = source.indices[t * 3]!;
      const ib = source.indices[t * 3 + 1]!;
      const ic = source.indices[t * 3 + 2]!;
      const a = meshVertex(source, ia);
      const b = meshVertex(source, ib);
      const c = meshVertex(source, ic);
      const eAB = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const eBC = Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]);
      const eCA = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const longest = Math.max(eAB, eBC, eCA);
      const n = Math.min(MAX_THICKNESS_SUBDIV, Math.max(1, Math.ceil(longest / maxSpacing)));
      if (longest / n > achievedSpacingMm) achievedSpacingMm = longest / n;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const wa = i / n;
          const wb = j / n;
          const wc = 1 - wa - wb;
          const p: Vec3 = [a[0] * wa + b[0] * wb + c[0] * wc, a[1] * wa + b[1] * wb + c[1] * wc, a[2] * wa + b[2] * wb + c[2] * wc];
          const cp = closestPoint(oppMesh, oppBvh, p);
          consider(p, cp.point, cp.distance);
        }
      }
    }
  };

  sampleSurface(innerMesh, outerMesh, bvhOuter);
  sampleSurface(outerMesh, innerMesh, bvhInner);

  if (sampleCount === 0) {
    minThicknessMm = Infinity;
  }

  return {
    minThicknessMm,
    minOcclusalThicknessMm,
    minAxialThicknessMm,
    minPoint,
    sampleCount,
    excludedCount,
    perInnerVertexMm,
    sampleSpacingMm: achievedSpacingMm,
    errorBoundMm: achievedSpacingMm,
  };
}

// ---------------------------------------------------------------------------
// autoThicken
// ---------------------------------------------------------------------------

/** Default overshoot factor — each pass pushes `overshoot ×` the measured
 * deficit. A vertex-displacement thickening leaves the TRIANGULATED surface
 * (and the opposing surface's own vertices) slightly short of the target
 * between moved vertices — most acutely opposite a convex intaglio corner,
 * whose nearest-outer distance a single outward nudge cannot fully raise; a
 * >1 overshoot clears that discretization gap (over-thickening, bounded by
 * `maxDisplacementMm`, is clinically safe — thicker walls are stronger). */
export const AUTO_THICKEN_DEFAULT_OVERSHOOT = 1.5;
/** Default number of deterministic convergence passes. */
export const AUTO_THICKEN_DEFAULT_PASSES = 5;

export interface AutoThickenParams {
  /** The target minimum wall thickness (mm) — from the material profile
   * (NEVER defaulted in kernel/pipeline code). Thin regions are pushed to
   * meet this. */
  readonly minThicknessMm: number;
  /** Maximum TOTAL outward displacement (mm) applied to any outer vertex
   * (accumulated over passes) — bounds the correction so a grossly-thin
   * design cannot be silently ballooned (a clamped vertex is reported, not
   * hidden). */
  readonly maxDisplacementMm: number;
  /** Overshoot factor (default {@link AUTO_THICKEN_DEFAULT_OVERSHOOT}). */
  readonly overshoot?: number;
  /** Convergence passes (default {@link AUTO_THICKEN_DEFAULT_PASSES}). */
  readonly passes?: number;
  /** Margin polyline — vertices within `marginExclusionMm` of it are NOT
   * displaced (the feather edge is left intact). */
  readonly marginLoop?: readonly Vec3[];
  readonly marginExclusionMm?: number;
}

export interface AutoThickenResult {
  /** The thickened OUTER anatomy (a NEW mesh; same topology, some vertices
   * displaced outward). Feed this back through `constructShell`. */
  readonly mesh: IndexedMesh;
  /** Outer vertices actually displaced. */
  readonly displacedVertexCount: number;
  /** Largest displacement applied (mm). */
  readonly maxAppliedMm: number;
  /** Vertices whose needed correction EXCEEDED `maxDisplacementMm` and were
   * clamped — their wall may still be below target after thickening (a
   * WARNING the caller journals, never a silent success). */
  readonly clampedVertexCount: number;
}

/**
 * User-invoked, bounded auto-thicken: pushes each OUTER-anatomy vertex whose
 * local wall thickness is below `minThicknessMm` outward (directly away from
 * its nearest point on the inner surface — the direction guaranteed to
 * increase the inner↔outer gap), by exactly the deficit, clamped to
 * `maxDisplacementMm`. Never thins anything; never runs silently (the caller
 * gates it behind an explicit user action and journals it — CLAUDE.md
 * invariant 5). Deterministic.
 *
 * @throws {TypeError} if `minThicknessMm`/`maxDisplacementMm` are not finite & > 0.
 */
export function autoThickenOuter(
  outerMesh: IndexedMesh,
  innerMesh: IndexedMesh,
  params: AutoThickenParams,
): AutoThickenResult {
  if (!(Number.isFinite(params.minThicknessMm) && params.minThicknessMm > 0)) {
    throw new TypeError(`autoThickenOuter: minThicknessMm must be finite and > 0, got ${params.minThicknessMm}`);
  }
  if (!(Number.isFinite(params.maxDisplacementMm) && params.maxDisplacementMm > 0)) {
    throw new TypeError(`autoThickenOuter: maxDisplacementMm must be finite and > 0, got ${params.maxDisplacementMm}`);
  }
  const overshoot = params.overshoot ?? AUTO_THICKEN_DEFAULT_OVERSHOOT;
  const passes = params.passes ?? AUTO_THICKEN_DEFAULT_PASSES;
  if (!(Number.isFinite(overshoot) && overshoot > 0)) {
    throw new TypeError(`autoThickenOuter: overshoot must be finite and > 0, got ${overshoot}`);
  }
  if (!(Number.isInteger(passes) && passes >= 1)) {
    throw new TypeError(`autoThickenOuter: passes must be an integer >= 1, got ${passes}`);
  }
  const marginLoop = params.marginLoop;
  const exclusion = params.marginExclusionMm ?? 0;
  const bvhInner = buildBvh(innerMesh);

  const origin = outerMesh.positions;
  const positions = outerMesh.positions.slice();
  const vCount = positions.length / 3;
  const excludedVertex = new Uint8Array(vCount);
  for (let v = 0; v < vCount; v++) {
    if (
      marginLoop !== undefined &&
      exclusion > 0 &&
      distanceToClosedPolyline([origin[v * 3]!, origin[v * 3 + 1]!, origin[v * 3 + 2]!], marginLoop) < exclusion
    ) {
      excludedVertex[v] = 1;
    }
  }

  // Deterministic convergence: each pass re-measures thickness to the FIXED
  // inner surface (BVH built once) and pushes (overshoot × remaining deficit)
  // outward, with each vertex's TOTAL displacement from its ORIGINAL position
  // capped at maxDisplacementMm.
  const everDisplaced = new Uint8Array(vCount);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < vCount; v++) {
      if (excludedVertex[v]) continue;
      const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
      const cp = closestPoint(innerMesh, bvhInner, p);
      const thickness = cp.distance;
      if (thickness >= params.minThicknessMm) continue;
      // Direction: directly away from the nearest inner point (increases the gap).
      let dx = p[0] - cp.point[0];
      let dy = p[1] - cp.point[1];
      let dz = p[2] - cp.point[2];
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0)) continue; // sits ON the inner surface — no safe direction
      dx /= len;
      dy /= len;
      dz /= len;
      const want = (params.minThicknessMm - thickness) * overshoot;
      const ox = origin[v * 3]!;
      const oy = origin[v * 3 + 1]!;
      const oz = origin[v * 3 + 2]!;
      const already = Math.hypot(p[0] - ox, p[1] - oy, p[2] - oz);
      const step = Math.max(0, Math.min(want, params.maxDisplacementMm - already));
      if (step <= 0) continue;
      positions[v * 3] = p[0] + dx * step;
      positions[v * 3 + 1] = p[1] + dy * step;
      positions[v * 3 + 2] = p[2] + dz * step;
      everDisplaced[v] = 1;
    }
  }

  // Report: displaced count, max TOTAL applied, and clamped (still below target
  // AND at the displacement bound — could not fully reach the floor).
  let displacedVertexCount = 0;
  let clampedVertexCount = 0;
  let maxAppliedMm = 0;
  for (let v = 0; v < vCount; v++) {
    if (!everDisplaced[v]) continue;
    displacedVertexCount++;
    const total = Math.hypot(
      positions[v * 3]! - origin[v * 3]!,
      positions[v * 3 + 1]! - origin[v * 3 + 1]!,
      positions[v * 3 + 2]! - origin[v * 3 + 2]!,
    );
    if (total > maxAppliedMm) maxAppliedMm = total;
    const cp = closestPoint(innerMesh, bvhInner, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
    if (cp.distance < params.minThicknessMm && total >= params.maxDisplacementMm - 1e-9) clampedVertexCount++;
  }

  return {
    mesh: { positions, indices: outerMesh.indices.slice() },
    displacedVertexCount,
    maxAppliedMm,
    clampedVertexCount,
  };
}
