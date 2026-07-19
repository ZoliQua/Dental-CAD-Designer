// packages/kernel/src/register/sampling.ts
//
// Deterministic, seeded, AREA-WEIGHTED sampling of points on a mesh's
// surface — icpRefine's "sample points on src" step (see that file's module
// doc). Area weighting (not per-vertex or per-triangle-uniform sampling) is
// what gives an unbiased approximation of "uniform density on the surface"
// for a real intake scan, whose triangle density/size varies substantially
// across a mesh (dense near a margin, coarse on a flat occlusal table) — a
// per-triangle-uniform draw would systematically over-sample small/dense
// regions and under-sample large/coarse ones, biasing ICP's correspondence
// set toward whatever the SCANNER happened to tessellate finely, not the
// underlying geometry.
//
// @errorBound: this is a Monte Carlo estimator of a uniform-density surface
// sample, not an exact regular sampling — for a FIXED seed and sampleCount
// it is perfectly deterministic (CLAUDE.md invariant 2: same inputs, params,
// kernel version => bit-identical output), but two different seeds/counts
// select different (equally valid) point sets, and icpRefine's convergence
// point can differ slightly between them — bounded, in practice, by how
// well `count` points approximate the true surface distribution (see
// icpRefine.ts's own `@errorBound` for the composed effect on the final
// transform).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { mulberry32, type Rng } from './prng.ts';

function triangleVertices(mesh: IndexedMesh, t: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[t * 3]!;
  const i1 = mesh.indices[t * 3 + 1]!;
  const i2 = mesh.indices[t * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/** Smallest index `i` such that `cumulative[i] >= target` — plain binary
 * search over the ascending `cumulative` array `samplePointsOnMesh` below
 * builds; no randomness here, only the RNG-derived `target` is random. */
function upperBound(cumulative: Float64Array, target: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SamplePointsResult {
  /** Flat xyz per sample, length `count * 3`. */
  points: Float64Array;
  /** Which triangle each sample landed on — length `count`. */
  triangleIndices: Uint32Array;
}

/**
 * Samples `count` points on `mesh`'s surface, area-weighted, using a seeded
 * PRNG (`mulberry32(seed)` — see prng.ts) so the SAME `(mesh, count, seed)`
 * always produces the SAME points (CLAUDE.md invariant 2). Per sample: pick
 * a triangle with probability proportional to its area (cumulative-area
 * binary search), then a uniform point within it via Osada et al.'s
 * sqrt-based barycentric method (`sqrt(r1)` warps a uniform unit-square draw
 * into a uniform TRIANGLE draw — standard, closed-form, no rejection
 * sampling needed).
 *
 * @throws {RangeError} for a zero-triangle/zero-area mesh, or `count <= 0`.
 */
export function samplePointsOnMesh(mesh: IndexedMesh, count: number, seed: number): SamplePointsResult {
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount === 0) {
    throw new RangeError('samplePointsOnMesh: mesh has no triangles');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError('samplePointsOnMesh: count must be a positive integer');
  }

  const cumulative = new Float64Array(triangleCount);
  let total = 0;
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = triangleVertices(mesh, t);
    total += triangleArea(a, b, c);
    cumulative[t] = total;
  }
  if (!(total > 0)) {
    throw new RangeError('samplePointsOnMesh: mesh has zero total surface area (degenerate)');
  }

  const rng: Rng = mulberry32(seed);
  const points = new Float64Array(count * 3);
  const triangleIndices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const target = rng() * total;
    const t = Math.min(upperBound(cumulative, target), triangleCount - 1);
    const [a, b, c] = triangleVertices(mesh, t);
    const r1 = rng();
    const r2 = rng();
    const sqrtR1 = Math.sqrt(r1);
    const wa = 1 - sqrtR1;
    const wb = sqrtR1 * (1 - r2);
    const wc = sqrtR1 * r2;
    points[i * 3] = wa * a[0] + wb * b[0] + wc * c[0];
    points[i * 3 + 1] = wa * a[1] + wb * b[1] + wc * c[1];
    points[i * 3 + 2] = wa * a[2] + wb * b[2] + wc * c[2];
    triangleIndices[i] = t;
  }
  return { points, triangleIndices };
}
