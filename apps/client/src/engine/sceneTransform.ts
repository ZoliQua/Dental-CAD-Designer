// apps/client/src/engine/sceneTransform.ts
//
// Converts a `SceneNode.transform` (WORLD/case-frame, column-major 16 —
// @dqcad/shared-types' documented convention, identical to
// @dqcad/kernel's register/ module's `Mat4`) into the RENDER frame
// SceneManager actually draws in (Float32-safe, re-centered at the case
// bbox centroid — engine/meshStore.ts's `getWorldOffset()`).
//
// ## Why this conversion exists at all
//
// Every mesh's RENDER positions (`RenderNode.positions`, produced by
// engine/caseStore.ts's `getRenderNodes()`) are already `masterPositions -
// worldOffset` (meshStore.ts's `recenterAll()`). Applying `node.transform`
// (a WORLD-frame rigid map) directly, unmodified, as a Three.js `mesh.matrix`
// on top of those ALREADY-OFFSET positions would double-count the offset:
// `node.transform`'s rotation would rotate the render-frame positions
// around the RENDER origin (`worldOffset` away from the true rotation
// pivot), not around the world origin the transform was actually computed
// against — a visibly wrong result for any transform with a non-identity
// rotation.
//
// The correct render-frame matrix follows from: let `P` be a vertex's
// WORLD-frame master position, `R`/`t` be `node.transform`'s rotation/
// translation, and `o` be `worldOffset`. The render-frame position IS
// `P - o` (by construction); the transformed WORLD position is `R*P + t`;
// the transformed RENDER position we actually want to draw is therefore
// `(R*P + t) - o`. Substituting `P = (P - o) + o` (i.e. `renderPos + o`):
//
//   (R*P + t) - o = R*(renderPos + o) + t - o = R*renderPos + (R*o + t - o)
//
// So `renderFrameTransform` returns the SAME rotation block as
// `worldTransform`, with translation replaced by `R*o + t - o` — applying
// THIS matrix directly to the already-offset render positions gives the
// correct on-screen result. For an IDENTITY `worldTransform` (`R = I`, `t =
// 0`), the adjusted translation is exactly `o - o = 0` — i.e. every
// currently-imported (untransformed) mesh in this repo renders byte-for-byte
// as before this module existed (verified in sceneTransform.test.ts).
//
// Verified against the INDEPENDENT Three.js convention (not just internally
// self-consistent) by apps/client/src/engine/sceneTransform.dom.test.tsx's
// round-trip test — this file itself has NO Three.js import (kept
// three.js-free so it can be unit-tested under the fast `client` project,
// not only the browser-mode `client-dom` one).
import type { SceneNode } from '@dqcad/shared-types';

/** Column-major 16-number identity — matches `SceneNode.transform`'s
 * documented convention (also `IDENTITY_MAT4`, re-exported from
 * `@dqcad/kernel-workers`, but duplicated here as a plain constant so this
 * dependency-free module never needs a kernel-workers import for one
 * literal array). */
export const IDENTITY_TRANSFORM: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function applyRotation3x3(m: readonly number[], v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

/** See this module's top doc for the derivation. `worldTransform` must be
 * a 16-element column-major `Mat4` (`SceneNode.transform`'s convention);
 * throws `RangeError` otherwise (defense-in-depth — a malformed transform
 * silently mis-rendering the wrong shape is worse than a loud failure). */
export function renderFrameTransform(
  worldTransform: readonly number[],
  worldOffset: readonly [number, number, number],
): number[] {
  if (worldTransform.length !== 16) {
    throw new RangeError(
      `renderFrameTransform: worldTransform must have exactly 16 elements (column-major 4x4), got ${worldTransform.length}`,
    );
  }
  const t: [number, number, number] = [worldTransform[12]!, worldTransform[13]!, worldTransform[14]!];
  const rOffset = applyRotation3x3(worldTransform, worldOffset);
  const adjustedTranslation: [number, number, number] = [
    rOffset[0] + t[0] - worldOffset[0],
    rOffset[1] + t[1] - worldOffset[1],
    rOffset[2] + t[2] - worldOffset[2],
  ];
  return [
    worldTransform[0]!, worldTransform[1]!, worldTransform[2]!, 0,
    worldTransform[4]!, worldTransform[5]!, worldTransform[6]!, 0,
    worldTransform[8]!, worldTransform[9]!, worldTransform[10]!, 0,
    adjustedTranslation[0], adjustedTranslation[1], adjustedTranslation[2], 1,
  ];
}

/** Convenience: `renderFrameTransform` for a live `SceneNode`. */
export function renderFrameTransformForNode(
  node: Pick<SceneNode, 'transform'>,
  worldOffset: readonly [number, number, number],
): number[] {
  return renderFrameTransform(node.transform, worldOffset);
}
