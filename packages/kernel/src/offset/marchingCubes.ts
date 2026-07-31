// packages/kernel/src/offset/marchingCubes.ts
//
// Marching cubes over a regular scalar grid (the SDF grid sdf/grid.ts
// produces) at an arbitrary iso value — the extraction stage of Task 7's
// offset pipeline (offsetMesh.ts). Implemented from the standard published
// case tables (mcTables.ts — see that module's doc for the source citation,
// corner/edge conventions, and the documented variant limitations).
//
// ## Output: triangle SOUP, welded downstream
//
// `marchingCubesSlab`/`marchingCubes` emit an UNINDEXED triangle soup
// (9 Float64 values per triangle), not a shared-vertex mesh — vertex
// unification is `weldVertices`' job (intake/weld.ts), per the brief's
// pipeline (MC -> weld -> manifold cleanup). For welding to reproduce exact
// shared vertices, a vertex on a grid edge shared by up to 4 cells must be
// computed BIT-IDENTICALLY in every cell that emits it. Linear
// interpolation is symmetric mathematically but not in floating point
// (`p1 + mu*(p2-p1)` vs `p2 + mu'*(p1-p2)` can differ in the last ulp), so
// `interpolateVertex` below CANONICALIZES the endpoint order (always
// interpolating from the lower flat-grid-index corner to the higher) —
// every cell then evaluates the same expression over the same inputs, and
// weld's 1e-6 mm epsilon merges exact duplicates. This also makes the
// whole extraction bit-deterministic (same grid in, same soup out).
//
// ## +Infinity sentinel policy (banded grids, sdf/grid.ts's `bandMm`)
//
// A cell with ANY non-finite corner sample is skipped entirely — no
// triangle, no vertex, is ever generated from a sentinel-valued cell (this
// task's guardrail; asserted by marchingCubes.test.ts's deliberately-tight-
// band test). Why skipping cannot clip the iso surface when the caller's
// band is adequate: the signed distance field is 1-Lipschitz, and every
// cell the true iso surface `{f = iso}` intersects has all 8 corners within
// `pitch * sqrt(3)` (the cell diagonal) of some surface point, hence all
// corner values in `[iso - pitch*sqrt(3), iso + pitch*sqrt(3)]`. If the
// band satisfies `bandMm >= |iso| + pitch*sqrt(3)` (offsetMesh.ts uses
// `|iso| + OFFSET_BAND_MARGIN_PITCHES * pitch` with margin 3 > sqrt(3)),
// every such corner is inside the band and therefore finite — so a cell
// containing a sentinel corner provably does NOT intersect the iso surface,
// and skipping it drops nothing. (With an INADEQUATE band the output may be
// clipped/open — but still never reads a sentinel value into a vertex.)
//
// ## Winding
//
// Triangles are emitted so the mesh's normals point toward INCREASING field
// value — for this kernel's negative-inside SDF convention that is outward
// (CCW-from-outside, positive signed volume), matching `analyzeMesh`/
// manifold-3d's requirement. Verified empirically against an analytic
// sphere field (marchingCubes.test.ts asserts positive signed volume) —
// Bourke's tables with the `value < iso` corner classification emit
// triangles wound clockwise when viewed from the positive-field side, so
// each triple is emitted REVERSED (see `emitTriangles`).
//
// @errorBound See offsetMesh.ts's `@errorBound` for the full pipeline
// derivation. This stage's own contribution: each emitted vertex `v` lies
// on a grid edge whose exact-sampled endpoint values straddle `iso`;
// placing it by linear interpolation guarantees
// `|f(v) - iso| <= (pitch^2 - delta^2) / (2 * pitch) <= pitch / 2`
// (chord-deviation bound for a 1-Lipschitz `f` sampled exactly at the
// endpoints, `delta = |f(p2) - f(p1)|`) — plus the grid's Float32 storage
// quantization (~1.2e-7 relative, see sdf/grid.ts's module doc).
import type { Vec3 } from '../bvh/geometry.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { CORNER_OFFSETS, EDGE_CORNERS, EDGE_TABLE, TRI_TABLE } from './mcTables.ts';

/** Hard floor on `pitchMm` accepted anywhere in this module — see
 * `PitchTooSmallError`'s doc for why. About 2.3 orders of magnitude (200×)
 * below this project's clinical default (`DEFAULT_OFFSET_VOXEL_PITCH_MM`,
 * `clinical-profiles/`, 0.02 mm / 20 µm), and about 1.1 orders of magnitude
 * (12.5×) ABOVE the point (`4 * MESH_WELD_EPSILON_MM = 8e-6` mm) at which
 * `muClampEpsilon`'s second term alone would reach 0.5 and invert the valid
 * `[eps, 1-eps]` clamp range — so this floor rejects a misconfigured/degenerate
 * `pitchMm` with a clear typed error a modest margin before the clamp math
 * itself would start silently misbehaving, not right at the edge of where it
 * does. */
export const MIN_PITCH_MM = 1e-4;

/** Thrown by `muClampEpsilon` (and therefore every entry point that calls
 * it — `marchingCubesSlab`/`marchingCubes`, plus
 * kernel-workers/src/jobs/offset.ts's own per-slab driving of
 * `marchingCubesSlab`) when `pitchMm < MIN_PITCH_MM`. Below `MIN_PITCH_MM`,
 * `muClampEpsilon`'s `4 * MESH_WELD_EPSILON_MM / pitchMm` term grows without
 * bound and can reach or exceed 0.5, at which point the intended
 * `[eps, 1 - eps]` clamp range for `mu` becomes empty or inverted —
 * marching cubes would then silently misplace or degenerate edge vertices
 * instead of failing loudly, exactly the kind of silent-approximation-
 * failure this kernel's `@errorBound` discipline (CLAUDE.md's "never trade
 * precision for FPS" rule) exists to prevent. Rejecting outright at the
 * grid-construction boundary is strictly better than letting the pipeline
 * run and produce a mesh whose documented `@errorBound` no longer holds. */
export class PitchTooSmallError extends Error {
  constructor(pitchMm: number) {
    super(
      `marching cubes: pitchMm must be >= ${MIN_PITCH_MM} mm, got ${pitchMm} mm — below this floor, ` +
        `muClampEpsilon's weld-safety margin can reach/exceed the valid mu-clamp range and silently ` +
        `degrade output rather than failing (see MIN_PITCH_MM's doc)`,
    );
    this.name = 'PitchTooSmallError';
  }
}

/**
 * Lower bound on the interpolation parameter's distance from either edge
 * endpoint (`mu` is clamped to `[eps, 1 - eps]`, see `marchingCubesSlab`).
 *
 * Why: when the iso surface passes EXACTLY through a grid corner (mu = 0 or
 * 1 — a real occurrence for analytic/synthetic fields on lattice-aligned
 * geometry, e.g. a radius-1 sphere sampled on a 0.1-pitch lattice hits
 * (±1, 0, 0) exactly), every crossed edge incident to that corner emits its
 * vertex at the SAME point. The downstream weld then merges them, which
 * collapses cell triangles to degenerate slivers and pinches the surface
 * into non-manifold vertices/edges (measured empirically: 72 degenerate
 * triangles and non-manifold edges on the analytic sphere above). Clamping
 * `mu` keeps each edge's vertex a distinct point strictly inside its own
 * edge, preserving marching cubes' generic (watertight-by-construction)
 * combinatorics — the crossing TOPOLOGY is untouched (corner
 * classification, EDGE_TABLE lookup, and triangle emission are all
 * unchanged), only the vertex slides inward by at most `eps * pitch`.
 *
 * Value: `eps = max(1e-3, 4 * MESH_WELD_EPSILON_MM / pitch)`. The second
 * term guarantees the clamped vertex sits at least 4 weld epsilons
 * (4e-6 mm) from the corner, so vertices from distinct edges can never be
 * re-merged by the weld; the 1e-3 floor keeps the added positional error
 * proportional to pitch (at the 0.02 mm clinical default: 2e-5 mm =
 * 0.02 µm, three orders of magnitude below the pitch/2 = 10 µm bound —
 * see the `@errorBound` in this module's doc).
 */
export function muClampEpsilon(pitchMm: number): number {
  if (!(Number.isFinite(pitchMm) && pitchMm >= MIN_PITCH_MM)) {
    throw new PitchTooSmallError(pitchMm);
  }
  return Math.max(1e-3, (4 * MESH_WELD_EPSILON_MM) / pitchMm);
}

/** The scalar grid marching cubes consumes — structurally matches
 * sdf/grid.ts's `SampleSdfGridResult` (same flat x-fastest layout), with
 * `Float64Array` also accepted so analytic test fields don't have to
 * round-trip through Float32. */
export interface ScalarGrid {
  readonly grid: Float32Array | Float64Array;
  readonly dims: readonly [number, number, number];
  readonly origin: Vec3;
  readonly pitchMm: number;
}

/** Triangle soup produced by `marchingCubes`/`marchingCubesSlab`:
 * `positions` is 9 Float64 values per triangle (identical layout to
 * intake's `TriangleSoup.positions`, so it feeds `weldVertices` directly). */
export interface MarchingCubesSoup {
  readonly positions: Float64Array;
  readonly triangleCount: number;
}

/**
 * Runs marching cubes over ONE z-slab of cells (the cells between sample
 * layers `z` and `z + 1`; valid `z` is `0 .. dims[2] - 2`) — the primitive
 * both `marchingCubes` (below, synchronous whole-grid convenience) and
 * kernel-workers/src/jobs/offset.ts's worker job drive, so the two paths
 * produce byte-identical output (same primitive, same iteration order
 * within a slab; mirrors sdf/grid.ts's `computeSdfGridSlice` split).
 *
 * Returns the slab's triangle soup — see this module's doc for the soup
 * rationale, sentinel policy, winding, and determinism guarantees.
 */
export function marchingCubesSlab(scalarGrid: ScalarGrid, isoMm: number, z: number): MarchingCubesSoup {
  const { grid, dims, origin, pitchMm } = scalarGrid;
  const [nx, ny, nz] = dims;
  if (!(Number.isInteger(z) && z >= 0 && z <= nz - 2)) {
    throw new RangeError(`marchingCubesSlab: z must be an integer in [0, ${nz - 2}], got ${z}`);
  }

  // Accumulated as a plain number[] then converted once — a slab's output is
  // small (only surface-crossing cells emit), so intake/weld.ts's
  // typed-array-accumulation concern (multi-million fixed-size outputs)
  // doesn't apply; the output size here is unknown until scanned.
  const out: number[] = [];

  // Per-cell scratch, allocated once per slab (not per cell).
  const cornerValues = new Float64Array(8);
  const cornerFlat = new Int32Array(8);
  // 12 edge vertices * xyz — filled only for crossed edges each cell.
  const edgeVertices = new Float64Array(36);

  const strideY = nx;
  const strideZ = nx * ny;
  const muEps = muClampEpsilon(pitchMm);

  for (let iy = 0; iy <= ny - 2; iy++) {
    for (let ix = 0; ix <= nx - 2; ix++) {
      const baseFlat = z * strideZ + iy * strideY + ix;

      // Gather the 8 corner samples; skip the whole cell on the first
      // non-finite (sentinel) corner — see the module doc's sentinel policy.
      let cubeIndex = 0;
      let sentinel = false;
      for (let c = 0; c < 8; c++) {
        const [dx, dy, dz] = CORNER_OFFSETS[c]!;
        const flat = baseFlat + dx + dy * strideY + dz * strideZ;
        const value = grid[flat]!;
        if (!Number.isFinite(value)) {
          sentinel = true;
          break;
        }
        cornerFlat[c] = flat;
        cornerValues[c] = value;
        if (value < isoMm) cubeIndex |= 1 << c;
      }
      if (sentinel) continue;

      const crossedEdges = EDGE_TABLE[cubeIndex]!;
      if (crossedEdges === 0) continue; // fully inside or fully outside

      // Interpolate a vertex on every crossed edge, canonicalized so shared
      // edges are computed bit-identically in every adjacent cell (module
      // doc, "Output" section).
      for (let e = 0; e < 12; e++) {
        if ((crossedEdges & (1 << e)) === 0) continue;
        let [cA, cB] = EDGE_CORNERS[e]!;
        if (cornerFlat[cA]! > cornerFlat[cB]!) {
          const tmp = cA;
          cA = cB;
          cB = tmp;
        }
        const vA = cornerValues[cA]!;
        const vB = cornerValues[cB]!;
        // Denominator is nonzero: a crossed edge has exactly one endpoint
        // `< iso` and one `>= iso` (that is what EDGE_TABLE encodes), so
        // vA !== vB; mu lands in [0, 1] for the same reason. Clamped away
        // from the endpoints — see `muClampEpsilon`'s doc.
        let mu = (isoMm - vA) / (vB - vA);
        if (mu < muEps) mu = muEps;
        else if (mu > 1 - muEps) mu = 1 - muEps;
        const [ax, ay, az] = CORNER_OFFSETS[cA]!;
        const [bx, by, bz] = CORNER_OFFSETS[cB]!;
        edgeVertices[e * 3] = origin[0] + ((ix + ax) + mu * (bx - ax)) * pitchMm;
        edgeVertices[e * 3 + 1] = origin[1] + ((iy + ay) + mu * (by - ay)) * pitchMm;
        edgeVertices[e * 3 + 2] = origin[2] + ((z + az) + mu * (bz - az)) * pitchMm;
      }

      // Emit triangles, REVERSED relative to the table's listed order so
      // normals face outward (positive field side) — module doc, "Winding".
      const row = cubeIndex * 16;
      for (let k = 0; TRI_TABLE[row + k]! !== -1; k += 3) {
        const e0 = TRI_TABLE[row + k]!;
        const e1 = TRI_TABLE[row + k + 1]!;
        const e2 = TRI_TABLE[row + k + 2]!;
        out.push(
          edgeVertices[e0 * 3]!, edgeVertices[e0 * 3 + 1]!, edgeVertices[e0 * 3 + 2]!,
          edgeVertices[e2 * 3]!, edgeVertices[e2 * 3 + 1]!, edgeVertices[e2 * 3 + 2]!,
          edgeVertices[e1 * 3]!, edgeVertices[e1 * 3 + 1]!, edgeVertices[e1 * 3 + 2]!,
        );
      }
    }
  }

  return { positions: Float64Array.from(out), triangleCount: out.length / 9 };
}

/**
 * Synchronous whole-grid marching cubes: `marchingCubesSlab` looped over
 * every z-slab, concatenated — the direct entry point offsetMesh.ts and the
 * kernel-level tests use. kernel-workers/src/jobs/offset.ts drives the slab
 * loop itself instead (real async cancellation between slabs — same split
 * as sdf/grid.ts's `sampleSdfGrid` vs. jobs/sdf.ts).
 *
 * @errorBound See this module's doc and offsetMesh.ts's `@errorBound`.
 */
export function marchingCubes(scalarGrid: ScalarGrid, isoMm: number): MarchingCubesSoup {
  if (!Number.isFinite(isoMm)) {
    throw new TypeError(`marchingCubes: isoMm must be finite, got ${isoMm}`);
  }
  const nz = scalarGrid.dims[2];
  const slabs: MarchingCubesSoup[] = [];
  let totalTriangles = 0;
  for (let z = 0; z <= nz - 2; z++) {
    const slab = marchingCubesSlab(scalarGrid, isoMm, z);
    if (slab.triangleCount > 0) {
      slabs.push(slab);
      totalTriangles += slab.triangleCount;
    }
  }
  const positions = new Float64Array(totalTriangles * 9);
  let offset = 0;
  for (const slab of slabs) {
    positions.set(slab.positions, offset);
    offset += slab.positions.length;
  }
  return { positions, triangleCount: totalTriangles };
}
