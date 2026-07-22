// apps/client/src/ui/MarginPanel.dom.test.tsx
//
// Phase 3 Task 5: real-DOM `client-dom` project test (browser mode — see
// apps/client/src/ui/README.md), same "no-mock philosophy" / "drive the
// engine with a real ray + real candidate set, not simulated canvas mouse
// events" convention as ui/AlignmentPanel.dom.test.tsx (this file has no
// mounted `<Viewport>`/WebGL canvas either — MarginPanel is a sidebar
// component).
//
// ## Fixture note (deliberate substitution — documented per this task's
// report)
//
// This task's brief asks for "propose on standin die via UI". The REAL
// `test-fixtures/standin-scans/standin-prep-die.stl` fixture IS exercised
// (via Node `readFileSync`) in the NODE-lane `marginEditor.test.ts`'s own
// NoRidgeFoundError test — Vitest's BROWSER-mode lane (this file) has no
// `node:fs` access from its test body (the established convention for every
// `*.dom.test.tsx` file in this repo is a small SYNTHETIC in-memory mesh —
// see AlignmentPanel.dom.test.tsx's/RepairPanel.dom.test.tsx's own
// icosahedron fixtures — none of them load a real STL file). This file's
// icosahedron plays the SAME functional role as the standin die for this
// test's purpose: a small, watertight, CONVEX-everywhere mesh — so
// `proposeMargin` deterministically throws `NoRidgeFoundError` on it too,
// exercising the exact same propose-error -> manual-fallback path, then
// manual placement -> close -> drag -> commit.
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore } from '../state/marginStore';
import { MarginPanel } from './MarginPanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

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

type Vec3 = readonly [number, number, number];

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

/** Ray from well outside the mesh, through `vertex`, toward the origin —
 * reliably hits a convex mesh's surface AT `vertex` (same convention as
 * AlignmentPanel.dom.test.tsx's own `rayAtVertex`). */
function rayAtVertex(vertex: Vec3): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const len = Math.hypot(vertex[0], vertex[1], vertex[2]) || 1;
  const dir: Vec3 = [-vertex[0] / len, -vertex[1] / len, -vertex[2] / len];
  const origin: Vec3 = [vertex[0] * 3, vertex[1] * 3, vertex[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

function registerDieStandin(): { nodeId: string; positions: Float64Array } {
  const { positions, indices } = icosahedronBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'margin-dom-die',
    name: 'die-standin.stl',
    format: 'stl',
    positions,
    indices,
    stats: ICOSA_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('margin-dom-die', 'prepDie');
  return { nodeId: node.id, positions };
}

beforeEach(() => {
  caseStore.resetForTests();
  marginEditor.resetForTests();
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
  marginEditor.resetForTests();
});

describe('MarginPanel — critical path (real component, real store, real worker jobs)', () => {
  it('propose fails gracefully on the ridge-free standin die, falls to manual mode, traces + closes + drags an anchor, and journals margin-edit ops', async () => {
    const user = userEvent.setup();
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });

    render(<MarginPanel />);

    await user.selectOptions(screen.getByTestId('margin-restoration-select'), restoration.id);
    await user.selectOptions(screen.getByTestId('margin-tooth-select'), '11');
    await user.click(screen.getByTestId('margin-start-button'));

    await waitFor(() => {
      expect(screen.getByTestId('margin-active-tooth')).toBeTruthy();
    });
    expect(useMarginStore.getState().phase).toBe('active');
    expect(useMarginStore.getState().mode).toBe('auto');

    // AUTO-PROPOSE via the real UI path (seed click on the standin die) —
    // deterministically fails (no ridge anywhere on a convex mesh).
    await act(async () => {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, 0)));
    });

    await waitFor(() => {
      expect(screen.getByTestId('margin-error')).toBeTruthy();
    });
    // Deliberately still 'active' (not a distinct 'error' phase — see
    // state/marginStore.ts's `MarginToolPhase` doc) — the panel stays
    // immediately clickable in manual mode right after the failure.
    expect(useMarginStore.getState().phase).toBe('active');
    expect(useMarginStore.getState().mode).toBe('manual'); // fell back automatically
    expect(useMarginStore.getState().anchors).toHaveLength(0); // nothing to discard
    expect(marginEditor.getErrorKind()).toBe('noRidgeFound');
    expect(screen.getByTestId('margin-error').textContent).toContain('finish line');

    // A fresh click after the error resumes normal manual-mode picking
    // (handlePick's own `phase !== 'active'` guard only blocks while an
    // error is unresolved at the STORE level between explicit actions — the
    // next real gesture, a plain manual placement click, moves it forward;
    // no separate "acknowledge error" button exists this task, by design —
    // matches ToolManager's own "the user just tries again" convention for
    // a dropped/failed pick).
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await marginEditor.handlePick(rayAtVertex(pointAt(positions, i)));
      });
    }
    await waitFor(() => {
      expect(useMarginStore.getState().anchors).toHaveLength(4);
    });
    expect(screen.getByTestId('margin-anchor-count').textContent).toContain('4');

    const historyBeforeClose = useCaseStore.getState().document.history.length;
    await user.click(screen.getByTestId('margin-close-button'));
    await waitFor(() => {
      expect(useMarginStore.getState().closed).toBe(true);
    });
    const afterClose = useCaseStore.getState().document.history;
    expect(afterClose).toHaveLength(historyBeforeClose + 1);
    expect(afterClose.at(-1)!.name).toBe('margin-edit');
    expect(afterClose.at(-1)!.params.gesture).toBe('toggle-close');

    const savedRestoration = useCaseStore.getState().document.restorations.find((r) => r.id === restoration.id)!;
    expect(savedRestoration.marginLines[11]!.anchors).toHaveLength(4);
    expect(savedRestoration.marginLines[11]!.closed).toBe(true);

    // Drag anchor 0 to a different vertex.
    const historyBeforeDrag = useCaseStore.getState().document.history.length;
    act(() => {
      marginEditor.beginAnchorDrag(0);
    });
    await act(async () => {
      await marginEditor.updateAnchorDrag(rayAtVertex(pointAt(positions, 6)));
    });
    await act(async () => {
      await marginEditor.endAnchorDrag();
    });

    const afterDrag = useCaseStore.getState().document.history;
    expect(afterDrag).toHaveLength(historyBeforeDrag + 1); // ONE coalesced op
    expect(afterDrag.at(-1)!.params.gesture).toBe('drag-anchor');
    const draggedRestoration = useCaseStore.getState().document.restorations.find((r) => r.id === restoration.id)!;
    expect(draggedRestoration.marginLines[11]!.anchors[0]!.position).not.toEqual(
      savedRestoration.marginLines[11]!.anchors[0]!.position,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Phase 3 editor enhancements: anchor-count slider (task 1) + bulk-delete
// button (task 2) — panel-level UI wiring (the engine/worker flows behind
// both are covered end-to-end in engine/marginEditor.test.ts and
// ui/MarginOverlay.dom.test.tsx).
// ---------------------------------------------------------------------------

describe('MarginPanel — anchor-count slider + bulk-delete button (Phase 3 editor enhancements)', () => {
  it('shows the slider in auto mode before any anchor exists (default 50), and a change flows to the store', async () => {
    const user = userEvent.setup();
    const { nodeId } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });

    render(<MarginPanel />);
    await user.selectOptions(screen.getByTestId('margin-restoration-select'), restoration.id);
    await user.selectOptions(screen.getByTestId('margin-tooth-select'), '11');
    await user.click(screen.getByTestId('margin-start-button'));
    await waitFor(() => {
      expect(screen.getByTestId('margin-anchor-count-slider')).toBeTruthy();
    });

    const slider = screen.getByTestId('margin-anchor-count-slider') as HTMLInputElement;
    expect(slider.min).toBe('20');
    expect(slider.max).toBe('200');
    expect(slider.value).toBe('50'); // measured default — see MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT's doc
    expect(useMarginStore.getState().proposalTargetAnchorCount).toBe(50);
    // The label echoes the live value (i18n'd, approximate-semantics "≈").
    expect(screen.getByTestId('margin-anchor-count-field').textContent).toContain('50');

    fireEvent.change(slider, { target: { value: '30' } });
    expect(useMarginStore.getState().proposalTargetAnchorCount).toBe(30);
    await waitFor(() => {
      expect(screen.getByTestId('margin-anchor-count-field').textContent).toContain('30');
    });

    // The slider is hidden in manual mode (it only affects auto-propose).
    await user.click(screen.getByTestId('margin-mode-manual'));
    expect(screen.queryByTestId('margin-anchor-count-slider')).toBeNull();
  });

  it('shows the bulk-delete button (with live count) whenever the shift-click selection is non-empty, replacing the single-delete button', async () => {
    const user = userEvent.setup();
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });

    render(<MarginPanel />);
    await user.selectOptions(screen.getByTestId('margin-restoration-select'), restoration.id);
    await user.selectOptions(screen.getByTestId('margin-tooth-select'), '11');
    await user.click(screen.getByTestId('margin-start-button'));
    await waitFor(() => {
      expect(useMarginStore.getState().phase).toBe('active');
    });

    // Trace a real 4-anchor open curve via the engine (real worker jobs).
    await act(async () => {
      marginEditor.setMode('manual');
      for (let i = 0; i < 4; i++) {
        await marginEditor.handlePick(rayAtVertex(pointAt(positions, i)));
      }
    });
    await waitFor(() => {
      expect(useMarginStore.getState().anchors.length).toBe(4);
    });

    // Single selection -> single-delete button only.
    act(() => {
      marginEditor.selectAnchor(0);
    });
    await waitFor(() => {
      expect(screen.getByTestId('margin-delete-anchor-button')).toBeTruthy();
    });
    expect(screen.queryByTestId('margin-delete-selected-button')).toBeNull();

    // Shift-click selection (engine seam) -> bulk button with the count,
    // single-delete button hidden (never two competing delete affordances).
    act(() => {
      marginEditor.toggleAnchorSelection(1);
      marginEditor.toggleAnchorSelection(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('margin-delete-selected-button')).toBeTruthy();
    });
    expect(screen.getByTestId('margin-delete-selected-button').textContent).toContain('2');
    expect(screen.queryByTestId('margin-delete-anchor-button')).toBeNull();

    // Bulk delete via the button — ONE journaled op (open curve, floor 2).
    const historyBefore = useCaseStore.getState().document.history.length;
    await user.click(screen.getByTestId('margin-delete-selected-button'));
    await waitFor(() => {
      expect(useMarginStore.getState().anchors.length).toBe(2);
    });
    const history = useCaseStore.getState().document.history;
    expect(history.length).toBe(historyBefore + 1);
    expect(history.at(-1)!.params.gesture).toBe('delete-anchors-bulk');
    expect(screen.queryByTestId('margin-delete-selected-button')).toBeNull(); // selection consumed
  }, 30_000);
});
