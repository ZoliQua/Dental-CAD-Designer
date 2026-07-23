// packages/tooth-library/src/geometry/ringMesh.ts
//
// A tiny "loft" mesh builder shared by every procedural tooth generator
// (generate/incisor.ts, generate/molar.ts): a crown is built as a stack of
// closed vertex rings (one per occluso-gingival height sample), stitched
// into a tube wall, then capped top and bottom. This module owns exactly
// the topology/winding bookkeeping — every generator supplies only the
// per-tooth-type SHAPE (cross-section radius/elevation functions); the
// watertight, correctly-wound assembly is written once, here, and verified
// once (this file's own analytic tests + every generator's watertight
// test), rather than re-derived per tooth type.
//
// Winding convention: `addRing`'s `segments` vertices are placed at
// increasing `theta` (0..2*PI), which is counter-clockwise when viewed from
// +z looking toward the origin (standard math convention, cos/sin). Given
// that, `stitchRings`/`capBottom`/`capTop`'s exact triangle vertex order
// below is EMPIRICALLY verified (not just reasoned about) to produce
// outward-facing normals — positive `signedVolumeMm3` in kernel's
// `analyzeMesh` on a plain cylinder built from these exact three functions
// (a throwaway script during this task's development; the property is now
// pinned by every generator's "watertight + positive volume" test, so a
// future accidental winding flip anywhere in this file fails loudly rather
// than silently shipping an inside-out mesh).
import type { IndexedMesh } from '@dqcad/kernel';
import type { Vec3 } from '@dqcad/shared-types';

/** Accumulates flat position/index arrays; converted to an `IndexedMesh`
 * once via `toIndexedMesh`. Deliberately plain arrays (not typed arrays)
 * while building — length is not known up front and typed arrays can't
 * grow; `toIndexedMesh` does the one-time Float64Array/Uint32Array copy. */
export interface MeshBuilder {
  readonly positions: number[];
  readonly indices: number[];
}

export function createMeshBuilder(): MeshBuilder {
  return { positions: [], indices: [] };
}

/** Appends one vertex, returns its new vertex index. */
export function addVertex(builder: MeshBuilder, x: number, y: number, z: number): number {
  const index = builder.positions.length / 3;
  builder.positions.push(x, y, z);
  return index;
}

function addTriangle(builder: MeshBuilder, a: number, b: number, c: number): void {
  builder.indices.push(a, b, c);
}

export function toIndexedMesh(builder: MeshBuilder): IndexedMesh {
  return {
    positions: Float64Array.from(builder.positions),
    indices: Uint32Array.from(builder.indices),
  };
}

/** Reads back a previously-added vertex's (x, y, z) — used by generators to
 * turn a "this ring index + this angular index" landmark PICK into an
 * actual `Vec3` position, straight from the mesh itself (never a
 * separately-interpolated/recomputed value that could drift from the real
 * vertex). */
export function vertexAt(builder: MeshBuilder, index: number): Vec3 {
  const base = index * 3;
  return [builder.positions[base]!, builder.positions[base + 1]!, builder.positions[base + 2]!];
}

/**
 * Adds one closed ring of `segments` vertices at height `z`, with each
 * vertex's (x, y) given by `shapeFn(theta)` for `segments` evenly spaced
 * `theta` values in `[0, 2*PI)`. Returns the ring's vertex indices, in
 * increasing-theta order — this order (and its resulting CCW-from-+z
 * winding) is exactly what `stitchRings`/`capBottom`/`capTop` assume.
 */
export function addRing(
  builder: MeshBuilder,
  shapeFn: (theta: number) => { x: number; y: number },
  z: number,
  segments: number,
): number[] {
  if (segments < 3 || !Number.isInteger(segments)) {
    throw new RangeError(`addRing: segments must be an integer >= 3, got ${segments}`);
  }
  const ring: number[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const { x, y } = shapeFn(theta);
    ring[i] = addVertex(builder, x, y, z);
  }
  return ring;
}

/**
 * Triangulates the tube wall between two same-length rings (`lower` at a
 * smaller z, `upper` at a larger z — this function does not itself check
 * z, only vertex correspondence by ring index). Outward-facing normals
 * (see this module's header doc for the empirical winding derivation).
 */
export function stitchRings(builder: MeshBuilder, lower: readonly number[], upper: readonly number[]): void {
  if (lower.length !== upper.length) {
    throw new RangeError(
      `stitchRings: ring length mismatch (lower=${lower.length}, upper=${upper.length})`,
    );
  }
  const segments = lower.length;
  for (let i = 0; i < segments; i++) {
    const iNext = (i + 1) % segments;
    const l0 = lower[i]!;
    const l1 = lower[iNext]!;
    const u0 = upper[i]!;
    const u1 = upper[iNext]!;
    addTriangle(builder, l0, l1, u1);
    addTriangle(builder, l0, u1, u0);
  }
}

/** Fan-triangulates `ring` to one new center vertex at `(0, 0, z)` — the
 * GINGIVAL/cervical cap (faces -z, "downward"/root-ward). Returns the new
 * center vertex's index. */
export function capBottom(builder: MeshBuilder, ring: readonly number[], z: number): number {
  const center = addVertex(builder, 0, 0, z);
  const segments = ring.length;
  for (let i = 0; i < segments; i++) {
    const iNext = (i + 1) % segments;
    addTriangle(builder, center, ring[iNext]!, ring[i]!);
  }
  return center;
}

/** Fan-triangulates `ring` to one new center vertex at `(0, 0, z)` — an
 * OCCLUSAL/incisal cap (faces +z, "upward"). Used directly by the incisor
 * generator (its incisal edge is a single apex vertex); the molar
 * generator instead builds its occlusal table as several concentric
 * `stitchRings` calls (see generate/molar.ts) and only fans the innermost
 * one, via this same function. */
export function capTop(builder: MeshBuilder, ring: readonly number[], z: number): number {
  const center = addVertex(builder, 0, 0, z);
  const segments = ring.length;
  for (let i = 0; i < segments; i++) {
    const iNext = (i + 1) % segments;
    addTriangle(builder, center, ring[i]!, ring[iNext]!);
  }
  return center;
}

// ---------------------------------------------------------------------------
// Shape-function helpers shared by every generator's cross-section math.
// ---------------------------------------------------------------------------

/** Standard 0..1 smoothstep (3t^2 - 2t^3), clamped outside `[edge0, edge1]`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Unnormalized Gaussian bump, peak value 1 at `x === center`. `width` is
 * the Gaussian's standard-deviation-like scale (NOT full-width-half-max) —
 * a placeholder-anatomy shaping primitive, not a statistical distribution;
 * chosen for its smoothness (infinitely differentiable) and because it
 * naturally decays toward 0 without needing an explicit clamp. */
export function gaussianBump(x: number, center: number, width: number): number {
  const t = (x - center) / width;
  return Math.exp(-(t * t));
}

/** Angular distance between two angles (radians), wrapped into `[0, PI]` —
 * used by cusp/ridge placement to find "how far around the ring" a target
 * angle is from a given theta, independent of the [0, 2*PI) wraparound. */
export function angularDistance(a: number, b: number): number {
  let diff = Math.abs(a - b) % (2 * Math.PI);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff;
}

/** A raised-cosine angular window: 1 at `theta === center`, falling
 * smoothly to 0 at `angularDistance(theta, center) >= halfWidthRad`, and
 * clamped to 0 beyond that — used to confine a lingual/cusp/ridge feature
 * to one angular sector of a ring without touching the rest of it. */
export function angularWindow(theta: number, center: number, halfWidthRad: number): number {
  const d = angularDistance(theta, center);
  if (d >= halfWidthRad) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / halfWidthRad));
}

/** Rounds `theta` (radians) to the nearest of `segments` ring sample angles
 * and returns that sample's index — used by generators to deterministically
 * pick "the ring vertex closest to this named landmark's intended angle"
 * from an already-built ring, so a landmark position is always an actual
 * mesh vertex (never an interpolated point off the mesh). */
export function nearestRingIndex(theta: number, segments: number): number {
  const normalized = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round((normalized / (2 * Math.PI)) * segments) % segments;
}
