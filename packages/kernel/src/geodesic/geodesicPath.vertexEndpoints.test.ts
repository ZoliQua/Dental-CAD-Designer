// packages/kernel/src/geodesic/geodesicPath.vertexEndpoints.test.ts
//
// REGRESSION test for the "one-ring seed extension" fix (see corridor.ts's
// module doc "One-ring seed extension (vertex-exact endpoints)" and
// geodesicPath.ts's `@errorBound`): p2-task-4-report.md's self-review noted
// that vertex-EXACT endpoints (a legitimate arbitrary surface point —
// `materializeGeodesic` itself emits them as funnel bend points, and a
// Phase 3 margin re-snap round-trips through them as a later call's
// endpoint) reached up to ~0.55% length error under fast-check's
// shrink-biased vertex-hunting sampling — over 5x the 0.1% acceptance
// budget geodesicPath.analytic.test.ts measures for typical (non-vertex)
// points. The root cause: `dualGraphDijkstra` seeded (or terminated) the
// search from only ONE, essentially arbitrary, triangle incident to the
// vertex, biasing the incrementally-unfolded distance metric toward that
// triangle's local "wedge" of the one-ring. The fix seeds/terminates from
// EVERY incident triangle simultaneously (corridor.ts) so the choice of
// attachment triangle no longer matters at all — this file's "attachment
// invariance" test below proves that directly, and the "budget" test below
// measures the resulting accuracy on a seeded vertex-pair sample.
//
// Same fixture as the acceptance test (icosphere r=5 subdiv=5, 20480
// triangles) and same 0.1% acceptance budget — this is the SAME phase
// acceptance criterion ("geodesic on icosphere vs analytic great-circle
// length error < 0.1%"), just re-measured specifically for vertex-anchored
// endpoint pairs rather than typical interior points, since the two turned
// out (before this fix) to have measurably different error profiles.
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { geodesicPath } from './geodesicPath.ts';
import { evaluateSurfacePoint } from './surfacePoint.ts';
import type { SurfacePoint } from './types.ts';

const PROPERTY_SEED = 20260712; // same seed as geodesicPath.analytic.test.ts — see this project's determinism convention
const NUM_PAIRS = 30; // >= 25 per this task's brief
const ACCEPTANCE_BOUND = 1e-3; // 0.1% — same budget as the main icosphere acceptance test

/** Small, deterministic PRNG (mulberry32) — same as geodesicPath.analytic.test.ts's. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(p: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / len, p[1] / len, p[2] / len];
}

/** Same analytic great-circle helper as geodesicPath.analytic.test.ts's. */
function greatCircleLength(radius: number, a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const na = normalize(a);
  const nb = normalize(b);
  const cosAngle = Math.min(1, Math.max(-1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
  return radius * Math.acos(cosAngle);
}

/** `mesh`'s global vertex -> (any ONE incident triangle, local corner)
 * index, built once per test (`indices` scanned in increasing face order —
 * an arbitrary but deterministic choice, exactly the kind of "whichever
 * triangle a caller happened to attach the point to" this fix makes
 * irrelevant). */
function buildVertexToFace(mesh: { indices: Uint32Array }): { face: number; corner: 0 | 1 | 2 }[] {
  const faceCount = mesh.indices.length / 3;
  const vertexCount = Math.max(...Array.from(mesh.indices)) + 1;
  const out: { face: number; corner: 0 | 1 | 2 }[] = new Array(vertexCount);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[f * 3 + k]!;
      if (out[v] === undefined) out[v] = { face: f, corner: k as 0 | 1 | 2 };
    }
  }
  return out;
}

function vertexExactSurfacePoint(entry: { face: number; corner: 0 | 1 | 2 }): SurfacePoint {
  const barycentric: [number, number, number] = [0, 0, 0];
  barycentric[entry.corner] = 1;
  return { triangleIndex: entry.face, barycentric };
}

describe('geodesicPath — vertex-exact endpoint REGRESSION (one-ring seed extension)', () => {
  const radius = 5;
  const subdivisions = 5; // same fixture as the main icosphere ACCEPTANCE test
  const mesh = icosphereMesh(radius, subdivisions);
  const hm = buildHalfedge(mesh);
  const vertexToFace = buildVertexToFace(mesh);
  const vertexCount = vertexToFace.length;

  it(`>= ${NUM_PAIRS} seeded vertex-anchored pairs (BOTH endpoints vertex-exact), each within ${(ACCEPTANCE_BOUND * 100).toFixed(2)}%`, () => {
    const rand = mulberry32(PROPERTY_SEED);
    let maxRelError = 0;
    let pairsChecked = 0;

    for (let i = 0; i < NUM_PAIRS; i++) {
      const va = Math.floor(rand() * vertexCount) % vertexCount;
      let vb = Math.floor(rand() * vertexCount) % vertexCount;
      if (vb === va) vb = (vb + 1) % vertexCount; // distinct vertices — avoid the trivial length-0 case
      const start = vertexExactSurfacePoint(vertexToFace[va]!);
      const end = vertexExactSurfacePoint(vertexToFace[vb]!);

      const result = geodesicPath(mesh, hm, start, end);
      const analytic = greatCircleLength(radius, evaluateSurfacePoint(mesh, start), evaluateSurfacePoint(mesh, end));
      const relError = analytic > 1e-9 ? Math.abs(result.length - analytic) / analytic : 0;
      if (relError > maxRelError) maxRelError = relError;
      pairsChecked++;
      expect(relError).toBeLessThan(ACCEPTANCE_BOUND);
    }

    expect(pairsChecked).toBe(NUM_PAIRS);
    console.log(
      `[geodesicPath vertex-endpoint regression] icosphere r=${radius} subdiv=${subdivisions}: ` +
        `${NUM_PAIRS} vertex-anchored pairs, measured max relative error = ${(maxRelError * 100).toFixed(4)}% ` +
        `(budget: ${(ACCEPTANCE_BOUND * 100).toFixed(2)}%)`,
    );
  });

  it('attachment invariance: the result does not depend on WHICH incident triangle a vertex-exact endpoint is attached to', () => {
    // This is the direct mechanism check behind the budget test above: pick
    // a handful of vertex pairs and, for EACH triangle in the start
    // vertex's one-ring, run geodesicPath against the SAME end point — all
    // must agree exactly (bit-identical length), proving the one-ring seed
    // extension has fully eliminated the single-triangle attachment bias
    // p2-task-4-report.md's self-review measured (previously up to ~0.55%
    // error, DIRECTLY attributable to this bias — see corridor.ts's module
    // doc).
    const faceCount = mesh.indices.length / 3;
    function facesContainingVertex(v: number): { face: number; corner: 0 | 1 | 2 }[] {
      const out: { face: number; corner: 0 | 1 | 2 }[] = [];
      for (let f = 0; f < faceCount; f++) {
        for (let k = 0; k < 3; k++) {
          if (mesh.indices[f * 3 + k] === v) out.push({ face: f, corner: k as 0 | 1 | 2 });
        }
      }
      return out;
    }

    const rand = mulberry32(PROPERTY_SEED + 1);
    const NUM_CHECKED = 8;
    for (let i = 0; i < NUM_CHECKED; i++) {
      const va = Math.floor(rand() * vertexCount) % vertexCount;
      let vb = Math.floor(rand() * vertexCount) % vertexCount;
      if (vb === va) vb = (vb + 1) % vertexCount;
      const end = vertexExactSurfacePoint(vertexToFace[vb]!);
      const oneRing = facesContainingVertex(va);
      expect(oneRing.length).toBeGreaterThan(0);

      const lengths = oneRing.map((entry) => geodesicPath(mesh, hm, vertexExactSurfacePoint(entry), end).length);
      const first = lengths[0]!;
      for (const length of lengths) {
        expect(length).toBe(first); // bit-identical — not just "close"
      }
    }
  });
});
