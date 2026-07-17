// packages/kernel/src/intake/weld.ts
//
// Vertex welding: turns an unindexed `TriangleSoup` (every triangle owns its
// own 3 vertices) into a shared-vertex `IndexedMesh`, merging vertices that
// coincide within a fixed epsilon.

import type { IndexedMesh } from '../mesh/types.ts';
import type { TriangleSoup } from './types.ts';

/**
 * Fixed clinical constant: the mesh vertex-dedup tolerance. Source: PLAN.md
 * §3 "Clinical parameters" table, row "Mesh weld tolerance | 1e-6 mm |
 * fixed | Vertex dedup epsilon" — this value is NOT configurable per
 * material profile (unlike every other row in that table), so it lives here
 * as a kernel constant rather than in `packages/clinical-profiles/`.
 * `weldVertices`'s `epsilon` parameter defaults to this and exists mainly
 * for tests; production callers should not override it.
 */
export const MESH_WELD_EPSILON_MM = 1e-6;

/**
 * 32-bit spatial hash of an integer grid-cell coordinate triple — the
 * classic 3-prime XOR construction (Teschner et al.-style), via `Math.imul`
 * so the multiplications wrap deterministically in int32 space regardless
 * of how large the cell indices get (at mm-scale coordinates over a 1e-6 mm
 * grid, indices reach ~1e8 — far past exact packing into one number, which
 * is why this hashes instead of packing). Two DIFFERENT cells may collide
 * into one hash bucket; that is deliberately safe here because
 * `weldVertices` never trusts bucket membership — every candidate is
 * verified with a real Euclidean-distance check before merging, so a
 * collision only costs a few extra rejected distance checks, never a wrong
 * merge. Purely arithmetic, so fully deterministic.
 */
function hashCell(ix: number, iy: number, iz: number): number {
  return (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f)) | 0;
}

/**
 * Welds coincident vertices in a triangle soup into a shared-vertex
 * `IndexedMesh`, using a spatial hash grid so this is average-case O(n) in
 * the number of raw (unwelded) vertices, not O(n²) — required for arch
 * scans in the ~300k-1M triangle range (~1M-3M raw vertices).
 *
 * Grid construction: cell size is `2 * epsilon`, and for each raw vertex
 * every cell overlapping the closed ±`epsilon` box around it is probed —
 * per axis that's `floor((p-ε)/2ε) .. floor((p+ε)/2ε)`, i.e. 2 cells
 * typically (3 at most), so a typical lookup probes 8 cells (2×2×2) rather
 * than the 27 a cell-size-ε grid would need. Any existing vertex within
 * `epsilon` of the query point necessarily lies inside that box, and every
 * vertex is bucketed under its own containing cell, so the probe set is
 * exhaustive for the tolerance being enforced. Bucket keys are `hashCell`
 * values (see its doc for why hash collisions are safe).
 *
 * **Stable first-occurrence ordering** (determinism, see CLAUDE.md invariant
 * 2): the output vertex at index `i` is the position of the `i`-th DISTINCT
 * vertex encountered while scanning the soup in triangle/corner order
 * (triangle 0's v0, v1, v2, then triangle 1's, ...) — never reordered by
 * hash-bucket iteration order (only insertion order into `weldedPositions`
 * matters, and that follows scan order exactly). Within a probe, cells are
 * visited in a fixed lexicographic order and candidates within a bucket in
 * insertion order, so even the ambiguous case (several existing vertices
 * within `epsilon` of one query point) resolves identically on every run.
 * Re-running this function on the same input always produces byte-identical
 * output.
 *
 * **Merge semantics: leader clustering, NOT transitive chaining, NO centroid
 * drift.** A welded vertex's stored position is fixed the instant it is
 * created — it is exactly the raw position of whichever raw vertex first
 * produced it (its cluster's "leader") — and is never averaged, nudged, or
 * otherwise moved as later raw vertices merge into it. A later raw vertex
 * `v` merges into an existing welded vertex `w` iff `|v - leaderPosition(w)|
 * <= epsilon`, i.e. the distance check is ALWAYS against that one fixed
 * leader position, never against any other raw vertex that has already
 * merged into `w`. Consequently the "is within epsilon of" relation this
 * function realizes is NOT transitively closed over raw vertices: given raw
 * vertices a, b, c scanned in that order with `|a-b| <= epsilon`,
 * `|b-c| <= epsilon`, but `|a-c| > epsilon`, the result is 2 welded
 * vertices, not 1 — b merges into a's cluster (a is the leader), but when c
 * is then checked it is compared against a (still the only stored position
 * for that cluster, since b contributed no position of its own), and
 * `a`≁`c` fails the check, so c starts a new cluster. See
 * weld.test.ts's "leader clustering (non-transitive merging)" tests for a
 * worked example.
 *
 * **Buffer ownership**: `soup.positions` is only ever read, never mutated,
 * and never aliased into the result — `weldVertices` BORROWS its input and
 * always returns brand-new, disjoint `Float64Array`/`Uint32Array` buffers
 * (CLAUDE.md invariant: meshes are immutable values). Callers may reuse
 * `soup.positions` freely after this call returns.
 *
 * **Accumulation (Phase 2 Task 2 intake scalability rebuild)**: welded
 * positions are written directly into a preallocated `Float64Array` sized
 * to the worst case (`rawVertexCount * 3` — welding can only ever produce
 * at most as many distinct vertices as raw ones went in), then trimmed to
 * the actual count with a single `.slice()` copy at the end — never a plain
 * `number[]` accumulated via `.push()`. At the multi-million-vertex scale
 * this project's NFR targets (PLAN.md §7), a `number[]` boxes every
 * coordinate as a heap `Number` and `Float64Array.from()` must then convert
 * the whole thing element-by-element; writing straight into a typed array
 * (and growing nothing, since the upper bound is known up front) avoids
 * both costs. The single trailing `.slice()` is an intentional, bounded
 * O(weldedVertexCount) copy — the same one-time cost `Float64Array.from`
 * paid before, just without the boxed intermediate.
 *
 * @errorBound Vertices farther apart than `epsilon` are never merged, and
 * every merge decision is a real Euclidean-distance check against
 * `epsilon` (not just "same grid cell") — so this introduces no positional
 * error beyond `epsilon` itself (1e-6 mm — far below the 1 µm clinical
 * display resolution, PLAN.md "Units mm; measurement display resolution
 * 1 µm").
 */
export function weldVertices(soup: TriangleSoup, epsilon: number = MESH_WELD_EPSILON_MM): IndexedMesh {
  if (!(soup.positions instanceof Float64Array)) {
    throw new TypeError('weldVertices: soup.positions must be a Float64Array (kernel Float64 rule)');
  }
  if (epsilon <= 0 || !Number.isFinite(epsilon)) {
    throw new RangeError(`weldVertices: epsilon must be a positive finite number, got ${epsilon}`);
  }

  const rawVertexCount = soup.triangleCount * 3;
  const epsilonSq = epsilon * epsilon;
  const cellSize = epsilon * 2;

  // hashCell(home cell) -> welded vertex indices bucketed there (possibly
  // from several distinct colliding cells — see hashCell's doc).
  const buckets = new Map<number, number[]>();
  // Upper bound: welding can never produce more distinct vertices than raw
  // ones went in — preallocate for the worst case and trim with one
  // `.slice()` at the end (see this function's "Accumulation" doc above).
  const weldedPositions = new Float64Array(rawVertexCount * 3);
  let weldedVertexCount = 0;
  const indices = new Uint32Array(rawVertexCount);

  for (let raw = 0; raw < rawVertexCount; raw++) {
    const base = raw * 3;
    const px = soup.positions[base]!;
    const py = soup.positions[base + 1]!;
    const pz = soup.positions[base + 2]!;

    const x0 = Math.floor((px - epsilon) / cellSize);
    const x1 = Math.floor((px + epsilon) / cellSize);
    const y0 = Math.floor((py - epsilon) / cellSize);
    const y1 = Math.floor((py + epsilon) / cellSize);
    const z0 = Math.floor((pz - epsilon) / cellSize);
    const z1 = Math.floor((pz + epsilon) / cellSize);

    let matchIndex = -1;
    for (let ix = x0; ix <= x1 && matchIndex === -1; ix++) {
      for (let iy = y0; iy <= y1 && matchIndex === -1; iy++) {
        for (let iz = z0; iz <= z1 && matchIndex === -1; iz++) {
          const bucket = buckets.get(hashCell(ix, iy, iz));
          if (!bucket) continue;
          for (const candidate of bucket) {
            const cBase = candidate * 3;
            const ddx = weldedPositions[cBase]! - px;
            const ddy = weldedPositions[cBase + 1]! - py;
            const ddz = weldedPositions[cBase + 2]! - pz;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= epsilonSq) {
              matchIndex = candidate;
              break;
            }
          }
        }
      }
    }

    if (matchIndex === -1) {
      matchIndex = weldedVertexCount;
      const dst = matchIndex * 3;
      weldedPositions[dst] = px;
      weldedPositions[dst + 1] = py;
      weldedPositions[dst + 2] = pz;
      weldedVertexCount++;
      // Home cell: floor(p/cellSize) per axis — always within the probe
      // ranges above (floor((p−ε)/2ε) ≤ floor(p/2ε) ≤ floor((p+ε)/2ε)), so
      // a future query within ε of this vertex is guaranteed to probe it.
      const key = hashCell(Math.floor(px / cellSize), Math.floor(py / cellSize), Math.floor(pz / cellSize));
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(matchIndex);
      } else {
        buckets.set(key, [matchIndex]);
      }
    }
    indices[raw] = matchIndex;
  }

  return { positions: weldedPositions.slice(0, weldedVertexCount * 3), indices };
}
