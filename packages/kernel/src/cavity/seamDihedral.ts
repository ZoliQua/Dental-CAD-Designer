// packages/kernel/src/cavity/seamDihedral.ts
//
// Phase 5 Task 4: the G1 MEASURABLE — the dihedral-angle measurement across the
// occlusal patch↔tooth SEAM. This is the acceptance instrument (PLAN.md Phase 5:
// "the boundary blend is G1-continuous: dihedral angle < 5° along the seam"),
// and it is deliberately implemented and VALIDATED INDEPENDENTLY of the blend
// (occlusalPatch.ts): it is a pure mesh operation — for each seam edge it
// compares the patch's boundary-triangle outward normal against the surrounding
// tooth's outward normal across that edge — so its correctness can be pinned on
// closed-form inputs (a flat patch meeting a plane → 0 exactly; two flat strips
// at a known wedge angle β → β exactly; a cap meeting a curved surface →
// closed-form seam angle within discretization) BEFORE it ever judges a blend.
//
// ## What a "seam dihedral" is (the exact definition, so the number is honest)
//
// The occlusal patch and the surrounding tooth are two SEPARATE oriented,
// outward-facing surfaces that meet along the cavity outline (Task 6 later
// stitches them; here they are distinct meshes sharing the outline vertices).
// For one seam edge e = (a, b) (an outline segment on a SEAM region — see
// occlusalPatch.ts's partition):
//   - `patchNormal`  = the outward unit normal of the (unique) PATCH triangle
//     whose boundary edge is e.
//   - `toothNormal`  = the outward unit normal of the SURROUNDING tooth triangle
//     across e (the tooth triangle adjacent to e that is NOT part of the cavity
//     surface — on a CLOSED tooth mesh e has two adjacent tooth triangles, the
//     cavity-wall one and the surrounding-occlusal one; the caller passes the
//     cavity triangle set to exclude the former. On an OPEN tooth mesh — the
//     closed-form test surfaces — e is a boundary edge with exactly ONE adjacent
//     triangle, so no exclusion is needed).
//   - `dihedralDeg`  = the angle between those two OUTWARD normals, in degrees.
//     For a G1 (tangent-continuous) join the two outward normals coincide →
//     0°; a tangent-plane discontinuity of angle β (e.g. a flat lid meeting a
//     sloped cusp incline) reads β. This is the true surface-bend at the seam,
//     NOT a mesh-interior facet angle.
//
// The gate value is `max(dihedralDeg)` over the SEAM edges ONLY. Free (proximal
// break-through) edges — where there is no surrounding tooth surface to be
// continuous with — are NOT seam edges and never enter this measurement (a
// measurement diluted over free segments would be a false-accuracy failure; see
// occlusalPatch.ts's partition). The per-segment breakdown (buccal / lingual)
// is reported so a localized failure is visible, never averaged away.
//
// ## @errorBound
//
// EXACT (Float64) for a flat seam: the measurement is a direct arccos of the
// dot product of two exact unit triangle normals — no interpolation, iteration
// or sampling of a continuous quantity. On a CURVED surrounding surface the
// per-edge value carries the surrounding TRIANGLE's own faceting (the facet
// normal samples the true surface normal within O(edge length · curvature)),
// exactly as a discrete dihedral must — this is a property of the discretized
// input, not of the measurement. Determinism: a pure function of the two mesh
// buffers + the seam-edge list + the excluded-triangle set; edge/triangle
// lookup is by bit-exact coordinate keys and all traversals run in ascending
// order, so the result is byte-reproducible.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { dot, triangleUnitNormal, triangleVertexPositions } from '../axis/vec.ts';

/** One seam edge to measure across — an outline segment `(a, b)` whose endpoints
 * are (bit-exact) vertices of BOTH the patch and the tooth mesh. `segment` is a
 * label (e.g. `'buccal'` / `'lingual'`) for the per-segment breakdown. */
export interface SeamEdge {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly segment: string;
}

export interface SeamDihedralSample {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly segment: string;
  readonly patchNormal: Vec3;
  readonly toothNormal: Vec3;
  readonly dihedralDeg: number;
}

export interface SeamDihedralMeasurement {
  /** Max seam dihedral (deg) — the gate value. `0` when there are no seam edges
   * (reported alongside `sampleCount === 0` so an empty seam is never a silent
   * pass — callers/gates must treat a zero-sample measurement as a failure). */
  readonly maxDeg: number;
  /** Area-unweighted mean seam dihedral (deg) over all sampled edges. */
  readonly meanDeg: number;
  /** Number of seam edges actually measured. */
  readonly sampleCount: number;
  /** Per-segment max dihedral (deg), keyed by the `SeamEdge.segment` label. */
  readonly perSegmentMaxDeg: Readonly<Record<string, number>>;
  /** Per-segment sampled edge count. */
  readonly perSegmentCount: Readonly<Record<string, number>>;
  /** Every per-edge sample, in the input `seamEdges` order. */
  readonly samples: readonly SeamDihedralSample[];
}

/** A seam edge's endpoints matched no adjacent triangle on one of the meshes, or
 * the surrounding tooth triangle could not be disambiguated to exactly one — a
 * structural mismatch between the seam-edge list and the meshes (a caller bug:
 * the seam edges must be shared, bit-exact edges of both surfaces). */
export class SeamEdgeNotOnMeshError extends Error {
  readonly edgeIndex: number;
  readonly which: 'patch' | 'tooth';
  readonly adjacentCount: number;
  constructor(edgeIndex: number, which: 'patch' | 'tooth', adjacentCount: number) {
    super(
      `measureSeamDihedral: seam edge ${edgeIndex} has ${adjacentCount} adjacent ${which} triangle(s) after exclusion, ` +
        `expected exactly 1 — the seam edges must be shared, bit-exact edges of both the patch and the tooth surface`,
    );
    this.name = 'SeamEdgeNotOnMeshError';
    this.edgeIndex = edgeIndex;
    this.which = which;
    this.adjacentCount = adjacentCount;
  }
}

function coordKey(p: Vec3): string {
  return `${p[0]}|${p[1]}|${p[2]}`;
}

function edgeKey(a: Vec3, b: Vec3): string {
  const ka = coordKey(a);
  const kb = coordKey(b);
  return ka < kb ? `${ka}#${kb}` : `${kb}#${ka}`;
}

/** Map every undirected mesh edge (by bit-exact endpoint coordinates) to the
 * ascending list of triangle indices incident to it. Coordinate keys (not
 * vertex indices) so a patch and a tooth built independently but sharing the
 * exact outline vertices match up. */
function buildEdgeTriangleMap(mesh: IndexedMesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = edgeKey(p, q);
      let arr = map.get(k);
      if (!arr) {
        arr = [];
        map.set(k, arr);
      }
      arr.push(t);
    }
  }
  return map;
}

export interface MeasureSeamDihedralOptions {
  /** Tooth triangle indices to EXCLUDE when disambiguating the surrounding
   * triangle across a seam edge (the cavity-surface triangles — on a closed
   * tooth mesh both the cavity wall and the surrounding occlusal surface are
   * adjacent to a seam edge; excluding the cavity ones leaves the surrounding
   * one). Omit/empty for an OPEN tooth mesh where each seam edge is a boundary
   * edge with exactly one adjacent triangle. */
  readonly excludeToothTriangles?: ReadonlySet<number>;
}

/**
 * Measures the seam dihedral across every edge in `seamEdges` between the
 * `patchMesh` and the surrounding `toothMesh` — the pure, blend-independent G1
 * instrument (see this module's doc for the exact definition + `@errorBound`).
 * Both meshes must be OUTWARD-oriented and share the seam-edge endpoint vertices
 * bit-exactly. Deterministic.
 *
 * @throws {SeamEdgeNotOnMeshError} if a seam edge does not match exactly one
 * patch triangle, or exactly one tooth triangle after exclusion.
 */
export function measureSeamDihedral(
  patchMesh: IndexedMesh,
  toothMesh: IndexedMesh,
  seamEdges: readonly SeamEdge[],
  options: MeasureSeamDihedralOptions = {},
): SeamDihedralMeasurement {
  const exclude = options.excludeToothTriangles ?? new Set<number>();
  const patchEdges = buildEdgeTriangleMap(patchMesh);
  const toothEdges = buildEdgeTriangleMap(toothMesh);

  const samples: SeamDihedralSample[] = [];
  const perSegmentMaxDeg: Record<string, number> = {};
  const perSegmentCount: Record<string, number> = {};
  let maxDeg = 0;
  let sumDeg = 0;

  for (let i = 0; i < seamEdges.length; i++) {
    const e = seamEdges[i]!;
    const k = edgeKey(e.a, e.b);

    const patchTris = patchEdges.get(k) ?? [];
    if (patchTris.length !== 1) {
      throw new SeamEdgeNotOnMeshError(i, 'patch', patchTris.length);
    }
    const patchTri = patchTris[0]!;

    const toothCand = (toothEdges.get(k) ?? []).filter((t) => !exclude.has(t));
    if (toothCand.length !== 1) {
      throw new SeamEdgeNotOnMeshError(i, 'tooth', toothCand.length);
    }
    const toothTri = toothCand[0]!;

    const [pa, pb, pc] = triangleVertexPositions(patchMesh, patchTri);
    const patchNormal = triangleUnitNormal(pa, pb, pc);
    const [ta, tb, tc] = triangleVertexPositions(toothMesh, toothTri);
    const toothNormal = triangleUnitNormal(ta, tb, tc);

    const c = Math.max(-1, Math.min(1, dot(patchNormal, toothNormal)));
    const dihedralDeg = (Math.acos(c) * 180) / Math.PI;

    samples.push({ a: e.a, b: e.b, segment: e.segment, patchNormal, toothNormal, dihedralDeg });
    if (dihedralDeg > maxDeg) maxDeg = dihedralDeg;
    sumDeg += dihedralDeg;
    perSegmentMaxDeg[e.segment] = Math.max(perSegmentMaxDeg[e.segment] ?? 0, dihedralDeg);
    perSegmentCount[e.segment] = (perSegmentCount[e.segment] ?? 0) + 1;
  }

  return {
    maxDeg,
    meanDeg: samples.length > 0 ? sumDeg / samples.length : 0,
    sampleCount: samples.length,
    perSegmentMaxDeg,
    perSegmentCount,
    samples,
  };
}
