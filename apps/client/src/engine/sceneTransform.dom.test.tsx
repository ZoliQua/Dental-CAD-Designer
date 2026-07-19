// apps/client/src/engine/sceneTransform.dom.test.tsx
//
// Real-DOM `client-dom` project test (browser mode). The ONE thing
// sceneTransform.test.ts's plain-arithmetic coverage cannot prove on its
// own: that this repo's column-major `Mat4` convention (@dqcad/shared-types'
// `SceneNode.transform` doc, @dqcad/kernel's register/transform.ts module
// doc) ACTUALLY MATCHES Three.js's own `Matrix4.fromArray`/
// `Vector3.applyMatrix4` convention — the one place in this repo
// (engine/SceneManager.ts) that ever turns this array into a real
// `THREE.Matrix4`. sceneTransform.ts itself has NO three.js import (kept
// three.js-free per its module doc), so this file is the independent
// cross-check: build a `Mat4` via this repo's own hand-rolled arithmetic,
// hand it to REAL Three.js, and confirm the two conventions agree exactly.
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { renderFrameTransform } from './sceneTransform';

describe('renderFrameTransform x Three.js Matrix4 — convention round-trip', () => {
  it('a rotation+translation Mat4 applies identically via this repo\'s hand-rolled math and via THREE.Matrix4.fromArray + Vector3.applyMatrix4', () => {
    // R = 90deg rotation about Z ((x,y,z) -> (-y,x,z)), t = (1, -2, 0.5).
    const worldTransform = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, -2, 0.5, 1];
    const worldOffset: [number, number, number] = [10, -5, 2];
    const renderMatrixArray = renderFrameTransform(worldTransform, worldOffset);

    const probeRenderPoints: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [3, -1, 2],
      [-7.5, 4.25, -1],
    ];

    const threeMatrix = new Matrix4().fromArray(renderMatrixArray);
    for (const p of probeRenderPoints) {
      const threeResult = new Vector3(p[0], p[1], p[2]).applyMatrix4(threeMatrix);
      // Independently-derived expected value: apply worldTransform in WORLD
      // space to (p + worldOffset), then re-subtract worldOffset — the SAME
      // derivation renderFrameTransform.ts's module doc states, computed
      // here via a completely separate code path (plain arithmetic, not
      // this repo's own applyMat4ToPoint/renderFrameTransform helpers) so
      // this is a genuine cross-check, not a tautology.
      const worldPoint: [number, number, number] = [p[0] + worldOffset[0], p[1] + worldOffset[1], p[2] + worldOffset[2]];
      const rotated: [number, number, number] = [-worldPoint[1], worldPoint[0], worldPoint[2]];
      const transformedWorld: [number, number, number] = [rotated[0] + 1, rotated[1] + -2, rotated[2] + 0.5];
      const expected: [number, number, number] = [
        transformedWorld[0] - worldOffset[0],
        transformedWorld[1] - worldOffset[1],
        transformedWorld[2] - worldOffset[2],
      ];

      expect(threeResult.x).toBeCloseTo(expected[0], 9);
      expect(threeResult.y).toBeCloseTo(expected[1], 9);
      expect(threeResult.z).toBeCloseTo(expected[2], 9);
    }
  });

  it('identity SceneNode.transform round-trips through THREE.Matrix4 as a true no-op', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const renderMatrixArray = renderFrameTransform(identity, [12.3, -4.5, 6.7]);
    const threeMatrix = new Matrix4().fromArray(renderMatrixArray);
    const p = new Vector3(1.5, -2.5, 3.5).applyMatrix4(threeMatrix);
    expect(p.x).toBeCloseTo(1.5, 12);
    expect(p.y).toBeCloseTo(-2.5, 12);
    expect(p.z).toBeCloseTo(3.5, 12);
  });
});
