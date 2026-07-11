// apps/client/src/engine/viewerBindings.ts
//
// Configurable mouse-button -> camera-action map for SceneManager's
// OrbitControls (docs/plans/phase-1-import-viewer.md Task 6 §2: "a
// `ViewerBindings` map — rotate/pan/zoom per button; settings UI can come
// later, structure now"). This module only defines the map shape, its
// default, and a pure translation into `THREE.MOUSE`'s enum values — no
// settings UI reads/writes it yet (YAGNI; SceneManager currently always
// applies `DEFAULT_VIEWER_BINDINGS`, but takes an optional override so a
// future settings panel only has to call `SceneManager.setViewerBindings`).
//
// `three`'s `MOUSE` export is a plain numeric enum with no DOM/WebGL
// touched at import time, so `toOrbitControlsMouseMap` below is safely
// unit-testable in the Vitest `node` environment (no jsdom/canvas needed) —
// see this module's test file.
import { MOUSE } from 'three';

export type ViewerAction = 'rotate' | 'pan' | 'zoom';

export interface ViewerBindings {
  left: ViewerAction;
  middle: ViewerAction;
  right: ViewerAction;
}

/** Matches the conventional CAD-viewer defaults: left-drag orbits, the
 * scroll-wheel/middle-drag zooms, right-drag pans. */
export const DEFAULT_VIEWER_BINDINGS: ViewerBindings = {
  left: 'rotate',
  middle: 'zoom',
  right: 'pan',
};

const ACTION_TO_MOUSE: Readonly<Record<ViewerAction, MOUSE>> = {
  rotate: MOUSE.ROTATE,
  pan: MOUSE.PAN,
  zoom: MOUSE.DOLLY,
};

/** Translates a `ViewerBindings` map into the shape OrbitControls'
 * `.mouseButtons` setter expects. Pure — no THREE.js object is constructed
 * or touched, just enum lookups. */
export function toOrbitControlsMouseMap(bindings: ViewerBindings): { LEFT: MOUSE; MIDDLE: MOUSE; RIGHT: MOUSE } {
  return {
    LEFT: ACTION_TO_MOUSE[bindings.left],
    MIDDLE: ACTION_TO_MOUSE[bindings.middle],
    RIGHT: ACTION_TO_MOUSE[bindings.right],
  };
}
