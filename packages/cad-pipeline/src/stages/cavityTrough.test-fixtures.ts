// packages/cad-pipeline/src/stages/cavityTrough.test-fixtures.ts
//
// TEST-ONLY break-through trough fixture shared by the cavity STAGE tests
// (cavityOcclusalPatch.test.ts, cavityProximalContact.test.ts) — extracted
// verbatim from cavityOcclusalPatch.test.ts when Task 5 needed the same
// fixture. A watertight box with a top channel open at both ±X ends — the
// minimal MOD analogue: the channel-opening rim carries two OCCLUSAL SEAM runs
// (the flat top beside the channel is the surrounding surface) plus two
// proximal FREE runs (the cut ends at ±X). Built inline because a
// cross-package import of @dqcad/kernel's TEST fixtures sits outside
// cad-pipeline's tsconfig rootDir (the same constraint the crown/cavity inner
// stage tests note). NOT exported from the package index (test-fixture
// convention, same as kernel's cavity.test-fixtures.ts).
import type { Vec3 } from '@dqcad/shared-types';
import { orientNormalsConsistently, type IndexedMesh } from '@dqcad/kernel';

/** Trough half-length in X — the proximal break-through planes sit at ±this. */
export const TROUGH_HALF_LENGTH_MM = 4;

/** Optional knobs — the default (no args) is the original fixture, unchanged
 * (every existing caller passes nothing). `floorMm` raises the channel floor to
 * make a DELIBERATELY-SHALLOW cavity (Phase 5 Task 6: the thin-inlay variant
 * that must BLOCK on the thickness gate). */
export interface TroughFixtureOptions {
  /** Channel floor height Z (mm). Default 1.5 (channel depth H−F = 1.5 mm). A
   * higher value makes the cavity shallower (a thinner inlay). */
  readonly floorMm?: number;
}

export function troughFixture(opts: TroughFixtureOptions = {}): { mesh: IndexedMesh; outline: Vec3[] } {
  const L = TROUGH_HALF_LENGTH_MM, W = 3, H = 3, c = 1, F = opts.floorMm ?? 1.5; // half-length, half-width, top, channel half-width, floor
  const nx = 4;
  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(i === 0 ? -L : i === nx ? L : -L + (2 * L * i) / nx);

  const vIndex = new Map<string, number>();
  const pos: number[] = [];
  const vid = (p: Vec3): number => {
    const k = `${p[0]}|${p[1]}|${p[2]}`;
    const e = vIndex.get(k);
    if (e !== undefined) return e;
    const i = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    vIndex.set(k, i);
    return i;
  };
  const tris: number[] = [];
  const tri = (a: Vec3, b: Vec3, c2: Vec3): void => {
    const ia = vid(a), ib = vid(b), ic = vid(c2);
    if (ia === ib || ib === ic || ia === ic) return;
    tris.push(ia, ib, ic);
  };
  const quad = (a: Vec3, b: Vec3, c2: Vec3, d: Vec3): void => {
    tri(a, b, c2);
    tri(a, c2, d);
  };

  for (let s = 0; s < xs.length - 1; s++) {
    const x0 = xs[s]!, x1 = xs[s + 1]!;
    // A) bottom z=0
    quad([x0, -W, 0], [x1, -W, 0], [x1, W, 0], [x0, W, 0]);
    // B/C) top strips z=H
    quad([x0, -W, H], [x0, -c, H], [x1, -c, H], [x1, -W, H]);
    quad([x0, c, H], [x0, W, H], [x1, W, H], [x1, c, H]);
    // D/E) outer sides y=±W
    quad([x0, -W, 0], [x0, -W, H], [x1, -W, H], [x1, -W, 0]);
    quad([x0, W, 0], [x1, W, 0], [x1, W, H], [x0, W, H]);
    // F/G) channel walls y=±c, z∈[F,H]
    quad([x0, -c, F], [x0, -c, H], [x1, -c, H], [x1, -c, F]);
    quad([x0, c, F], [x1, c, F], [x1, c, H], [x0, c, H]);
    // H) channel floor z=F, y∈[-c,c]
    quad([x0, -c, F], [x1, -c, F], [x1, c, F], [x0, c, F]);
  }
  // proximal frames at x=±L — the ⊓-with-notch cross-section (project to y,z)
  const buildFrame = (x: number): void => {
    const poly: Vec3[] = [
      [x, -W, 0], [x, W, 0], [x, W, H], [x, c, H], [x, c, F], [x, -c, F], [x, -c, H], [x, -W, H],
    ];
    const uv = poly.map((p) => [p[1], p[2]] as [number, number]);
    for (const [ia, ib, ic] of earClip(uv)) tri(poly[ia]!, poly[ib]!, poly[ic]!);
  };
  buildFrame(-L);
  buildFrame(L);

  let mesh: IndexedMesh = orientNormalsConsistently({ positions: new Float64Array(pos), indices: new Uint32Array(tris) }).mesh;
  if (sixSignedVolume(mesh.positions, mesh.indices) < 0) {
    const flipped = mesh.indices.slice();
    for (let t = 0; t < flipped.length; t += 3) {
      const b = flipped[t + 1]!;
      flipped[t + 1] = flipped[t + 2]!;
      flipped[t + 2] = b;
    }
    mesh = { positions: mesh.positions, indices: flipped };
  }

  // outline (channel-opening rim), same structure as modCavityMesh
  const outline: Vec3[] = [];
  for (const x of xs) outline.push([x, -c, H]); // buccal margin
  outline.push([L, -c, F], [L, c, F], [L, c, H]); // distal U
  for (let i = xs.length - 2; i >= 0; i--) outline.push([xs[i]!, c, H]); // lingual margin
  outline.push([-L, c, F], [-L, -c, F]); // mesial U
  return { mesh, outline };
}

function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length;
  const idx = poly.map((_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    area2 += poly[i]![0] * poly[(i + 1) % n]![1] - poly[(i + 1) % n]![0] * poly[i]![1];
  }
  if (area2 < 0) idx.reverse();
  const cr = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const inTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => {
    const d1 = cr(ax, ay, bx, by, px, py), d2 = cr(bx, by, cx, cy, px, py), d3 = cr(cx, cy, ax, ay, px, py);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const out: [number, number, number][] = [];
  const v = idx.slice();
  let guard = 0;
  while (v.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!, b = v[i]!, c = v[(i + 1) % v.length]!;
      const [ax, ay] = poly[a]!, [bx, by] = poly[b]!, [cx, cy] = poly[c]!;
      if (cr(ax, ay, bx, by, cx, cy) <= 0) continue;
      let any = false;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        if (inTri(poly[p]![0], poly[p]![1], ax, ay, bx, by, cx, cy)) { any = true; break; }
      }
      if (any) continue;
      out.push([a, b, c]);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) out.push([v[0]!, v[1]!, v[2]!]);
  return out;
}

function sixSignedVolume(positions: Float64Array, indices: Uint32Array): number {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol;
}

/** Outward-wound axis-aligned box (CCW from outside) — the P4 T6 synthetic
 * neighbour pattern, shared by the Task-5 stage test. */
export function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const idx = [
    0, 3, 2, 0, 2, 1,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
  ];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
