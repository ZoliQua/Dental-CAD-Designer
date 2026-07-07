import { describe, expect, it } from 'vitest';
import type { Measurement } from '@dqcad/shared-types';
import { toMeasurementRenderData, toWorldRay } from './measurementFrame';

describe('toMeasurementRenderData', () => {
  it('subtracts the world offset from every point, preserving id/kind/order', () => {
    const measurements: Measurement[] = [
      {
        id: 'm1',
        kind: 'pointToPoint',
        points: [
          { nodeId: 'n1', position: [10, 20, 30] },
          { nodeId: 'n2', position: [15, 25, 35] },
        ],
        value: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        kind: 'angle',
        points: [
          { nodeId: 'n1', position: [0, 0, 0] },
          { nodeId: 'n1', position: [1, 0, 0] },
          { nodeId: 'n1', position: [1, 1, 0] },
        ],
        value: 90,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const result = toMeasurementRenderData(measurements, [10, 10, 10]);
    expect(result).toEqual([
      {
        id: 'm1',
        kind: 'pointToPoint',
        points: [
          [0, 10, 20],
          [5, 15, 25],
        ],
      },
      {
        id: 'm2',
        kind: 'angle',
        points: [
          [-10, -10, -10],
          [-9, -10, -10],
          [-9, -9, -10],
        ],
      },
    ]);
  });

  it('is the identity when the world offset is zero', () => {
    const measurements: Measurement[] = [
      {
        id: 'm1',
        kind: 'pointToPoint',
        points: [{ nodeId: 'n', position: [1, 2, 3] }],
        value: 0,
        createdAt: 't',
      },
    ];
    expect(toMeasurementRenderData(measurements, [0, 0, 0])[0]!.points).toEqual([[1, 2, 3]]);
  });
});

describe('toWorldRay', () => {
  it('adds the world offset to the ray origin and leaves direction unchanged', () => {
    const result = toWorldRay({ rayOrigin: [1, 2, 3], rayDirection: [0, 0, -1] }, [100, 200, 300]);
    expect(result.rayOrigin).toEqual([101, 202, 303]);
    expect(result.rayDirection).toEqual([0, 0, -1]);
  });

  it('is the identity for the origin when the world offset is zero', () => {
    const result = toWorldRay({ rayOrigin: [1, 2, 3], rayDirection: [1, 1, 1] }, [0, 0, 0]);
    expect(result.rayOrigin).toEqual([1, 2, 3]);
  });
});
