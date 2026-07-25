// packages/kernel/src/shell/shell.test.ts
//
// Phase 4 Task 7 — crown shell construction + wall-thickness + auto-thicken.
// Analytic scenario: a truncated-cone prep die (bottom rim = the margin
// circle) + a buildInnerSurface intaglio + an occlusally-capped open-cervical
// anatomy dome offset outward from the die. Proves: the shell is watertight +
// manifold + single-component (analyzeMesh); the wall thickness is measured
// correctly against a known offset; a deliberately-thin dome is flagged at the
// right value; auto-thicken raises the thin region and is re-measured
// before/after; the construction is deterministic (byte-identical shell hash,
// two runs, same manifold-3d version).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  analyzeMesh,
  buildBvh,
  buildInnerSurface,
  closestPointBatch,
  constructShell,
  measureWallThickness,
  autoThickenOuter,
  ShellClosedOuterNeedsMarginError,
  ShellNotWatertightError,
  volume,
  type IndexedMesh,
  type Vec3,
} from '../index.ts';

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];

/** A cone frustum. `capBottom=false` leaves the CERVICAL rim open (one
 * boundary loop) — the outer anatomy dome; `capBottom=true` closes it (the
 * die). */
function buildFrustum(
  marginR: number,
  topR: number,
  marginZ: number,
  topZ: number,
  segments: number,
  capTop: boolean,
  capBottom: boolean,
): IndexedMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    bottom.push(push(marginR * Math.cos(th), marginR * Math.sin(th), marginZ));
  }
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    top.push(push(topR * Math.cos(th), topR * Math.sin(th), topZ));
  }
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sn = (s + 1) % segments;
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!);
    tris.push(bottom[s]!, top[sn]!, top[s]!);
  }
  if (capBottom) {
    const bc = push(0, 0, marginZ);
    for (let s = 0; s < segments; s++) {
      const sn = (s + 1) % segments;
      tris.push(bc, bottom[sn]!, bottom[s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, topZ);
    for (let s = 0; s < segments; s++) {
      const sn = (s + 1) % segments;
      tris.push(tc, top[s]!, top[sn]!);
    }
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(tris) };
}

function marginCircle(r: number, z: number, n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return loop;
}

function hashMesh(m: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  h.update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  return h.digest('hex');
}

/** The die + intaglio, shared by every test (buildInnerSurface is the slow
 * step — computed once). */
async function buildIntaglio(): Promise<IndexedMesh> {
  const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
  const inner = await buildInnerSurface(die, {
    pitchMm: 0.08,
    marginalGapMm: 0.02,
    cementGapMm: 0.05,
    spacerStartMm: 0.8,
    blendWidthMm: 0.3,
    marginLoop: marginCircle(MARGIN_R, MARGIN_Z, 240),
    insertionAxis: AXIS,
  });
  return inner.mesh;
}

/** Outer anatomy: an occlusally-capped, open-cervical dome offset `out` mm
 * radially from the die AND `out` mm in occlusal height (so both the axial
 * and occlusal walls are ≈ `out`). */
function outerDome(out: number): IndexedMesh {
  return buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);
}

/** A dome thin on the AXIAL wall (`out` mm) but generously thick occlusally
 * (so the thin region is a clean axial band, not the convex occlusal-shoulder
 * corner — autoThicken's outward vertex push resolves an axial wall cleanly). */
function thinAxialDome(out: number): IndexedMesh {
  return buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + 0.9, 96, true, false);
}

/** A CLOSED tooth — an occlusally-AND-cervically-capped solid (both caps), the
 * topology the Task-6 morphed library tooth has (it is watertight). The
 * pipeline feeds THIS into constructShell, which trims it to the margin. */
function closedTooth(out: number): IndexedMesh {
  return buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, true);
}

describe('constructShell — watertight crown shell', () => {
  it('joins outer + inner at the margin band into a watertight, manifold, single-component solid', async () => {
    const inner = await buildIntaglio();
    const outer = outerDome(0.7);
    const shell = await constructShell(outer, inner, { insertionAxis: AXIS });

    // Re-validated topology (independent of the construction's own claim).
    const stats = analyzeMesh(shell.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.componentCount).toBe(1);
    expect(shell.stats.watertight).toBe(true);
    expect(shell.seamTriangleCount).toBeGreaterThan(0);
    // Positive, finite volume (outward-oriented solid).
    const vol = await volume(shell.mesh);
    expect(vol).toBeGreaterThan(0);
    expect(shell.volumeMm3).toBeCloseTo(vol, 3);
  }, 120000);

  // THE PIPELINE CONNECTION: the Task-6 morphed tooth is a CLOSED solid;
  // constructShell must consume it (trim to margin -> stitch) into a watertight
  // shell WITHOUT perturbing the inner intaglio's margin seal.
  it('consumes a CLOSED tooth (trimmed to margin) into a watertight shell, margin fit preserved (<=10 um)', async () => {
    const inner = await buildIntaglio();
    const margin = marginCircle(MARGIN_R, MARGIN_Z, 240);
    const closed = closedTooth(1.0);
    expect(analyzeMesh(closed).watertight).toBe(true); // it really is a closed solid

    const shell = await constructShell(closed, inner, { insertionAxis: AXIS, marginLoop: margin });
    const stats = analyzeMesh(shell.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.boundaryEdgeCount).toBe(0);

    // Margin fit preserved: every confirmed margin point lies on the shell
    // surface (the intaglio's exact margin rim survived — only the outer was cut).
    const bvhShell = buildBvh(shell.mesh);
    const marginFlat = new Float64Array(margin.flatMap((p) => [p[0], p[1], p[2]]));
    const res = closestPointBatch(shell.mesh, bvhShell, marginFlat);
    let maxMarginFitMm = 0;
    for (const r of res) if (r.distance > maxMarginFitMm) maxMarginFitMm = r.distance;
    expect(maxMarginFitMm).toBeLessThanOrEqual(0.010);
    console.log(`[closed-tooth] watertight shell from CLOSED tooth; margin fit ${(maxMarginFitMm * 1000).toFixed(2)} um (<= 10 um), seam ${shell.seamTriangleCount} tris`);
  }, 120000);

  it('is deterministic on the CLOSED-tooth path (byte-identical shell hash)', async () => {
    const inner = await buildIntaglio();
    const margin = marginCircle(MARGIN_R, MARGIN_Z, 240);
    const closed = closedTooth(1.0);
    const a = await constructShell(closed, inner, { insertionAxis: AXIS, marginLoop: margin });
    const b = await constructShell(closed, inner, { insertionAxis: AXIS, marginLoop: margin });
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  }, 120000);

  it('rejects a CLOSED outer with NO marginLoop to trim to (typed error)', async () => {
    const inner = await buildIntaglio();
    await expect(constructShell(closedTooth(1.0), inner, { insertionAxis: AXIS })).rejects.toBeInstanceOf(
      ShellClosedOuterNeedsMarginError,
    );
  }, 120000);

  // Re-validation path: a broken stitch must be REJECTED, never returned as a
  // shell. (a) an OPEN-TUBE outer (two rims) leaves the un-stitched rim open ->
  // the manifold wrapper rejects the non-watertight construction.
  it('rejects a broken stitch: an open-tube outer leaves an unsealed rim', async () => {
    const inner = await buildIntaglio();
    // Tube: no top cap, no bottom cap -> TWO boundary rims; only one gets stitched.
    const tube = buildFrustum(MARGIN_R + 0.7, TOP_R + 0.7, MARGIN_Z, TOP_Z + 0.7, 96, false, false);
    await expect(constructShell(tube, inner, { insertionAxis: AXIS })).rejects.toThrow();
  }, 120000);

  // (b) a disjoint extra closed component makes the cleaned result multi-
  // component -> the analyzeMesh re-validation throws ShellNotWatertightError.
  it('rejects a multi-component result with ShellNotWatertightError', async () => {
    const inner = await buildIntaglio();
    // inner intaglio + a disjoint far-away closed tetrahedron (its own component).
    const tetra: IndexedMesh = {
      positions: new Float64Array([50, 50, 50, 51, 50, 50, 50, 51, 50, 50, 50, 51]),
      indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
    };
    const vCount = inner.positions.length / 3;
    const merged: IndexedMesh = {
      positions: new Float64Array([...inner.positions, ...tetra.positions]),
      indices: Uint32Array.from([...inner.indices, ...[...tetra.indices].map((i) => i + vCount)]),
    };
    await expect(constructShell(outerDome(0.7), merged, { insertionAxis: AXIS })).rejects.toBeInstanceOf(
      ShellNotWatertightError,
    );
  }, 120000);

  it('is deterministic: two runs produce a byte-identical shell hash (same manifold-3d version)', async () => {
    const inner = await buildIntaglio();
    const outer = outerDome(0.7);
    const a = await constructShell(outer, inner, { insertionAxis: AXIS });
    const b = await constructShell(outer, inner, { insertionAxis: AXIS });
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  }, 120000);

  it('progress hooks do not change the output (byte-identity contract)', async () => {
    const inner = await buildIntaglio();
    const outer = outerDome(0.7);
    const plain = await constructShell(outer, inner, { insertionAxis: AXIS });
    const fractions: number[] = [];
    const hooked = await constructShell(outer, inner, { insertionAxis: AXIS }, { onProgress: (f) => fractions.push(f) });
    expect(hashMesh(hooked.mesh)).toBe(hashMesh(plain.mesh));
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!)).toBe(true);
  }, 120000);
});

describe('measureWallThickness', () => {
  it('measures the wall thickness of a uniform-offset dome, DENSELY (samples between vertices)', async () => {
    const inner = await buildIntaglio();
    const outer = outerDome(1.0);
    const t = measureWallThickness(inner, outer, { insertionAxis: AXIS });
    // Dome offset ~1.0 mm; measured min ~0.9-1.0 mm.
    expect(t.minThicknessMm).toBeGreaterThan(0.8);
    expect(t.minThicknessMm).toBeLessThanOrEqual(1.05);
    expect(t.sampleCount).toBeGreaterThan(1000); // DENSE grid sampling, not just vertices
    // Achieved spacing is bounded well below the 0.5 mm threshold (the fail-safe).
    expect(t.sampleSpacingMm).toBeLessThanOrEqual(0.12);
    expect(t.errorBoundMm).toBe(t.sampleSpacingMm);
    expect(t.perInnerVertexMm.length).toBe(inner.positions.length / 3);
    console.log(`[thickness] uniform 1.0mm dome -> measured min ${(t.minThicknessMm * 1000).toFixed(0)} µm, ${t.sampleCount} samples, spacing ${(t.sampleSpacingMm * 1000).toFixed(0)} µm`);
  }, 120000);

  it('flags a deliberately-thin dome at the right (sub-0.5mm) value', async () => {
    const inner = await buildIntaglio();
    const thin = outerDome(0.3); // 0.3 mm wall — below the 0.5 mm minimum
    const t = measureWallThickness(inner, thin, { insertionAxis: AXIS });
    expect(t.minThicknessMm).toBeLessThan(0.5);
    expect(t.minThicknessMm).toBeGreaterThan(0.2);
    console.log(`[thickness] thin 0.3mm dome -> measured min ${(t.minThicknessMm * 1000).toFixed(0)} µm (flagged < 500 µm)`);
  }, 120000);
});

describe('autoThickenOuter', () => {
  it('raises a thin wall above the minimum (re-measured before/after)', async () => {
    const inner = await buildIntaglio();
    const thin = thinAxialDome(0.3);
    const before = measureWallThickness(inner, thin, { insertionAxis: AXIS });
    expect(before.minThicknessMm).toBeLessThan(0.5);

    // Overshoot clears the discretization gap so the DENSELY RE-MEASURED min
    // reaches the floor (over-thickening is bounded + clinically safe).
    const thickened = autoThickenOuter(thin, inner, { minThicknessMm: 0.5, maxDisplacementMm: 1.5, overshoot: 4.0, passes: 10 });
    expect(thickened.displacedVertexCount).toBeGreaterThan(0);
    expect(thickened.clampedVertexCount).toBe(0);

    const after = measureWallThickness(inner, thickened.mesh, { insertionAxis: AXIS });
    expect(after.minThicknessMm).toBeGreaterThan(before.minThicknessMm);
    expect(after.minThicknessMm).toBeGreaterThanOrEqual(0.5 - 1e-6);
    console.log(`[autoThicken] min ${(before.minThicknessMm * 1000).toFixed(0)} µm -> ${(after.minThicknessMm * 1000).toFixed(0)} µm (>= 500 µm), displaced ${thickened.displacedVertexCount} verts, maxApplied ${(thickened.maxAppliedMm * 1000).toFixed(0)} µm`);

    // The thickened outer still stitches into a watertight shell.
    const shell = await constructShell(thickened.mesh, inner, { insertionAxis: AXIS });
    expect(shell.stats.watertight).toBe(true);
  }, 120000);

  it('reports clamped vertices when the correction exceeds the bound (never silently over-balloons)', async () => {
    const inner = await buildIntaglio();
    const thin = outerDome(0.3);
    const thickened = autoThickenOuter(thin, inner, { minThicknessMm: 0.5, maxDisplacementMm: 0.05 });
    // 0.2 mm deficit but only 0.05 mm allowed -> clamped.
    expect(thickened.clampedVertexCount).toBeGreaterThan(0);
    expect(thickened.maxAppliedMm).toBeLessThanOrEqual(0.05 + 1e-9);
  }, 120000);

  it('is deterministic', async () => {
    const inner = await buildIntaglio();
    const thin = outerDome(0.3);
    const a = autoThickenOuter(thin, inner, { minThicknessMm: 0.5, maxDisplacementMm: 0.6 });
    const b = autoThickenOuter(thin, inner, { minThicknessMm: 0.5, maxDisplacementMm: 0.6 });
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  }, 120000);

  it('rejects non-positive params', async () => {
    const inner = await buildIntaglio();
    const thin = outerDome(0.3);
    expect(() => autoThickenOuter(thin, inner, { minThicknessMm: 0, maxDisplacementMm: 0.5 })).toThrow(TypeError);
    expect(() => autoThickenOuter(thin, inner, { minThicknessMm: 0.5, maxDisplacementMm: 0 })).toThrow(TypeError);
  }, 120000);
});

describe('constructShell — property: watertight across a range of wall offsets', () => {
  it('every stitched shell (outer offset in a valid range) is watertight', async () => {
    const inner = await buildIntaglio();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 30, max: 90 }), async (outMilli) => {
        const out = outMilli / 100; // 0.30 .. 0.90 mm
        fc.pre(out >= 0.3 && out <= 0.9); // Task-5 flaky-test lesson: guard generators
        const shell = await constructShell(outerDome(out), inner, { insertionAxis: AXIS });
        expect(shell.stats.watertight).toBe(true);
        expect(shell.stats.componentCount).toBe(1);
      }),
      { numRuns: 6 },
    );
  }, 180000);
});
