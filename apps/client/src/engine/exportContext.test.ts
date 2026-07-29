// apps/client/src/engine/exportContext.test.ts
//
// Phase 7 Task 7 — the pure `qcContext` converters (typed-array → JSON, flat
// loop → point list). Node lane; the full per-engine `exportQcContext` getters
// are exercised end-to-end against the real server by T8/T9.
import { describe, expect, it } from 'vitest';
import { indicesJson, loopJson, meshJson } from './exportContext';

describe('exportContext converters', () => {
  it('meshJson copies Float64/Uint32 buffers into plain JSON number arrays (value-identical)', () => {
    const positions = Float64Array.from([0.1, -2.5, 3.75, 4, 5, 6]);
    const indices = Uint32Array.from([0, 1, 2]);
    const json = meshJson(positions, indices);
    expect(json).toEqual({ positions: [0.1, -2.5, 3.75, 4, 5, 6], indices: [0, 1, 2] });
    expect(Array.isArray(json.positions)).toBe(true);
    expect(Array.isArray(json.indices)).toBe(true);
  });

  it('loopJson unflattens a flat xyz Float64 loop into [x,y,z] triples', () => {
    const flat = Float64Array.from([1, 2, 3, 4, 5, 6]);
    expect(loopJson(flat)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(loopJson(new Float64Array())).toEqual([]);
  });

  it('loopJson throws loudly on a non-multiple-of-3 length (never silently drops a coordinate)', () => {
    expect(() => loopJson(Float64Array.from([1, 2, 3, 4]))).toThrow(/multiple of 3/);
  });

  it('indicesJson copies a Uint32 index array to a plain number array', () => {
    expect(indicesJson(Uint32Array.from([7, 8, 9]))).toEqual([7, 8, 9]);
  });
});
