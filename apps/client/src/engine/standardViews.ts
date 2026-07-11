// apps/client/src/engine/standardViews.ts
//
// Pure, framework-free math for the viewer's "standard view" toolbar
// buttons + numeric-key shortcuts (docs/plans/phase-1-import-viewer.md
// Task 6 §3). No Three.js import here on purpose — this is exactly the kind
// of "jaw-aware matrix expectations" logic the task brief calls out as
// unit-testable without a WebGL context; SceneManager.ts is the only
// consumer that turns these plain number tuples into `THREE.Vector3`s.
//
// ## World-axis convention (documented once, here)
//
// SceneManager's local render frame (engine/meshStore.ts's re-centered
// Float32 copies) is Y-up, matching the existing grid/camera setup from
// Phase 0 (GridHelper lies in the XZ plane; the placeholder camera sits at
// a positive Y). This module assumes every case's meshes share one
// consistent axis convention within that frame:
//
//   +X = patient's right / -X = patient's left
//   +Y = superior (up, toward the occlusal/biting plane) / -Y = inferior (down)
//   +Z = anterior (facial, toward the viewer) / -Z = posterior (back of the mouth)
//
// This is a SIMPLIFICATION: real scan files carry no canonical orientation
// (STL/PLY have no coordinate-frame metadata — see CLAUDE.md's "STL has no
// units" pitfall, same problem one axis over), so a raw import may not
// actually align with these axes until a future alignment/registration tool
// (out of Phase 1 scope) fixes it up. Given that assumption, the 6 standard
// views below are well-defined, but `buccal`/`lingual`/`mesial`/`distal` are
// WHOLE-CASE axis-aligned approximations of what are, clinically, per-tooth
// directions (a molar's mesial and a canine's mesial point different ways
// around a curved arch) — good enough for whole-scene toolbar navigation,
// not a substitute for a future per-tooth clinical view.
//
// ## Occlusal — the one view that's jaw-role-aware
//
// `occlusal` is the only view whose direction flips based on the scene's
// jaw roles (RenderNode.role, sourced from SceneNode.role): viewing the
// UPPER jaw's occlusal (biting) surface means looking UP at it from below
// (camera at -Y, looking toward +Y) — same convention as viewing the
// maxilla from the mandible's vantage point. Viewing the LOWER jaw's
// occlusal surface means looking DOWN into it from above (camera at +Y,
// looking toward -Y). A `mixed` (both jaws present) or `none` (neither
// present) scene defaults to the lower-jaw convention (camera above,
// looking down) — arbitrary but documented, and the more common "looking
// into the mouth from above" framing.
import type { MeshRole } from '@dqcad/shared-types';

export const STANDARD_VIEWS = ['front', 'buccal', 'lingual', 'mesial', 'distal', 'occlusal'] as const;
export type StandardView = (typeof STANDARD_VIEWS)[number];

export type JawContext = 'upperJaw' | 'lowerJaw' | 'mixed' | 'none';

/** A plain (non-Three) unit vector — see this module's doc for why. */
export type Vec3Tuple = readonly [number, number, number];

const SQRT1_2 = Math.SQRT1_2;

/** Camera-offset unit vectors (direction FROM the framed target TO the
 * camera; SceneManager looks back toward -offset) for every view except
 * `occlusal`, which is computed by `standardViewOffset` below. */
const FIXED_VIEW_OFFSETS: Readonly<Record<Exclude<StandardView, 'occlusal'>, Vec3Tuple>> = {
  front: [0, 0, 1],
  lingual: [0, 0, -1],
  buccal: [1, 0, 0],
  mesial: [-1, 0, 0],
  // Oblique postero-lateral viewpoint — distinct from the four cardinal
  // directions above, conventionally used to inspect distal proximal
  // contacts (see module doc's "whole-case approximation" caveat).
  distal: [SQRT1_2, 0, -SQRT1_2],
};

/** Camera-offset unit vector for the lower-jaw / default occlusal view
 * (camera above, looking down — see module doc). */
const OCCLUSAL_LOWER_OFFSET: Vec3Tuple = [0, 1, 0];
/** Camera-offset unit vector for the upper-jaw occlusal view (camera below,
 * looking up — see module doc). */
const OCCLUSAL_UPPER_OFFSET: Vec3Tuple = [0, -1, 0];

/**
 * Reduces a scene's SceneNode roles down to the jaw context that
 * `standardViewOffset`'s `occlusal` case needs — see module doc.
 */
export function resolveJawContext(roles: readonly MeshRole[]): JawContext {
  const hasUpper = roles.includes('upperJaw');
  const hasLower = roles.includes('lowerJaw');
  if (hasUpper && hasLower) return 'mixed';
  if (hasUpper) return 'upperJaw';
  if (hasLower) return 'lowerJaw';
  return 'none';
}

/**
 * The camera-offset unit vector (direction from the framed target to the
 * camera) for `view`, given the scene's `jawContext` — only `occlusal`
 * actually consults `jawContext`; every other view is a fixed direction.
 */
export function standardViewOffset(view: StandardView, jawContext: JawContext): Vec3Tuple {
  if (view !== 'occlusal') {
    return FIXED_VIEW_OFFSETS[view];
  }
  return jawContext === 'upperJaw' ? OCCLUSAL_UPPER_OFFSET : OCCLUSAL_LOWER_OFFSET;
}

/** Numeric-key shortcut order (1-6) for the standard-view toolbar —
 * arbitrary but fixed and documented here as the single source of truth for
 * both the toolbar's key-hint labels and SceneManager's keydown handler. */
export const STANDARD_VIEW_KEY_ORDER: readonly StandardView[] = [
  'front',
  'buccal',
  'lingual',
  'mesial',
  'distal',
  'occlusal',
];

export function standardViewForDigitKey(key: string): StandardView | null {
  const index = Number(key) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= STANDARD_VIEW_KEY_ORDER.length) {
    return null;
  }
  return STANDARD_VIEW_KEY_ORDER[index]!;
}
