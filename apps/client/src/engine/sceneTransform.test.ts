// apps/client/src/engine/sceneTransform.test.ts
//
// Fast, three.js-free unit coverage for renderFrameTransform's derivation
// (see that module's doc). The INDEPENDENT cross-check against Three.js's
// own `Matrix4`/`Vector3.applyMatrix4` convention lives in
// sceneTransform.dom.test.tsx (browser-mode `client-dom` project) — this
// file only proves the arithmetic is internally correct.
import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, renderFrameTransform } from './sceneTransform';

function applyMat4(m: readonly number[], p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

describe('renderFrameTransform', () => {
  it('identity transform -> zero adjusted translation regardless of worldOffset', () => {
    const worldOffset: [number, number, number] = [12.5, -3.2, 7.1];
    const result = renderFrameTransform(IDENTITY_TRANSFORM, worldOffset);
    expect(result).toEqual(IDENTITY_TRANSFORM);
  });

  it('a pure translation (no rotation) passes through unchanged (R=I => R*o - o = 0)', () => {
    const worldOffset: [number, number, number] = [5, 5, 5];
    const pureTranslation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, -2, 3, 1];
    const result = renderFrameTransform(pureTranslation, worldOffset);
    expect(result).toEqual(pureTranslation);
  });

  it('a 90deg Z rotation + translation produces the correct on-screen (render-frame) position for an off-origin worldOffset', () => {
    // R = 90deg about Z: (x,y,z) -> (-y,x,z). t = (1,0,0).
    const rotate90Z = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];
    const worldOffset: [number, number, number] = [100, 0, 0]; // far from origin
    const renderMatrix = renderFrameTransform(rotate90Z, worldOffset);

    // A master-frame point P; its render-frame echo is P - worldOffset.
    const worldPoint: [number, number, number] = [102, 3, 0];
    const renderPoint: [number, number, number] = [
      worldPoint[0] - worldOffset[0],
      worldPoint[1] - worldOffset[1],
      worldPoint[2] - worldOffset[2],
    ];

    // Expected: transform P in WORLD space, then re-express in render frame.
    const transformedWorld: [number, number, number] = [-worldPoint[1], worldPoint[0], worldPoint[2]].map(
      (v, i) => v + [1, 0, 0][i]!,
    ) as [number, number, number];
    const expectedRender: [number, number, number] = [
      transformedWorld[0] - worldOffset[0],
      transformedWorld[1] - worldOffset[1],
      transformedWorld[2] - worldOffset[2],
    ];

    const actualRender = applyMat4(renderMatrix, renderPoint);
    expect(actualRender[0]).toBeCloseTo(expectedRender[0], 9);
    expect(actualRender[1]).toBeCloseTo(expectedRender[1], 9);
    expect(actualRender[2]).toBeCloseTo(expectedRender[2], 9);
  });

  it('throws RangeError for a malformed (wrong-length) transform', () => {
    expect(() => renderFrameTransform([1, 2, 3], [0, 0, 0])).toThrow(RangeError);
  });
});
