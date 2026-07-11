// apps/client/src/engine/viewerController.ts
//
// Module-level handle to the currently-mounted SceneManager — same
// singleton-accessor pattern as engine/workers.ts's `getPool()` and
// engine/caseStore.ts's `caseStore`. Exists because ui/ViewerToolbar.tsx
// needs to call imperative one-shot methods (setStandardView, frameAll,
// toggleProjection, ...) on the SAME SceneManager instance
// ui/Viewport.tsx constructs on mount — without this, either SceneManager
// would have to be lifted into React state (breaking the "engine is
// imperative, non-React" rule the whole codebase follows) or the toolbar
// would need prop-drilled access to Viewport's internal ref.
//
// One-shot actions (a view button click, a "frame all" click) are
// deliberately NOT modeled as zustand state — there's nothing to "be" in
// steady state, only something to DO once, so ui/ViewerToolbar.tsx calls
// these directly through `getActiveSceneManager()`.
//
// Steady/reactive viewer settings (projection mode, shading preset,
// wireframe) live in state/viewerStore.ts instead, following the SAME
// direction as state/appStore.ts's `theme`: ui/ writes the desired setting
// into the store, and ui/Viewport.tsx's effects apply it to SceneManager
// imperatively (SceneManager itself never imports zustand — it stays a
// plain, store-agnostic Three.js class, consistent with this file's whole
// reason for existing).
import type { SceneManager } from './SceneManager';

let active: SceneManager | null = null;

/** Called by ui/Viewport.tsx on mount (with the new instance) and unmount
 * (with `null`) — never called anywhere else. */
export function registerActiveSceneManager(sceneManager: SceneManager | null): void {
  active = sceneManager;
}

/** `null` before the viewport has mounted (or after it unmounts) — every
 * caller (ViewerToolbar's button handlers) must tolerate that, since a
 * toolbar render can theoretically race the very first mount effect. */
export function getActiveSceneManager(): SceneManager | null {
  return active;
}
