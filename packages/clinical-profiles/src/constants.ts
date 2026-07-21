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
import { STANDARD_ZIRCONIA_PROFILE } from './profiles.ts';

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

/**
 * The `RestorationParams` a freshly created `Restoration` (Phase 3 Task 2's
 * wizard, `apps/client/src/engine/restorations.ts`) is seeded with before
 * any per-material profile selection UI exists (Phase 4 — PLAN.md §5).
 * Deliberately IDENTICAL to `STANDARD_ZIRCONIA_PROFILE.restorationParams`
 * (`profiles.ts`) rather than an independent hand-copied literal — one
 * number, one citation, zero drift risk; see
 * PLAN.md §3's table for each field's citation (repeated verbatim on
 * `materialProfile.ts`'s `validateMaterialProfileShape`, which is what this
 * value is actually schema/checksum-VALIDATED against at startup — this
 * binding is just a convenient, always-in-sync alias for the common case of
 * "no material chosen yet, use the default").
 */
export const DEFAULT_RESTORATION_PARAMS = STANDARD_ZIRCONIA_PROFILE.restorationParams;

/**
 * Default undercut blockout threshold (mm), relative to the restoration's
 * confirmed insertion axis — a triangle/vertex only counts as "needs
 * blockout" once its undercut depth (see
 * `packages/kernel/src/undercut/undercutScan.ts`'s `depthMm`) exceeds this
 * value, not merely `> 0`.
 *
 * Source: PLAN.md §3, "Undercut blockout threshold | 0 µm | — | Relative to
 * insertion axis" (row present since Phase 0's parameter table, wired to a
 * real preview only now, Phase 3 Task 10 —
 * `packages/kernel/src/blockout/blockoutPreview.ts`). Deliberately IDENTICAL
 * to `STANDARD_ZIRCONIA_PROFILE.undercutBlockoutThresholdMm` rather than an
 * independent hand-copied literal — same one-number/one-citation/zero-drift
 * rationale as `DEFAULT_RESTORATION_PARAMS` above; the profile's own
 * `undercutBlockoutThresholdMm` field (`materialProfile.ts`) is what this
 * value is actually schema/checksum-VALIDATED against at startup.
 */
export const DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM = STANDARD_ZIRCONIA_PROFILE.undercutBlockoutThresholdMm;
