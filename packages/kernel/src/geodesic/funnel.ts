// packages/kernel/src/geodesic/funnel.ts
//
// Step 3 of `geodesicPath` (see geodesicPath.ts's module doc): the "Simple
// Stupid Funnel Algorithm" (Lee & Preparata's taut-string algorithm for the
// shortest path between two points inside a simple polygon, as popularized
// for navmesh pathfinding by Mikko Mononen / Recast-Detour) run over the
// corridor's UNFOLDED 2D portals (unfold.ts) — this is the "straightening"
// half of this task's method: it finds the EXACT shortest path within the
// fixed corridor (a proven property of the funnel algorithm over a simple,
// non-self-overlapping portal sequence), which — because unfold.ts's
// flattening is an exact per-triangle isometry — corresponds one-to-one to
// the exact shortest path along the corridor's ACTUAL 3D triangle strip.
//
// The funnel's output only ever bends at PORTAL ENDPOINTS, i.e. actual mesh
// vertices (a well-known property of this algorithm: the taut string can
// only "catch" on a polygon corner, never stop partway along a portal edge)
// — `materializeGeodesic` below reconstructs the full ordered 3D polyline,
// inserting the actual triangle-edge crossing point at every intermediate
// portal a straight bend-to-bend run passes through (the segment between two
// consecutive bends is straight only in the UNFOLDED plane; in true 3D it
// bends at each triangle boundary it crosses — the length is identical
// either way, since each per-triangle sub-flattening is an exact isometry).
import type { IndexedMesh } from '../mesh/types.ts';
import type { SurfacePoint } from './types.ts';
import { evaluateSurfacePoint, triangleVertexIndices } from './surfacePoint.ts';
import { triarea2, vec2Sub, type Portal, type UnfoldedCorridor, type Vec2 } from './unfold.ts';

interface AllPortal {
  left: Vec2;
  right: Vec2;
  leftVertex: number;
  rightVertex: number;
}

interface Bend {
  /** Index into the `allPortals` array (0 = start cap, `numPortals - 1` =
   * end cap) this bend is pinned at. */
  allIndex: number;
  point: Vec2;
  /** Global mesh vertex index, or `-1` for the start/end anchor caps. */
  vertex: number;
}

/** Runs the funnel algorithm over `start2D -> portals -> end2D`, returning
 * the ordered bend sequence (always starting with the `start` cap and ending
 * with the `end` cap — see this module's top doc for why interior entries
 * are always actual portal-endpoint vertices). */
function runFunnel(start2D: Vec2, end2D: Vec2, portals: readonly Portal[]): Bend[] {
  const numPortals = portals.length + 2;
  const allPortals: AllPortal[] = new Array(numPortals);
  allPortals[0] = { left: start2D, right: start2D, leftVertex: -1, rightVertex: -1 };
  for (let j = 0; j < portals.length; j++) {
    const p = portals[j]!;
    allPortals[j + 1] = { left: p.left, right: p.right, leftVertex: p.leftVertex, rightVertex: p.rightVertex };
  }
  allPortals[numPortals - 1] = { left: end2D, right: end2D, leftVertex: -1, rightVertex: -1 };

  let apex = allPortals[0]!.left;
  let left = apex;
  let right = apex;
  let apexIdx = 0;
  let leftIdx = 0;
  let rightIdx = 0;

  const bends: Bend[] = [{ allIndex: 0, point: apex, vertex: -1 }];

  for (let i = 1; i < numPortals; i++) {
    const pLeft = allPortals[i]!.left;
    const pRight = allPortals[i]!.right;

    // Update right side of the funnel. `triarea2` here is CCW-positive
    // (unfold.ts's convention): narrowing the RIGHT boundary means sweeping
    // it CCW (toward `left`), i.e. `triarea2(apex, right, pRight) >= 0` (a
    // CCW-or-straight turn from the current right ray to the candidate); a
    // NEGATIVE value means `pRight` would WIDEN the funnel and is skipped
    // entirely (falls through, no branch below runs). Once accepted, `pRight`
    // pops the funnel (advances the apex to `left`) only if it has swept
    // CCW PAST `left` too (`triarea2(apex, left, pRight) > 0`); otherwise it
    // just tightens `right`.
    if (triarea2(apex, right, pRight) >= 0) {
      if (apexIdx === rightIdx || triarea2(apex, left, pRight) <= 0) {
        right = pRight;
        rightIdx = i;
      } else {
        bends.push({ allIndex: leftIdx, point: left, vertex: allPortals[leftIdx]!.leftVertex });
        apex = left;
        apexIdx = leftIdx;
        left = apex;
        right = apex;
        leftIdx = apexIdx;
        rightIdx = apexIdx;
        i = apexIdx;
        continue;
      }
    }

    // Update left side of the funnel — the mirror image of the right-side
    // test above: narrowing LEFT means sweeping it CW,
    // `triarea2(apex, left, pLeft) <= 0`; pops (advances apex to `right`)
    // only once `pLeft` has swept CW past `right` too
    // (`triarea2(apex, right, pLeft) < 0`).
    if (triarea2(apex, left, pLeft) <= 0) {
      if (apexIdx === leftIdx || triarea2(apex, right, pLeft) >= 0) {
        left = pLeft;
        leftIdx = i;
      } else {
        bends.push({ allIndex: rightIdx, point: right, vertex: allPortals[rightIdx]!.rightVertex });
        apex = right;
        apexIdx = rightIdx;
        left = apex;
        right = apex;
        leftIdx = apexIdx;
        rightIdx = apexIdx;
        i = apexIdx;
        continue;
      }
    }
  }

  bends.push({ allIndex: numPortals - 1, point: allPortals[numPortals - 1]!.left, vertex: -1 });
  return bends;
}

const LINE_PARALLEL_EPSILON = 1e-15;

/** 2D line-line intersection parameters: `s` along `p0->p1`, `t` along
 * `q0->q1`. `null` if (near-)parallel. Not segment-clipped — callers here
 * trust the funnel algorithm's own correctness to guarantee `t` (and `s`)
 * land in `[0, 1]` for every portal actually walked (defensively clamped at
 * the call site anyway — see `materializeGeodesic`). */
function lineIntersect(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): { s: number; t: number } | null {
  const d1 = vec2Sub(p1, p0);
  const d2 = vec2Sub(q1, q0);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < LINE_PARALLEL_EPSILON) return null;
  const dx = q0.x - p0.x;
  const dy = q0.y - p0.y;
  const s = (dx * d2.y - dy * d2.x) / denom;
  const t = (dx * d1.y - dy * d1.x) / denom;
  return { s, t };
}

function vertexPosition3(mesh: IndexedMesh, v: number): readonly [number, number, number] {
  const p = mesh.positions;
  return [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dist3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** `SurfacePoint` for global vertex `v`, attached to triangle `f` (must have
 * `v` as one of its 3 corners). */
function surfacePointAtVertex(mesh: IndexedMesh, f: number, v: number): SurfacePoint {
  const corners = triangleVertexIndices(mesh, f);
  const k = corners.indexOf(v);
  if (k === -1) {
    throw new RangeError(`surfacePointAtVertex: vertex ${v} is not a corner of triangle ${f}`);
  }
  const bary: [number, number, number] = [0, 0, 0];
  bary[k] = 1;
  return { triangleIndex: f, barycentric: bary };
}

/** `SurfacePoint` for the point at parameter `t` along the directed edge
 * `(leftVertex -> rightVertex)`, attached to triangle `f` (must have both as
 * corners). */
function surfacePointOnEdge(mesh: IndexedMesh, f: number, leftVertex: number, rightVertex: number, t: number): SurfacePoint {
  const corners = triangleVertexIndices(mesh, f);
  const kl = corners.indexOf(leftVertex);
  const kr = corners.indexOf(rightVertex);
  if (kl === -1 || kr === -1) {
    throw new RangeError(`surfacePointOnEdge: edge (${leftVertex}, ${rightVertex}) not both corners of triangle ${f}`);
  }
  const clamped = Math.min(1, Math.max(0, t));
  const bary: [number, number, number] = [0, 0, 0];
  bary[kl] = 1 - clamped;
  bary[kr] = clamped;
  return { triangleIndex: f, barycentric: bary };
}

export interface MaterializedPath {
  points: SurfacePoint[];
  length: number;
  /** Interior bend vertices (excludes the start/end caps), each tagged with
   * the `allIndex` (portal index within this call's `numPortals`) it was
   * pinned at — geodesicPath.ts's widening loop uses `allIndex` to find the
   * two corridor faces meeting at that vertex (`corridor[allIndex - 1]` and
   * `corridor[allIndex]`). */
  bendVertices: { allIndex: number; vertex: number }[];
}

/**
 * Runs the funnel algorithm over `unfolded` and reconstructs the full 3D
 * polyline (start, every intermediate triangle-boundary crossing, every
 * bend vertex, end) — see this module's top doc.
 */
export function materializeGeodesic(
  mesh: IndexedMesh,
  corridor: readonly number[],
  unfolded: UnfoldedCorridor,
  start: SurfacePoint,
  start2D: Vec2,
  end: SurfacePoint,
  end2D: Vec2,
): MaterializedPath {
  const bends = runFunnel(start2D, end2D, unfolded.portals);

  const points: SurfacePoint[] = [start];
  const positions: (readonly [number, number, number])[] = [evaluateSurfacePoint(mesh, start)];
  let totalLength = 0;

  for (let k = 0; k < bends.length - 1; k++) {
    const bendA = bends[k]!;
    const bendB = bends[k + 1]!;

    // Intermediate crossings strictly between the two bends' portal indices.
    for (let allIndex = bendA.allIndex + 1; allIndex < bendB.allIndex; allIndex++) {
      const portal = unfolded.portals[allIndex - 1]!; // allPortals[allIndex] === portals[allIndex-1]
      const hit = lineIntersect(bendA.point, bendB.point, portal.left, portal.right);
      const t = hit ? Math.min(1, Math.max(0, hit.t)) : 0.5; // defensive fallback — see lineIntersect's doc
      const face = corridor[allIndex - 1]!;
      const sp = surfacePointOnEdge(mesh, face, portal.leftVertex, portal.rightVertex, t);
      points.push(sp);
      const pos3 = lerp3(vertexPosition3(mesh, portal.leftVertex), vertexPosition3(mesh, portal.rightVertex), t);
      positions.push(pos3);
    }

    // The endpoint of this bend-to-bend run.
    if (k + 1 === bends.length - 1) {
      points.push(end);
      positions.push(evaluateSurfacePoint(mesh, end));
    } else {
      const face = corridor[Math.max(0, bendB.allIndex - 1)]!;
      const sp = surfacePointAtVertex(mesh, face, bendB.vertex);
      points.push(sp);
      positions.push(vertexPosition3(mesh, bendB.vertex));
    }
  }

  for (let i = 1; i < positions.length; i++) {
    totalLength += dist3(positions[i - 1]!, positions[i]!);
  }

  const bendVertices = bends
    .slice(1, -1)
    .filter((b) => b.vertex !== -1)
    .map((b) => ({ allIndex: b.allIndex, vertex: b.vertex }));

  return { points, length: totalLength, bendVertices };
}

export { runFunnel };
