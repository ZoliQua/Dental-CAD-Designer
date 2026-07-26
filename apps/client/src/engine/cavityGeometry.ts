// apps/client/src/engine/cavityGeometry.ts
//
// Phase 5 Task 8 — a CLIENT-SIDE analytic MOD-cavity fixture for the browser-lane
// critical-path test (ui/CavityDesignPanel.dom.test.tsx). It is the engine-layer
// twin of the kernel's TEST-ONLY `modCavityMesh` (packages/kernel/src/cavity/
// cavity.test-fixtures.ts): the SAME closed-form direct-sweep construction and
// the SAME exact on-mesh cavity outline, ported here because the layer rule bars
// apps/client from importing `@dqcad/kernel` (ui → engine → kernel-workers). The
// one kernel dependency the fixture had — `orientNormalsConsistently` for
// globally-consistent outward winding — is replaced by the self-contained
// `orientConsistently` below (BFS edge-adjacency flood-fill + a signed-volume
// global flip), so the returned mesh is a watertight closed 2-manifold with
// outward normals that the real cavity worker jobs accept unchanged. Verified
// against the kernel ops (`buildCavityInnerSurface`/`buildOcclusalPatch`/
// `constructInlayShell`) before wiring the browser test.
//
// Pure Float64 geometry, no DOM/Three.js. Used ONLY by the dom test (a fixture,
// not production UI); it lives in engine/ so the ui test may import it under the
// layer rule.
import type { IndexedBuffers } from './crownGeometry';

type Vec3 = readonly [number, number, number];

export interface ClientModCavity {
  mesh: IndexedBuffers;
  /** The exact cavosurface outline — an ordered closed ring, every point a mesh
   * vertex (the "margin currency" the fit/patch stages consume). */
  cavityOutline: Vec3[];
}

export interface ClientModCavityOptions {
  lengthMm?: number;
  widthMm?: number;
  tableZ?: number;
  cuspHeightMm?: number;
  isthmusWidthMm?: number;
  isthmusDepthMm?: number;
  boxDepthMm?: number;
  boxLengthMm?: number;
  taperDeg?: number;
  mdSegmentsPerZone?: number;
}

/** Endpoints pinned EXACTLY to `a`/`b` so adjacent zones share bit-identical
 * station coordinates the vertex-dedup map merges (a one-ULP mismatch silently
 * un-welds a shared ring). */
function linspace(a: number, b: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) out.push(i === 0 ? a : i === segments ? b : a + ((b - a) * i) / segments);
  return out;
}

/** Ear-clip a SIMPLE 2D polygon; returns index triples into `poly`. O(n²) — the
 * proximal-frame cap is a ~10-vertex polygon. Orientation-agnostic. */
function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ux, uy] = poly[i]!;
    const [vx, vy] = poly[(i + 1) % n]!;
    area2 += ux * vy - vx * uy;
  }
  if (area2 < 0) idx.reverse();
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const inTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => {
    const d1 = cross(ax, ay, bx, by, px, py);
    const d2 = cross(bx, by, cx, cy, px, py);
    const d3 = cross(cx, cy, ax, ay, px, py);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const tris: [number, number, number][] = [];
  const v = idx.slice();
  let guard = 0;
  while (v.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!;
      const b = v[i]!;
      const c = v[(i + 1) % v.length]!;
      const [ax, ay] = poly[a]!;
      const [bx, by] = poly[b]!;
      const [cx, cy] = poly[c]!;
      if (cross(ax, ay, bx, by, cx, cy) <= 0) continue;
      let anyInside = false;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        const [px, py] = poly[p]!;
        if (inTri(px, py, ax, ay, bx, by, cx, cy)) {
          anyInside = true;
          break;
        }
      }
      if (anyInside) continue;
      tris.push([a, b, c]);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) tris.push([v[0]!, v[1]!, v[2]!]);
  return tris;
}

/** Consistent OUTWARD orientation without moving any vertex: BFS over the
 * triangle edge-adjacency graph flips faces so neighbours traverse their shared
 * edge in opposite directions, then a single signed-volume test flips the whole
 * mesh if it came out inward. Replaces the kernel's `orientNormalsConsistently`
 * for this fixture (the mesh is already a closed 2-manifold, so every interior
 * edge is shared by exactly two faces). */
function orientConsistently(positions: Float64Array, indices: Uint32Array): IndexedBuffers {
  const triCount = indices.length / 3;
  const out = indices.slice();
  const key = (u: number, v: number): string => (u < v ? `${u}_${v}` : `${v}_${u}`);
  // undirected edge -> the (≤2) triangles touching it
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const a = out[3 * t]!, b = out[3 * t + 1]!, c = out[3 * t + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = key(u, v);
      const list = edgeTris.get(k);
      if (list) list.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  const flip = (t: number): void => {
    const b = out[3 * t + 1]!;
    out[3 * t + 1] = out[3 * t + 2]!;
    out[3 * t + 2] = b;
  };
  /** Does triangle `t` traverse directed edge u→v? */
  const hasDirected = (t: number, u: number, v: number): boolean => {
    const a = out[3 * t]!, b = out[3 * t + 1]!, c = out[3 * t + 2]!;
    return (a === u && b === v) || (b === u && c === v) || (c === u && a === v);
  };
  const visited = new Uint8Array(triCount);
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const stack = [seed];
    while (stack.length > 0) {
      const t = stack.pop()!;
      const a = out[3 * t]!, b = out[3 * t + 1]!, c = out[3 * t + 2]!;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const neighbours = edgeTris.get(key(u, v)) ?? [];
        for (const nt of neighbours) {
          if (nt === t || visited[nt]) continue;
          // Consistent iff the neighbour traverses the shared edge in the
          // OPPOSITE direction (v→u). If it also has u→v, flip it.
          if (hasDirected(nt, u, v)) flip(nt);
          visited[nt] = 1;
          stack.push(nt);
        }
      }
    }
  }
  // Global outward flip via signed volume (∑ v0·(v1×v2) / 6).
  let vol6 = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = out[3 * t]!, ib = out[3 * t + 1]!, ic = out[3 * t + 2]!;
    const ax = positions[3 * ia]!, ay = positions[3 * ia + 1]!, az = positions[3 * ia + 2]!;
    const bx = positions[3 * ib]!, by = positions[3 * ib + 1]!, bz = positions[3 * ib + 2]!;
    const cx = positions[3 * ic]!, cy = positions[3 * ic + 1]!, cz = positions[3 * ic + 2]!;
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol6 < 0) for (let t = 0; t < triCount; t++) flip(t);
  return { positions, indices: out };
}

/**
 * The client analytic MOD-cavity fixture — see this module's doc. Frame: X =
 * mesiodistal, Y = buccolingual, Z = occlusal-up, base z=0, insertion axis +Z.
 * Deterministic Float64.
 */
export function buildModCavity(opts: ClientModCavityOptions = {}): ClientModCavity {
  const lengthMm = opts.lengthMm ?? 10;
  const widthMm = opts.widthMm ?? 9;
  const tableZ = opts.tableZ ?? 6;
  const cuspHeightMm = opts.cuspHeightMm ?? 1.5;
  const isthmusWidthMm = opts.isthmusWidthMm ?? 2.5;
  const isthmusDepthMm = opts.isthmusDepthMm ?? 2.0;
  const boxDepthMm = opts.boxDepthMm ?? 3.5;
  const boxLengthMm = opts.boxLengthMm ?? 2.5;
  const taperDeg = opts.taperDeg ?? 6;
  const mdSegmentsPerZone = opts.mdSegmentsPerZone ?? 6;

  const halfLen = lengthMm / 2;
  const isthmusHalfLenMm = halfLen - boxLengthMm;
  const isthmusHalfWidthMm = isthmusWidthMm / 2;
  const tan = Math.tan((taperDeg * Math.PI) / 180);
  const floorZ = tableZ - isthmusDepthMm;
  const gingivalFloorZ = tableZ - boxDepthMm;
  const isthmusFloorHalfWidthMm = isthmusHalfWidthMm - isthmusDepthMm * tan;
  const boxFloorHalfWidthMm = isthmusHalfWidthMm - boxDepthMm * tan;
  const cuspZ = tableZ + cuspHeightMm;

  if (!(boxLengthMm > 0 && isthmusHalfLenMm > 0)) throw new RangeError('buildModCavity: need a real isthmus');
  if (!(boxDepthMm > isthmusDepthMm)) throw new RangeError('buildModCavity: boxDepthMm must exceed isthmusDepthMm');
  if (!(gingivalFloorZ > 0 && boxFloorHalfWidthMm > 0)) throw new RangeError('buildModCavity: taper/depth out of range');

  const vertexIndex = new Map<string, number>();
  const positions: number[] = [];
  const vid = (p: Vec3): number => {
    const k = `${p[0]}|${p[1]}|${p[2]}`;
    const existing = vertexIndex.get(k);
    if (existing !== undefined) return existing;
    const i = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    vertexIndex.set(k, i);
    return i;
  };
  const triangles: [number, number, number][] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    const ia = vid(a), ib = vid(b), ic = vid(c);
    if (ia === ib || ib === ic || ia === ic) return;
    triangles.push([ia, ib, ic]);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    tri(a, b, c);
    tri(a, c, d);
  };

  const MB = (x: number): Vec3 => [x, -isthmusHalfWidthMm, tableZ];
  const ML = (x: number): Vec3 => [x, +isthmusHalfWidthMm, tableZ];
  const outerChain = (x: number): Vec3[] => [
    MB(x),
    [x, -widthMm / 2, cuspZ],
    [x, -widthMm / 2, 0],
    [x, +widthMm / 2, 0],
    [x, +widthMm / 2, cuspZ],
    ML(x),
  ];
  const shoulderB = (x: number): Vec3 => [x, -isthmusFloorHalfWidthMm, floorZ];
  const shoulderL = (x: number): Vec3 => [x, +isthmusFloorHalfWidthMm, floorZ];
  const cavityChain = (x: number, deep: boolean): Vec3[] => {
    if (!deep) return [MB(x), shoulderB(x), shoulderL(x), ML(x)];
    return [MB(x), shoulderB(x), [x, -boxFloorHalfWidthMm, gingivalFloorZ], [x, +boxFloorHalfWidthMm, gingivalFloorZ], shoulderL(x), ML(x)];
  };

  const mesialXs = linspace(-halfLen, -isthmusHalfLenMm, mdSegmentsPerZone);
  const isthmusXs = linspace(-isthmusHalfLenMm, +isthmusHalfLenMm, mdSegmentsPerZone);
  const distalXs = linspace(+isthmusHalfLenMm, +halfLen, mdSegmentsPerZone);
  const fullXs = [...mesialXs, ...isthmusXs.slice(1), ...distalXs.slice(1)];

  // 1) outer shell
  for (let s = 0; s < fullXs.length - 1; s++) {
    const a = outerChain(fullXs[s]!);
    const b = outerChain(fullXs[s + 1]!);
    for (let i = 0; i < a.length - 1; i++) quad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
  }
  // 2) cavity surface (per zone)
  const sweep = (xs: number[], deep: boolean): void => {
    for (let s = 0; s < xs.length - 1; s++) {
      const a = cavityChain(xs[s]!, deep);
      const b = cavityChain(xs[s + 1]!, deep);
      for (let i = 0; i < a.length - 1; i++) quad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
    }
  };
  sweep(mesialXs, true);
  sweep(isthmusXs, false);
  sweep(distalXs, true);
  // 3) pulpal walls (box↔isthmus floor step)
  const pulpalWall = (x: number): void => {
    quad(shoulderB(x), [x, -boxFloorHalfWidthMm, gingivalFloorZ], [x, +boxFloorHalfWidthMm, gingivalFloorZ], shoulderL(x));
  };
  pulpalWall(-isthmusHalfLenMm);
  pulpalWall(+isthmusHalfLenMm);
  // 4) proximal frames (break-through caps)
  const frame = (x: number): void => {
    const oc = outerChain(x);
    const cc = cavityChain(x, true);
    const poly: Vec3[] = [...oc, ...cc.slice(1, cc.length - 1).reverse()];
    const uv = poly.map((p) => [p[1], p[2]] as [number, number]);
    for (const [ia, ib, ic] of earClip(uv)) tri(poly[ia]!, poly[ib]!, poly[ic]!);
  };
  frame(-halfLen);
  frame(+halfLen);

  const flatPositions = new Float64Array(positions);
  const rawIndices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => rawIndices.set(t, i * 3));
  const mesh = orientConsistently(flatPositions, rawIndices);

  // exact outline ring (every point a mesh vertex)
  const cavityOutline: Vec3[] = [];
  for (const x of fullXs) cavityOutline.push(MB(x));
  {
    const cc = cavityChain(+halfLen, true);
    for (let i = 1; i < cc.length; i++) cavityOutline.push(cc[i]!);
  }
  for (let i = fullXs.length - 2; i >= 0; i--) cavityOutline.push(ML(fullXs[i]!));
  {
    const cc = cavityChain(-halfLen, true);
    for (let i = cc.length - 2; i >= 1; i--) cavityOutline.push(cc[i]!);
  }

  return { mesh, cavityOutline };
}
