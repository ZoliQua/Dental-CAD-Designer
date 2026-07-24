// packages/cad-pipeline/src/gates/watertight.test.ts
//
// Unit tests for the watertight + manifold topological gates — each with a
// PASSING and a FAILING fixture (a closed box vs a box with a hole; a clean
// box vs a non-manifold edge; a single solid vs two components). Pure
// (analyzeMesh) — no WASM.
import { describe, expect, it } from 'vitest';
import { analyzeMesh, type IndexedMesh } from '@dqcad/kernel';
import { watertightGate, manifoldGate, WATERTIGHT_GATE_NAME, MANIFOLD_GATE_NAME } from './watertight.ts';

/** A closed, single-component, manifold unit box. */
function box(cx = 0, cy = 0, cz = 0, s = 1): IndexedMesh {
  const h = s / 2;
  const v = [
    cx - h, cy - h, cz - h, cx + h, cy - h, cz - h, cx + h, cy + h, cz - h, cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h, cx + h, cy - h, cz + h, cx + h, cy + h, cz + h, cx - h, cy + h, cz + h,
  ];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

/** The box minus its last triangle — leaves a hole (boundary edges). */
function boxWithHole(): IndexedMesh {
  const b = box();
  return { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 3) };
}

/** Two disjoint boxes → single mesh, two connected components. */
function twoBoxes(): IndexedMesh {
  const a = box(0, 0, 0, 1);
  const c = box(5, 0, 0, 1);
  const positions = new Float64Array(a.positions.length + c.positions.length);
  positions.set(a.positions, 0);
  positions.set(c.positions, a.positions.length);
  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + c.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < c.indices.length; i++) indices[a.indices.length + i] = c.indices[i]! + offset;
  return { positions, indices };
}

/** A closed box with one extra fin triangle glued on an existing edge → that
 * edge is now shared by 3 faces (non-manifold edge). */
function nonManifoldBox(): IndexedMesh {
  const b = box();
  const extraVert = b.positions.length / 3;
  const positions = new Float64Array(b.positions.length + 3);
  positions.set(b.positions, 0);
  positions[extraVert * 3] = 0; positions[extraVert * 3 + 1] = 0; positions[extraVert * 3 + 2] = 2;
  // Edge (0,1) already borders two faces; add a third face on it.
  const indices = new Uint32Array(b.indices.length + 3);
  indices.set(b.indices, 0);
  indices[b.indices.length] = 0; indices[b.indices.length + 1] = 1; indices[b.indices.length + 2] = extraVert;
  return { positions, indices };
}

describe('watertightGate', () => {
  it('PASSES a closed box', () => {
    const r = watertightGate({ stats: analyzeMesh(box()) });
    expect(r.gate).toBe(WATERTIGHT_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.acknowledged).toBe(false);
  });

  it('FAILS a box with a hole (boundary edges)', () => {
    const r = watertightGate({ stats: analyzeMesh(boxWithHole()) });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/boundary/i);
  });

  it('FAILS an empty mesh (unverifiable → fail-safe)', () => {
    const r = watertightGate({ stats: analyzeMesh({ positions: new Float64Array(0), indices: new Uint32Array(0) }) });
    expect(r.passed).toBe(false);
  });
});

describe('manifoldGate', () => {
  it('PASSES a single closed box', () => {
    const r = manifoldGate({ stats: analyzeMesh(box()) });
    expect(r.gate).toBe(MANIFOLD_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.value).toBe(1);
  });

  it('FAILS two disconnected components', () => {
    const r = manifoldGate({ stats: analyzeMesh(twoBoxes()) });
    expect(r.passed).toBe(false);
    expect(r.value).toBe(2);
    expect(r.message).toMatch(/component/i);
  });

  it('FAILS a non-manifold edge', () => {
    const r = manifoldGate({ stats: analyzeMesh(nonManifoldBox()) });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/non-manifold/i);
  });
});
