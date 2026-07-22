// apps/client/src/ui/MarginPanel.validation.dom.test.tsx
//
// Phase 3 Task 6: real-DOM `client-dom` project tests (browser mode) for the
// live validation badge + confirm/acknowledge-warnings flow — same
// "synthetic icosahedron standin, no mounted Viewport" convention as
// MarginPanel.dom.test.tsx (this file's own module doc has the full
// rationale for that substitution; not repeated here).
//
// ## Three scenarios, three different geometry-construction strategies
//
// 1. **ACCEPTANCE — self-intersection blocks confirm**: real UI clicks
//    (`marginEditor.handlePick`, exactly like MarginPanel.dom.test.tsx) at
//    a deliberately scrambled vertex order that forms a classic "bowtie"
//    self-crossing quad (see `BOWTIE_ORDER`'s doc below for the geometric
//    proof).
// 2. **Clean confirm**: the SAME 4 vertices in their real perimeter order
//    (a simple, non-crossing quad) — the control case.
// 3. **Confirm-with-acknowledge**: smoothness-only warnings (no hard
//    failure) are NOT reachable via a few coarse icosahedron-vertex clicks
//    (this task's report: `MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV`,
//    80mm^-1, is calibrated against REAL fine-grained ridge-walk noise —
//    reaching that threshold needs FINE point spacing a handful of ~2mm-
//    edge icosahedron clicks cannot produce, and — this task's report has
//    the full derivation — a DENSE zigzag along a whole edge triggers a
//    false `selfIntersecting` too, purely from point density, not a real
//    crossing). This scenario instead injects a PRECISELY ENGINEERED
//    `LiveMarginAnchor[]`/`LiveMarginSegment[]` directly via
//    `useMarginStore.getState().setActive(...)` — the SAME shape
//    `marginEditor`'s own `resolveAndPublish`/`commit` would publish, just
//    constructed by hand instead of via simulated clicks + real worker
//    geodesic calls, so ONE ISOLATED sharp "spike" (see `isolatedSpike`'s
//    doc) can be engineered — every injected point is still a genuine
//    on-surface point of the REAL mesh (barycentric interpolation within
//    one real triangle face), verified by the REAL `validateMargin` worker
//    job's own BVH on-surface check, not merely asserted.
//    `confirmMargin()` itself, the REAL worker `validateMargin` round trip,
//    the REAL rendered badge/buttons, and the REAL journal are exercised
//    identically to scenarios 1-2 from this point on — only HOW the anchor
//    geometry entered the store differs.
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore, type LiveMarginAnchor, type LiveMarginSegment } from '../state/marginStore';
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

// Same raw vertex/face data as MarginPanel.dom.test.tsx's own
// `icosahedronBuffers` (duplicated per this repo's established test-fixture
// convention — see that file's module doc).
const T = (1 + Math.sqrt(5)) / 2;
const RAW_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  return { positions: new Float64Array(RAW_VERTICES.flat()), indices: Uint32Array.from(FACES.flat()) };
}

type Vec3 = readonly [number, number, number];

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

function rayAtVertex(vertex: Vec3): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const len = Math.hypot(vertex[0], vertex[1], vertex[2]) || 1;
  const dir: Vec3 = [-vertex[0] / len, -vertex[1] / len, -vertex[2] / len];
  const origin: Vec3 = [vertex[0] * 3, vertex[1] * 3, vertex[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

function registerDieStandin(): { nodeId: string; positions: Float64Array } {
  const { positions, indices } = icosahedronBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'margin-validation-dom-die',
    name: 'die-standin.stl',
    format: 'stl',
    positions,
    indices,
    stats: ICOSA_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('margin-validation-dom-die', 'prepDie');
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

// ---------------------------------------------------------------------------
// Scenario 1/2 fixture: vertices 0,1,2,3 (the raw list's own golden
// RECTANGLE in the z=0 plane: (-1,t),(1,t),(1,-t),(-1,-t) for indices
// 0,1,3,2 respectively — a real face of this icosahedron's own convex hull,
// not an arbitrary coplanar coincidence).
//
// PERIMETER order (0,1,3,2) traces the rectangle's own boundary
// (top-left -> top-right -> bottom-right -> bottom-left) — a simple,
// non-crossing quad.
//
// BOWTIE order (0,2,1,3) instead visits: 0->2 (LEFT edge, vertical),
// 2->1 (the rectangle's OWN DIAGONAL, bottom-left to top-right), 1->3
// (RIGHT edge, vertical), 3->0 (the OTHER diagonal, bottom-right to
// top-left) — the two diagonal segments (2->1 and 3->0) cross exactly at
// the rectangle's center: the textbook "bowtie" self-intersecting
// quadrilateral construction. All 4 points share z=0 exactly (the raw
// vertex data), so the crossing is EXACT (ambient ~0 distance, not merely
// "close"), robustly clearing `MARGIN_SELF_INTERSECTION_TOLERANCE_MM`.
// ---------------------------------------------------------------------------
const PERIMETER_ORDER = [0, 1, 3, 2];
const BOWTIE_ORDER = [0, 2, 1, 3];

async function placeManualLoop(positions: Float64Array, order: readonly number[]): Promise<void> {
  // `setMode` synchronously updates `marginStore` (a React re-render), so it
  // needs the SAME `act()` wrap as every other store-mutating call here —
  // an earlier draft of this helper called it bare, which was the root
  // cause of this file's act() warnings (a real DOM subscriber re-render
  // firing with no act() scope active), found and fixed by this task's
  // review batch (see MarginPanel — validation.dom test.tsx's own note in
  // p3-task-6-report.md's "Fix: T6 review items" section for the trace that
  // pinned it down).
  act(() => {
    marginEditor.setMode('manual');
  });
  for (const vertexIndex of order) {
    await act(async () => {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, vertexIndex)));
    });
  }
}

describe('MarginPanel — validation badge + confirm (ACCEPTANCE: seeded self-intersection rejection)', () => {
  it('ACCEPTANCE: a bowtie (figure-eight) anchor ordering — validation badge shows invalid, confirm is blocked (browser-lane + engine-level)', async () => {
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });

    render(<MarginPanel />);
    await act(async () => {
      marginEditor.startForTooth(restoration.id, 11);
    });

    await placeManualLoop(positions, BOWTIE_ORDER);
    await waitFor(() => expect(useMarginStore.getState().anchors).toHaveLength(4));
    await act(async () => {
      await marginEditor.toggleClosed();
    });
    await waitFor(() => expect(useMarginStore.getState().closed).toBe(true));

    // Live badge (browser-lane assertion): waits for the fire-and-forget
    // `refreshValidation()` the commit triggered.
    await waitFor(() => {
      expect(screen.getByTestId('margin-validation-badge').getAttribute('data-status')).toBe('invalid');
    });
    expect(screen.getByTestId('margin-validation-hard-failures').textContent).toContain('crosses itself');
    const confirmButton = screen.getByTestId('margin-confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    // Engine-level assertion of the SAME acceptance. `confirmMargin()` is
    // called directly (not via a DOM event, so React can't wrap the
    // dispatch itself) — its own store update needs an explicit `act()`
    // wrap, same as every other direct `marginEditor` call in this file.
    const historyBefore = useCaseStore.getState().document.history.length;
    let outcome!: Awaited<ReturnType<typeof marginEditor.confirmMargin>>;
    await act(async () => {
      outcome = await marginEditor.confirmMargin();
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.hardFailureKinds).toContain('selfIntersecting');
    // Nothing journaled — a blocked confirm never writes an Operation.
    expect(useCaseStore.getState().document.history.length).toBe(historyBefore);

    // Browser-lane: clicking a disabled button is a no-op (real DOM
    // semantics, not a simulated bypass) — the SAME hard block from the UI
    // side. `MarginPanel`'s own confirm handler is fire-and-forget
    // (`onClick={() => void handleConfirm(false)}`) — `user.click()` only
    // awaits the synchronous DOM dispatch, not that inner promise, so this
    // needs its own `act()` wrap too (same reasoning as the direct
    // `confirmMargin()` call above).
    const user = userEvent.setup();
    await act(async () => {
      await user.click(confirmButton);
    });
    expect(useCaseStore.getState().document.history.length).toBe(historyBefore);
  }, 30_000);

  it('control case: the SAME 4 vertices in perimeter order validate clean and confirm succeeds, journaled', async () => {
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });
    const user = userEvent.setup();

    render(<MarginPanel />);
    await act(async () => {
      marginEditor.startForTooth(restoration.id, 11);
    });

    await placeManualLoop(positions, PERIMETER_ORDER);
    await waitFor(() => expect(useMarginStore.getState().anchors).toHaveLength(4));
    await act(async () => {
      await marginEditor.toggleClosed();
    });
    await waitFor(() => expect(useMarginStore.getState().closed).toBe(true));

    await waitFor(() => {
      expect(screen.getByTestId('margin-validation-badge').getAttribute('data-status')).toBe('valid');
    });
    const confirmButton = screen.getByTestId('margin-confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);

    const historyBefore = useCaseStore.getState().document.history.length;
    await act(async () => {
      await user.click(confirmButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId('margin-confirmed-indicator')).toBeTruthy();
    });
    const history = useCaseStore.getState().document.history;
    expect(history.length).toBe(historyBefore + 1);
    expect(history.at(-1)!.name).toBe('margin-confirm');
    expect(history.at(-1)!.params.acknowledgedWarnings).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 3: confirm-with-acknowledge (smoothness warning, no hard
// failure) — see this file's module doc for why the geometry is injected
// directly rather than clicked.
// ---------------------------------------------------------------------------

/** A point on the real triangle face `[fromVertex, viaVertex, toVertex]`
 * (must be an ACTUAL face of `FACES`) via barycentric interpolation:
 * `wFrom = 1 - s - e`, `wTo = s`, `wVia = e` — `s` is the fractional
 * position along the `fromVertex -> toVertex` edge, `e` is a perpendicular
 * deviation toward `viaVertex`. Guaranteed on-surface (a convex
 * combination of one real triangle's 3 vertices), independent of any
 * validator behavior — verified anyway, by the REAL `validateMargin`
 * worker job, in the test below. */
function facePoint(positions: Float64Array, fromVertex: number, viaVertex: number, toVertex: number, s: number, e: number): Vec3 {
  const pFrom = pointAt(positions, fromVertex);
  const pVia = pointAt(positions, viaVertex);
  const pTo = pointAt(positions, toVertex);
  const wFrom = 1 - s - e;
  const wTo = s;
  const wVia = e;
  return [wFrom * pFrom[0] + wTo * pTo[0] + wVia * pVia[0], wFrom * pFrom[1] + wTo * pTo[1] + wVia * pVia[1], wFrom * pFrom[2] + wTo * pTo[2] + wVia * pVia[2]];
}

/** ONE isolated, sharp "spike" (3 points: `prev`, `spike`, `next`) inserted
 * near `fromVertex` on the real triangle face `[fromVertex, viaVertex,
 * toVertex]` — deliberately NOT a dense zigzag along the whole edge (an
 * earlier draft of this test tried that; this task's report has the
 * measured reason it doesn't work: a DENSE zigzag's own nearby same-curve
 * points fall within `MARGIN_SELF_INTERSECTION_TOLERANCE_MM` of EACH
 * OTHER, purely from point density — not a real crossing — spuriously
 * tripping `selfIntersecting` too; validate.ts's arc-length locality
 * window (added specifically to fix this class of false positive for
 * DENSE, uniformly-spaced resampled curves) does not fully cover an
 * embedded spike's own inflated local arc length). ONE isolated spike,
 * surrounded on both sides by nothing else nearby, sidesteps the whole
 * class of interaction: `prev`/`next` sit at `sMid -/+ ds` (tiny
 * tangential separation), `spike` at `sMid` with perpendicular deviation
 * `amplitude` — MEASURED (this task's report, scratchpad probe):
 * `sMid=0.05, ds=0.0001, amplitude=0.01` reads a discrete curvature of
 * ~156mm^-1 at the spike (comfortably above
 * `MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV`'s 80mm^-1, ~2x headroom)
 * with ZERO self-intersection/off-surface side effects — the REMAINING
 * loop (a single long segment from `next` all the way to `toVertex`, plus
 * the other 2 anchors) stays far enough away, in both ambient AND
 * arc-length terms, that nothing else in the loop is disturbed. */
function isolatedSpike(positions: Float64Array, fromVertex: number, viaVertex: number, toVertex: number): Vec3[] {
  const sMid = 0.05;
  const ds = 0.0001;
  const amplitude = 0.01;
  return [
    facePoint(positions, fromVertex, viaVertex, toVertex, sMid - ds, 0),
    facePoint(positions, fromVertex, viaVertex, toVertex, sMid, amplitude),
    facePoint(positions, fromVertex, viaVertex, toVertex, sMid + ds, 0),
  ];
}

describe('MarginPanel — validation badge + confirm-with-acknowledge (smoothness warning, no hard failure)', () => {
  it('a clean-otherwise triangle loop with one deliberately fine zigzag edge shows a WARNING badge, confirm requires acknowledgement, then journals with acknowledgedWarnings: true', async () => {
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });
    const user = userEvent.setup();

    render(<MarginPanel />);
    await act(async () => {
      marginEditor.startForTooth(restoration.id, 11);
    });

    // Triangle loop: vertex0 -[straight-with-one-spike, face (0,5,1)]->
    // vertex1 -[straight]-> vertex3 -[straight]-> vertex0. Vertex3 sits far
    // from the (0,5,1) face, so the spike cannot accidentally self-
    // intersect with the other two (coarse, 2-point) edges.
    const anchor0: LiveMarginAnchor = { position: pointAt(positions, 0), triangleIndex: 1, barycentric: [1, 0, 0] }; // face (0,5,1) corner 0
    const anchor1: LiveMarginAnchor = { position: pointAt(positions, 1), triangleIndex: 1, barycentric: [0, 0, 1] }; // face (0,5,1) corner 2
    const anchor3: LiveMarginAnchor = { position: pointAt(positions, 3), triangleIndex: 10, barycentric: [1, 0, 0] }; // face (3,9,4) corner 0

    const spikeSegment: LiveMarginSegment = { points: [anchor0.position, ...isolatedSpike(positions, 0, 5, 1), anchor1.position] };
    const straightSegment1: LiveMarginSegment = { points: [anchor1.position, anchor3.position] };
    const straightSegment2: LiveMarginSegment = { points: [anchor3.position, anchor0.position] };

    act(() => {
      useMarginStore.getState().setActive({
        anchors: [anchor0, anchor1, anchor3],
        segments: [spikeSegment, straightSegment1, straightSegment2],
        closed: true,
        segmentConfidence: null,
        humanEdited: true,
        mode: 'manual',
        unresolvedAnchorCount: 0,
      });
    });

    // No commit ran (state injected directly via `setActive`, not through
    // the normal commit-worthy-gesture path), so the badge has not
    // auto-refreshed yet — `refreshValidation()` is public specifically for
    // this: a caller that publishes geometry outside the commit path can
    // still populate the live badge (see that method's own doc).
    // `confirmMargin()` itself ALWAYS re-validates fresh regardless (its
    // doc: never trusts a possibly-stale badge) — this call is purely to
    // exercise/assert the BADGE's own state before confirming.
    await act(async () => {
      await marginEditor.refreshValidation();
    });
    await waitFor(() => {
      expect(screen.getByTestId('margin-validation-badge').getAttribute('data-status')).toBe('warning');
    });
    const confirmButton = screen.getByTestId('margin-confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false); // enabled: warnings only, not blocked

    const historyBefore = useCaseStore.getState().document.history.length;
    await user.click(confirmButton);

    // First click: hard failures are absent but a warning exists — the
    // engine returns `requiresAcknowledgement: true` and does NOT journal;
    // the UI reveals the acknowledge button.
    await waitFor(() => {
      expect(screen.getByTestId('margin-validation-badge').getAttribute('data-status')).toBe('warning');
    });
    expect(screen.getByTestId('margin-validation-smoothness-warning')).toBeTruthy();
    expect(useCaseStore.getState().document.history.length).toBe(historyBefore); // not yet confirmed
    const acknowledgeButton = await screen.findByTestId('margin-acknowledge-confirm-button');

    await user.click(acknowledgeButton);

    await waitFor(() => {
      expect(screen.getByTestId('margin-confirmed-indicator')).toBeTruthy();
    });
    const history = useCaseStore.getState().document.history;
    expect(history.length).toBe(historyBefore + 1);
    expect(history.at(-1)!.name).toBe('margin-confirm');
    expect(history.at(-1)!.params.acknowledgedWarnings).toBe(true);
    expect((history.at(-1)!.params.smoothnessWarningCount as number)).toBeGreaterThan(0);
  }, 30_000);
});
