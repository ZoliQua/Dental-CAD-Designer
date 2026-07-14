// packages/kernel/src/geodesic/unfold.ts
//
// Step 2 of `geodesicPath` (see geodesicPath.ts's module doc): sequentially
// "unfolds" (develops) an ordered corridor of triangles into a single shared
// 2D plane, preserving every triangle's actual 3D edge lengths exactly (an
// isometric per-triangle flattening — a standard technique for approximate
// geodesics on triangulated surfaces: straighten a path by flattening the
// strip of triangles it crosses, then working in 2D). funnel.ts then runs
// the standard "taut string" funnel algorithm over this flattened corridor.
//
// ## The hinge-unfold rule
//
// `corridor[0]` is placed directly from its own 3 actual edge lengths
// (`unfoldFirstFace`). Each subsequent `corridor[i]` shares exactly one edge
// (2 vertices) with `corridor[i-1]` (guaranteed by `dualGraphDijkstra` only
// ever stepping across a shared mesh edge) — its ONE new vertex is placed by
// a 2-circle intersection using the 2 already-fixed shared-edge 2D positions
// and the 2 REAL 3D distances from the new vertex to them (law of cosines),
// then the ambiguous "which of the 2 circle-intersection solutions" is
// resolved by picking the point on the OPPOSITE side of the shared edge from
// `corridor[i-1]`'s own third (non-shared) vertex — the same side any two
// triangles sharing an edge in ANY valid 2-manifold triangulation are always
// on (this is exactly "unfolding a hinge flat": the true dihedral angle
// between the two triangles is flattened to 0/180°, but the two triangles
// never end up on the SAME side of their shared edge). For an
// ALREADY-COPLANAR strip of triangles (e.g. a flat mesh), this rule
// reproduces the mesh's true flat 2D shape EXACTLY (up to a rigid motion) —
// see unfold.test.ts's flat-strip test, which backs this module's planar
// "exact straight line" acceptance case (geodesicPath.analytic.test.ts).
//
// ## Vertex revisits (documented simplification)
//
// If the corridor loops back near itself (rare — needs a tight bend in a
// coarse mesh), a global vertex index can appear as the "new" vertex of more
// than one corridor face. This module keeps the FIRST-computed 2D position
// for such a vertex (later occurrences reuse it rather than re-deriving a
// possibly slightly different position) — a standard simplification other
// practical "unfold and straighten" geodesic implementations make too; it
// does not affect the acceptance test (a generically-triangulated icosphere
// at the subdivision this task uses does not produce revisiting corridors
// for the seeded point pairs — see geodesicPath.analytic.test.ts).
import type { IndexedMesh } from '../mesh/types.ts';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec2Sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vec2Length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

/** Twice the signed area of triangle (a, b, c) — positive if a->b->c winds
 * CCW. The funnel algorithm's core primitive (funnel.ts). */
export function triarea2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

function vertexPosition3(mesh: IndexedMesh, v: number): readonly [number, number, number] {
  const p = mesh.positions;
  return [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
}

function dist3(mesh: IndexedMesh, a: number, b: number): number {
  const pa = vertexPosition3(mesh, a);
  const pb = vertexPosition3(mesh, b);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

/**
 * Places a new point `c` at 2D distances `da`/`db` from already-fixed points
 * `a`/`b`, choosing the solution on the side of line `a->b` indicated by
 * `positiveSide` (the sign of `triarea2(a, b, c)`: `true` picks the CCW/
 * positive-area solution, `false` the CW/negative-area one). Degenerate
 * (near-collinear/impossible triangle inequality violated by Float64
 * rounding at a near-flat dihedral angle) cases clamp the height to 0
 * (`c` placed exactly on line `a->b`) rather than producing NaN.
 */
function placeThirdPoint(a: Vec2, b: Vec2, da: number, db: number, positiveSide: boolean): Vec2 {
  const ab = vec2Sub(b, a);
  const l = vec2Length(ab);
  if (l === 0) {
    // Degenerate shared edge (zero length — a genuinely degenerate input
    // triangle slipped past intake). Fall back to placing c at distance da
    // from a along an arbitrary axis rather than dividing by zero.
    return { x: a.x + da, y: a.y };
  }
  const ux = ab.x / l;
  const uy = ab.y / l;
  const x = (da * da - db * db + l * l) / (2 * l);
  const hSq = da * da - x * x;
  const h = Math.sqrt(Math.max(0, hSq));
  // Perpendicular to (ux,uy), rotated +90 degrees: (-uy, ux).
  const px = -uy;
  const py = ux;
  const signedH = positiveSide ? h : -h;
  return { x: a.x + x * ux + signedH * px, y: a.y + x * uy + signedH * py };
}

/** One internal portal — the shared edge between `corridor[i]` and
 * `corridor[i+1]` — in the fixed `(left, right)` convention funnel.ts's
 * Simple Stupid Funnel Algorithm implementation expects (verified by
 * unfold.test.ts's / funnel.test.ts's flat-strip cases: this ordering is
 * exactly `corridor[i+1]`'s own winding order for that edge, starting right
 * after its non-shared vertex — see `sequentialUnfold`'s top doc). */
export interface Portal {
  leftVertex: number;
  rightVertex: number;
  left: Vec2;
  right: Vec2;
}

export interface UnfoldedCorridor {
  /** `corridor.length` entries; `face2D[i]` is corridor face `corridor[i]`'s
   * 3 corner 2D positions, in the SAME winding order as
   * `mesh.indices[corridor[i]*3 + 0..2]`. */
  face2D: [Vec2, Vec2, Vec2][];
  /** First-seen 2D position per global vertex index touched by the corridor
   * — see this module's "vertex revisits" doc. */
  vertex2D: Map<number, Vec2>;
  /** `corridor.length - 1` entries: `portals[i]` is the shared-edge portal
   * between `corridor[i]` and `corridor[i+1]`. */
  portals: Portal[];
}

/** The 3 global vertex indices of triangle `f`, in winding order. */
function faceCorners(mesh: IndexedMesh, f: number): [number, number, number] {
  return [mesh.indices[f * 3]!, mesh.indices[f * 3 + 1]!, mesh.indices[f * 3 + 2]!];
}

/** A single triangle's placement within a hinge-unfold chain: its 3 global
 * vertex indices (winding order) and their 2D positions in whatever frame
 * the chain started from. The reusable single-step primitive behind both
 * `sequentialUnfold` (below) and corridor.ts's incremental-unfold Dijkstra
 * (which needs a per-relaxation single-step placement, not a whole
 * pre-built corridor). */
export interface FacePlacement {
  face: number;
  corners: [number, number, number];
  positions: [Vec2, Vec2, Vec2];
}

/** Base case: places `face`'s own 3 vertices from its actual 3D edge
 * lengths, starting a new hinge-unfold chain (corner 0 at the origin,
 * corner 1 along +x — see this module's top doc). */
export function placeFirstFace(mesh: IndexedMesh, face: number): FacePlacement {
  const corners = faceCorners(mesh, face);
  const [v0, v1, v2] = corners;
  const l01 = dist3(mesh, v0, v1);
  const p0: Vec2 = { x: 0, y: 0 };
  const p1: Vec2 = { x: l01, y: 0 };
  const p2 = placeThirdPoint(p0, p1, dist3(mesh, v0, v2), dist3(mesh, v1, v2), true);
  return { face, corners, positions: [p0, p1, p2] };
}

/**
 * Places `face` (which must share exactly one edge — 2 vertices — with
 * `prev`) into `prev`'s SAME 2D frame, via the hinge-unfold rule (this
 * module's top doc): `face`'s one new vertex is placed opposite `prev`'s own
 * non-shared vertex across their shared edge.
 *
 * @throws {RangeError} if `face` doesn't share exactly 2 vertices with
 * `prev` (not actually adjacent — an invalid corridor/relaxation step).
 */
export function placeNextFace(mesh: IndexedMesh, prev: FacePlacement, face: number): FacePlacement {
  const corners = faceCorners(mesh, face);
  const prevSet = new Set(prev.corners);
  let newLocal = -1;
  for (let k = 0; k < 3; k++) {
    if (!prevSet.has(corners[k]!)) {
      newLocal = k;
      break;
    }
  }
  if (newLocal === -1) {
    throw new RangeError(`placeNextFace: faces ${prev.face} and ${face} share all 3 vertices (duplicate/degenerate step)`);
  }
  const a = corners[(newLocal + 1) % 3]!;
  const b = corners[(newLocal + 2) % 3]!;
  const newVertex = corners[newLocal]!;

  const aLocal = prev.corners.indexOf(a);
  const bLocal = prev.corners.indexOf(b);
  if (aLocal === -1 || bLocal === -1) {
    throw new RangeError(`placeNextFace: shared edge (${a}, ${b}) not found on face ${prev.face} — not actually adjacent to ${face}`);
  }
  const aPos = prev.positions[aLocal]!;
  const bPos = prev.positions[bLocal]!;

  const prevApexLocal = prev.corners.findIndex((v) => v !== a && v !== b);
  const prevApex2D = prev.positions[prevApexLocal]!;

  const da = dist3(mesh, a, newVertex);
  const db = dist3(mesh, b, newVertex);
  const prevSide = triarea2(aPos, bPos, prevApex2D) > 0;
  const newPos = placeThirdPoint(aPos, bPos, da, db, !prevSide);

  const placed: [Vec2, Vec2, Vec2] = [aPos, aPos, aPos]; // placeholder, overwritten below
  placed[newLocal as 0 | 1 | 2] = newPos;
  placed[((newLocal + 1) % 3) as 0 | 1 | 2] = aPos;
  placed[((newLocal + 2) % 3) as 0 | 1 | 2] = bPos;
  return { face, corners, positions: placed };
}

/**
 * Sequentially unfolds `corridor` (an ordered list of triangle indices, each
 * consecutive pair sharing exactly one mesh edge — see `dualGraphDijkstra`)
 * into a single shared 2D plane, via `placeFirstFace`/`placeNextFace`. See
 * this module's top doc for the hinge-unfold rule, its "reproduces flat
 * geometry exactly" property, and the vertex-revisit simplification applied
 * here (a REVISITED vertex's position is reused from its first placement,
 * rather than trusting a later step's possibly-different re-derivation —
 * `placeFirstFace`/`placeNextFace` themselves have no notion of revisits,
 * only this whole-corridor wrapper does).
 *
 * @throws {RangeError} if two consecutive corridor entries do not share
 * exactly 2 vertices (an invalid/non-adjacent corridor — a `corridor.ts`/
 * `geodesicPath.ts` bug, never expected from normal callers).
 */
export function sequentialUnfold(mesh: IndexedMesh, corridor: readonly number[]): UnfoldedCorridor {
  if (corridor.length === 0) {
    throw new RangeError('sequentialUnfold: corridor must have at least one face');
  }

  const vertex2D = new Map<number, Vec2>();
  const face2D: [Vec2, Vec2, Vec2][] = [];
  const portals: Portal[] = [];

  let prev = placeFirstFace(mesh, corridor[0]!);
  face2D.push(prev.positions);
  prev.corners.forEach((v, i) => vertex2D.set(v, prev.positions[i]!));

  for (let i = 1; i < corridor.length; i++) {
    const next = placeNextFace(mesh, prev, corridor[i]!);
    const prevSet = new Set(prev.corners);
    const newLocal = next.corners.findIndex((v) => !prevSet.has(v));
    const newVertex = next.corners[newLocal]!;
    const a = next.corners[(newLocal + 1) % 3]!;
    const b = next.corners[(newLocal + 2) % 3]!;

    let positions = next.positions;
    if (vertex2D.has(newVertex)) {
      positions = [...next.positions] as [Vec2, Vec2, Vec2];
      positions[newLocal as 0 | 1 | 2] = vertex2D.get(newVertex)!; // revisit — see top doc.
    } else {
      vertex2D.set(newVertex, next.positions[newLocal as 0 | 1 | 2]!);
    }

    face2D.push(positions);
    portals.push({
      leftVertex: a,
      rightVertex: b,
      left: positions[(newLocal + 1) % 3]!,
      right: positions[(newLocal + 2) % 3]!,
    });
    prev = { face: next.face, corners: next.corners, positions };
  }

  return { face2D, vertex2D, portals };
}
