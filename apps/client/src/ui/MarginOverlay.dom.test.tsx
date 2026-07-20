// apps/client/src/ui/MarginOverlay.dom.test.tsx
//
// Phase 3 Task 5 review item 3b: real-DOM `client-dom` project test (browser
// mode, real Chromium — see apps/client/src/ui/README.md) for the
// nearest-anchor PICK-PRIORITY interception documented in
// MarginOverlay.tsx's top doc ("Nearest-anchor pick priority"): a
// pointerdown landing within the pick-priority radius of ANY anchor — the
// FULL set, including anchors a declutter pass chose not to render a handle
// for — must begin an anchor drag INSTEAD OF letting OrbitControls start an
// orbit.
//
// This deliberately does NOT construct a real `SceneManager`/WebGLRenderer
// — no test in this repo ever has (see engine/SceneManager.test.ts's own
// module doc: "SceneManager itself needs a real HTMLElement/WebGLRenderer/
// ResizeObserver and so can't be constructed under vitest's `node`
// environment"; this repo's `client-dom` lane has likewise never exercised
// it directly, even though it runs under real Chromium — see
// ui/AlignmentPanel.dom.test.tsx's own "no mounted <Viewport>/WebGL canvas"
// note). Instead this test:
//
//   1. Registers a minimal duck-typed `getCanvasElement`/`projectToScreen`
//      stand-in through `engine/viewerController.ts`'s real
//      `registerActiveSceneManager` seam (the SAME accessor
//      ui/Viewport.tsx uses) — MarginOverlay.tsx only ever calls these two
//      methods (plus `rayAtClientPosition`, unused by this test — see
//      below) for this interaction, so a narrowly-scoped double is a
//      faithful stand-in, not a re-implementation of SceneManager.
//   2. Attaches a stand-in "OrbitControls" pointerdown listener DIRECTLY to
//      a plain `<canvas>` element (bubble phase, default — exactly how the
//      real `OrbitControls` constructor wires itself to
//      `renderer.domElement` in SceneManager.ts) BEFORE mounting
//      `<MarginOverlay/>` — reproducing the real app's registration order
//      (SceneManager's constructor runs, wiring OrbitControls, strictly
//      before ui/Viewport.tsx ever mounts `<MarginOverlay/>`) — and
//      asserts it NEVER FIRES for a pointerdown landing within the
//      pick-priority radius of an anchor. Per the DOM Events spec, a
//      capture-phase listener on an ANCESTOR always runs strictly before
//      ANY listener on the target itself (capture or bubble — for
//      same-element listeners, order is registration order, not
//      capture-flag order, exactly why MarginOverlay.tsx's own top doc
//      documents wiring its interceptor on the canvas's PARENT, not the
//      canvas itself). This test proves that guarantee holds for THIS
//      component's actual wiring, in a real browser — not just by
//      inspection of the spec.
//   3. Asserts the live margin store shows the drag as STARTED
//      (`draggingAnchorIndex` set to the clicked anchor) for an anchor
//      that is NOT among the currently-RENDERED (decluttered) handle
//      `<div>`s — proving the interception reads the FULL anchor set from
//      the store, not the declutter-filtered render list (deliverable 3a).
//
// `updateAnchorDrag`/`endAnchorDrag`'s worker-backed geodesic recompute and
// journal-coalescing are already covered end-to-end (real WorkerPool, real
// fixture) by engine/marginEditor.test.ts and MarginPanel.dom.test.tsx —
// this file's sole, narrow scope is the interception/priority-vs-orbit
// mechanism itself, so the stub's `rayAtClientPosition` is never exercised
// (this test never dispatches a pointermove/pointerup).
import { act } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import type { SceneManager } from '../engine/SceneManager';
import { registerActiveSceneManager } from '../engine/viewerController';
import { useMarginStore, type LiveMarginAnchor } from '../state/marginStore';
import { MarginOverlay } from './MarginOverlay';

/** A synthetic anchor whose `position[0]` doubles as its own index — the
 * fake `projectToScreen` below keys off that value directly (no real 3D
 * projection math is exercised or needed by this test). */
function anchorAt(index: number): LiveMarginAnchor {
  return { position: [index, 0, 0], triangleIndex: index, barycentric: [1, 0, 0] };
}

/** Minimal `getCanvasElement`/`projectToScreen` stand-in — see this file's
 * top doc for why a real SceneManager is never constructed.
 * `screenByAnchorIndex` maps each anchor's synthetic `position[0]` (==
 * its index, per `anchorAt` above) to a fixed screen position. Relies on
 * `caseStore`'s render-world-offset defaulting to `[0, 0, 0]` when no mesh
 * is registered (engine/meshStore.ts) so `toRenderPoint(anchor.position,
 * worldOffset) === anchor.position` exactly — `caseStore.resetForTests()`
 * in `beforeEach` guarantees that default holds regardless of any other
 * test file's state. */
function createFakeSceneManager(
  canvas: HTMLCanvasElement,
  screenByAnchorIndex: ReadonlyMap<number, { xPx: number; yPx: number }>,
): SceneManager {
  const fake = {
    getCanvasElement: () => canvas,
    projectToScreen: (point: readonly [number, number, number]) => screenByAnchorIndex.get(point[0]) ?? null,
    rayAtClientPosition: () => null,
  };
  return fake as unknown as SceneManager;
}

let container: HTMLDivElement | null = null;

beforeEach(() => {
  caseStore.resetForTests();
  marginEditor.resetForTests();
});

afterEach(() => {
  cleanup();
  registerActiveSceneManager(null);
  caseStore.resetForTests();
  marginEditor.resetForTests();
  if (container) {
    container.remove();
    container = null;
  }
});

describe('MarginOverlay — nearest-anchor pick PRIORITY (Task 5 review item 3b)', () => {
  it('a pointerdown within the pick-priority radius of an UNDRAWN (decluttered) anchor begins a drag for THAT anchor, and never reaches a same-element "OrbitControls" stand-in listener', async () => {
    container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '0px';
    container.style.top = '0px';
    document.body.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    canvas.style.width = '400px';
    canvas.style.height = '400px';
    container.appendChild(canvas);

    // Two anchors 4px apart on screen — well inside MarginOverlay's own
    // decluttering spacing (20px, deliverable 3a), so only ONE of them
    // ever gets a rendered handle `<div>`.
    const screenByAnchorIndex = new Map([
      [0, { xPx: 100, yPx: 100 }],
      [1, { xPx: 104, yPx: 100 }],
    ]);
    registerActiveSceneManager(createFakeSceneManager(canvas, screenByAnchorIndex));

    let orbitStandInFired = false;
    // Registered BEFORE `<MarginOverlay/>` mounts, directly on `canvas` —
    // reproducing the real app's registration order (SceneManager's
    // constructor wires OrbitControls before ui/Viewport.tsx ever mounts
    // `<MarginOverlay/>`) and proving the fix does NOT merely happen to win
    // a same-element registration-order race.
    canvas.addEventListener('pointerdown', () => {
      orbitStandInFired = true;
    });

    act(() => {
      useMarginStore.setState({
        phase: 'active',
        anchors: [anchorAt(0), anchorAt(1)],
        segments: [],
        closed: false,
        segmentConfidence: null,
        humanEdited: true,
        selectedAnchorIndex: null,
        draggingAnchorIndex: null,
        unresolvedAnchorCount: 0,
      });
    });

    render(<MarginOverlay />);

    // Only ONE handle should actually be rendered — the second is
    // decluttered (deliverable 3a) — a real assertion (not an assumption)
    // that anchor 1 is genuinely "undrawn" for the rest of this test to
    // mean anything.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="margin-anchor-handle"]').length).toBe(1);
    });

    const canvasRect = canvas.getBoundingClientRect();
    act(() => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: canvasRect.left + 104,
          clientY: canvasRect.top + 100,
        }),
      );
    });

    expect(useMarginStore.getState().draggingAnchorIndex).toBe(1); // the UNDRAWN anchor's drag began
    expect(useMarginStore.getState().selectedAnchorIndex).toBe(1);
    expect(orbitStandInFired).toBe(false); // never reached the same-element stand-in listener
  });

  it('a pointerdown that lands nowhere near any anchor is NOT intercepted — the stand-in "OrbitControls" listener fires normally', async () => {
    container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '0px';
    container.style.top = '0px';
    document.body.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    canvas.style.width = '400px';
    canvas.style.height = '400px';
    container.appendChild(canvas);

    const screenByAnchorIndex = new Map([[0, { xPx: 100, yPx: 100 }]]);
    registerActiveSceneManager(createFakeSceneManager(canvas, screenByAnchorIndex));

    let orbitStandInFired = false;
    canvas.addEventListener('pointerdown', () => {
      orbitStandInFired = true;
    });

    act(() => {
      useMarginStore.setState({
        phase: 'active',
        anchors: [anchorAt(0)],
        segments: [],
        closed: false,
        segmentConfidence: null,
        humanEdited: true,
        selectedAnchorIndex: null,
        draggingAnchorIndex: null,
        unresolvedAnchorCount: 0,
      });
    });

    render(<MarginOverlay />);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="margin-anchor-handle"]').length).toBe(1);
    });

    const canvasRect = canvas.getBoundingClientRect();
    act(() => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          // Far outside the 12px pick-priority radius of the one anchor.
          clientX: canvasRect.left + 350,
          clientY: canvasRect.top + 350,
        }),
      );
    });

    expect(useMarginStore.getState().draggingAnchorIndex).toBeNull(); // no drag began
    expect(orbitStandInFired).toBe(true); // propagation reached the "camera orbit" stand-in normally
  });
});
