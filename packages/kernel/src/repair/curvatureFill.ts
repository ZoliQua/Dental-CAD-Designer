// packages/kernel/src/repair/curvatureFill.ts
//
// Curvature-continuity pass for fillSmallHoles (Phase 2 Task 11): a discrete
// thin-plate (bi-Laplacian) fairing solve over one hole's ear-clip-refined
// patch, replacing the Phase 1 fixed-lambda Laplacian relax as the DEFAULT
// path (that relax survives here only as a documented, rare fallback — see
// below). Reuses curvature/cotan.ts's per-halfedge cotan weight ("built for
// THIS task's thin-plate solve", per that file's module doc) as the
// discrete Laplace-Beltrami operator's edge weights.
//
// ## Discretization
//
// For one filled loop, build a LOCAL mesh = the loop's ear-clip-refined fan
// triangulation (the new interior — centroid + chord-midpoint — vertices,
// see fillSmallHoles.ts) UNION every pre-existing triangle of the
// surrounding mesh incident to any boundary-loop vertex (the "one ring of
// surrounding context" the task brief calls for — this is what lets the
// solve see the surrounding surface's actual curvature, not just a flat
// ring). Every node in this local mesh is one of:
//
//   - INTERIOR (free/unknown): the patch's new centroid/chord-midpoint
//     vertices.
//   - BOUNDARY LOOP (fixed): the hole's original boundary vertices — shared
//     with the rest of the mesh, never moved (same "boundary ring stays
//     fixed" convention fillSmallHoles.ts's module doc already documents).
//   - CONTEXT (fixed): the loop's one-ring neighbors in the surrounding
//     mesh, beyond the loop itself — never moved (real, pre-existing mesh
//     vertices), but their POSITIONS are what carry the surrounding
//     surface's curvature into the solve, via the boundary loop's
//     Laplacian value.
//
// Discrete Laplacian at a local-mesh vertex v: `(Lf)_v = sum_j w_vj (f_j -
// f_v)`, cotan weights `w_vj` (`computeCotanWeights`, symmetric per
// undirected edge). The bending energy minimized is `sum_{v in INTERIOR
// union BOUNDARY LOOP} (Lf)_v^2` — the discrete bi-Laplacian (thin-plate)
// energy, restricted to rows whose full one-ring is actually present in the
// local mesh (true for exactly those two sets — see below) — over the
// INTERIOR unknowns, with BOUNDARY LOOP and CONTEXT positions held fixed
// (Dirichlet). This is linear least squares in the free (interior)
// unknowns: `E(f_free) = sum_row (c_row . f_free + k_row)^2`, `c_row` a
// row's coefficients on the free variables, `k_row` that row's contribution
// from fixed neighbors' current positions. Minimized by the normal
// equations `(C^T C) f_free = -C^T k`.
//
// Why only INTERIOR/BOUNDARY-LOOP rows contribute energy: a CONTEXT
// vertex's own one-ring typically reaches beyond this local mesh (its
// neighbors further out in the surrounding surface, which this function
// does not load) — its Laplacian value can't be computed correctly here, so
// it never appears as an energy-minimized ROW, only as a fixed VALUE
// feeding other rows. A BOUNDARY LOOP vertex's one-ring, by contrast, IS
// fully present: every original triangle it touches is included (context
// triangles are "every triangle incident to ANY loop vertex"), and every
// new patch triangle it touches is included (the loop's own fan
// triangulation) — so its full one-ring, and therefore its Laplacian value,
// is exact.
//
// ## Solver: dense Gaussian elimination, partial pivoting
//
// `C^T C` is `numFree x numFree` (`numFree` = this loop's interior vertex
// count — for the default `maxBoundaryEdges` of 32, at most ~2*32-5 = 59,
// see fillSmallHoles.ts's ear-clip-fan construction: one centroid per ear
// triangle plus one midpoint per interior chord). A DIRECT dense solve
// (Gaussian elimination, partial pivoting) is therefore cheap
// (O(numFree^3) on a <=~60x60 matrix) and, crucially, DETERMINISTIC — no
// iterative-with-tolerance solver whose convergence path could vary across
// platforms (CLAUDE.md invariant 2 / this task's guardrail: "The thin-plate
// solve must be DETERMINISTIC ... fixed ordering, direct solve"). Partial
// pivoting picks, at each elimination step, the FIRST row (lowest index)
// among those attaining the maximum absolute value in the current pivot
// column — both "first" and "maximum absolute value" are total orders over
// a fixed-size array, so this is bit-for-bit reproducible for identical
// input. A caller passing a much larger `maxBoundaryEdges` accepts the
// correspondingly larger, still-deterministic, O(numFree^3) cost — no
// additional cap is imposed here (that budget is exactly what
// `maxBoundaryEdges` already governs).
//
// A tiny fixed Tikhonov term (`REGULARIZATION_EPS`, added to the matrix
// diagonal) guards against a near-singular system for a pathological patch
// shape (e.g. an almost-degenerate ear triangle) — negligible relative to
// the ~5 degree seam-angle acceptance threshold this solve targets (see
// fillSmallHoles.test.ts), documented rather than silently relied upon.
//
// ## Fallback
//
// If the combined local mesh (patch + context triangles) is itself
// non-manifold-edge (`buildHalfedge` throws `NonManifoldEdgeError` — e.g.
// the hole's surrounding neighborhood is ALSO already damaged, a
// pathological/rare case for real intake'd meshes — `buildHalfedge` is
// normally run upstream of repair and would already have rejected such a
// mesh), this function reports `solved: false` and the caller
// (fillSmallHoles.ts) falls back to the plain fixed-lambda Laplacian relax
// (the Phase 1 behavior) for that ONE loop only — a documented, defensive
// degrade-gracefully path, not a silent skip (the result is still
// watertight/manifold, just not curvature-continuous for that specific
// loop; `FillSmallHolesReport.curvatureFallbackLoopCount` surfaces this).
//
// **Bowtie-adjacent context — closed upstream (Fix batch, post-Task-11)**:
// if a BOUNDARY LOOP or CONTEXT vertex is itself a bowtie vertex
// (`findNonManifoldVertices`, halfedge/build.ts), its one-ring within the
// local mesh can be INCOMPLETE-but-not-rejected (`buildHalfedge` does not
// reject bowtie vertices — see that function's doc), silently
// under-weighting that row's energy term rather than failing loudly. This
// function itself still has no defense against that (it trusts its caller's
// loop/context inputs) — the fix lives in the CALLER: `fillSmallHoles.ts`
// now runs `findNonManifoldVertices` once per call and REFUSES (skips, with
// reason `'bowtie-adjacent'`) any loop whose boundary+context vertex set
// contains a bowtie vertex, so `solveCurvaturePatch` is never actually
// invoked with one — see that file's "Bowtie-adjacent context" module-doc
// section. `splitNonManifoldVertices.ts` remains the underlying fix a user
// applies to un-refuse such a loop.
//
// @approximation This is a LINEARIZED thin-plate energy (cotan-weighted
// graph bi-Laplacian, not a true continuous PDE solve) over a FIXED patch
// topology (the ear-clip fan triangulation is not itself re-optimized) — it
// produces a G1-ish (tangent-plane-continuous-ish) blend whose actual seam
// quality is a MEASURED, not derived, property (see
// fillSmallHoles.test.ts's dihedral-angle assertion for the quantified
// bound this repo targets).
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge, NonManifoldEdgeError } from '../halfedge/build.ts';
import { oneRingOutgoingHalfedges, destinationVertex } from '../halfedge/iterate.ts';
import { computeCotanWeights } from '../curvature/cotan.ts';

type Vec3 = readonly [number, number, number];

/** Diagonal stabilizer added to `C^T C` before solving — see this file's
 * module doc "Solver" section. Dimensional analysis: a cotan weight is
 * cos(angle)/sin(angle), i.e. a dot product divided by a cross-product
 * magnitude — both length^2 (mm^2) for a mesh embedded in mm — so the mm^2
 * factors cancel and every weight is UNITLESS; `C^T C`'s entries (sums of
 * products of such weights) are therefore unitless too, and this constant,
 * added directly to that unitless diagonal, is correctly unitless as well —
 * negligible against any real patch's actual diagonal terms regardless of
 * the patch's physical size. */
const REGULARIZATION_EPS = 1e-9;

export interface CurvaturePatchInput {
  /** Original (pre-fill) mesh — supplies CONTEXT triangles (every triangle
   * incident to a boundary-loop vertex). Never mutated. */
  mesh: IndexedMesh;
  /** This loop's boundary vertices, in loop order (global vertex ids). */
  loop: readonly number[];
  /** This loop's new ear-clip-fan triangles (global vertex id triples),
   * generation order. */
  patchTriangles: readonly (readonly [number, number, number])[];
  /** This loop's new interior (centroid/chord-midpoint) vertex ids —
   * exactly the free unknowns — in CREATION order (deterministic column
   * ordering; see fillSmallHoles.ts's `thisLoopInterior`, a `Set` whose
   * iteration order is insertion order). */
  interiorIds: readonly number[];
  getPos: (v: number) => Vec3;
  setPos: (v: number, p: Vec3) => void;
  /** Original-mesh vertex -> incident ORIGINAL triangle indices, ascending
   * triangle-index order — built ONCE per `fillSmallHoles` call (not per
   * loop), see that file. */
  vertexTriangles: ReadonlyMap<number, readonly number[]>;
}

export interface CurvaturePatchResult {
  /** `false` when the local patch+context mesh could not be built as a
   * valid halfedge structure (see module doc's "Fallback" section) — the
   * caller keeps the ear-clip-only positions and applies its own fallback
   * relax instead; `solveCurvaturePatch` never partially writes positions
   * in that case. */
  solved: boolean;
}

/**
 * Solves one loop's curvature-continuity patch in place (via `setPos` on
 * its `interiorIds`) — see this file's module doc for the discretization
 * and solver.
 */
export function solveCurvaturePatch(input: CurvaturePatchInput): CurvaturePatchResult {
  const { mesh, loop, patchTriangles, interiorIds, getPos, setPos, vertexTriangles } = input;

  // --- 1. Local vertex id remap (deterministic insertion order) ---------
  const localOf = new Map<number, number>();
  function localId(global: number): number {
    let id = localOf.get(global);
    if (id === undefined) {
      id = localOf.size;
      localOf.set(global, id);
    }
    return id;
  }
  for (const [a, b, c] of patchTriangles) {
    localId(a);
    localId(b);
    localId(c);
  }

  const contextTriangleIds = new Set<number>();
  for (const v of loop) {
    const incident = vertexTriangles.get(v);
    if (!incident) continue;
    for (const t of incident) contextTriangleIds.add(t);
  }
  const contextTriangles = [...contextTriangleIds].sort((a, b) => a - b);
  for (const t of contextTriangles) {
    const base = t * 3;
    localId(mesh.indices[base]!);
    localId(mesh.indices[base + 1]!);
    localId(mesh.indices[base + 2]!);
  }

  const nodeCount = localOf.size;
  const localPositions = new Float64Array(nodeCount * 3);
  for (const [global, local] of localOf) {
    const p = getPos(global);
    localPositions[local * 3] = p[0];
    localPositions[local * 3 + 1] = p[1];
    localPositions[local * 3 + 2] = p[2];
  }
  const localIndices: number[] = [];
  for (const [a, b, c] of patchTriangles) {
    localIndices.push(localId(a), localId(b), localId(c));
  }
  for (const t of contextTriangles) {
    const base = t * 3;
    localIndices.push(localId(mesh.indices[base]!), localId(mesh.indices[base + 1]!), localId(mesh.indices[base + 2]!));
  }
  const localMesh: IndexedMesh = { positions: localPositions, indices: Uint32Array.from(localIndices) };

  let hm;
  try {
    hm = buildHalfedge(localMesh);
  } catch (error) {
    if (error instanceof NonManifoldEdgeError) return { solved: false };
    throw error;
  }
  const weights = computeCotanWeights(hm, localMesh);

  // --- 2. free/fixed partition, row set S = interior ++ boundary loop ---
  const freeIndexOfLocal = new Map<number, number>();
  for (const v of interiorIds) freeIndexOfLocal.set(localId(v), freeIndexOfLocal.size);
  const numFree = freeIndexOfLocal.size;

  const rowLocalIds: number[] = [...interiorIds, ...loop].map((v) => localId(v));

  const ata = Array.from({ length: numFree }, () => new Float64Array(numFree));
  const atkX = new Float64Array(numFree);
  const atkY = new Float64Array(numFree);
  const atkZ = new Float64Array(numFree);

  for (const vLocal of rowLocalIds) {
    const rowCoeffs = new Float64Array(numFree);
    let knownX = 0;
    let knownY = 0;
    let knownZ = 0;
    let selfWeightSum = 0;

    for (const he of oneRingOutgoingHalfedges(hm, vLocal)) {
      const j = destinationVertex(hm, he);
      const w = weights[he]!;
      selfWeightSum += w;
      const freeJ = freeIndexOfLocal.get(j);
      if (freeJ !== undefined) {
        rowCoeffs[freeJ]! += w;
      } else {
        knownX += w * localPositions[j * 3]!;
        knownY += w * localPositions[j * 3 + 1]!;
        knownZ += w * localPositions[j * 3 + 2]!;
      }
    }

    const freeSelf = freeIndexOfLocal.get(vLocal);
    if (freeSelf !== undefined) {
      rowCoeffs[freeSelf]! += -selfWeightSum;
    } else {
      knownX += -selfWeightSum * localPositions[vLocal * 3]!;
      knownY += -selfWeightSum * localPositions[vLocal * 3 + 1]!;
      knownZ += -selfWeightSum * localPositions[vLocal * 3 + 2]!;
    }

    for (let i = 0; i < numFree; i++) {
      const ci = rowCoeffs[i]!;
      if (ci === 0) continue;
      atkX[i]! -= ci * knownX;
      atkY[i]! -= ci * knownY;
      atkZ[i]! -= ci * knownZ;
      const rowI = ata[i]!;
      for (let j = 0; j < numFree; j++) {
        const cj = rowCoeffs[j]!;
        if (cj !== 0) rowI[j]! += ci * cj;
      }
    }
  }

  for (let i = 0; i < numFree; i++) ata[i]![i]! += REGULARIZATION_EPS;

  const solvedX = solveDense(ata.map((r) => Float64Array.from(r)), atkX);
  const solvedY = solveDense(ata.map((r) => Float64Array.from(r)), atkY);
  const solvedZ = solveDense(ata.map((r) => Float64Array.from(r)), atkZ);

  for (const [global, local] of localOf) {
    const freeIdx = freeIndexOfLocal.get(local);
    if (freeIdx === undefined) continue;
    setPos(global, [solvedX[freeIdx]!, solvedY[freeIdx]!, solvedZ[freeIdx]!]);
  }

  return { solved: true };
}

/**
 * Dense Gaussian elimination with partial pivoting — solves `A x = b` for a
 * square `A` (`A`'s rows are mutated in place; each call above passes a
 * FRESH row-copy of `ata`, since the 3 axes share the same matrix).
 * Deterministic (fixed elimination order, first-row-wins pivot tie-break) —
 * see this file's module doc "Solver" section.
 */
function solveDense(a: Float64Array[], b: Float64Array): Float64Array {
  const n = a.length;
  const rhs = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(a[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(a[row]![col]!);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = row;
      }
    }
    if (pivotRow !== col) {
      const tmpRow = a[col]!;
      a[col] = a[pivotRow]!;
      a[pivotRow] = tmpRow;
      const tmpB = rhs[col]!;
      rhs[col] = rhs[pivotRow]!;
      rhs[pivotRow] = tmpB;
    }
    const pivot = a[col]![col]!;
    if (Math.abs(pivot) < 1e-300) continue; // fully degenerate column (shouldn't happen given regularization)
    for (let row = col + 1; row < n; row++) {
      const factor = a[row]![col]! / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) a[row]![k] = a[row]![k]! - factor * a[col]![k]!;
      rhs[row] = rhs[row]! - factor * rhs[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row]!;
    for (let k = row + 1; k < n; k++) sum -= a[row]![k]! * x[k]!;
    const diag = a[row]![row]!;
    x[row] = Math.abs(diag) < 1e-300 ? 0 : sum / diag;
  }
  return x;
}
