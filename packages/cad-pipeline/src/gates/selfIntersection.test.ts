// packages/cad-pipeline/src/gates/selfIntersection.test.ts
//
// Unit tests for the self-intersection gate (manifold-3d construction proxy) —
// a PASSING fixture (a valid watertight solid manifold-3d accepts) and a FAILING
// fixture (an open mesh manifold-3d rejects). The proxy's documented blind spot
// (a topologically-manifold but geometrically self-intersecting mesh can pass)
// is stated in the gate module doc/@errorBound, not asserted here. WASM.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '@dqcad/kernel';
import { measureSelfIntersection, selfIntersectionGate, SELF_INTERSECTION_GATE_NAME } from './selfIntersection.ts';

function box(): IndexedMesh {
  const v = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
function openBox(): IndexedMesh {
  const b = box();
  return { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 3) };
}

describe('measureSelfIntersection + selfIntersectionGate', () => {
  it('PASSES a valid watertight solid (manifold-3d accepts it)', async () => {
    const m = await measureSelfIntersection(box());
    expect(m.manifoldValid).toBe(true);
    expect(m.rejectionStatus).toBeNull();
    expect(m.volumeMm3).toBeCloseTo(1, 5);
    const r = selfIntersectionGate({ measurement: m });
    expect(r.gate).toBe(SELF_INTERSECTION_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.message).toMatch(/PROXY/);
  }, 60000);

  it('FAILS an open (non-watertight) mesh manifold-3d rejects', async () => {
    const m = await measureSelfIntersection(openBox());
    expect(m.manifoldValid).toBe(false);
    expect(m.rejectionStatus).not.toBeNull();
    const r = selfIntersectionGate({ measurement: m });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/rejected/i);
  }, 60000);

  // ---- T6-review copy-artifact fix: restoration-type-appropriate wording -----

  it('defaults the message noun to "crown" (crown QC path — byte-identical)', async () => {
    const m = await measureSelfIntersection(box());
    const r = selfIntersectionGate({ measurement: m });
    expect(r.message).toContain('accepts the crown as a valid solid');
    expect(r.message).not.toContain('inlay');
  }, 60000);

  it('labels an inlay/onlay solid correctly (no "the crown" copy artifact)', async () => {
    const valid = await measureSelfIntersection(box());
    const inlay = selfIntersectionGate({ measurement: valid, restorationLabel: 'inlay' });
    expect(inlay.message).toContain('accepts the inlay as a valid solid');
    expect(inlay.message).not.toContain('crown');

    const invalid = await measureSelfIntersection(openBox());
    const onlay = selfIntersectionGate({ measurement: invalid, restorationLabel: 'onlay' });
    expect(onlay.message).toContain('manifold-3d rejected the onlay');
    expect(onlay.message).not.toContain('crown');
  }, 60000);
});
