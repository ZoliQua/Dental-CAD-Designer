// Kernel-wide indexed triangle mesh representation. Float64 throughout (see
// docs/plans/phase-0-foundation.md Global Constraints: all coordinates and
// math in packages/kernel are Float64) — Float32 only ever appears at the
// documented manifold-3d WASM boundary (packages/kernel/src/boolean/
// manifold.ts), never in this type.

/**
 * A triangle mesh as flat, indexed typed arrays: `positions` is a flat
 * xyzxyz... array of vertex coordinates (length = vertexCount * 3),
 * `indices` is a flat list of triangle-corner vertex indices in CCW order
 * (from the outside), length = triangleCount * 3.
 */
export interface IndexedMesh {
  positions: Float64Array;
  indices: Uint32Array;
}
