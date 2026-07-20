import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import { toMarginOverlayRenderData, toMarginRenderPoints, toRenderPoint, toWorldRay } from './marginFrame';
import { MARGIN_WEAK_CONFIDENCE_THRESHOLD } from './marginEditor';
import type { LiveMarginSegment } from '../state/marginStore';

describe('toMarginRenderPoints', () => {
  it('subtracts the world offset from every point, preserving order', () => {
    const points: Vec3[] = [
      [10, 20, 30],
      [15, 25, 35],
    ];
    expect(toMarginRenderPoints(points, [10, 10, 10])).toEqual([
      [0, 10, 20],
      [5, 15, 25],
    ]);
  });

  it('is the identity when the world offset is zero', () => {
    expect(toMarginRenderPoints([[1, 2, 3]], [0, 0, 0])).toEqual([[1, 2, 3]]);
  });
});

describe('toRenderPoint', () => {
  it('subtracts the world offset', () => {
    expect(toRenderPoint([5, 5, 5], [1, 2, 3])).toEqual([4, 3, 2]);
  });
});

describe('toWorldRay (margin domain twin of measurementFrame.ts)', () => {
  it('adds the world offset to the ray origin and leaves direction unchanged', () => {
    const result = toWorldRay({ rayOrigin: [1, 2, 3], rayDirection: [0, 0, -1] }, [100, 200, 300]);
    expect(result.rayOrigin).toEqual([101, 202, 303]);
    expect(result.rayDirection).toEqual([0, 0, -1]);
  });
});

describe('toMarginOverlayRenderData', () => {
  const segments: LiveMarginSegment[] = [
    { points: [[0, 0, 0], [1, 0, 0]] },
    { points: [[1, 0, 0], [2, 0, 0]] },
    { points: [[2, 0, 0], [0, 0, 0]] },
  ];

  it('returns null for zero segments', () => {
    expect(toMarginOverlayRenderData([], null, true, [0, 0, 0])).toBeNull();
  });

  it('maps humanEdited to origin confirmed/proposed', () => {
    expect(toMarginOverlayRenderData(segments, null, true, [0, 0, 0])!.origin).toBe('confirmed');
    expect(toMarginOverlayRenderData(segments, null, false, [0, 0, 0])!.origin).toBe('proposed');
  });

  it('re-centers every segment point by the world offset', () => {
    const result = toMarginOverlayRenderData(segments, null, true, [1, 1, 1])!;
    expect(result.segments[0]!.points).toEqual([
      [-1, -1, -1],
      [0, -1, -1],
    ]);
  });

  it('flags a segment weak iff its confidence is below the threshold', () => {
    const confidence = [0.9, MARGIN_WEAK_CONFIDENCE_THRESHOLD - 0.01, MARGIN_WEAK_CONFIDENCE_THRESHOLD];
    const result = toMarginOverlayRenderData(segments, confidence, true, [0, 0, 0])!;
    expect(result.segments[0]!.weak).toBe(false);
    expect(result.segments[1]!.weak).toBe(true);
    // Exactly AT the threshold is NOT weak (strict '<', matching
    // marginEditor.ts's own MARGIN_WEAK_CONFIDENCE_THRESHOLD doc: 0.5 is
    // "ridge signal equals background", not yet below it).
    expect(result.segments[2]!.weak).toBe(false);
  });

  it('treats a null segmentConfidence (manual-mode curve) as never weak', () => {
    const result = toMarginOverlayRenderData(segments, null, true, [0, 0, 0])!;
    expect(result.segments.every((s) => !s.weak)).toBe(true);
  });
});
