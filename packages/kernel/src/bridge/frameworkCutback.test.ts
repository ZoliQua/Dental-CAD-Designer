// packages/kernel/src/bridge/frameworkCutback.test.ts
//
// Phase 6 Task 5 — the framework cutback op. Tests are CLOSED-FORM FIRST (the
// P6 discipline): every hard invariant is asserted against the analytic
// shell-unit fixture (fit byte-identity, margin-seal preservation, exact planar
// offset on the top cap, the documented facet term on the faceted wall, the
// wall-thickness reduction that makes the framework gate falsifiable) BEFORE any
// determinism / property claim.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { analyzeMesh } from '../intake/index.ts';
import { measureWallThickness } from '../shell/shell.ts';
import { frameworkCutback, FrameworkCutbackParamError } from './frameworkCutback.ts';
import { closedShellUnit, submeshFromTriRange } from './frameworkCutback.test-fixtures.ts';

const hashPositions = (p: Float64Array): string => createHash('sha256').update(Buffer.from(p.buffer, p.byteOffset, p.byteLength)).digest('hex');
const radius = (p: Float64Array, i: number): number => Math.hypot(p[i * 3]!, p[i * 3 + 1]!);

describe('closedShellUnit fixture', () => {
  it('is a watertight closed 2-manifold with a coherent outer/fit partition', () => {
    const u = closedShellUnit();
    const stats = analyzeMesh(u.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    // mask length == vertex count; every inner-wall + ceiling vertex is fit.
    expect(u.fitVertexMask.length).toBe(u.mesh.positions.length / 3);
    for (const ring of u.innerWallRingIndices) for (const vi of ring) expect(u.fitVertexMask[vi]).toBe(true);
    expect(u.fitVertexMask[u.innerTopCenterIndex]).toBe(true);
    // every outer vertex is NOT fit.
    for (const ring of u.outerWallRingIndices) for (const vi of ring) expect(u.fitVertexMask[vi]).toBe(false);
    expect(u.fitVertexMask[u.outerTopCenterIndex]).toBe(false);
  });
});

describe('frameworkCutback — closed-form invariants', () => {
  const u = closedShellUnit();
  const { params } = u;
  const d = 1.0; // veneering space
  const band = 0.6;
  const res = frameworkCutback(u.mesh, { veneeringSpaceMm: d, fitVertexMask: u.fitVertexMask, marginLoop: u.marginLoop, marginTaperBandMm: band });
  const before = u.mesh.positions;
  const after = res.mesh.positions;

  it('preserves the topology + stays a watertight 2-manifold (no self-intersection introduced)', () => {
    expect(res.mesh.indices).toEqual(u.mesh.indices);
    const stats = analyzeMesh(res.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
  });

  it('preserves the FIT surface BYTE-EXACT (abutment intaglio untouched)', () => {
    let fitCount = 0;
    for (let i = 0; i < u.fitVertexMask.length; i++) {
      if (!u.fitVertexMask[i]) continue;
      fitCount++;
      expect(after[i * 3]).toBe(before[i * 3]);
      expect(after[i * 3 + 1]).toBe(before[i * 3 + 1]);
      expect(after[i * 3 + 2]).toBe(before[i * 3 + 2]);
      expect(res.appliedCutbackMm[i]).toBe(0);
    }
    expect(fitCount).toBeGreaterThan(0);
  });

  it('preserves the MARGIN rim BYTE-EXACT (the seal does not open)', () => {
    // The outer ring at z=0 IS the margin loop — every one of its vertices must
    // be byte-identical (weight 0 on the loop).
    for (const vi of u.outerWallRingIndices[0]!) {
      expect(after[vi * 3]).toBe(before[vi * 3]);
      expect(after[vi * 3 + 1]).toBe(before[vi * 3 + 1]);
      expect(after[vi * 3 + 2]).toBe(before[vi * 3 + 2]);
      expect(res.appliedCutbackMm[vi]).toBe(0);
    }
  });

  it('offsets the flat top cap inward by EXACTLY the veneering space (planar ⇒ exact)', () => {
    const ci = u.outerTopCenterIndex;
    // Centre: normal = +z, full weight, moved straight down by d.
    expect(after[ci * 3]).toBeCloseTo(0, 12);
    expect(after[ci * 3 + 1]).toBeCloseTo(0, 12);
    expect(after[ci * 3 + 2]).toBeCloseTo(params.outerHeightMm - d, 12);
    expect(res.appliedCutbackMm[ci]).toBeCloseTo(d, 12);
  });

  it('offsets an interior wall ring by the veneering space in displacement, d·cos(π/n) in surface offset (facet term)', () => {
    // A clearly-beyond-band interior wall ring (z = 2.0 > band): pure radial
    // normal, full weight.
    const zTarget = 2.0;
    const ri = Math.round((zTarget / params.outerHeightMm) * params.outerWallRings);
    const ring = u.outerWallRingIndices[ri]!;
    const vi = ring[0]!;
    // z unchanged (radial displacement), radius reduced by exactly d.
    expect(after[vi * 3 + 2]!).toBeCloseTo(before[vi * 3 + 2]!, 12);
    expect(radius(after, vi)).toBeCloseTo(params.outerRadiusMm - d, 12);
    // displacement magnitude == d exactly.
    const dispMag = Math.hypot(after[vi * 3]! - before[vi * 3]!, after[vi * 3 + 1]! - before[vi * 3 + 1]!, after[vi * 3 + 2]! - before[vi * 3 + 2]!);
    expect(dispMag).toBeCloseTo(d, 12);
    expect(res.appliedCutbackMm[vi]).toBeCloseTo(d, 12);
    // Surface offset (apothem drop) on the n-gon wall = d·cos(π/n) < d — the
    // documented facet term.
    const n = params.segments;
    const apothemBefore = params.outerRadiusMm * Math.cos(Math.PI / n);
    const apothemAfter = (params.outerRadiusMm - d) * Math.cos(Math.PI / n);
    const surfaceOffset = apothemBefore - apothemAfter;
    expect(surfaceOffset).toBeCloseTo(d * Math.cos(Math.PI / n), 12);
    expect(surfaceOffset).toBeLessThan(d);
  });

  it('reports an honest facet @errorBound and the taper-region extent', () => {
    expect(res.errorBoundMm).toBeGreaterThan(0);
    expect(res.errorBoundMm).toBeLessThan(d); // small facet term, never the full depth
    expect(res.maxAppliedCutbackMm).toBeCloseTo(d, 12);
    expect(res.meanFullWeightCutbackMm).toBeCloseTo(d, 12);
    expect(res.fullWeightVertexCount).toBeGreaterThan(0);
    expect(res.taperedVertexCount).toBeGreaterThan(0); // the near-margin band IS non-uniform
    expect(res.taperBandMm).toBe(band);
  });

  it('re-measures the margin fit as 0 µm (byte-preserved) before and after', () => {
    // Margin fit here = max deviation of a margin-ring vertex from its original
    // position. Byte-preserved ⇒ exactly 0 (≪ 10 µm).
    let maxDevMm = 0;
    for (const vi of u.outerWallRingIndices[0]!) {
      maxDevMm = Math.max(maxDevMm, Math.hypot(after[vi * 3]! - before[vi * 3]!, after[vi * 3 + 1]! - before[vi * 3 + 1]!, after[vi * 3 + 2]! - before[vi * 3 + 2]!));
    }
    expect(maxDevMm).toBe(0);
    expect(maxDevMm).toBeLessThan(0.01); // ≤ 10 µm
  });

  it('THINS the wall by the cutback (measured inner↔outer) — the framework thickness gate premise', () => {
    const inner = submeshFromTriRange(u.mesh, u.innerTriRange[0], u.innerTriRange[1]);
    const outerBefore = submeshFromTriRange(u.mesh, u.outerTriRange[0], u.outerTriRange[1]);
    const outerAfter = submeshFromTriRange(res.mesh, u.outerTriRange[0], u.outerTriRange[1]);
    const tBefore = measureWallThickness(inner, outerBefore).minThicknessMm;
    const tAfter = measureWallThickness(inner, outerAfter).minThicknessMm;
    // Before ≈ R − r = 2.0; after ≈ (R−d) − r = 1.0 — reduced by ≈ d.
    expect(tBefore).toBeGreaterThan(tAfter);
    expect(tBefore - tAfter).toBeGreaterThan(d - 0.15); // reduced by ≈ the cutback
  });
});

describe('frameworkCutback — determinism + properties', () => {
  it('is byte-identical across runs (same mesh + params)', () => {
    const u = closedShellUnit();
    const opts = { veneeringSpaceMm: 0.9, fitVertexMask: u.fitVertexMask, marginLoop: u.marginLoop, marginTaperBandMm: 0.5 };
    const a = frameworkCutback(u.mesh, opts);
    const b = frameworkCutback(u.mesh, opts);
    expect(hashPositions(a.mesh.positions)).toBe(hashPositions(b.mesh.positions));
  });

  it('property: fit + margin always byte-preserved, no vertex ever moves more than d (fc.pre)', () => {
    const u = closedShellUnit({ segments: 24, outerWallRings: 6, innerWallRings: 4 });
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 1.5, noNaN: true }), fc.double({ min: 0.2, max: 1.0, noNaN: true }), (d, band) => {
        fc.pre(d > 0 && band > 0);
        const res = frameworkCutback(u.mesh, { veneeringSpaceMm: d, fitVertexMask: u.fitVertexMask, marginLoop: u.marginLoop, marginTaperBandMm: band });
        for (let i = 0; i < u.fitVertexMask.length; i++) {
          const moved = Math.hypot(
            res.mesh.positions[i * 3]! - u.mesh.positions[i * 3]!,
            res.mesh.positions[i * 3 + 1]! - u.mesh.positions[i * 3 + 1]!,
            res.mesh.positions[i * 3 + 2]! - u.mesh.positions[i * 3 + 2]!,
          );
          if (u.fitVertexMask[i]) expect(moved).toBe(0);
          expect(moved).toBeLessThanOrEqual(d + 1e-9);
        }
        // margin ring byte-preserved.
        for (const vi of u.outerWallRingIndices[0]!) expect(res.appliedCutbackMm[vi]).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});

describe('frameworkCutback — param validation', () => {
  const u = closedShellUnit({ segments: 12, outerWallRings: 3, innerWallRings: 2 });
  const base = { veneeringSpaceMm: 1.0, fitVertexMask: u.fitVertexMask, marginLoop: u.marginLoop, marginTaperBandMm: 0.5 };
  it('rejects a non-finite / negative veneering space', () => {
    expect(() => frameworkCutback(u.mesh, { ...base, veneeringSpaceMm: -0.1 })).toThrow(FrameworkCutbackParamError);
    expect(() => frameworkCutback(u.mesh, { ...base, veneeringSpaceMm: NaN })).toThrow(FrameworkCutbackParamError);
  });
  it('rejects a non-positive taper band', () => {
    expect(() => frameworkCutback(u.mesh, { ...base, marginTaperBandMm: 0 })).toThrow(FrameworkCutbackParamError);
  });
  it('rejects a mask length mismatch', () => {
    expect(() => frameworkCutback(u.mesh, { ...base, fitVertexMask: [true, false] })).toThrow(FrameworkCutbackParamError);
  });
  it('rejects an empty margin loop', () => {
    expect(() => frameworkCutback(u.mesh, { ...base, marginLoop: [] })).toThrow(FrameworkCutbackParamError);
  });
});
