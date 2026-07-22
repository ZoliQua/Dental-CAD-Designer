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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import type { SceneManager } from '../engine/SceneManager';
import { registerActiveSceneManager } from '../engine/viewerController';
import { useCaseStore } from '../state/caseStore';
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

// ---------------------------------------------------------------------------
// Phase 3 editor enhancements, task 2: shift-click bulk multi-select + Delete
// key bulk deletion — full browser-lane flow against the REAL WorkerPool
// (same icosahedron + real-jobs convention as MarginPanel.dom.test.tsx; the
// fake SceneManager below only stands in for projection, exactly like this
// file's other tests — see the module doc).
// ---------------------------------------------------------------------------

const ICOSA_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-2, -2, -2], max: [2, 2, 2] },
  surfaceAreaMm2: 40,
  signedVolumeMm3: 10,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: ReadonlyArray<readonly [number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces: ReadonlyArray<readonly [number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { positions: new Float64Array(raw.flat()), indices: Uint32Array.from(faces.flat()) };
}

function icoVertex(positions: Float64Array, i: number): readonly [number, number, number] {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

function rayAtIcoVertex(vertex: readonly [number, number, number]): {
  rayOrigin: readonly [number, number, number];
  rayDirection: readonly [number, number, number];
} {
  const len = Math.hypot(vertex[0], vertex[1], vertex[2]) || 1;
  return {
    rayOrigin: [vertex[0] * 3, vertex[1] * 3, vertex[2] * 3],
    rayDirection: [-vertex[0] / len, -vertex[1] / len, -vertex[2] / len],
  };
}

/** Position-based linear projection (unlike `createFakeSceneManager`'s
 * index-keyed lookup above — these anchors come from REAL worker raycasts,
 * so their positions are real icosahedron vertices, not synthetic index
 * tags). Spreads the traced vertices ~35-60px apart on screen — all above
 * the 20px declutter spacing, so every anchor gets a rendered handle. */
function createProjectingSceneManager(canvas: HTMLCanvasElement): SceneManager {
  const fake = {
    getCanvasElement: () => canvas,
    projectToScreen: (point: readonly [number, number, number]) => ({
      xPx: 200 + point[0] * 30,
      yPx: 200 + point[1] * 30,
    }),
    rayAtClientPosition: () => null,
  };
  return fake as unknown as SceneManager;
}

describe('MarginOverlay — shift-click bulk multi-select + Delete key (Phase 3 editor enhancements, real worker jobs)', () => {
  it('shift-clicks two handles into the bulk set, deletes them with ONE journaled op via the Delete key', async () => {
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
    registerActiveSceneManager(createProjectingSceneManager(canvas));

    // REAL margin session: registered mesh, real raycast/geodesic worker
    // jobs, journaled close — the same critical-path convention as
    // MarginPanel.dom.test.tsx.
    const { positions, indices } = icosahedronBuffers();
    caseStore.registerImportedMesh({
      contentHash: 'overlay-bulk-ico',
      name: 'overlay-bulk-ico.stl',
      format: 'stl',
      positions,
      indices,
      stats: ICOSA_STATS,
      report: { weldEpsilonMm: 1e-6, steps: [] },
      operations: [],
    });
    const node = caseStore.addSceneNode('overlay-bulk-ico', 'prepDie');
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: node.id });
    marginEditor.startForTooth(restoration.id, 11);
    marginEditor.setMode('manual');
    for (let i = 0; i < 5; i++) {
      await marginEditor.handlePick(rayAtIcoVertex(icoVertex(positions, i)));
    }
    await marginEditor.toggleClosed(); // first commit — 5 anchors, closed
    expect(useMarginStore.getState().anchors).toHaveLength(5);

    render(<MarginOverlay />);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="margin-anchor-handle"]').length).toBe(5);
    });

    // Shift-click the handles for anchors 1 and 3 (pointerdown+up with no
    // movement = a click; shiftKey on the UP is what handlePointerUp reads).
    for (const targetIndex of [1, 3]) {
      const handle = document.querySelector(`[data-anchor-index="${targetIndex}"]`)!;
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0, clientY: 0, shiftKey: true });
    }
    expect([...useMarginStore.getState().selectedAnchorIndices].sort()).toEqual([1, 3]);
    // Multi-selected handles get their distinct visual state.
    await waitFor(() => {
      expect(document.querySelectorAll('.margin-overlay__handle--multi-selected').length).toBe(2);
    });

    // Delete key -> ONE coalesced bulk-delete commit (real geodesic bridging
    // via the worker), selection consumed.
    const historyBefore = useCaseStore.getState().document.history.length;
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => {
      expect(useMarginStore.getState().anchors).toHaveLength(3);
    });
    const history = useCaseStore.getState().document.history;
    expect(history).toHaveLength(historyBefore + 1);
    expect(history.at(-1)!.name).toBe('margin-edit');
    expect(history.at(-1)!.params.gesture).toBe('delete-anchors-bulk');
    expect(history.at(-1)!.params.deletedIndices).toEqual([1, 3]);
    expect(useMarginStore.getState().selectedAnchorIndices.size).toBe(0);
    expect(useMarginStore.getState().closed).toBe(true); // still a closed loop (3 anchors — the floor)
  });

  it('a plain (unshifted) click still single-selects and CLEARS any bulk set — the two mechanisms never fight', async () => {
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

    const screenByAnchorIndex = new Map([
      [0, { xPx: 100, yPx: 100 }],
      [1, { xPx: 200, yPx: 100 }],
      [2, { xPx: 300, yPx: 100 }],
    ]);
    registerActiveSceneManager(createFakeSceneManager(canvas, screenByAnchorIndex));

    act(() => {
      useMarginStore.setState({
        phase: 'active',
        anchors: [anchorAt(0), anchorAt(1), anchorAt(2)],
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
      expect(document.querySelectorAll('[data-testid="margin-anchor-handle"]').length).toBe(3);
    });

    const handleFor = (i: number) => document.querySelector(`[data-anchor-index="${i}"]`)!;
    fireEvent.pointerDown(handleFor(0), { pointerId: 1 });
    fireEvent.pointerUp(handleFor(0), { pointerId: 1, shiftKey: true });
    fireEvent.pointerDown(handleFor(2), { pointerId: 1 });
    fireEvent.pointerUp(handleFor(2), { pointerId: 1, shiftKey: true });
    expect(useMarginStore.getState().selectedAnchorIndices.size).toBe(2);

    // Plain click on anchor 1: fresh single selection, bulk set dropped.
    fireEvent.pointerDown(handleFor(1), { pointerId: 1 });
    fireEvent.pointerUp(handleFor(1), { pointerId: 1 });
    expect(useMarginStore.getState().selectedAnchorIndex).toBe(1);
    expect(useMarginStore.getState().selectedAnchorIndices.size).toBe(0);
  });
});
