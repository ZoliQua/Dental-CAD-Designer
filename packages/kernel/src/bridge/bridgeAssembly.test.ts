// packages/kernel/src/bridge/bridgeAssembly.test.ts
//
// Phase 6 Task 6 — the whole-bridge UNION op: watertight + manifold + single
// component on the assembled 3-unit; falsifiable typed errors (a disjoint
// connector → a LOUD failure, never a silent multi-body "solid"); the fit-patch
// extractor; determinism.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { assembleBridge, extractFitPatch, BridgeAssemblyError } from './bridgeAssembly.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops } from '../halfedge/iterate.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { bridgeAssemblyFixture } from './bridgeAssembly.test-fixtures.ts';

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

describe('assembleBridge — the whole-bridge union', () => {
  it('fuses 3 units + 2 connectors into ONE watertight single-component solid', async () => {
    const fx = bridgeAssemblyFixture();
    const result = await assembleBridge(fx.solids);
    expect(result.watertight).toBe(true);
    expect(result.manifoldEdges).toBe(true);
    expect(result.componentCount).toBe(1);
    expect(result.inputCount).toBe(5);
    expect(result.volumeMm3).not.toBeNull();
    expect(result.volumeMm3!).toBeGreaterThan(0);
    // Independent re-analysis of the returned solid.
    const stats = analyzeMesh(result.solid);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
  });

  it('is deterministic — same inputs ⇒ byte-identical fused solid', async () => {
    const a = await assembleBridge(bridgeAssemblyFixture().solids);
    const b = await assembleBridge(bridgeAssemblyFixture().solids);
    expect(hashMesh(a.solid)).toBe(hashMesh(b.solid));
  });

  it('FALSIFIABLE: a disjoint (floating) connector → BridgeAssemblyError(disjoint), never a silent multi-body solid', async () => {
    const fx = bridgeAssemblyFixture({ disjointConnectorA: true });
    await expect(assembleBridge(fx.solids)).rejects.toMatchObject({
      name: 'BridgeAssemblyError',
      reason: 'disjoint',
    });
    // and the component count is carried for the report
    try {
      await assembleBridge(fx.solids);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeAssemblyError);
      expect((e as BridgeAssemblyError).componentCount).toBeGreaterThan(1);
    }
  });

  it('FALSIFIABLE: an empty solids array → BridgeAssemblyError(empty)', async () => {
    await expect(assembleBridge([])).rejects.toMatchObject({ name: 'BridgeAssemblyError', reason: 'empty' });
  });

  it('rejects a non-watertight input up front (repair-before-boolean), naming the solid index', async () => {
    const fx = bridgeAssemblyFixture();
    // Corrupt one input: drop its last triangle → open (non-watertight).
    const good = fx.solids[0]!;
    const broken = { positions: good.positions, indices: good.indices.slice(0, good.indices.length - 3) };
    await expect(assembleBridge([broken, ...fx.solids.slice(1)])).rejects.toMatchObject({
      name: 'BridgeAssemblyError',
      reason: 'non-watertight-input',
      solidIndex: 0,
    });
  });
});

describe('extractFitPatch — the assembled-solid intaglio patch (survive-assembly measurement)', () => {
  it('extracts each abutment intaglio as an open patch whose single boundary loop is the margin rim', async () => {
    const fx = bridgeAssemblyFixture();
    const result = await assembleBridge(fx.solids);
    for (const unit of fx.units.filter((u) => u.kind === 'abutment')) {
      const patch = extractFitPatch(result.solid, unit.fitRegion);
      expect(patch.indices.length).toBeGreaterThan(0);
      const loops = findBoundaryLoops(buildHalfedge(patch));
      // Exactly ONE open boundary loop (the cavity rim at z=0); the ceiling fan is closed.
      expect(loops.length).toBe(1);
      // Every extracted vertex sits at the cavity radius or inside it (radial ≤ r+tol).
      for (let i = 0; i < patch.positions.length; i += 3) {
        const dx = patch.positions[i]! - unit.centreXMm;
        const dy = patch.positions[i + 1]!;
        const radial = Math.hypot(dx, dy);
        expect(radial).toBeLessThanOrEqual(unit.fitRegion.maxRadialMm + 1e-6);
      }
    }
  });
});

describe('assembleBridge — property: any valid span fuses to one component', () => {
  it('fc.pre — spans that keep units apart but connectors bridging always fuse to 1 component', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 6.5, max: 9, noNaN: true }), async (span) => {
        fc.pre(span > 6.2); // units (R=3) must not overlap; connector overlap 0.5 must still bridge
        const fx = bridgeAssemblyFixture({ spanMm: span });
        const result = await assembleBridge(fx.solids);
        expect(result.componentCount).toBe(1);
        expect(result.watertight).toBe(true);
      }),
      { numRuns: 4 },
    );
  }, 30000);
});
