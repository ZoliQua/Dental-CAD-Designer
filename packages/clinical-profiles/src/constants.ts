// packages/clinical-profiles/src/constants.ts
//
// This package's FIRST real exports (Phase 2 Task 7). Clinical defaults live
// ONLY here (CLAUDE.md invariant 7 / docs/plans/phase-2-kernel-core.md's
// Global Constraints: "No clinical defaults hardcoded outside
// packages/clinical-profiles ... Kernel functions take such values as
// REQUIRED parameters; defaults live only in clinical-profiles").
//
// The kernel deliberately has NO fallback to these values — e.g.
// `offsetMesh` (packages/kernel/src/offset/offsetMesh.ts) requires `pitchMm`
// on every call; a caller that wants "the clinical default" imports it from
// here explicitly. This keeps every clinically-meaningful number in exactly
// one reviewable, versionable place, per PLAN.md §3's parameter-table
// philosophy.

/**
 * Default voxel pitch (grid spacing, mm) for SDF-based offset surfacing of
 * die-sized inputs — 0.02 mm (20 µm).
 *
 * Source: PLAN.md §5 Phase 2, "Offset surfaces: distance-field based
 * (sample → SDF → marching cubes at configurable voxel pitch, default 20 µm
 * for die-sized inputs)"; bound to this package by PLAN.md §3's "clinical
 * parameters live in clinical-profiles" rule and
 * docs/plans/phase-2-kernel-core.md's Global Constraints (which name this
 * exact constant). The Phase 2 acceptance criterion "offset of a sphere by
 * 50 µm has max radial error ≤ 10 µm at default pitch" is stated AT this
 * pitch — see packages/kernel/src/offset/offsetMesh.ts's `@errorBound`
 * (pitch/2 = 10 µm at this value).
 */
export const DEFAULT_OFFSET_VOXEL_PITCH_MM = 0.02;
