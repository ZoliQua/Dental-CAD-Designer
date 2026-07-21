// axisStore.test.ts — pure store-logic tests (no worker/engine involved) —
// mirrors state/sectionStore's own lack of a dedicated test file being an
// exception, not the norm; state/marginStore-adjacent stores in this repo
// get direct unit coverage of their setters/initial-state contract.
import { beforeEach, describe, expect, it } from 'vitest';
import { useAxisStore } from './axisStore';

beforeEach(() => {
  useAxisStore.getState().reset();
});

describe('useAxisStore — initial state', () => {
  it('starts idle with no active session', () => {
    const state = useAxisStore.getState();
    expect(state.status).toBe('idle');
    expect(state.restorationId).toBeNull();
    expect(state.abutmentTeeth).toEqual([]);
    expect(state.ranked).toEqual([]);
    expect(state.perAbutment).toEqual([]);
    expect(state.confirmed).toBe(false);
  });
});

describe('useAxisStore — start', () => {
  it('sets restoration/target/abutments and marks active', () => {
    useAxisStore.getState().start('r1', 'node1', [11, 21], [0.1, 0.2, 0.97]);
    const state = useAxisStore.getState();
    expect(state.restorationId).toBe('r1');
    expect(state.targetNodeId).toBe('node1');
    expect(state.abutmentTeeth).toEqual([11, 21]);
    expect(state.direction).toEqual([0.1, 0.2, 0.97]);
    expect(state.status).toBe('active');
  });

  it('resets any stale state from a previous session', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setConfirmed(true);
    useAxisStore.getState().start('r2', 'node2', [21], [0, 1, 0]);
    const state = useAxisStore.getState();
    expect(state.restorationId).toBe('r2');
    expect(state.confirmed).toBe(false);
  });
});

describe('useAxisStore — suggest lifecycle', () => {
  it('setSuggesting -> setSuggestResult transitions status/busy/progress correctly', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setSuggesting();
    expect(useAxisStore.getState().status).toBe('suggesting');
    expect(useAxisStore.getState().busy).toBe(true);

    useAxisStore.getState().setSuggestProgress(0.5);
    expect(useAxisStore.getState().progress).toBe(0.5);

    const candidate = { direction: [0, 0, 1] as const, scoreMm3: 0, undercutAreaMm2: 0, maxDepthMm: 0, undercutTriangleCount: 0 };
    useAxisStore.getState().setSuggestResult({
      direction: [0, 0, 1],
      azimuthDeg: 0,
      elevationDeg: 90,
      ranked: [candidate],
      perAbutment: [{ tooth: 11, undercutAreaMm2: 0, maxDepthMm: 0, undercutTriangleCount: 0, regionTriangleCount: 10 }],
    });
    const state = useAxisStore.getState();
    expect(state.status).toBe('active');
    expect(state.busy).toBe(false);
    expect(state.progress).toBe(1);
    expect(state.source).toBe('suggested');
    expect(state.ranked).toHaveLength(1);
    expect(state.perAbutment).toHaveLength(1);
    expect(state.confirmed).toBe(false);
  });

  it('setError keeps status active (never a distinct error phase) and clears busy', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setSuggesting();
    useAxisStore.getState().setError('boom');
    const state = useAxisStore.getState();
    expect(state.status).toBe('active');
    expect(state.busy).toBe(false);
    expect(state.error).toBe('boom');
  });
});

describe('useAxisStore — manual adjust', () => {
  it('setManualDirection marks source manual and clears confirmed', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setConfirmed(true);
    useAxisStore.getState().setManualDirection({ direction: [0.1, 0, 0.99], azimuthDeg: 0, elevationDeg: 82 });
    const state = useAxisStore.getState();
    expect(state.direction).toEqual([0.1, 0, 0.99]);
    expect(state.azimuthDeg).toBe(0);
    expect(state.elevationDeg).toBe(82);
    expect(state.source).toBe('manual');
    expect(state.confirmed).toBe(false);
  });
});

describe('useAxisStore — heatmap', () => {
  it('setHeatmapResult bumps heatmapGeneration and clears heatmapBusy', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setHeatmapBusy(true);
    const before = useAxisStore.getState().heatmapGeneration;
    useAxisStore.getState().setHeatmapResult({ perAbutment: [] });
    const state = useAxisStore.getState();
    expect(state.heatmapGeneration).toBe(before + 1);
    expect(state.heatmapBusy).toBe(false);
  });

  it('setHeatmapVisible toggles independently of any recompute', () => {
    useAxisStore.getState().setHeatmapVisible(false);
    expect(useAxisStore.getState().heatmapVisible).toBe(false);
    useAxisStore.getState().setHeatmapVisible(true);
    expect(useAxisStore.getState().heatmapVisible).toBe(true);
  });
});

describe('useAxisStore — reset', () => {
  it('returns to the exact initial state', () => {
    useAxisStore.getState().start('r1', 'node1', [11], [0, 0, 1]);
    useAxisStore.getState().setConfirmed(true);
    useAxisStore.getState().reset();
    const state = useAxisStore.getState();
    expect(state.status).toBe('idle');
    expect(state.restorationId).toBeNull();
    expect(state.confirmed).toBe(false);
  });
});
