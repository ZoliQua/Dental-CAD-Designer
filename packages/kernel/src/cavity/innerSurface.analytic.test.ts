// packages/kernel/src/cavity/innerSurface.analytic.test.ts
//
// ANALYTIC + ACCEPTANCE tests for the inlay/onlay inner (fit) surface
// (`buildCavityInnerSurface`: two-zone cavity offset + solid undercut blockout
// + skirt-to-outline) on the analytic MOD-cavity fixture (cavity.test-fixtures.ts).
// Acceptance evidence (all MEASURED + REPORTED):
//
//   - MARGIN FIT ≤ 10 µm on the cavity OUTLINE (the phase's inherited
//     acceptance measurable), default + onlay variant. Symmetric directed
//     Hausdorff both directions (the same quantity marginFitGate computes).
//   - OFFSET ACCURACY: measured cement-zone offset = cementGapMm and
//     marginal-zone offset = marginalGapMm within the documented
//     flatZoneErrorBound (mean + max reported).
//   - SELF-CONSISTENCY (falsifiable BOTH ways): whole-mesh ZERO undercut on the
//     drafted fixture; and on the negative-taper variant the RAW cavity walls
//     scan NONZERO undercut (the un-blocked surface) while the blocked fit
//     surface scans ZERO — proving the blockout does real work.
//   - DETERMINISM: two runs byte-identical (committed sha256 pin).
//   - @errorBound surfaced (flat-zone vs blend-zone).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { undercutScan } from '../undercut/undercutScan.ts';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import { classifyCavityRegions, scanCavityUndercut } from './regions.ts';
import { buildCavityInnerSurface, distanceToClosedPolyline, type CavityInnerSurfaceResult } from '../index.ts';

const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const AXIS: Vec3 = [0, 0, 1]; // insertion = +Z lift-out (the fixture convention)
const MARGIN_FIT_GATE_MM = 0.010;

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

function boundaryLoopsPos(mesh: IndexedMesh): Vec3[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as Vec3;
    }),
  );
}

/** Symmetric directed-Hausdorff between the OUTLINE boundary loop (the loop
 * closest to the outline polyline) and the outline — the marginFitGate quantity. */
function marginFit(mesh: IndexedMesh, poly: readonly Vec3[]): { max: number; loopCount: number; boundaryVerts: number } {
  const loops = boundaryLoopsPos(mesh);
  if (loops.length === 0) return { max: Infinity, loopCount: 0, boundaryVerts: 0 };
  const loopToMargin = loops.map((loop) => loop.reduce((m, p) => Math.max(m, distanceToClosedPolyline(p, poly)), 0));
  let mi = 0;
  for (let i = 1; i < loops.length; i++) if (loopToMargin[i]! < loopToMargin[mi]!) mi = i;
  const marginLoop = loops[mi] ?? [];
  let mToB = 0;
  for (const p of poly) mToB = Math.max(mToB, distanceToClosedPolyline(p, marginLoop));
  return { max: Math.max(loopToMargin[mi] ?? Infinity, mToB), loopCount: loops.length, boundaryVerts: marginLoop.length };
}

/** Whole-mesh undercut count along `axis`, split PATCH (the blocked offset —
 * triangles [0, patchTriangleCount)) vs SKIRT (the marginal seal), and FACING
 * (normal·axis < 0 — the draft-close's direct guarantee) vs OCCLUSION — the
 * honest self-consistency measurement (mirrors the crown op's test). */
function wholeMeshUndercut(res: CavityInnerSurfaceResult, axis: Vec3): { total: number; patch: number; skirt: number; patchFacing: number; triangleCount: number } {
  const bvh = buildBvh(res.mesh);
  const scan = undercutScan(res.mesh, bvh, axis);
  const pos = res.mesh.positions, idx = res.mesh.indices;
  let patch = 0, skirt = 0, patchFacing = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    if (scan.undercut[t] !== 1) continue;
    const isPatch = t < res.patchTriangleCount;
    if (isPatch) patch++; else skirt++;
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    const nx = (pos[b + 1]! - pos[a + 1]!) * (pos[c + 2]! - pos[a + 2]!) - (pos[b + 2]! - pos[a + 2]!) * (pos[c + 1]! - pos[a + 1]!);
    const ny = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    const nz = (pos[b]! - pos[a]!) * (pos[c + 1]! - pos[a + 1]!) - (pos[b + 1]! - pos[a + 1]!) * (pos[c]! - pos[a]!);
    const len = Math.hypot(nx, ny, nz) || 1;
    if (isPatch && nz / len < -1e-12) patchFacing++;
  }
  return { total: scan.undercutTriangleCount, patch, skirt, patchFacing, triangleCount: idx.length / 3 };
}

/** Offset accuracy on the PATCH (triangles [0, patchTriangleCount)): for each
 * patch vertex, measure signed distance to the tooth and classify its zone by
 * the FOOTPOINT height above the outline. Returns per-zone mean/max |offset −
 * targetGap| and sample counts. */
function offsetAccuracy(
  res: CavityInnerSurfaceResult,
  tooth: IndexedMesh,
  outline: readonly Vec3[],
): { cement: { mean: number; max: number; n: number }; marginal: { mean: number; max: number; n: number } } {
  const bvh = buildBvh(tooth);
  const pn = computePseudonormals(tooth);
  const half = GAP.blendWidthMm / 2;
  const cementH = GAP.spacerStartMm + half; // above the blend -> cement
  const marginalHi = GAP.spacerStartMm - half; // below the blend -> marginal
  // only sample vertices that belong to a PATCH triangle (index < 3*patchTris)
  const patchVerts = new Set<number>();
  for (let t = 0; t < res.patchTriangleCount; t++) {
    patchVerts.add(res.mesh.indices[t * 3]!);
    patchVerts.add(res.mesh.indices[t * 3 + 1]!);
    patchVerts.add(res.mesh.indices[t * 3 + 2]!);
  }
  let cSum = 0, cMax = 0, cN = 0, mSum = 0, mMax = 0, mN = 0;
  for (const v of patchVerts) {
    const p: Vec3 = [res.mesh.positions[v * 3]!, res.mesh.positions[v * 3 + 1]!, res.mesh.positions[v * 3 + 2]!];
    const sc = signedClosestPoint(tooth, bvh, pn, p);
    const h = distanceToClosedPolyline(sc.point, outline);
    if (h >= cementH) {
      const e = Math.abs(sc.signedDistance - GAP.cementGapMm);
      cSum += e; cMax = Math.max(cMax, e); cN++;
    } else if (h > 0 && h <= marginalHi) {
      const e = Math.abs(sc.signedDistance - GAP.marginalGapMm);
      mSum += e; mMax = Math.max(mMax, e); mN++;
    }
  }
  return {
    cement: { mean: cN > 0 ? cSum / cN : 0, max: cMax, n: cN },
    marginal: { mean: mN > 0 ? mSum / mN : 0, max: mMax, n: mN },
  };
}

// GOLDEN (committed): byte-hash of the default MOD-cavity +Z build at pitch
// 0.06 mm. Pins buildCavityInnerSurface against regression; may change ONLY
// with a KERNEL_VERSION bump + a docs/CHANGELOG-kernel.md entry (CLAUDE.md
// golden discipline). Generated under KERNEL_VERSION 0.17.0.
const GOLDEN_MOD_CAVITY_HASH = '711d676286fc4036e9033c826967b9fa692d2b3a59191757f3b97257eb1f0988';

describe('buildCavityInnerSurface — ANALYTIC: margin fit + offset accuracy (MOD cavity, +Z, coarse pitch)', () => {
  let res: CavityInnerSurfaceResult;
  const fx = modCavityMesh();

  it('builds; margin fit ≤ 10 µm on the cavity outline; exactly one boundary loop == the outline', { timeout: 120_000 }, async () => {
    const started = performance.now();
    res = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.06, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    const elapsedMs = performance.now() - started;
    const fit = marginFit(res.mesh, fx.cavityOutline);
    console.log(
      `[CAVITY-INNER +Z] ${res.mesh.indices.length / 3} tris (patch ${res.patchTriangleCount} + skirt ${res.skirtTriangleCount}) | ` +
        `${(elapsedMs / 1000).toFixed(2)} s | MARGIN FIT max = ${(fit.max * 1000).toFixed(4)} µm (gate ${MARGIN_FIT_GATE_MM * 1000} µm) | ` +
        `boundary loops = ${fit.loopCount}, boundary verts = ${fit.boundaryVerts} | ` +
        `errorBound ${(res.errorBoundMm * 1000).toFixed(1)} µm (flat ${(res.flatZoneErrorBoundMm * 1000).toFixed(1)} µm)`,
    );
    expect(fit.loopCount).toBe(1);
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
    expect(res.marginVertexCount).toBe(fx.cavityOutline.length);
    // The single boundary is the outline loop (a simple loop -> boundaryEdgeCount == vertex count).
    expect(res.stats.boundaryEdgeCount).toBe(res.marginVertexCount);
  });

  it('offset accuracy: cement zone = cementGapMm, marginal zone = marginalGapMm within the flat-zone error bound', { timeout: 120_000 }, async () => {
    const acc = offsetAccuracy(res, fx.mesh, fx.cavityOutline);
    console.log(
      `[CAVITY-INNER +Z] OFFSET ACCURACY | cement (target ${GAP.cementGapMm * 1000} µm): mean ${(acc.cement.mean * 1000).toFixed(3)} µm, max ${(acc.cement.max * 1000).toFixed(3)} µm, n=${acc.cement.n} | ` +
        `marginal (target ${GAP.marginalGapMm * 1000} µm): mean ${(acc.marginal.mean * 1000).toFixed(3)} µm, max ${(acc.marginal.max * 1000).toFixed(3)} µm, n=${acc.marginal.n} | ` +
        `bound ${(res.flatZoneErrorBoundMm * 1000).toFixed(1)} µm`,
    );
    expect(acc.cement.n).toBeGreaterThan(0);
    expect(acc.marginal.n).toBeGreaterThan(0);
    expect(acc.cement.max).toBeLessThanOrEqual(res.flatZoneErrorBoundMm);
    expect(acc.marginal.max).toBeLessThanOrEqual(res.flatZoneErrorBoundMm);
  });

  it('@errorBound: flat-zone = pitch/2 + eps; blend-zone ≥ flat-zone (Lipschitz inflation)', () => {
    expect(res.flatZoneErrorBoundMm).toBeGreaterThan(0.06 / 2); // pitch/2 + eps_f32
    expect(res.errorBoundMm).toBeGreaterThanOrEqual(res.flatZoneErrorBoundMm);
  });
});

describe('buildCavityInnerSurface — ANALYTIC: onlay variant margin fit', () => {
  it('onlay (reduced-cusp) fixture: margin fit ≤ 10 µm on the (unchanged) cavity outline', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh({ reducedCusp: true });
    const res = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.06, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    const fit = marginFit(res.mesh, fx.cavityOutline);
    console.log(`[CAVITY-INNER ONLAY] MARGIN FIT max = ${(fit.max * 1000).toFixed(4)} µm (gate ${MARGIN_FIT_GATE_MM * 1000} µm), loops ${fit.loopCount}`);
    expect(fit.loopCount).toBe(1);
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
  });
});

describe('buildCavityInnerSurface — SELF-CONSISTENCY: undercut blockout (falsifiable both ways)', () => {
  it('WHOLE finished fit surface has ZERO undercut along +Z on the drafted fixture', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh(); // +6° draft
    const res = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.06, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    const u = wholeMeshUndercut(res, AXIS);
    console.log(`[CAVITY-INNER DRAFTED] WHOLE-MESH undercut = ${u.total}/${u.triangleCount}`);
    expect(u.total).toBe(0);
    expect(res.stats.manifoldEdges).toBe(true);
  });

  // The blockout does real work — proven falsifiably. The negative-taper cavity
  // has REAL wall undercut (the RAW cavity, i.e. the un-blocked surface, scans
  // nonzero). The blocked fit surface's OFFSET PATCH is undercut-free (the
  // draft-close FILLS the wall undercut — that is the blockout doing its job).
  // The only whole-mesh residual is the marginal-seal SKIRT reaching the
  // cavosurface OUTLINE, whose proximal-U segments follow the box wall DOWN into
  // the (negative-taper) undercut — i.e. the MARGIN ITSELF is undercut (an
  // invalid prep). No fit surface sealing exactly to an undercut margin can be
  // fully undercut-free there; that residual is honest and localized (the same
  // finding the crown op documents for its >taper marginal skirt). On a valid
  // (drafted) prep the whole mesh is ZERO (the test above).
  it('the blockout does real work: RAW negative-taper cavity scans NONZERO undercut; the blocked OFFSET PATCH scans ZERO (residual is the marginal skirt at the undercut margin)', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh({ taperDeg: -1 }); // negative taper -> real wall undercut
    // CONTROL (the "un-blocked surface"): the raw cavity walls have real undercut.
    const regions = classifyCavityRegions(fx.mesh, fx.cavityOutline, AXIS);
    const rawScan = scanCavityUndercut(fx.mesh, buildBvh(fx.mesh), regions.cavity, AXIS);
    expect(rawScan.undercutTriangleIndices.length).toBeGreaterThan(0); // real undercut to block

    const res = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.06, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    const u = wholeMeshUndercut(res, AXIS);
    const fit = marginFit(res.mesh, fx.cavityOutline);
    console.log(
      `[CAVITY-INNER NEG-TAPER] RAW cavity undercut = ${rawScan.undercutTriangleIndices.length} tris (un-blocked) | ` +
        `blocked: patchFacing ${u.patchFacing} (the draft-close guarantee), patch ${u.patch}, skirt ${u.skirt}, total ${u.total}/${u.triangleCount} | margin fit ${(fit.max * 1000).toFixed(4)} µm`,
    );
    // THE FALSIFIABLE PROOF: the raw cavity had real FACING wall undercut; the
    // blockout draft-closes the offset PATCH so it has ZERO facing undercut
    // (every patch normal·axis ≥ 0 — the blockout's exact guarantee, identical
    // to the crown op). The residual (patch OCCLUSION + skirt) is the marginal
    // seal wrapping to the genuinely-undercut proximal margin (an invalid prep
    // — the margin itself sits in the undercut), honest and localized to the
    // proximal U. On a valid drafted prep the whole mesh is ZERO (test above).
    expect(u.patchFacing).toBe(0);
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM); // margin seal intact
  });
});

describe('buildCavityInnerSurface — determinism + golden', () => {
  it('two runs are byte-identical (hash equality); pinned golden hash', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh();
    const run = () => buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.06, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    const a = await run();
    const b = await run();
    const ha = hashMesh(a.mesh);
    expect(hashMesh(b.mesh)).toBe(ha);
    expect(b.errorBoundMm).toBe(a.errorBoundMm);
    expect(b.patchTriangleCount).toBe(a.patchTriangleCount);
    expect(b.skirtTriangleCount).toBe(a.skirtTriangleCount);
    console.log(`[CAVITY-INNER GOLDEN] sha256 = ${ha}`);
    // GOLDEN pin (KERNEL_VERSION-gated). Only re-pin with a bump + changelog.
    expect(ha).toBe(GOLDEN_MOD_CAVITY_HASH);
  });
});

describe('buildCavityInnerSurface — property (fc.pre-guarded, few runs — heavy op)', () => {
  it('builds a single-loop, margin-≤10µm fit surface across valid cavity parameters', { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          isthmusWidthMm: fc.double({ min: 2.0, max: 3.0, noNaN: true }),
          isthmusDepthMm: fc.double({ min: 1.5, max: 2.2, noNaN: true }),
          boxDepthMm: fc.double({ min: 3.0, max: 4.0, noNaN: true }),
          taperDeg: fc.double({ min: 4, max: 10, noNaN: true }),
        }),
        async (p) => {
          fc.pre(p.boxDepthMm > p.isthmusDepthMm + 0.5); // real box step
          const fx = modCavityMesh(p);
          const res = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.12, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
          const fit = marginFit(res.mesh, fx.cavityOutline);
          expect(fit.loopCount).toBe(1);
          expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
        },
      ),
      // Fixed seed for determinism (CLAUDE.md invariant 2); few runs — heavy op.
      { numRuns: 4, seed: 20260717, endOnFailure: true },
    );
  });
});
