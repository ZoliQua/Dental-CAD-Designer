// packages/cad-pipeline/src/gates/selfIntersection.test.ts
//
// Unit tests for the self-intersection gate — now a TRUE geometric
// determination (kernel tri-tri scan) corroborated by manifold-3d, no longer a
// topology-only proxy. Covers: a clean watertight solid PASSES (scan finds 0
// pairs, manifold-3d accepts); an open mesh FAILS (manifold-3d rejects); the
// FALSIFIABLE case the old proxy hid — a mesh manifold-3d accepts but whose
// faces geometrically interpenetrate now FAILS; and restoration-label wording.
// WASM.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '@dqcad/kernel';
import {
  measureSelfIntersection,
  selfIntersectionGate,
  SELF_INTERSECTION_GATE_NAME,
  type SelfIntersectionMeasurement,
} from './selfIntersection.ts';

function box(): IndexedMesh {
  const v = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
    0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ];
  const idx = [
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
    6, 1, 6, 5,
  ];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
function openBox(): IndexedMesh {
  const b = box();
  return { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 3) };
}

/** A closed tetrahedron (4 verts, 4 faces) at `origin` with edge ~`s`. */
function tetra(
  ox: number,
  oy: number,
  oz: number,
  s: number,
  base: number,
): { v: number[]; f: number[] } {
  const v = [ox, oy, oz, ox + s, oy, oz, ox, oy + s, oz, ox, oy, oz + s];
  const f = [
    base + 0,
    base + 2,
    base + 1,
    base + 0,
    base + 1,
    base + 3,
    base + 0,
    base + 3,
    base + 2,
    base + 1,
    base + 2,
    base + 3,
  ];
  return { v, f };
}

// TWO overlapping closed tetrahedra as ONE indexed mesh: each component is a
// closed 2-manifold, but they occupy overlapping space so their faces
// interpenetrate. This is exactly the class the old topology proxy could pass
// yet is geometrically self-intersecting.
function overlappingTetrahedra(): IndexedMesh {
  const a = tetra(0, 0, 0, 1, 0);
  const b = tetra(0.3, 0.3, 0.3, 1, 4);
  return {
    positions: new Float64Array([...a.v, ...b.v]),
    indices: Uint32Array.from([...a.f, ...b.f]),
  };
}

describe('measureSelfIntersection + selfIntersectionGate', () => {
  it('PASSES a valid watertight solid (scan finds 0 pairs, manifold-3d accepts)', async () => {
    const m = await measureSelfIntersection(box());
    expect(m.manifoldValid).toBe(true);
    expect(m.rejectionStatus).toBeNull();
    expect(m.volumeMm3).toBeCloseTo(1, 5);
    expect(m.geometricIntersectionPairs).toBe(0);
    expect(m.geometricFirstLocus).toBeNull();
    expect(m.degenerateTrianglesSkipped).toBe(0);
    const r = selfIntersectionGate({ measurement: m });
    expect(r.gate).toBe(SELF_INTERSECTION_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.message).toMatch(/triangle–triangle geometric scan found 0/);
    expect(r.message).not.toMatch(/PROXY/); // no longer a deferred proxy
  }, 60000);

  it('FAILS an open (non-watertight) mesh manifold-3d rejects', async () => {
    const m = await measureSelfIntersection(openBox());
    expect(m.manifoldValid).toBe(false);
    expect(m.rejectionStatus).not.toBeNull();
    const r = selfIntersectionGate({ measurement: m });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/rejected/i);
  }, 60000);

  it('FALSIFIABLE: a manifold-accepted mesh whose faces interpenetrate now FAILS', async () => {
    const m = await measureSelfIntersection(overlappingTetrahedra());
    // The geometric scan MUST catch the interpenetration regardless of what
    // manifold-3d concludes about the topology.
    expect(m.geometricIntersectionPairs).toBeGreaterThan(0);
    expect(m.geometricFirstLocus).not.toBeNull();
    const r = selfIntersectionGate({ measurement: m });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/self-intersecting face pair/);
  }, 60000);

  it('the gate is strictly stronger than the proxy (manifoldValid alone no longer passes)', () => {
    // Pure gate over a synthetic measurement: manifold-3d accepted, but the
    // geometric scan found pairs ⇒ the gate MUST fail (the proxy would pass).
    const measurement: SelfIntersectionMeasurement = {
      manifoldValid: true,
      rejectionStatus: null,
      volumeMm3: 42,
      geometricIntersectionPairs: 3,
      geometricFirstLocus: { triangleA: 5, triangleB: 91 },
      degenerateTrianglesSkipped: 0,
      triangleCount: 1000,
      candidatePairsTested: 500,
    };
    const r = selfIntersectionGate({ measurement });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('5↔91');
  });

  // ---- restoration-type-appropriate wording (T6-review copy-artifact fix) -----

  it('defaults the message noun to "crown" (crown QC path)', async () => {
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
    expect(onlay.message).toContain('rejected the onlay');
    expect(onlay.message).not.toContain('crown');
  }, 60000);
});
