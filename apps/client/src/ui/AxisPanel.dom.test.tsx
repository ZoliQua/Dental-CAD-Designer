// apps/client/src/ui/AxisPanel.dom.test.tsx
//
// Phase 3 Task 9: real-DOM `client-dom` project test (browser mode — see
// README.md in this directory, and ui/SurfaceDistancePanel.dom.test.tsx for
// the established pattern this file follows). Exercises the axis tool
// panel end to end through the REAL kernel-workers WorkerPool (browser Web
// Worker path — buildBvh + suggestAxis + axisHeatmap jobs, affinity-routed
// — see engine/axis.ts/workers.ts) against a real (small, synthetic)
// tapered-frustum mesh, same "no-mock philosophy" as the other client-dom
// tests in this directory.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import type { MarginAnchor, MarginLine } from '@dqcad/shared-types';
import { axisEngine } from '../engine/axis';
import { caseStore } from '../engine/caseStore';
import { type MeshStats } from '../engine/repair';
// `createRestoration` (not a hand-built `Restoration` object literal with
// `@dqcad/clinical-profiles`' `DEFAULT_RESTORATION_PARAMS`): the `ui` layer
// may not import `@dqcad/clinical-profiles` directly (CLAUDE.md/
// eslint.config.js's boundaries policy — only `engine` may), so this test
// goes through the SAME engine orchestration a real wizard flow would use,
// mirroring ui/MarginPanel.dom.test.tsx's own `createRestoration` usage.
import { createRestoration } from '../engine/restorations';
import { AxisPanel } from './AxisPanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const CUBE_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-4, -4, 0], max: [4, 4, 9] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

// A capped cone frustum (bottom ring WIDER than the top — true insertion
// axis [0,0,1]) with several intermediate wall rings — same construction as
// packages/kernel/src/axis/axis.test-fixtures.ts's `coneFrustumMesh` /
// engine/axis.test.ts's own duplicated builder (this repo's established
// "duplicate small fixture logic per test file" convention).
const BOTTOM_RADIUS = 4;
const TOP_RADIUS = 2.5;
const HEIGHT = 9;
const SEGMENTS = 32;
const HEIGHT_SEGMENTS = 8;

function frustumMeshBuffers(): { positions: Float64Array; indices: Uint32Array; wallSeed: (ring: number, seg: number) => MarginAnchor } {
  const ringIndex = (ring: number, seg: number): number => ring * SEGMENTS + seg;
  const positions: number[] = [];
  for (let r = 0; r <= HEIGHT_SEGMENTS; r++) {
    const t = r / HEIGHT_SEGMENTS;
    const z = t * HEIGHT;
    const radius = BOTTOM_RADIUS + (TOP_RADIUS - BOTTOM_RADIUS) * t;
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / SEGMENTS;
      positions.push(radius * Math.cos(theta), radius * Math.sin(theta), z);
    }
  }
  const bottomCenterIndex = positions.length / 3;
  positions.push(0, 0, 0);
  const topCenterIndex = positions.length / 3;
  positions.push(0, 0, HEIGHT);

  const indices: number[] = [];
  const wallTriangleIndexOf = new Map<string, number>();
  for (let r = 0; r < HEIGHT_SEGMENTS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sNext = (s + 1) % SEGMENTS;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      wallTriangleIndexOf.set(`${r},${s}`, indices.length / 3);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s));
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(topCenterIndex, ringIndex(HEIGHT_SEGMENTS, s), ringIndex(HEIGHT_SEGMENTS, sNext));
  }

  const flatPositions = Float64Array.from(positions);
  const flatIndices = Uint32Array.from(indices);
  return {
    positions: flatPositions,
    indices: flatIndices,
    wallSeed: (ring, seg) => {
      const key = `${Math.min(ring, HEIGHT_SEGMENTS - 1)},${seg}`;
      const triangleIndex = wallTriangleIndexOf.get(key)!;
      const i0 = flatIndices[triangleIndex * 3]!;
      return {
        position: [flatPositions[i0 * 3]!, flatPositions[i0 * 3 + 1]!, flatPositions[i0 * 3 + 2]!],
        triangleIndex,
        barycentric: [1, 0, 0],
      };
    },
  };
}

function setupCrownRestoration(): string {
  const fixture = frustumMeshBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'axis-panel-frustum',
    name: 'frustum.stl',
    format: 'stl',
    positions: fixture.positions,
    indices: fixture.indices,
    stats: CUBE_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('axis-panel-frustum', 'prepDie');

  const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: node.id });

  const loop: MarginAnchor[] = [];
  for (let s = 0; s < SEGMENTS; s++) {
    loop.push(fixture.wallSeed(3, s));
  }
  const marginLine: MarginLine = { anchors: loop, closed: true };
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 11: marginLine } },
    {
      id: 'op-margin',
      name: 'margin-edit',
      params: { tooth: 11 },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: '0.0.0-test',
      timestamp: new Date().toISOString(),
    },
  );
  return restoration.id;
}

beforeEach(() => {
  caseStore.resetForTests();
  axisEngine.resetForTests();
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
  axisEngine.resetForTests();
});

describe('AxisPanel — end to end (real WorkerPool, real frustum fixture)', () => {
  it('starts the tool, auto-suggests an axis close to the true construction axis, adjusts a slider, and confirms (journals axis-set)', async () => {
    const user = userEvent.setup();
    const restorationId = setupCrownRestoration();

    render(<AxisPanel />);

    await user.selectOptions(screen.getByTestId('axis-restoration-select'), restorationId);
    await user.click(screen.getByTestId('axis-start-button'));

    expect(screen.getByTestId('axis-suggest-button')).toBeTruthy();
    await user.click(screen.getByTestId('axis-suggest-button'));

    await waitFor(
      () => {
        expect(screen.getByTestId('axis-abutment-table')).toBeTruthy();
      },
      { timeout: 10_000 },
    );

    // Suggested elevation should read close to 90 degrees (axis close to
    // +Z, the frustum's true construction axis) — generous bound, the
    // kernel-level analytic tests own the tight, derived tolerance.
    const elevationSlider = screen.getByTestId('axis-elevation-slider') as HTMLInputElement;
    const elevationDeg = Number(elevationSlider.value);
    expect(elevationDeg).toBeGreaterThan(60);

    expect(screen.getByTestId('axis-source').textContent).toContain('auto-suggested');

    // Manual adjustment: drag the elevation slider — provenance flips to
    // manual and the heatmap recomputes (fire-and-forget; not directly
    // observed here, only the store-visible side effects are). `fireEvent.
    // change` (not userEvent.keyboard/click), the standard Testing Library
    // way to drive a `type="range"` input's value programmatically.
    fireEvent.change(elevationSlider, { target: { value: String(elevationDeg - 10) } });
    await waitFor(() => {
      expect(screen.getByTestId('axis-source').textContent).toContain('manually adjusted');
    });

    await user.click(screen.getByTestId('axis-confirm-button'));
    await waitFor(() => {
      expect(screen.getByTestId('axis-confirmed-indicator')).toBeTruthy();
    });

    const restoration = caseStore.getDocument().restorations.find((r) => r.id === restorationId)!;
    const history = caseStore.getDocument().history;
    const lastOp = history[history.length - 1]!;
    expect(lastOp.name).toBe('axis-set');
    expect(restoration.insertionAxis).toEqual(lastOp.params.axis);
  }, 20_000);
});
