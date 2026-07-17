// packages/kernel/src/halfedge/validate.test.ts
//
// `assertValidTopology` positive/negative cases, plus
// `debugAssertValidTopology`/`halfedgeDebugAssertionsEnabled`'s env-gate
// behavior — per this task's brief item 2 and CLAUDE.md's "Halfedge
// topology" rule.
import { afterEach, describe, expect, it } from 'vitest';
import { buildHalfedge } from './build.ts';
import {
  assertValidTopology,
  debugAssertValidTopology,
  halfedgeDebugAssertionsEnabled,
} from './validate.ts';
import { cubeMesh, openGridPatchMesh } from './halfedge.test-fixtures.ts';

describe('assertValidTopology — positive cases', () => {
  it('passes on a closed manifold (cube)', () => {
    expect(() => assertValidTopology(buildHalfedge(cubeMesh()))).not.toThrow();
  });

  it('passes on an open manifold with boundary (grid patch)', () => {
    expect(() => assertValidTopology(buildHalfedge(openGridPatchMesh(3, 3)))).not.toThrow();
  });
});

describe('assertValidTopology — negative cases (manually corrupted structures)', () => {
  it('throws when twin involution is broken', () => {
    const hm = buildHalfedge(cubeMesh()); // fully closed: every halfedge has a real (non -1) twin
    const corrupted = { ...hm, twin: hm.twin.slice() };
    // Repoint halfedge 0's twin at some halfedge that is NOT its real twin
    // (and not itself) — that halfedge's own `twin` entry still points
    // elsewhere, breaking involution without a self-twin or an
    // out-of-range index (those are separate tests below).
    const heA = 0;
    const realTwin = hm.twin[heA]!;
    const heB = realTwin === 1 ? 2 : 1;
    corrupted.twin[heA] = heB;
    expect(() => assertValidTopology(corrupted)).toThrow(/twin/i);
  });

  it('throws when a halfedge is its own twin', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, twin: hm.twin.slice() };
    corrupted.twin[0] = 0;
    expect(() => assertValidTopology(corrupted)).toThrow(/own twin/);
  });

  it('throws when the next 3-cycle is broken', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, next: hm.next.slice() };
    corrupted.next[0] = (hm.next[0]! + 1) % hm.halfedgeCount;
    expect(() => assertValidTopology(corrupted)).toThrow(/next-cycle/);
  });

  it('throws when vertex index is out of range', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, vertex: hm.vertex.slice() };
    corrupted.vertex[0] = hm.vertexCount + 5;
    expect(() => assertValidTopology(corrupted)).toThrow(/out of range/);
  });

  it('throws when a vertexHalfedge anchor points at a halfedge with a different origin vertex', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, vertexHalfedge: hm.vertexHalfedge.slice() };
    // Point vertex 0's anchor at some halfedge whose origin is a different vertex.
    const wrongHe = hm.vertex.findIndex((v) => v !== 0);
    corrupted.vertexHalfedge[0] = wrongHe;
    expect(() => assertValidTopology(corrupted)).toThrow(/vertexHalfedge/);
  });

  it('throws on a dangling reference (a referenced vertex with no anchor)', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, vertexHalfedge: hm.vertexHalfedge.slice() };
    corrupted.vertexHalfedge[0] = -1;
    expect(() => assertValidTopology(corrupted)).toThrow(/dangling/);
  });

  it('throws on an array-length mismatch', () => {
    const hm = buildHalfedge(cubeMesh());
    const corrupted = { ...hm, twin: hm.twin.slice(0, hm.twin.length - 1) };
    expect(() => assertValidTopology(corrupted)).toThrow(/length/);
  });
});

describe('debug-build assertion gate (DQCAD_KERNEL_DEBUG_ASSERTIONS)', () => {
  const ENV_VAR = 'DQCAD_KERNEL_DEBUG_ASSERTIONS';
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  function brokenHalfedgeMesh() {
    const hm = buildHalfedge(cubeMesh());
    return {
      ...hm,
      twin: (() => {
        const t = hm.twin.slice();
        t[0] = 0; // self-twin — invalid.
        return t;
      })(),
    };
  }

  it('halfedgeDebugAssertionsEnabled() reflects the env var exactly', () => {
    delete process.env[ENV_VAR];
    expect(halfedgeDebugAssertionsEnabled()).toBe(false);
    process.env[ENV_VAR] = '1';
    expect(halfedgeDebugAssertionsEnabled()).toBe(true);
    process.env[ENV_VAR] = '0';
    expect(halfedgeDebugAssertionsEnabled()).toBe(false);
  });

  it('debugAssertValidTopology is a silent no-op on broken topology when the flag is unset', () => {
    delete process.env[ENV_VAR];
    expect(() => debugAssertValidTopology(brokenHalfedgeMesh())).not.toThrow();
  });

  it('debugAssertValidTopology throws on broken topology when the flag is set', () => {
    process.env[ENV_VAR] = '1';
    expect(() => debugAssertValidTopology(brokenHalfedgeMesh())).toThrow();
  });

  it('debugAssertValidTopology never throws on VALID topology, flag on or off', () => {
    const hm = buildHalfedge(cubeMesh());
    delete process.env[ENV_VAR];
    expect(() => debugAssertValidTopology(hm)).not.toThrow();
    process.env[ENV_VAR] = '1';
    expect(() => debugAssertValidTopology(hm)).not.toThrow();
  });
});
