import { describe, expect, it } from 'vitest';
import {
  CM_TO_MM_FACTOR,
  SUSPECT_CM_MAX_EXTENT_MM,
  SUSPECT_UM_MIN_EXTENT_MM,
  UM_TO_MM_FACTOR,
  bboxMaxExtentMm,
  computeBboxMm,
  suggestUnitRescale,
  type BboxMm,
} from './units';

function cubeBbox(extent: number): BboxMm {
  return { min: [0, 0, 0], max: [extent, extent * 0.5, extent * 0.25] };
}

describe('computeBboxMm', () => {
  it('returns the zero box for an empty buffer', () => {
    expect(computeBboxMm(new Float64Array(0))).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });

  it('computes min/max over xyz triples, ignoring soup vertex repetition', () => {
    // Two triangles sharing an edge, written as an unwelded 9-per-triangle
    // soup (STL-style) — repeated vertices must not skew the box.
    const positions = new Float64Array([
      0, 0, 0, 10, 0, 0, 0, 10, 0, // triangle 1
      10, 0, 0, 10, 10, 0, 0, 10, 0, // triangle 2 (shares 2 verts)
    ]);
    expect(computeBboxMm(positions)).toEqual({ min: [0, 0, 0], max: [10, 10, 0] });
  });
});

describe('bboxMaxExtentMm', () => {
  it('returns the largest of the three axis extents', () => {
    expect(bboxMaxExtentMm({ min: [0, 0, 0], max: [5, 60, 12] })).toBe(60);
  });
});

describe('suggestUnitRescale — table-driven boundary cases', () => {
  const cases: Array<{
    name: string;
    extent: number;
    expected: { suspectedUnit: 'cm' | 'um'; factor: number } | null;
  }> = [
    { name: 'typical arch scan (60 mm) — no suspicion', extent: 60, expected: null },
    { name: 'expected-min boundary (40 mm) — no suspicion', extent: 40, expected: null },
    { name: 'expected-max boundary (80 mm) — no suspicion', extent: 80, expected: null },
    {
      name: 'exactly at the cm threshold (8 mm) — NOT flagged (strict <)',
      extent: SUSPECT_CM_MAX_EXTENT_MM,
      expected: null,
    },
    {
      name: 'just under the cm threshold (7.999 mm) — flagged as cm',
      extent: SUSPECT_CM_MAX_EXTENT_MM - 0.001,
      expected: { suspectedUnit: 'cm', factor: CM_TO_MM_FACTOR },
    },
    {
      name: 'clearly cm-scale (6 mm, e.g. a 0.6 cm die read as mm)',
      extent: 6,
      expected: { suspectedUnit: 'cm', factor: CM_TO_MM_FACTOR },
    },
    {
      name: 'zero extent (degenerate/empty mesh) — flagged as cm',
      extent: 0,
      expected: { suspectedUnit: 'cm', factor: CM_TO_MM_FACTOR },
    },
    {
      name: 'exactly at the µm threshold (400 mm) — NOT flagged (strict >)',
      extent: SUSPECT_UM_MIN_EXTENT_MM,
      expected: null,
    },
    {
      name: 'just over the µm threshold (400.001 mm) — flagged as µm',
      extent: SUSPECT_UM_MIN_EXTENT_MM + 0.001,
      expected: { suspectedUnit: 'um', factor: UM_TO_MM_FACTOR },
    },
    {
      name: 'clearly µm-scale (60000 mm, e.g. a 60 mm arch stored in µm units)',
      extent: 60_000,
      expected: { suspectedUnit: 'um', factor: UM_TO_MM_FACTOR },
    },
  ];

  it.each(cases)('$name', ({ extent, expected }) => {
    const suggestion = suggestUnitRescale(cubeBbox(extent));
    // cubeBbox scales y/z down from the x extent, so the MAX extent (x) is
    // exactly `extent` for every case above except the zero case (all axes
    // are 0 already).
    if (expected === null) {
      expect(suggestion).toBeNull();
    } else {
      expect(suggestion).not.toBeNull();
      expect(suggestion?.suspectedUnit).toBe(expected.suspectedUnit);
      expect(suggestion?.factor).toBe(expected.factor);
      expect(suggestion?.maxExtentMm).toBe(extent);
    }
  });
});
