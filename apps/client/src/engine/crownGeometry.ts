// apps/client/src/engine/crownGeometry.ts
//
// Phase 4 Task 10 — small, PURE, deterministic Float64 geometry builders used
// by the crown-design workflow's CLIENT side: the anatomy stage's built-in
// parametric "library tooth" (a placeholder anatomy the client can supply
// without importing @dqcad/tooth-library, which the layer rule forbids from
// both ui/ and engine/ — see this file's `builtinLibraryTooth` doc), plus the
// flat-array margin-loop helper the worker payloads need. No worker, no
// Three.js, no case mutation — just closed-form mesh construction, so it lives
// as a pure engine module (like engine/marginFrame.ts / sceneTransform.ts).
//
// HONEST SCOPE NOTE: `builtinLibraryTooth` is NOT real dental anatomy — it is
// a parametric closed frustum dome. The real anatomical tooth library
// (@dqcad/tooth-library, `generateIncisorAsset`/`generateMolarAsset`) is not
// reachable from the client layers yet (no kernel-workers asset-load job
// exists — Phase 4 Task 5 exercised it only in the node golden lane). Until
// such a job exists, this deterministic dome is what the anatomy stage places
// so the rest of the pipeline (morph -> shell -> QC) is runnable end to end.
// This is called out as a reviewer-attention item, not hidden.
import type { Vec3 } from '@dqcad/shared-types';

export interface IndexedBuffers {
  positions: Float64Array;
  indices: Uint32Array;
}

/** A canonical anatomy frame (mirrors `@dqcad/kernel`'s `CanonicalFrameAxes`,
 * re-declared — engine may not import kernel). */
export interface CanonicalFrame {
  origin: Vec3;
  mesialDistal: Vec3;
  buccoLingual: Vec3;
  occlusoGingival: Vec3;
}

export interface BuiltinLibraryTooth extends IndexedBuffers {
  canonicalFrame: CanonicalFrame;
  landmarks: Record<string, Vec3>;
}

/**
 * A capped/uncapped cone frustum around the +Z axis. `marginZ`/`topZ` are the
 * bottom/top ring heights; `marginR`/`topR` their radii. Winding is outward
 * (CCW seen from outside). Deterministic. This is the shared shape family the
 * prep die (both caps), the intaglio-facing library dome (both caps), and the
 * open-cervical outer dome (top cap only) are all built from — the frustum
 * family is the one that reliably stitches into a WATERTIGHT shell (Task 9
 * fixture lineage).
 */
export function buildFrustum(
  marginR: number,
  topR: number,
  marginZ: number,
  topZ: number,
  segments: number,
  capTop: boolean,
  capBottom: boolean,
): IndexedBuffers {
  const positions: number[] = [];
  const bottomRing: number[] = [];
  const topRing: number[] = [];
  for (let s = 0; s < segments; s++) {
    const theta = (2 * Math.PI * s) / segments;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    bottomRing.push(positions.length / 3);
    positions.push(marginR * cos, marginR * sin, marginZ);
  }
  for (let s = 0; s < segments; s++) {
    const theta = (2 * Math.PI * s) / segments;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    topRing.push(positions.length / 3);
    positions.push(topR * cos, topR * sin, topZ);
  }
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    const a = bottomRing[s]!;
    const b = bottomRing[sNext]!;
    const c = topRing[sNext]!;
    const d = topRing[s]!;
    // Outward-facing (CCW from outside).
    indices.push(a, b, c);
    indices.push(a, c, d);
  }
  if (capBottom) {
    const center = positions.length / 3;
    positions.push(0, 0, marginZ);
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      // Bottom cap faces -Z: wind so the outward normal points down.
      indices.push(center, bottomRing[sNext]!, bottomRing[s]!);
    }
  }
  if (capTop) {
    const center = positions.length / 3;
    positions.push(0, 0, topZ);
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      indices.push(center, topRing[s]!, topRing[sNext]!);
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Flat xyz Float64Array of a circle in the z = `z` plane, centred at
 * (`cx`, `cy`) — the worker payload form of a margin loop (`>= 3` points). */
export function marginCircleFlat(cx: number, cy: number, r: number, z: number, n: number): Float64Array {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    out[i * 3] = cx + r * Math.cos(theta);
    out[i * 3 + 1] = cy + r * Math.sin(theta);
    out[i * 3 + 2] = z;
  }
  return out;
}

/** Vec3[] circle — the `MarginLine.resampledPoints` form (case-document). */
export function marginCircleVecs(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    out.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta), z]);
  }
  return out;
}

/** Flattens a `readonly Vec3[]` margin loop into the flat xyz Float64Array the
 * worker jobs expect. */
export function flattenLoop(points: readonly Vec3[]): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/** An axis-aligned box, outward-wound. Used for the synthetic antagonist /
 * neighbour contact geometry the morph stage consumes when a real scan of
 * that role is present in the scene. */
export function boxMesh(min: Vec3, max: Vec3): IndexedBuffers {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = Float64Array.from([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // bottom
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // top
  ]);
  // 12 outward-wound triangles.
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // -y
    1, 2, 6, 1, 6, 5, // +x
    2, 3, 7, 2, 7, 6, // +y
    3, 0, 4, 3, 4, 7, // -x
  ]);
  return { positions, indices };
}

/**
 * A built-in parametric "library tooth" — a CLOSED, rounded cylinder of
 * radius `marginR` rising from the margin plane (`marginZ`) to a tapered
 * occlusal apex at `marginZ + heightMm`. Both caps closed (watertight solid)
 * so the shell stage can trim it to the margin and stitch it to the intaglio.
 *
 * Why a straight-walled cylinder at EXACTLY `marginR` (not a wider dome): the
 * anatomy-placement solve scales the library so its widest cross-section
 * matches the margin width, so a dome wider than `marginR` would be shrunk
 * until its cervical base fell INSIDE the margin (a seam gap). Keeping the max
 * radius == `marginR` makes that scale ≈ 1, so the base ring lands ON the
 * margin loop (a clean seam) while the walls stay at `marginR` as the prep
 * tapers inward beneath them — and THAT radial difference is the crown's wall
 * thickness. Canonical frame is the identity dental frame (MD = +X, BL = +Y,
 * OG = +Z), origin at the margin centre. Deterministic. See this file's
 * HONEST SCOPE NOTE — placeholder anatomy, not a real tooth; `wallMm` is
 * reserved (the wall emerges from the prep taper, not an outward offset).
 */
export function builtinLibraryTooth(
  marginR: number,
  marginZ: number,
  heightMm: number,
  _wallMm: number,
  segments = 96,
  heightSegments = 10,
): BuiltinLibraryTooth {
  const shoulderFrac = 0.7;
  const positions: number[] = [];
  const rings: number[][] = [];
  for (let r = 0; r <= heightSegments; r++) {
    const t = r / heightSegments;
    const z = marginZ + t * heightMm;
    const radius = t <= shoulderFrac ? marginR : marginR * (1 - ((t - shoulderFrac) / (1 - shoulderFrac)) * 0.85);
    const ring: number[] = [];
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      ring.push(positions.length / 3);
      positions.push(radius * Math.cos(theta), radius * Math.sin(theta), z);
    }
    rings.push(ring);
  }
  const indices: number[] = [];
  for (let r = 0; r < heightSegments; r++) {
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = rings[r]![s]!;
      const b = rings[r]![sNext]!;
      const c = rings[r + 1]![sNext]!;
      const d = rings[r + 1]![s]!;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  // Bottom cap (-Z) at the margin plane.
  const bottomCenter = positions.length / 3;
  positions.push(0, 0, marginZ);
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    indices.push(bottomCenter, rings[0]![sNext]!, rings[0]![s]!);
  }
  // Top cap (+Z) — rounded apex.
  const topZ = marginZ + heightMm;
  const topCenter = positions.length / 3;
  positions.push(0, 0, topZ);
  const topRing = rings[heightSegments]!;
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    indices.push(topCenter, topRing[s]!, topRing[sNext]!);
  }
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    canonicalFrame: {
      origin: [0, 0, marginZ],
      mesialDistal: [1, 0, 0],
      buccoLingual: [0, 1, 0],
      occlusoGingival: [0, 0, 1],
    },
    landmarks: {
      incisalEdge: [0, 0, topZ],
      cingulum: [0, -marginR * 0.6, marginZ + heightMm * 0.3],
    },
  };
}
