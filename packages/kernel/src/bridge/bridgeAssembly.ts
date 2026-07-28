// packages/kernel/src/bridge/bridgeAssembly.ts
//
// Phase 6 Task 6 — the WHOLE-BRIDGE ASSEMBLY op. The abutment units, the pontic
// unit and the connectors are, up to this point, INDEPENDENT watertight closed
// solids (Task 2 abutment bodies, Task 3 pontic, Task 4 connector lofts, Task 5
// cut-back units). `assembleBridge` fuses them into ONE watertight, single-
// component solid — the geometry the whole-bridge QC (`runBridgeQc`) judges and
// the mill/printer receives.
//
// ## Why a boolean UNION here (and NOT a shared-ring weld like P5)
//
// Phase 5's `constructInlayShell` WELDED an intaglio patch and an occlusal patch
// along a SHARED margin RING: the two surfaces meet at one common boundary loop,
// so a topological stitch (shared vertices, no overlap) is exact and preserves
// every vertex's Float64 coordinates. A bridge is different: the connectors are
// GENUINELY SEPARATE solids that OVERLAP the unit bodies — a connector bar is
// lofted so its ends penetrate INTO the two units' proximal walls (there is no
// shared boundary loop to weld along; the surfaces interpenetrate in a volume).
// Fusing interpenetrating solids is exactly what a boolean UNION is for, and it
// is the ONLY correct operation: a weld cannot resolve the interior faces that
// fall inside the merged material, but the union does (it deletes the buried
// faces and re-triangulates the intersection curves into one closed shell). So
// this op goes through the manifold-3d wrapper's `union` (CLAUDE.md: booleans
// ONLY via the wrapper), fold-unioning every solid into one.
//
// ## Repair-before-boolean + output re-validation (the P4/P5 discipline)
//
//   1. BEFORE: every input is checked watertight (`analyzeMesh`) — the wrapper's
//      `union` rejects a non-watertight input with `NonManifoldInputError`, but we
//      check up front so the failure names WHICH solid and WHY (repair first, do
//      not bypass — CLAUDE.md).
//   2. FOLD: `acc = union(acc, next)` across all solids. Each `union` output is a
//      valid manifold-3d solid (watertight by construction), so the accumulator is
//      always a valid boolean input for the next fold.
//   3. AFTER: `analyzeMesh(result)` must report watertight + manifoldEdges +
//      componentCount === 1. A componentCount > 1 means the solids did NOT all
//      fuse (e.g. a connector that does not actually reach both units — a mis-
//      placed/disjoint connector) — surfaced LOUDLY as a typed `BridgeAssemblyError`
//      (`reason: 'disjoint'`, carrying the component count), NEVER returned as a
//      silent multi-body "solid". This is the falsifiable failure the tests drive.
//
// ## What the union does to the margin rims (the survive-assembly argument)
//
// The connectors attach on the PROXIMAL surfaces, occlusal to (well above) the
// cervical margin rim — the union's re-triangulation is LOCAL to the intersection
// curves where connector meets unit, nowhere near the intaglio/margin. Away from
// those curves manifold-3d preserves the input triangulation, so the fit surface
// and its margin boundary pass through unchanged EXCEPT for the one shared
// Float64→Float32 rounding at the WASM boundary (`boolean/manifold.ts` @errorBound:
// ~1.2e-7 relative, ~1e-4 mm absolute at the dental working scale). The whole-
// bridge QC RE-MEASURES the abutment margin fit on the assembled solid (via
// `extractFitPatch` below) to PROVE the rim survived ≤ 10 µm — it is measured, not
// assumed. `@errorBound` for this op is exactly the wrapper's WASM-boundary bound.
//
// ## Provenance on the assembled solid (the T5 fitVertexMask TODO, scoped)
//
// Task 5's `frameworkCutback` needs a per-vertex `fitVertexMask` — that mask is
// CONSTRUCTION PROVENANCE on a PRE-UNION unit (the cutback runs per unit BEFORE
// this assembly, where the shell's inner/outer vertex split is known). A manifold
// union does NOT preserve vertex identity (it merges/splits/re-indexes vertices at
// the intersection curves), so a per-vertex mask CANNOT be carried THROUGH the
// union. On the ASSEMBLED solid the fit region is therefore identified GEOMETRICALLY
// (`extractFitPatch`, by an axis/radial/axial region descriptor that is itself
// construction provenance — the unit's known intaglio bounds), not by a carried
// vertex mask. See the Task 6 report for the full closure of the T5 TODO: WIRED for
// the pre-union cutback (mask from the unit builder's known partition), SCOPED-by-
// geometry for the post-union measurement (region descriptor), because the union
// re-tessellates.
//
// Deterministic for a fixed manifold-3d version (WASM determinism); Float64 in/out
// (the wrapper's Float32 boundary is the documented exception).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { union } from '../boolean/manifold.ts';

/** Why a bridge assembly failed. `non-watertight-input`: a supplied solid was not
 * a watertight 2-manifold (repair first). `disjoint`: the union did not fuse into
 * ONE component (a connector does not reach both units). `non-watertight-output`:
 * the fused result was not watertight (a manifold-3d anomaly — never silently
 * shipped). `empty`: no solids supplied. */
export type BridgeAssemblyFailureReason =
  | 'empty'
  | 'non-watertight-input'
  | 'disjoint'
  | 'non-watertight-output';

/** Thrown when the whole-bridge union cannot produce ONE watertight solid — see
 * `BridgeAssemblyFailureReason`. Explicit field + body assignment (NOT a TS
 * constructor parameter property — this module is in the Node worker's
 * strip-only-TS import closure; the P5-T1 landmine). */
export class BridgeAssemblyError extends Error {
  readonly reason: BridgeAssemblyFailureReason;
  /** The connected-component count of the fused result (for `disjoint`), else null. */
  readonly componentCount: number | null;
  /** The index into the input `solids` array that failed (for
   * `non-watertight-input`), else null. */
  readonly solidIndex: number | null;
  constructor(reason: BridgeAssemblyFailureReason, message: string, componentCount: number | null = null, solidIndex: number | null = null) {
    super(`assembleBridge: ${message}`);
    this.name = 'BridgeAssemblyError';
    this.reason = reason;
    this.componentCount = componentCount;
    this.solidIndex = solidIndex;
  }
}

export interface BridgeAssemblyResult {
  /** The single watertight fused bridge solid. */
  readonly solid: IndexedMesh;
  /** Always `true` on a returned result (else the op throws). */
  readonly watertight: boolean;
  /** Always `true` on a returned result. */
  readonly manifoldEdges: boolean;
  /** Always `1` on a returned result (a disjoint fuse throws `BridgeAssemblyError`). */
  readonly componentCount: number;
  /** How many input solids were fused. */
  readonly inputCount: number;
  /** The fused solid's signed volume (mm³) — a positive-volume self-check field. */
  readonly volumeMm3: number | null;
  /** The fused solid's triangle count. */
  readonly triangleCount: number;
}

/**
 * Fuses `solids` (abutment units + pontic + connectors, each a watertight closed
 * solid) into ONE watertight single-component bridge solid via boolean union — see
 * this module's doc. Async (WASM). Deterministic for a fixed manifold-3d version.
 *
 * @throws {BridgeAssemblyError} `empty` (no solids), `non-watertight-input` (a
 * supplied solid is not watertight — repair first), `disjoint` (the union did not
 * fuse into one component), or `non-watertight-output`.
 * @throws {NonManifoldInputError} propagated from the wrapper if a solid is
 * rejected at the WASM boundary despite the up-front check (defense in depth).
 */
export async function assembleBridge(
  solids: readonly IndexedMesh[],
  onProgress?: (fraction: number) => void,
): Promise<BridgeAssemblyResult> {
  onProgress?.(0);
  if (solids.length === 0) {
    throw new BridgeAssemblyError('empty', 'no solids supplied — a bridge needs at least one unit');
  }
  // 1. Repair-before-boolean: every input must be a watertight 2-manifold.
  for (let i = 0; i < solids.length; i++) {
    const stats = analyzeMesh(solids[i]!);
    if (!stats.watertight || !stats.manifoldEdges) {
      throw new BridgeAssemblyError(
        'non-watertight-input',
        `solid #${i} is not a watertight 2-manifold (watertight=${stats.watertight}, manifoldEdges=${stats.manifoldEdges}) — repair before assembly, do not bypass`,
        null,
        i,
      );
    }
  }
  // 2. Fold-union every solid into one.
  let acc = solids[0]!;
  for (let i = 1; i < solids.length; i++) {
    acc = await union(acc, solids[i]!);
    onProgress?.(i / solids.length);
  }
  // 3. Re-validate the fused output.
  const stats = analyzeMesh(acc);
  if (stats.componentCount !== 1) {
    throw new BridgeAssemblyError(
      'disjoint',
      `the union produced ${stats.componentCount} components, not one fused solid — a connector does not reach both units it should bridge (mis-placed / non-overlapping connector)`,
      stats.componentCount,
    );
  }
  if (!stats.watertight || !stats.manifoldEdges) {
    throw new BridgeAssemblyError(
      'non-watertight-output',
      `the fused solid is not watertight (watertight=${stats.watertight}, manifoldEdges=${stats.manifoldEdges}) — never ship a non-watertight bridge`,
    );
  }
  onProgress?.(1);
  return {
    solid: acc,
    watertight: stats.watertight,
    manifoldEdges: stats.manifoldEdges,
    componentCount: stats.componentCount,
    inputCount: solids.length,
    volumeMm3: stats.signedVolumeMm3,
    triangleCount: acc.indices.length / 3,
  };
}

/** A cylindrical region descriptor identifying a unit's intaglio (fit) surface on
 * the assembled solid: the surface of revolution about `axis` through `axisPointMm`,
 * with radial distance ≤ `maxRadialMm` and axial coordinate (projection onto
 * `axis`) in `[minAxialMm, maxAxialMm]`. This is CONSTRUCTION PROVENANCE (the unit
 * builder knows its own intaglio bounds) — the geometric substitute for a per-vertex
 * fit mask that a manifold union cannot carry through (see this module's doc). */
export interface FitRegionDescriptor {
  readonly axisPointMm: Vec3;
  readonly axis: Vec3;
  readonly maxRadialMm: number;
  readonly minAxialMm: number;
  readonly maxAxialMm: number;
}

function radialAxial(p: Vec3, region: FitRegionDescriptor): { radial: number; axial: number } {
  const dx = p[0] - region.axisPointMm[0];
  const dy = p[1] - region.axisPointMm[1];
  const dz = p[2] - region.axisPointMm[2];
  const axial = dx * region.axis[0] + dy * region.axis[1] + dz * region.axis[2];
  const px = dx - axial * region.axis[0];
  const py = dy - axial * region.axis[1];
  const pz = dz - axial * region.axis[2];
  return { radial: Math.hypot(px, py, pz), axial };
}

/**
 * Extracts the intaglio (fit) surface PATCH of one unit from a (closed) assembled
 * solid, by GEOMETRIC region selection: every triangle ALL of whose vertices fall
 * inside `region` (radial ≤ `maxRadialMm`, axial ∈ `[minAxialMm, maxAxialMm]`) is
 * kept, compacted into a standalone open patch (re-indexed). The patch's open
 * boundary loop is the intaglio's margin rim — feeding it to the `marginFit` gate
 * RE-MEASURES the margin on the assembled solid (the survive-assembly proof).
 *
 * Robust to the union's vertex re-indexing (it tests POSITIONS, not identities);
 * correct because the intaglio pocket is spatially isolated from the connector
 * overlaps, so the union leaves its triangulation intact (only Float32-cast). Pure
 * Float64 mesh op (no WASM). Deterministic (fixed triangle iteration order).
 */
export function extractFitPatch(solid: IndexedMesh, region: FitRegionDescriptor): IndexedMesh {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const triCount = solid.indices.length / 3;
  const inRegion = (vi: number): boolean => {
    const p: Vec3 = [solid.positions[vi * 3]!, solid.positions[vi * 3 + 1]!, solid.positions[vi * 3 + 2]!];
    const { radial, axial } = radialAxial(p, region);
    return radial <= region.maxRadialMm && axial >= region.minAxialMm && axial <= region.maxAxialMm;
  };
  for (let t = 0; t < triCount; t++) {
    const a = solid.indices[t * 3]!;
    const b = solid.indices[t * 3 + 1]!;
    const c = solid.indices[t * 3 + 2]!;
    if (!inRegion(a) || !inRegion(b) || !inRegion(c)) continue;
    for (const vi of [a, b, c]) {
      let nv = remap.get(vi);
      if (nv === undefined) {
        nv = positions.length / 3;
        remap.set(vi, nv);
        positions.push(solid.positions[vi * 3]!, solid.positions[vi * 3 + 1]!, solid.positions[vi * 3 + 2]!);
      }
      indices.push(nv);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}
