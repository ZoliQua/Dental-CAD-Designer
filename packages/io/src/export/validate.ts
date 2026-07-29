// packages/io/src/export/validate.ts
//
// `assertExportableSolid` — the export layer's independent proof that a
// mesh is a manufacturable solid: watertight, 2-manifold, consistently
// wound, and OUTWARD-oriented, all derived from the mesh's own topology
// (never trusted from caller-supplied normals; STL export recomputes facet
// normals from the verified winding downstream).
//
// ## Why this is reimplemented here instead of importing kernel's intake
//
// The layer rule (CLAUDE.md / eslint.config.js `boundaries/dependencies`)
// allows packages/io to import only `shared-types` — kernel's
// `analyzeMesh`/`orientNormalsConsistently` are out of reach by design.
// That constraint is also a feature: this check is a VERIFICATION gate on
// the bytes leaving the system, and an implementation independent of the
// kernel machinery that produced the mesh is strictly stronger evidence
// (the same reasoning as invariant 6's dual validation). It is deliberately
// minimal: a strict accept/reject for closed solids, not a general mesh
// analyzer — kernel's `MeshStats` remains the diagnostic tool.
//
// ## Rejection policy: REJECT, never repair (including inward orientation)
//
// By the time a mesh reaches export, the QC gates have already proven it
// watertight/manifold/outward — so a violation here means an UPSTREAM BUG,
// and the only honest response is a typed error that surfaces it:
//  1. Silently flipping an inward mesh (or stitching a hole) would be
//     silent data mutation (CLAUDE.md invariant 5) — the exported geometry
//     would correspond to no journaled mesh state, breaking the
//     journal-hash lineage the Task 3 export `Operation` records.
//  2. The server re-validates the exported BYTES independently (invariant
//     6); a client-side "fix" would make the two sides disagree about what
//     mesh was designed vs what was shipped.
// Hence every failure below throws `ExportMeshInvalidError` with a typed
// `reason` — never a warning, never a corrected mesh.

import { ExportMeshInvalidError, type ExportableMesh } from './types.ts';

/**
 * Vertex-count ceiling for the packed undirected-edge key `min * V + max`
 * used below: exact integer arithmetic requires `V * V <= Number.MAX_SAFE_
 * INTEGER`, i.e. `V <= floor(sqrt(2^53 - 1))` (~94.9M vertices) — the same
 * bound (and reasoning) as kernel's `mesh/edgeKey.ts`. Far above any
 * restoration-scale mesh; enforced explicitly rather than assumed.
 */
export const MAX_EXPORT_VERTEX_COUNT = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));

/** Guards the packed-edge-key exactness precondition. Split out (and
 * exported) so it can be unit-tested directly without allocating the
 * multi-gigabyte positions buffer a real over-limit mesh would require —
 * the same seam pattern as stl/binary.ts's `assertWriteableTriangleCount`. */
export function assertExportVertexCountWithinEdgeKeyRange(vertexCount: number): void {
  if (vertexCount > MAX_EXPORT_VERTEX_COUNT) {
    fail(
      'structural',
      `vertexCount (${vertexCount}) exceeds the exact-edge-key ceiling (${MAX_EXPORT_VERTEX_COUNT})`,
    );
  }
}

/** What `assertExportableSolid` measured on the accepted solid — returned
 * so callers (tests, the Task 5 traceability document) can surface the
 * numbers without recomputing them. */
export interface ExportSolidCheck {
  vertexCount: number;
  triangleCount: number;
  /** Enclosed volume (divergence theorem), mm³ — strictly positive for an
   * accepted solid (positive ⇔ CCW-from-outside winding, the kernel's
   * outward convention). Summed in Float64 in triangle-index order
   * (deterministic: fixed order, pure arithmetic). */
  signedVolumeMm3: number;
}

function fail(reason: ExportMeshInvalidError['reason'], message: string): never {
  throw new ExportMeshInvalidError(reason, message);
}

const identityCoordinate = (x: number): number => x;

/** Total signed volume (divergence theorem) over every triangle in index
 * order, each coordinate first passed through `mapCoordinate` — identity
 * for the Float64 check, `Math.fround` for the STL narrowed-bytes check.
 * One fixed summation order for both, so the two checks are directly
 * comparable and each is deterministic. */
function signedVolume(
  positions: Float64Array,
  indices: Uint32Array,
  mapCoordinate: (x: number) => number,
): number {
  const triangleCount = indices.length / 3;
  let acc = 0;
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    const ax = mapCoordinate(positions[a]!);
    const ay = mapCoordinate(positions[a + 1]!);
    const az = mapCoordinate(positions[a + 2]!);
    const bx = mapCoordinate(positions[b]!);
    const by = mapCoordinate(positions[b + 1]!);
    const bz = mapCoordinate(positions[b + 2]!);
    const cx = mapCoordinate(positions[c]!);
    const cy = mapCoordinate(positions[c + 1]!);
    const cz = mapCoordinate(positions[c + 2]!);
    acc += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return acc;
}

/**
 * Signed volume of the mesh's f32-NARROWED geometry — i.e. of the solid a
 * binary STL reader will actually decode from the written bytes. Used by
 * `exportStlBinary` to certify outward orientation ON THE SHIPPED BYTES,
 * not just on the Float64 mesh (Phase 7 Task 2 review, finding 2: a
 * near-degenerate solid's orientation can flip under narrowing). Same
 * deterministic summation order as `assertExportableSolid`'s volume.
 */
export function f32NarrowedSignedVolumeMm3(mesh: ExportableMesh): number {
  return signedVolume(mesh.positions, mesh.indices, Math.fround);
}

/**
 * Asserts `mesh` is a closed, consistently-wound, outward-oriented triangle
 * solid — the precondition both export entries (`exportStlBinary`,
 * `exportPlyBinary`) enforce — and returns the measured counts/volume.
 *
 * The topological criterion (checked exactly, in Float64/integer
 * arithmetic, no tolerances):
 *  - every triangle references 3 DISTINCT in-range vertex indices and has
 *    a not-exactly-zero area (cross product ≠ (0,0,0)) — so the writer's
 *    degenerate (0,0,0)-normal fallback is unreachable from this path.
 *    Deliberately EXACT-zero only, no epsilon: near-zero-area quality is
 *    kernel QC's territory (intake already drops cross-norm < 1e-12); this
 *    layer only excludes what would corrupt the written bytes;
 *  - every undirected edge is incident to EXACTLY 2 triangles
 *    (2-manifold + watertight: 1 incidence = open boundary, 3+ =
 *    non-manifold);
 *  - the 2 incidences traverse the edge in OPPOSITE directions
 *    (consistent winding across every edge);
 *  - the mesh is exactly ONE edge-connected component (union-find over the
 *    shared edges). Required both by manufacturing semantics (one
 *    restoration = one fused solid — the kernel's shell/assembly ops
 *    guarantee single-component output, e.g. cavity/inlayShell.ts's
 *    watertight-single-component invariant) and by the orientation
 *    argument below, which is ONLY valid for a connected surface: a
 *    disjoint inward component or nested inward void hides inside a
 *    net-positive total volume (Phase 7 Task 2 review, finding 1);
 *  - the total signed volume is STRICTLY positive (outward orientation —
 *    a CONNECTED, consistently-wound closed surface has exactly 2 global
 *    orientations; positive divergence-theorem volume selects the
 *    CCW-from-outside one, matching kernel's convention).
 *
 * Failure precedence when several defects coexist: structural malformation
 * → degenerate triangle → non-manifold edge → boundary edge → inconsistent
 * winding → multi-component → zero volume / inward orientation.
 * Deterministic (fixed scan order), so the same broken mesh always reports
 * the same reason.
 *
 * Note this certifies the Float64 mesh; the STL entry additionally
 * re-checks orientation on the f32-NARROWED coordinates (the bytes
 * actually shipped) — see stl.ts and `f32NarrowedSignedVolumeMm3`.
 *
 * Determinism: pure function of the input arrays; no randomness, no time,
 * no environment. Never mutates `mesh` (buffers are only read).
 */
export function assertExportableSolid(mesh: ExportableMesh): ExportSolidCheck {
  const { positions, indices } = mesh;

  if (!(positions instanceof Float64Array)) {
    fail('structural', 'positions must be a Float64Array (kernel Float64 rule)');
  }
  if (!(indices instanceof Uint32Array)) {
    fail('structural', 'indices must be a Uint32Array');
  }
  if (positions.length % 3 !== 0) {
    fail('structural', `positions.length (${positions.length}) is not a multiple of 3`);
  }
  if (indices.length % 3 !== 0) {
    fail('structural', `indices.length (${indices.length}) is not a multiple of 3`);
  }

  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  if (triangleCount === 0) {
    fail('empty', 'mesh has zero triangles — nothing to export');
  }
  assertExportVertexCountWithinEdgeKeyRange(vertexCount);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i]!)) {
      fail('structural', `positions[${i}] is ${positions[i]} — coordinates must be finite`);
    }
  }

  // --- Pass 1: structural index checks + degenerate triangles ------------
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      fail(
        'structural',
        `triangle ${t} references vertex index >= vertexCount (${vertexCount}): (${a}, ${b}, ${c})`,
      );
    }
    if (a === b || b === c || c === a) {
      fail('degenerate-triangle', `triangle ${t} repeats a vertex index: (${a}, ${b}, ${c})`);
    }
    // Exactly-zero-area check (see this function's doc — exact, no epsilon):
    // cross(v1-v0, v2-v0) === (0,0,0) is precisely the condition under which
    // stl/binary.ts's geometricFacetNormal would write a (0,0,0) normal.
    const ax = positions[a * 3]!;
    const ay = positions[a * 3 + 1]!;
    const az = positions[a * 3 + 2]!;
    const ux = positions[b * 3]! - ax;
    const uy = positions[b * 3 + 1]! - ay;
    const uz = positions[b * 3 + 2]! - az;
    const vx = positions[c * 3]! - ax;
    const vy = positions[c * 3 + 1]! - ay;
    const vz = positions[c * 3 + 2]! - az;
    if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) {
      fail(
        'degenerate-triangle',
        `triangle ${t} has an exactly zero-area cross product (collinear vertices) — its written STL ` +
          'facet normal would be the degenerate (0, 0, 0) fallback',
      );
    }
  }

  // --- Pass 2: undirected edge incidence + winding direction + components -
  // Key: min * vertexCount + max (exact — see MAX_EXPORT_VERTEX_COUNT).
  // Value: per-edge counts of the two possible traversal directions:
  //   forwardCount  — traversed min→max by some triangle,
  //   backwardCount — traversed max→min,
  // plus the FIRST triangle that touched the edge, so triangles sharing an
  // edge can be unioned for the single-component check (edge-connectivity,
  // matching kernel intake's `connectedComponents` notion — two closed
  // surfaces touching only at a vertex are 2 components, correctly).
  // Watertight + consistently wound ⇔ every edge ends at exactly
  // { forwardCount: 1, backwardCount: 1 }.
  const edges = new Map<number, { forwardCount: number; backwardCount: number; firstTriangle: number }>();

  // Union-find over triangles (path-halving find; deterministic).
  const parent = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) parent[t] = t;
  const find = (x: number): number => {
    while (parent[x]! !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };

  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const from = indices[t * 3 + corner]!;
      const to = indices[t * 3 + ((corner + 1) % 3)]!;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const key = lo * vertexCount + hi;
      let entry = edges.get(key);
      if (!entry) {
        entry = { forwardCount: 0, backwardCount: 0, firstTriangle: t };
        edges.set(key, entry);
      } else {
        const rootA = find(entry.firstTriangle);
        const rootB = find(t);
        if (rootA !== rootB) parent[rootA] = rootB;
      }
      if (from === lo) entry.forwardCount++;
      else entry.backwardCount++;
    }
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let sameDirectionEdgeCount = 0;
  for (const { forwardCount, backwardCount } of edges.values()) {
    const total = forwardCount + backwardCount;
    if (total === 1) boundaryEdgeCount++;
    else if (total > 2) nonManifoldEdgeCount++;
    else if (forwardCount !== 1) sameDirectionEdgeCount++; // total === 2, same direction twice
  }
  if (nonManifoldEdgeCount > 0) {
    fail(
      'non-manifold-edge',
      `${nonManifoldEdgeCount} edge(s) are shared by 3+ triangles — the mesh is not 2-manifold`,
    );
  }
  if (boundaryEdgeCount > 0) {
    fail(
      'boundary-edge',
      `${boundaryEdgeCount} boundary edge(s) — the mesh is open, not watertight`,
    );
  }
  if (sameDirectionEdgeCount > 0) {
    fail(
      'inconsistent-winding',
      `${sameDirectionEdgeCount} edge(s) are traversed twice in the SAME direction — adjacent ` +
        'triangles disagree on which side is outside',
    );
  }

  // --- Pass 3: exactly one edge-connected component ----------------------
  let componentCount = 0;
  for (let t = 0; t < triangleCount; t++) {
    if (find(t) === t) componentCount++;
  }
  if (componentCount !== 1) {
    fail(
      'multi-component',
      `mesh has ${componentCount} edge-connected components — a manufacturing export is exactly ONE ` +
        'fused solid, and the positive-volume ⇒ outward argument is only valid for a connected ' +
        'surface (a disjoint inward component or nested void would hide inside the total). Fuse or ' +
        'split upstream; this layer never picks components for the caller.',
    );
  }

  // --- Pass 4: outward orientation via total signed volume ---------------
  const signedVolumeMm3 = signedVolume(positions, indices, identityCoordinate);
  if (signedVolumeMm3 === 0) {
    fail('zero-volume', 'watertight but encloses zero volume — a degenerate solid cannot be milled');
  }
  if (signedVolumeMm3 < 0) {
    fail(
      'inward-orientation',
      `signed volume is ${signedVolumeMm3} mm³ (< 0): every facet points INTO the solid. The export ` +
        'layer rejects inward orientation rather than silently flipping it — see validate.ts (an ' +
        'inward mesh at export time is an upstream pipeline bug that must surface, and a silent flip ' +
        'would break the journaled mesh-hash lineage).',
    );
  }

  return { vertexCount, triangleCount, signedVolumeMm3 };
}
