// packages/kernel/src/intake/orient.ts
//
// Consistent-normal-orientation for an IndexedMesh: flood-fills triangle
// winding across shared edges so adjacent triangles agree on which way is
// "outside", then — for closed components — picks the global sign (all
// triangles flipped, or none) that makes the enclosed volume positive
// (CCW-from-outside, matching boolean/manifold.ts's winding convention).
// That sign decision is resolved per-island by TOTAL signed volume (see
// `signedVolumeOf` and its call site below) — it is never a literal
// per-triangle vote; a single island-wide sign flips (or doesn't) every
// triangle in that island together.
//
// ## The subtle part: non-manifold real scans
//
// A well-behaved closed 2-manifold component (every edge shared by exactly
// 2 triangles) has EXACTLY 2 possible globally-consistent orientations, and
// a single flood fill from any seed triangle reaches every other triangle
// in the component, fixing their orientation RELATIVE to the seed. Real
// scan data is not always this well-behaved: intake explicitly does not
// repair anything (Task 8's job), so a component can legitimately contain
// non-manifold edges (an edge shared by 3+ triangles — e.g. a thin scanned
// sliver welded onto a wall, or scanner noise stitching two nearly-touching
// surfaces together at one edge) BEFORE this function ever runs. Across
// such an edge, "the other triangle" is ambiguous — there isn't one, there
// are several — so propagating a flip decision across it would be an
// arbitrary choice dressed up as a fact.
//
// This function's flood fill therefore only ever CROSSES an edge whose
// degree is exactly 2 (see `buildDegreeTwoAdjacency` below); it does not
// mean the same thing as "connected component" (`MeshStats.componentCount`,
// topology.ts's `connectedComponents`, which counts a component as
// connected via ANY shared edge, non-manifold ones included). The result is
// that ONE geometric component can require MULTIPLE flood-fill runs
// ("islands") to cover every one of its triangles — each island is
// internally consistent, but nothing about the flood fill relates one
// island's global sign to another's. When that happens (or when the
// component simply has a non-manifold edge at all, even if by coincidence
// every triangle was still reached in one island), this function does NOT
// crash or throw: it still produces a plausible (if only best-effort)
// orientation for every triangle — see `orientComponent` below — and flags
// the component's `orientationAmbiguous: true` in its report so callers
// (and, eventually, QC) know not to trust the sign as authoritative.
import type { IndexedMesh } from '../mesh/types.ts';
import { buildEdgeMap, connectedComponents } from './topology.ts';

export interface OrientComponentReport {
  componentIndex: number;
  triangleCount: number;
  /** No boundary AND no non-manifold edges touch this component. */
  closed: boolean;
  /** `true` when this component's orientation could not be established with
   * full confidence: it's open (no meaningful enclosed-volume sign to pick
   * a canonical direction from), it has a non-manifold edge, or its
   * flood fill needed more than one island to cover every triangle. See
   * this module's doc above. */
  orientationAmbiguous: boolean;
  /** How many of this component's triangles were flipped relative to their
   * original winding. */
  flippedCount: number;
}

export interface OrientNormalsResult {
  mesh: IndexedMesh;
  triangleCount: number;
  flippedCount: number;
  componentCount: number;
  ambiguousComponentCount: number;
  components: OrientComponentReport[];
}

/**
 * Adjacency restricted to degree-2 (manifold-interior) edges only — see this
 * module's doc for why non-manifold edges are deliberately excluded from
 * flood-fill propagation.
 *
 * **CSR (compressed sparse row) typed-array storage** (Phase 2 Task 2 intake
 * scalability rebuild): NOT a `Neighbor[][]` — one JS array per triangle,
 * each accumulated via `.push()` — because at the multi-million-triangle
 * scale this project's NFR targets (PLAN.md §7), allocating ~`triangleCount`
 * individually-managed small arrays (via `Array.from({length,...}, () =>
 * [])`) plus ~`2 * degreeTwoEdgeCount` pushed `Neighbor` objects turned out
 * to be a genuine scalability CLIFF, not just a proportionally-larger cost:
 * empirically, this pattern took a ~5M-triangle mesh from a healthy ~3.3 GB
 * RSS straight past a 16 GB heap ceiling into an OOM crash (verified via a
 * throwaway instrumented run — see this task's perf report), even though
 * the SAME code at ~2.5M triangles only cost ~115 MB. A huge COUNT of tiny,
 * individually-GC-tracked objects (rather than raw byte volume) is what
 * breaks down here — millions of small arrays/objects is a documented weak
 * spot for V8's generational/incremental GC, independent of how much actual
 * data they hold.
 *
 * The fix: two passes over the SAME `edges` `Map` (whose iteration order is
 * stable and IDENTICAL across repeated iterations of one `Map` instance —
 * this is what makes the two passes agree), building one flat CSR structure
 * instead: `start` (`Uint32Array`, length `triangleCount + 1`) gives
 * triangle `t`'s adjacency slice as `[start[t], start[t+1])` into the flat
 * `neighbor`/`dSelf`/`dNeighbor` arrays. This preserves, EXACTLY, the same
 * per-triangle neighbor visiting order the original push-based version
 * produced (both passes iterate `edges.values()` in the same order, so
 * pass 2 appends each triangle's entries in the same relative order pass 1
 * counted them in) — required for `orientNormalsConsistently`'s flood-fill
 * traversal, and therefore its floating-point `signedVolumeOf` summation
 * order, to stay BIT-IDENTICAL to before (this task's brief: "OUTPUT must
 * be bit-identical").
 */
interface DegreeTwoAdjacency {
  /** `start[t] .. start[t+1])` is triangle `t`'s slice into
   * `neighbor`/`dSelf`/`dNeighbor`. Length `triangleCount + 1`. */
  start: Uint32Array;
  neighbor: Int32Array;
  /** `1`/`0` in place of `boolean` — packed into a `Uint8Array`, avoiding a
   * third `boolean[]`/object-per-entry allocation. */
  dSelf: Uint8Array;
  dNeighbor: Uint8Array;
}

function buildDegreeTwoAdjacency(
  edges: ReturnType<typeof buildEdgeMap>,
  triangleCount: number,
): DegreeTwoAdjacency {
  const degree = new Uint32Array(triangleCount);
  for (const entry of edges.values()) {
    if (entry.incidences.length !== 2) continue;
    const ta = entry.incidences[0]!.triangle;
    const tb = entry.incidences[1]!.triangle;
    degree[ta] = degree[ta]! + 1;
    degree[tb] = degree[tb]! + 1;
  }

  const start = new Uint32Array(triangleCount + 1);
  for (let t = 0; t < triangleCount; t++) start[t + 1] = start[t]! + degree[t]!;
  const total = start[triangleCount]!;

  const neighbor = new Int32Array(total);
  const dSelf = new Uint8Array(total);
  const dNeighbor = new Uint8Array(total);
  // Per-triangle write cursor, initialized to each triangle's slice start —
  // a separate copy from `start` itself (which must stay untouched as the
  // slice-boundary array callers read).
  const cursor = start.slice(0, triangleCount);

  for (const entry of edges.values()) {
    if (entry.incidences.length !== 2) continue;
    const first = entry.incidences[0]!;
    const second = entry.incidences[1]!;

    const i1 = cursor[first.triangle]!;
    neighbor[i1] = second.triangle;
    dSelf[i1] = first.directed ? 1 : 0;
    dNeighbor[i1] = second.directed ? 1 : 0;
    cursor[first.triangle] = i1 + 1;

    const i2 = cursor[second.triangle]!;
    neighbor[i2] = first.triangle;
    dSelf[i2] = second.directed ? 1 : 0;
    dNeighbor[i2] = first.directed ? 1 : 0;
    cursor[second.triangle] = i2 + 1;
  }

  return { start, neighbor, dSelf, dNeighbor };
}

/** Signed volume (divergence theorem) of a triangle subset, applying each
 * triangle's `flip` bit (flipped triangles contribute with v1/v2 swapped —
 * equivalent to negating their term). Used both to pick a component's/
 * island's global sign and, after flip decisions are finalized, is
 * recomputed by `analyzeMesh` on the real output for `MeshStats` — this
 * copy is intentionally local/minimal (only what the sign decision needs),
 * not exported, to avoid a premature shared "volume of a triangle list"
 * utility neither analyze.ts nor anything else needs yet (YAGNI).
 */
function signedVolumeOf(mesh: IndexedMesh, triangles: readonly number[], flip: Uint8Array): number {
  let acc = 0;
  for (const t of triangles) {
    const base = t * 3;
    const a = mesh.indices[base]!;
    let b = mesh.indices[base + 1]!;
    let c = mesh.indices[base + 2]!;
    if (flip[t] === 1) {
      const tmp = b;
      b = c;
      c = tmp;
    }
    const ax = mesh.positions[a * 3]!;
    const ay = mesh.positions[a * 3 + 1]!;
    const az = mesh.positions[a * 3 + 2]!;
    const bx = mesh.positions[b * 3]!;
    const by = mesh.positions[b * 3 + 1]!;
    const bz = mesh.positions[b * 3 + 2]!;
    const cx = mesh.positions[c * 3]!;
    const cy = mesh.positions[c * 3 + 1]!;
    const cz = mesh.positions[c * 3 + 2]!;
    acc += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return acc;
}

/**
 * Consistently orients every triangle in `mesh` — see this module's doc for
 * the algorithm and the non-manifold-edge caveat.
 *
 * **Buffer ownership**: `mesh.positions` is never mutated and is reused
 * (same reference) in the result, exactly like `dropDegenerateTriangles` —
 * only triangle winding changes, never vertex positions. `indices` is
 * always a freshly allocated `Uint32Array`.
 */
export function orientNormalsConsistently(mesh: IndexedMesh): OrientNormalsResult {
  const triangleCount = mesh.indices.length / 3;
  const edges = buildEdgeMap(mesh);
  const { rootOfTriangle, componentIndexOfRoot, componentCount } = connectedComponents(mesh, edges);
  const adjacency = buildDegreeTwoAdjacency(edges, triangleCount);

  // Per-component boundary/non-manifold flags, computed once by scanning
  // every edge's incident components (an edge's degree classifies it
  // regardless of which triangle within a component it touches).
  const componentHasBoundary = new Array<boolean>(componentCount).fill(false);
  const componentHasNonManifold = new Array<boolean>(componentCount).fill(false);
  for (const entry of edges.values()) {
    const degree = entry.incidences.length;
    if (degree === 2) continue;
    for (const incidence of entry.incidences) {
      const componentIndex = componentIndexOfRoot.get(rootOfTriangle[incidence.triangle]!)!;
      if (degree === 1) componentHasBoundary[componentIndex] = true;
      else componentHasNonManifold[componentIndex] = true;
    }
  }

  // Flood fill via degree-2 edges only, seeding a new "island" for every
  // triangle not yet reached. `flip[t] === 1` means t's final winding is
  // (a, c, b) relative to its ORIGINAL (a, b, c).
  const flip = new Uint8Array(triangleCount);
  const visited = new Uint8Array(triangleCount);
  const islandsByComponent = new Map<number, number[][]>(); // componentIndex -> islands (each an array of triangle indices)

  for (let seed = 0; seed < triangleCount; seed++) {
    if (visited[seed] === 1) continue;
    const componentIndex = componentIndexOfRoot.get(rootOfTriangle[seed]!)!;
    const island: number[] = [];
    visited[seed] = 1;
    flip[seed] = 0;
    const queue: number[] = [seed];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head]!;
      head++;
      island.push(current);
      for (let i = adjacency.start[current]!; i < adjacency.start[current + 1]!; i++) {
        const neighbor = adjacency.neighbor[i]!;
        if (visited[neighbor] === 1) continue;
        const dSelf = adjacency.dSelf[i] === 1;
        const dNeighbor = adjacency.dNeighbor[i] === 1;
        const effectiveSelf = dSelf !== (flip[current] === 1);
        const desiredNeighborEffective = !effectiveSelf;
        const neighborFlip = dNeighbor !== desiredNeighborEffective;
        flip[neighbor] = neighborFlip ? 1 : 0;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    const islands = islandsByComponent.get(componentIndex);
    if (islands) islands.push(island);
    else islandsByComponent.set(componentIndex, [island]);
  }

  const components: OrientComponentReport[] = [];
  let totalFlipped = 0;
  let ambiguousComponentCount = 0;

  for (let componentIndex = 0; componentIndex < componentCount; componentIndex++) {
    const islands = islandsByComponent.get(componentIndex) ?? [];
    const hasBoundary = componentHasBoundary[componentIndex] ?? false;
    const hasNonManifold = componentHasNonManifold[componentIndex] ?? false;
    const closed = !hasBoundary && !hasNonManifold;
    const multiIsland = islands.length > 1;
    const orientationAmbiguous = !closed || multiIsland;

    if (closed) {
      // Well-defined enclosed-volume sign to pick a canonical direction —
      // per-island when the flood fill needed more than one (best-effort:
      // each island is pushed toward non-negative LOCAL volume
      // contribution independently; see this module's doc for why a
      // single authoritative global sign isn't derivable across a
      // non-manifold junction).
      for (const island of islands) {
        const vol = signedVolumeOf(mesh, island, flip);
        if (vol < 0) {
          for (const t of island) flip[t] = flip[t] === 1 ? 0 : 1;
        }
      }
    }
    // Open components (or non-manifold ones): no meaningful global sign to
    // pick — leave each island's flood-fill baseline as-is (internally
    // consistent per island, per this task's brief: "Open components:
    // consistent within component, flagged orientationAmbiguous").

    let componentTriangleCount = 0;
    let componentFlipped = 0;
    for (const island of islands) {
      componentTriangleCount += island.length;
      for (const t of island) if (flip[t] === 1) componentFlipped++;
    }
    totalFlipped += componentFlipped;
    if (orientationAmbiguous) ambiguousComponentCount++;

    components.push({
      componentIndex,
      triangleCount: componentTriangleCount,
      closed,
      orientationAmbiguous,
      flippedCount: componentFlipped,
    });
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    const a = mesh.indices[base]!;
    const b = mesh.indices[base + 1]!;
    const c = mesh.indices[base + 2]!;
    if (flip[t] === 1) {
      indices[base] = a;
      indices[base + 1] = c;
      indices[base + 2] = b;
    } else {
      indices[base] = a;
      indices[base + 1] = b;
      indices[base + 2] = c;
    }
  }

  return {
    mesh: { positions: mesh.positions, indices },
    triangleCount,
    flippedCount: totalFlipped,
    componentCount,
    ambiguousComponentCount,
    components,
  };
}
