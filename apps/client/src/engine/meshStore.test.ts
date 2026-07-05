import { describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { MeshStore, type RegisterMeshInput } from './meshStore';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 1,
    signedVolumeMm3: 1,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

function unitTriangle(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function makeInput(overrides: Partial<RegisterMeshInput> = {}): RegisterMeshInput {
  const { positions, indices } = unitTriangle();
  return {
    contentHash: 'hash-a',
    name: 'mesh-a.stl',
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([0, 0, 0], [1, 1, 0]),
    report: EMPTY_REPORT,
    ...overrides,
  };
}

describe('MeshStore.register', () => {
  it('stores the record and computes a render copy of the same length', () => {
    const store = new MeshStore();
    const record = store.register(makeInput());
    expect(store.has('hash-a')).toBe(true);
    expect(store.get('hash-a')).toBe(record);
    expect(record.renderPositions).toHaveLength(record.positions.length);
    expect(record.renderIndices).toBe(record.indices);
  });

  it('is idempotent by content hash — a second register() with the same hash returns the existing record', () => {
    const store = new MeshStore();
    const first = store.register(makeInput());
    const second = store.register(makeInput({ name: 'different-name.stl' }));
    expect(second).toBe(first);
    expect(store.list()).toHaveLength(1);
    expect(store.get('hash-a')?.name).toBe('mesh-a.stl');
  });

  it('centers a single mesh render copy at its own bbox centroid', () => {
    const store = new MeshStore();
    // bbox [0,0,0]-[2,0,0] -> centroid (1,0,0); vertex (0,0,0) -> render (-1,0,0).
    const record = store.register(
      makeInput({
        positions: new Float64Array([0, 0, 0, 2, 0, 0, 1, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        stats: statsForBbox([0, 0, 0], [2, 0, 0]),
      }),
    );
    expect(Array.from(record.renderPositions.subarray(0, 3))).toEqual([-1, 0, 0]);
    expect(Array.from(record.renderPositions.subarray(3, 6))).toEqual([1, 0, 0]);
  });

  it('recenters ALL registered meshes at the union bbox centroid when a second mesh is added', () => {
    const store = new MeshStore();
    store.register(
      makeInput({
        contentHash: 'hash-a',
        positions: new Float64Array([0, 0, 0]),
        indices: new Uint32Array([0, 0, 0]),
        stats: statsForBbox([0, 0, 0], [0, 0, 0]),
      }),
    );
    // Union bbox after adding mesh B: [0,0,0]-[10,0,0] -> centroid (5,0,0).
    store.register(
      makeInput({
        contentHash: 'hash-b',
        positions: new Float64Array([10, 0, 0]),
        indices: new Uint32Array([0, 0, 0]),
        stats: statsForBbox([10, 0, 0], [10, 0, 0]),
      }),
    );
    const a = store.get('hash-a')!;
    const b = store.get('hash-b')!;
    expect(Array.from(a.renderPositions)).toEqual([-5, 0, 0]);
    expect(Array.from(b.renderPositions)).toEqual([5, 0, 0]);
  });

  it('does not mutate the Float64 master positions when recentering', () => {
    const store = new MeshStore();
    const record = store.register(
      makeInput({
        positions: new Float64Array([10, 0, 0]),
        indices: new Uint32Array([0, 0, 0]),
        stats: statsForBbox([10, 0, 0], [10, 0, 0]),
      }),
    );
    expect(Array.from(record.positions)).toEqual([10, 0, 0]);
    expect(record.positions).toBeInstanceOf(Float64Array);
    expect(record.renderPositions).toBeInstanceOf(Float32Array);
  });
});

describe('MeshStore.remove', () => {
  it('removes a record and recenters the remaining ones', () => {
    const store = new MeshStore();
    store.register(makeInput({ contentHash: 'hash-a', stats: statsForBbox([0, 0, 0], [0, 0, 0]) }));
    store.register(
      makeInput({
        contentHash: 'hash-b',
        positions: new Float64Array([10, 0, 0]),
        indices: new Uint32Array([0, 0, 0]),
        stats: statsForBbox([10, 0, 0], [10, 0, 0]),
      }),
    );
    store.remove('hash-a');
    expect(store.has('hash-a')).toBe(false);
    // Only mesh B left -> centroid is its own bbox center (10,0,0).
    expect(Array.from(store.get('hash-b')!.renderPositions)).toEqual([0, 0, 0]);
  });
});
