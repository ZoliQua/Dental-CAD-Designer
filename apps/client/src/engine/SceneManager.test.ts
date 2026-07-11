import { describe, expect, it } from 'vitest';
import { transparentRenderOrders } from './SceneManager';

// `SceneManager` itself needs a real `HTMLElement`/`WebGLRenderer`/
// `ResizeObserver` and so can't be constructed under vitest's `node`
// environment (see `.superpowers/sdd/p1-task-6-report.md`'s "Concerns"
// section) — these tests instead cover `transparentRenderOrders`, the pure
// helper `createEntry`/`applyOpacity` both delegate to, which is where the
// actual mesh-vs-wireframe-overlay renderOrder invariant lives. See the
// module doc's "Transparent render order" section for the full mechanics
// (why a scene-graph child does not implicitly draw after its parent).
describe('transparentRenderOrders', () => {
  it('gives the wireframe overlay a strictly higher renderOrder than its mesh when the mesh is transparent (opacity < 1)', () => {
    const { meshRenderOrder, wireframeRenderOrder } = transparentRenderOrders(0.5);
    expect(meshRenderOrder).toBe(1);
    expect(wireframeRenderOrder).toBeGreaterThan(meshRenderOrder);
  });

  it('still orders the wireframe above the mesh at opacity 1 — numerically true though render-inconsequential there (the opaque mesh and the always-transparent wireframe are in different render queues; see this function\'s doc)', () => {
    const { meshRenderOrder, wireframeRenderOrder } = transparentRenderOrders(1);
    expect(meshRenderOrder).toBe(0);
    expect(wireframeRenderOrder).toBeGreaterThan(meshRenderOrder);
  });

  it('holds the invariant across the full opacity range, with no dip to equal/reversed ordering at the opaque/transparent boundary', () => {
    for (const opacity of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      const { meshRenderOrder, wireframeRenderOrder } = transparentRenderOrders(opacity);
      expect(wireframeRenderOrder).toBeGreaterThan(meshRenderOrder);
    }
  });
});
