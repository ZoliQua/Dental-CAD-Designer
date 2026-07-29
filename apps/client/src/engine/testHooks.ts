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
//
// ## Phase 3 Task 11 additions
//
// e2e/phase3.spec.ts's margin/axis flow needs two more narrow, read-only-or-
// deliberately-test-only seams, same spirit as `getCameraState`/
// `worldToCanvasPoint` above (real pipeline underneath; only the "how do we
// get an exact input/read an internal result" step is test-assisted):
//   - `seedMarginPropose` — see `engine/marginEditor.ts`'s
//     `seedProposeForTest` doc for the full reasoning (bypasses only the
//     screen-pixel-to-ray step of a real click; the real `proposeMargin`
//     worker job runs unmodified).
//   - `getAxisHeatmapOverlay` — the live undercut heatmap is a Three.js
//     per-vertex color buffer (`engine/axis.ts`'s `AxisHeatmapOverlay`), not
//     a DOM element or a screenshot-checkable pixel — reading
//     `axisEngine.getHeatmapOverlay()` directly is this repo's established
//     "assert real engine state, not a screenshot" convention (this file's
//     top doc) applied to a case with no DOM surface at all to assert
//     against.
import type { Operation, Restoration, Vec3 } from '@dqcad/shared-types';
import { KERNEL_VERSION } from '@dqcad/kernel-workers';
import { axisEngine } from './axis';
import { caseStore } from './caseStore';
import { marginEditor } from './marginEditor';
import { getActiveSceneManager } from './viewerController';
import { useAxisStore } from '../state/axisStore';
import { useMarginStore } from '../state/marginStore';

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
  /** DEV/TEST-ONLY margin-tool seed — see this module's top doc and
   * `engine/marginEditor.ts`'s `seedProposeForTest` doc. Resolves once the
   * real `proposeMargin` worker job (and the store update it feeds) has
   * settled, one way or another (success sets `anchors`; a typed
   * `NoRidgeFoundError`/`NoClosureError` sets the panel's error state) — a
   * caller awaiting this can immediately read anchor state, no polling. */
  seedMarginPropose(
    triangleIndex: number,
    barycentric: readonly [number, number, number],
  ): Promise<void>;
  /** Read-only: the CURRENT live margin anchors' world-frame positions (or
   * `null` before any anchors exist) — used to compute a real drag gesture's
   * exact pixel target via `worldToCanvasPoint` above, same "know the exact
   * 3D point, then drive a real pointer event at its exact projected pixel"
   * pattern as the point-to-point measurement test in e2e/phase1.spec.ts. */
  getMarginAnchorPositions(): readonly (readonly [number, number, number])[] | null;
  /** Read-only: a light summary of the live undercut heatmap overlay
   * (`engine/axis.ts`'s `AxisHeatmapOverlay`) — `null` while the heatmap is
   * off, no target scan is set, or no heatmap colors have been computed yet;
   * otherwise the vertex-color-buffer length and whether it holds any
   * genuinely non-uniform (not-all-identical) values, i.e. a REAL computed
   * heatmap rather than an all-zero/uninitialized buffer. */
  getAxisHeatmapOverlay(): { nodeId: string; colorCount: number; hasVariation: boolean } | null;
  /** Read-only: the axis tool's CURRENT `direction` vector — `axisEngine.
   * start()` seeds this from `restoration.insertionAxis` verbatim (see
   * `state/axisStore.ts`'s `start` action), so reading this immediately
   * after `axis-start-button` is clicked (before any suggest/manual
   * override) is exactly "what insertion axis did this restoration
   * persist" — used by e2e/phase3.spec.ts's reload-restore check, since
   * `confirmed` itself is deliberately session-scoped (resets to `false`
   * on every fresh `start()`, per that store's own doc) and so cannot be
   * used to prove restoration on its own. `null` before the tool has been
   * started. */
  getAxisDirection(): readonly [number, number, number] | null;
  /** DEV/TEST-ONLY, Phase 5 Task 11 addition. Commits a CONFIRMED cavity-
   * outline margin line for `restorationId`/`tooth` — the same data shape
   * (`MarginLine.resampledPoints`) a manual trace or a working cavity
   * auto-propose would produce, via the exact engine call
   * `ui/CavityDesignPanel.dom.test.tsx`'s `setupInlayCase` helper uses
   * (T8's own established convention), exposed here for a real browser
   * session. Unlike `seedMarginPropose` above, there is no real-algorithm
   * walk being bypassed underneath: a standalone check this session (see
   * `docs/demos/phase-5.md`'s e2e section) confirmed `proposeMarginLoop`
   * (the curvature-ridge crest walk) finds NO ridge locus anywhere on the
   * MOD-cavity fixture — `packages/kernel/src/cavity/cavity.test-
   * fixtures.ts`'s own doc explains why: the fixture's sharp box corners are
   * deliberately left un-densified (Task 1's "no fillet" simplification,
   * kept exactly as Tasks 2-10 built and golden-pinned it), which is exactly
   * the kind of coarse corner `e2e/phase4.spec.ts`'s shoulder-die
   * `CORNER_REFINEMENT_MM` trick works around for the crown case — doing the
   * same here would mean deviating from the T1-T10 acceptance fixture
   * itself, out of scope for a wrap-up task. This hook writes the confirmed
   * outline directly (`closed: true`, `anchors: []` — no hand-placed anchor
   * chain exists) so the REST of the cavity pipeline (fit/patch/contacts/
   * shell/QC, all in `ui/CavityDesignPanel.tsx`) runs through the real
   * worker-backed UI unmodified. */
  seedCavityOutline(restorationId: string, tooth: number, points: readonly (readonly [number, number, number])[]): void;
  /** DEV/TEST-ONLY, Phase 6 Task 10 addition. Commits a CONFIRMED margin loop
   * for one ABUTMENT tooth of a bridge restoration — the same `MarginLine`
   * shape (`resampledPoints`) `seedCavityOutline` above writes, exposed under
   * its own honestly-scoped name because a bridge abutment margin is a
   * different clinical concept (a prep finish line, not a cavity outline) even
   * though the underlying engine call is identical (`marginEditor`/
   * `restorations.ts` are restoration-type-agnostic outside the bridge
   * multi-tooth path — see `engine/bridgeDesign.ts`'s own top doc). Unlike a
   * crown/cavity margin, this hook's OUTPUT IS NOT itself geometrically
   * consumed by the Phase 6 bridge pipeline: `hasAbutmentMargins` (engine/
   * bridgeWorkflow.ts) only checks a dense loop is PRESENT (>=3 points) to
   * gate the workflow open; the actual abutment fit surfaces, connectors, and
   * pontic base are CAPTURED from the demonstration fixture
   * (`engine/bridgeGeometry.ts#buildBridgeFixture`), not derived from this
   * loop — see `docs/demos/phase-6.md`'s synthetic-fixture disclosure. So a
   * simple closed-form ring (not traced from the imported mesh at all) is
   * sufficient and honest here, unlike `seedCavityOutline`'s bit-exact
   * snap-to-mesh requirement. */
  seedBridgeAbutmentMargin(restorationId: string, tooth: number, points: readonly (readonly [number, number, number])[]): void;
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
  async seedMarginPropose(triangleIndex, barycentric) {
    await marginEditor.seedProposeForTest(triangleIndex, barycentric);
  },
  getMarginAnchorPositions() {
    const anchors = useMarginStore.getState().anchors;
    if (anchors.length === 0) return null;
    return anchors.map((a) => a.position);
  },
  getAxisHeatmapOverlay() {
    const overlay = axisEngine.getHeatmapOverlay();
    if (!overlay) return null;
    const colors = overlay.colors;
    let hasVariation = false;
    for (let i = 1; i < colors.length; i++) {
      if (colors[i] !== colors[0]) {
        hasVariation = true;
        break;
      }
    }
    return { nodeId: overlay.nodeId, colorCount: colors.length, hasVariation };
  },
  getAxisDirection() {
    const store = useAxisStore.getState();
    return store.status === 'idle' ? null : store.direction;
  },
  seedCavityOutline(restorationId, tooth, points) {
    const restoration = caseStore
      .getDocument()
      .restorations.find((r) => r.id === restorationId);
    if (!restoration) {
      throw new Error(`seedCavityOutline: no restoration ${restorationId}`);
    }
    const next: Restoration = {
      ...restoration,
      marginLines: {
        ...restoration.marginLines,
        [tooth]: { anchors: [], closed: true, resampledPoints: points.map((p) => [...p] as Vec3) },
      },
    };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'margin-edit',
      params: { restorationId, tooth, source: 'e2e-test-hook-seedCavityOutline' },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date().toISOString(),
    };
    caseStore.updateRestoration(next, operation);
  },
  seedBridgeAbutmentMargin(restorationId, tooth, points) {
    const restoration = caseStore
      .getDocument()
      .restorations.find((r) => r.id === restorationId);
    if (!restoration) {
      throw new Error(`seedBridgeAbutmentMargin: no restoration ${restorationId}`);
    }
    const next: Restoration = {
      ...restoration,
      marginLines: {
        ...restoration.marginLines,
        [tooth]: { anchors: [], closed: true, resampledPoints: points.map((p) => [...p] as Vec3) },
      },
    };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'margin-edit',
      params: { restorationId, tooth, source: 'e2e-test-hook-seedBridgeAbutmentMargin' },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date().toISOString(),
    };
    caseStore.updateRestoration(next, operation);
  },
};

/** Called once at startup (src/main.tsx) — see this module's doc for the
 * `import.meta.env.DEV` gating. */
export function installTestHooksIfDev(): void {
  if (import.meta.env.DEV) {
    window.__dqcadTestHooks__ = hooks;
  }
}
