// apps/client/src/engine/testHooks.ts
//
// DEV/TEST-ONLY. Task 12's brief calls for asserting the viewer's real
// engine state from e2e/phase1.spec.ts (camera moved after a standard-view
// button click; a measurement click lands on a known analytic point on a
// synthetic sphere) WITHOUT screenshotting the WebGL canvas (flaky, and
// tells you nothing about *why* a pixel is wrong) and WITHOUT bypassing the
// real pick pipeline (which would test nothing). This module is the single,
// narrow, clearly-marked seam that makes both possible: it exposes exactly
// two read-only queries against whatever `SceneManager` is currently
// mounted (via engine/viewerController.ts's existing accessor — the exact
// same one ui/ViewerToolbar.tsx uses for its own one-shot camera actions,
// see that module's doc) plus `engine/caseStore.ts`'s already-public
// render/world coordinate offset.
//
// `worldToCanvasPoint` deliberately does NOT drive a pick itself — it only
// answers "where would this WORLD-frame point land on the canvas, in CSS
// pixels, right now" (composing `caseStore.getRenderWorldOffset()`, the
// exact same world->render conversion ui/Viewport.tsx's
// `handleMeasurePick` uses in the other direction, with the existing
// `SceneManager.projectToScreen`). The e2e spec then drives a REAL
// `page.mouse`/`locator.click()` at that pixel — a real DOM pointerdown/up,
// a real `Raycaster.setFromCamera`, a real `ToolManager.handlePick` worker
// round trip — so the thing being tested is the actual pipeline, not a
// shortcut around it.
//
// Installed by src/main.tsx ONLY when `import.meta.env.DEV` is true (Vite's
// dev-server flag, false in a `vite build` production bundle — so this
// object never ships to a real deployed build; `npm run build`'s output has
// no `window.__dqcadTestHooks__` at all). Playwright's `webServer` always
// runs `npm run dev` (see playwright.config.ts), so it's present for every
// e2e run.
import { caseStore } from './caseStore';
import { getActiveSceneManager } from './viewerController';

export interface DqcadCameraState {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

export interface DqcadCanvasPoint {
  x: number;
  y: number;
}

export interface DqcadTestHooks {
  /** The active viewport's camera position + `OrbitControls.target`
   * (render frame — see SceneManager.getCameraState's doc), or `null`
   * before the viewport has mounted. */
  getCameraState(): DqcadCameraState | null;
  /** Projects a WORLD-frame (Float64 mm, un-re-centered) point to CSS pixel
   * coordinates relative to the viewport's `<canvas>` element — the exact
   * frame `page.locator('canvas').click({ position })` expects, and the
   * exact frame `SceneManager`'s own real pick handler
   * (`pickAtClientPosition`) reads `getBoundingClientRect()` against, so a
   * click at the returned point round-trips through the real raycaster.
   * Returns `null` if the viewport hasn't mounted or the point is outside
   * the camera's near/far range (see `SceneManager.projectToScreen`'s doc). */
  worldToCanvasPoint(point: readonly [number, number, number]): DqcadCanvasPoint | null;
}

declare global {
  interface Window {
    __dqcadTestHooks__?: DqcadTestHooks;
  }
}

const hooks: DqcadTestHooks = {
  getCameraState() {
    return getActiveSceneManager()?.getCameraState() ?? null;
  },
  worldToCanvasPoint(point) {
    const sceneManager = getActiveSceneManager();
    if (!sceneManager) return null;
    const [ox, oy, oz] = caseStore.getRenderWorldOffset();
    const renderPoint: readonly [number, number, number] = [
      point[0] - ox,
      point[1] - oy,
      point[2] - oz,
    ];
    const projected = sceneManager.projectToScreen(renderPoint);
    return projected ? { x: projected.xPx, y: projected.yPx } : null;
  },
};

/** Called once at startup (src/main.tsx) — see this module's doc for the
 * `import.meta.env.DEV` gating. */
export function installTestHooksIfDev(): void {
  if (import.meta.env.DEV) {
    window.__dqcadTestHooks__ = hooks;
  }
}
