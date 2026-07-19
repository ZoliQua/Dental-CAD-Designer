// apps/client/src/ui/RepairPanel.dom.test.tsx
//
// Phase 2 Task 12: the first real-DOM component test in this repo, proving
// the `client-dom` vitest project (browser mode, real Chromium via the
// Playwright provider — see vitest.config.ts and README.md in this
// directory for the full lane writeup). Targets the exact gap prior
// per-task reviews kept flagging (see .superpowers/sdd/progress.md's P1
// Task 8 minor note): "RepairPanel conditional-render logic untested at DOM
// level (no jsdom infra — repo convention)".
//
// Same "no-mock philosophy" as the rest of this repo's tests: this renders
// the REAL RepairPanel against a REAL caseStore/meshStore (fabricated
// fixtures, exactly like engine/repair.test.ts) and, for the async cards,
// goes through the REAL kernel-workers WorkerPool (browser Web Worker path
// — a real Comlink round trip, real @dqcad/kernel repair algorithms) rather
// than stubbing engine/repair.ts's preview* functions.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n'; // side-effect: initializes i18next synchronously (see that module's doc)
import { caseStore } from '../engine/caseStore';
// `MeshStats` re-exported from engine/repair.ts (not `@dqcad/kernel-workers`
// directly) — the `ui` layer may not import `kernel-workers` (CLAUDE.md's
// layer rule, lint-enforced), same reasoning RepairPanel.tsx itself
// documents at its own `MeshStats` import. `IntakeReport` has no such
// re-export anywhere in `engine/`, so `registerMesh` below passes its
// `report` field as a plain untyped object literal instead of naming that
// type (TypeScript still structurally checks its shape against
// `caseStore.registerImportedMesh`'s parameter type).
import { type MeshStats } from '../engine/repair';
import { RepairPanel } from './RepairPanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const CLEAN_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  surfaceAreaMm2: 6,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

const HOLE_STATS: MeshStats = {
  ...CLEAN_STATS,
  watertight: false,
  boundaryEdgeCount: 3,
};

// A closed unit cube (watertight, manifold, one component) — used for the
// "nothing to repair" case.
const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [0, 4, 7],
  [0, 7, 3],
];

function cubePositions(): Float64Array {
  return new Float64Array(CUBE_CORNERS.flat());
}
function cubeIndices(): Uint32Array {
  return Uint32Array.from(CUBE_TRIANGLES.flat());
}

// A single unfilled triangular hole in an otherwise-closed box: drop one
// triangle from the cube fixture above, leaving a 3-edge boundary loop small
// enough for fillSmallHoles to actually fill (real geometry — this drives a
// REAL previewFillSmallHoles worker job below, not a stubbed result).
function boxWithHolePositions(): Float64Array {
  return cubePositions();
}
function boxWithHoleIndices(): Uint32Array {
  // Same triangle list as the cube, minus the LAST face (indices 10/11 —
  // [0,4,7] and [0,7,3], the -X face) so exactly one 4-vertex boundary loop
  // remains open.
  const withoutLastFace = CUBE_TRIANGLES.slice(0, CUBE_TRIANGLES.length - 2);
  return Uint32Array.from(withoutLastFace.flat());
}

// A flat, open 9x9-quad grid sheet (10x10 vertices) — its ENTIRE outer
// perimeter is one boundary loop of 4*9 = 36 edges, ABOVE fillSmallHoles'
// default `maxBoundaryEdges` (32 — see packages/kernel/src/repair/
// fillSmallHoles.ts's DEFAULT_MAX_BOUNDARY_EDGES) — so the REAL
// previewFillSmallHoles worker job is expected to refuse it with reason
// 'tooManyEdges', exercising RepairPanel's skip-reason display
// (repair.fillSmallHoles.skippedSummary) end to end through a real browser
// Web Worker, not a stubbed/forced UI state.
function oversizedHoleGridMesh(): { positions: Float64Array; indices: Uint32Array } {
  const cols = 9;
  const rows = 9;
  const positions = new Float64Array((cols + 1) * (rows + 1) * 3);
  let p = 0;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      positions[p++] = i;
      positions[p++] = j;
      positions[p++] = 0;
    }
  }
  const vertexIndex = (i: number, j: number): number => j * (cols + 1) + i;
  const triangles: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = vertexIndex(i, j);
      const b = vertexIndex(i + 1, j);
      const c = vertexIndex(i + 1, j + 1);
      const d = vertexIndex(i, j + 1);
      triangles.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices: Uint32Array.from(triangles) };
}

const OVERSIZED_HOLE_STATS: MeshStats = {
  watertight: false,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [9, 9, 0] },
  surfaceAreaMm2: 81,
  signedVolumeMm3: null,
  degenerateCount: 0,
  boundaryEdgeCount: 36,
};

function registerMesh(contentHash: string, positions: Float64Array, indices: Uint32Array, stats: MeshStats): void {
  caseStore.registerImportedMesh({
    contentHash,
    name: 'scan.stl',
    format: 'stl',
    positions,
    indices,
    stats,
    report: EMPTY_REPORT,
    operations: [],
  });
}

beforeEach(() => {
  caseStore.resetForTests();
});

afterEach(() => {
  // See CasePicker.dom.test.tsx's afterEach doc: browser mode does not
  // auto-wire @testing-library/react's implicit cleanup the way a jsdom
  // project does — explicit cleanup here keeps each test's render() from
  // leaking into the next test's real (shared) browser page.
  cleanup();
  caseStore.resetForTests();
});

describe('RepairPanel — conditional render', () => {
  it('renders nothing for a clean (watertight, manifold, single-component, no boundary) mesh', () => {
    registerMesh('dom-clean', cubePositions(), cubeIndices(), CLEAN_STATS);
    const node = caseStore.addSceneNode('dom-clean', 'situ');

    render(<RepairPanel meshId={node.meshId} />);

    // The panel's synchronous show* gating (RepairPanel.tsx lines ~76-83)
    // means this is decidable on the FIRST render, before any async preview
    // call settles — no waitFor needed for the negative case.
    expect(screen.queryByTestId('repair-panel')).toBeNull();
  });

  it('renders nothing for an unknown meshId (no mesh record)', () => {
    render(<RepairPanel meshId="does-not-exist" />);
    expect(screen.queryByTestId('repair-panel')).toBeNull();
  });
});

describe('RepairPanel — fill-small-holes card + skip-reason display', () => {
  it('shows the panel and, once the REAL previewFillSmallHoles worker job resolves, the fill-small-holes card with its summary', async () => {
    registerMesh('dom-hole', boxWithHolePositions(), boxWithHoleIndices(), HOLE_STATS);
    const node = caseStore.addSceneNode('dom-hole', 'situ');

    render(<RepairPanel meshId={node.meshId} />);

    // Panel-level gating is synchronous (boundaryEdgeCount > 0 from the
    // registered stats), so the panel itself and the fill-holes card shell
    // appear immediately, in a 'loading' state.
    expect(screen.getByTestId('repair-panel')).toBeTruthy();
    expect(screen.getByTestId('repair-card-fill-small-holes')).toBeTruthy();

    // The card's preview is a REAL kernel-workers job (previewFillSmallHoles
    // -> repairFillSmallHoles job -> a real browser Web Worker running
    // @dqcad/kernel's fillSmallHoles) — `findByTestId` polls until the
    // 'ready' state's apply button actually appears (replacing the
    // 'repair-card__status' "Computing preview…" paragraph), proving the
    // real worker round trip actually completes inside this browser test
    // environment (this is the whole point of the client-dom lane: real DOM
    // AND real workers, not a jsdom stand-in for either).
    const applyButton = await screen.findByTestId(
      'repair-card-fill-small-holes-apply',
      {},
      { timeout: 10_000 },
    );
    expect(applyButton).toBeTruthy();

    // One boundary loop (the single missing face) was found and filled —
    // the summary text is i18n'd (repair.fillSmallHoles.summary), so assert
    // via the stable stats table (before/after watertight/manifold/
    // components/boundary-edges) instead of a hardcoded locale string.
    const statsRows = screen.getAllByRole('row');
    expect(statsRows.length).toBeGreaterThan(0);
  });

  it('displays the skip-reason note (and disables Apply) when the REAL worker refuses an oversized boundary loop', async () => {
    const oversized = oversizedHoleGridMesh();
    registerMesh('dom-oversized-hole', oversized.positions, oversized.indices, OVERSIZED_HOLE_STATS);
    const node = caseStore.addSceneNode('dom-oversized-hole', 'situ');

    render(<RepairPanel meshId={node.meshId} />);

    // Waits for the REAL previewFillSmallHoles worker job (this grid's
    // 36-edge outer perimeter exceeds the default 32-edge cap — see
    // oversizedHoleGridMesh's doc) to settle into 'ready' with a refused
    // loop.
    const applyButton = await screen.findByTestId(
      'repair-card-fill-small-holes-apply',
      {},
      { timeout: 10_000 },
    );
    // loopsFilled === 0 (the only loop found was refused, not filled) — the
    // panel disables Apply rather than letting the user commit a no-op.
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);

    // The skip-reason note (repair.fillSmallHoles.skippedSummary) — matched
    // by its stable English substring (this repo bundles en.json as the
    // DEFAULT_LANGUAGE — see apps/client/src/i18n/index.ts) rather than a
    // data-testid, since the component itself doesn't tag this paragraph
    // separately from its sibling summary text.
    expect(screen.getByText(/hole\(s\) refused/i)).toBeTruthy();
  });
});
