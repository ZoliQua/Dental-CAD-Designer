// packages/io/src/export/types.ts
//
// Shared types for the manufacturing-export layer (Phase 7 Task 2) — the
// entry points that certify this package's writers for the bytes actually
// handed to a mill. Pure TS, Float64 in memory; float32 appears ONLY at the
// STL byte-writing boundary (the documented io format exception — see
// stl/binary.ts's module doc).

/**
 * The indexed mesh shape the export entries accept — a STRUCTURAL twin of
 * `packages/kernel`'s `IndexedMesh` (flat Float64 xyzxyz positions, flat
 * Uint32 CCW-from-outside triangle indices), deliberately NOT imported from
 * `@dqcad/kernel`: the layer rule (CLAUDE.md / eslint.config.js's
 * `boundaries/dependencies` policy) allows `packages/io` to import only
 * `shared-types` — the same reason kernel's own `TriangleSoup` is a
 * structural twin of this package's `RawTriangleSoup` rather than an
 * import. Any kernel `IndexedMesh` is a valid `ExportableMesh` by
 * structural typing, with no conversion or copy.
 */
export interface ExportableMesh {
  positions: Float64Array;
  indices: Uint32Array;
}

/**
 * Why an `ExportMeshInvalidError` fired — a closed discriminant so callers
 * (the Task 3 client export flow, the Task 4 server re-validation) can
 * branch on the failure class without parsing messages:
 *
 *  - `'empty'` — zero triangles; there is nothing to manufacture.
 *  - `'structural'` — the arrays themselves are malformed (wrong typed-array
 *    type, lengths not multiples of 3, out-of-range indices, non-finite
 *    coordinates, or coordinates outside float32's representable range for
 *    the STL path).
 *  - `'degenerate-triangle'` — a triangle repeats a vertex index OR has an
 *    exactly zero-area cross product (collinear vertices). Rejected so the
 *    export path can never emit a facet whose written normal is the
 *    writer's degenerate `(0, 0, 0)` fallback; a canonical post-intake
 *    kernel mesh never contains either (intake drops cross-norm < 1e-12).
 *  - `'non-manifold-edge'` — an edge shared by 3+ triangles.
 *  - `'boundary-edge'` — an edge with only one incident triangle (the mesh
 *    is open, not watertight).
 *  - `'inconsistent-winding'` — an edge whose two incident triangles
 *    traverse it in the SAME direction (adjacent triangles disagree on
 *    which side is outside).
 *  - `'multi-component'` — more than one edge-connected component. A
 *    manufacturing export is exactly ONE fused solid (the kernel's own
 *    shell/assembly ops guarantee a single-component result); and the
 *    positive-total-volume ⇒ outward argument below is only valid for a
 *    CONNECTED closed surface — a disjoint inward component (or an inward
 *    nested void) can hide inside a net-positive sum, so multi-component
 *    input is rejected outright rather than half-verified.
 *  - `'zero-volume'` — watertight and consistently wound, but the enclosed
 *    signed volume is exactly 0 (a degenerate "sandwich" solid).
 *  - `'inward-orientation'` — watertight and consistently wound, but the
 *    signed volume is NEGATIVE: every facet points into the solid. The
 *    export layer REJECTS this rather than silently flipping — see
 *    `assertExportableSolid`'s doc for why.
 *  - `'inward-orientation-narrowed'` — STL only: the Float64 mesh is
 *    outward, but the f32-NARROWED geometry (the bytes actually shipped)
 *    has a non-positive signed volume — a near-degenerate solid whose
 *    orientation does not survive the format's precision floor. See
 *    stl.ts's normals section.
 */
export type ExportMeshInvalidReason =
  | 'empty'
  | 'structural'
  | 'degenerate-triangle'
  | 'non-manifold-edge'
  | 'boundary-edge'
  | 'inconsistent-winding'
  | 'multi-component'
  | 'zero-volume'
  | 'inward-orientation'
  | 'inward-orientation-narrowed';

/**
 * Typed rejection for the export entries (`exportStlBinary` /
 * `exportPlyBinary`): the input mesh is not a manufacturable solid.
 * Deliberately NOT an `IoParseError` (nothing was parsed) and NOT an
 * `IoWriteRangeError` (the input may be perfectly writable as bytes — it
 * just isn't a valid solid to hand to a mill; `IoWriteRangeError` remains
 * the low-level writers' "doesn't fit the format's fields" error).
 */
export class ExportMeshInvalidError extends Error {
  readonly reason: ExportMeshInvalidReason;

  constructor(reason: ExportMeshInvalidReason, message: string) {
    super(message);
    this.name = 'ExportMeshInvalidError';
    this.reason = reason;
    // Restores `instanceof` under transpiled `Error` subclassing (same
    // pattern as ../types.ts's IoParseError).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
