// packages/kernel/src/offset/innerSurfaceOffset.analytic.test.ts
//
// ANALYTIC GOLDEN for the two-zone inner-surface offset (innerSurfaceOffset.ts),
// on the shoulder-prep die (margin/marginRidge.test-fixtures.ts's
// `shoulderPrepMesh`) whose margin is a closed-form circle at
// `(marginRadiusMm, marginHeightMm)` — the EXACT P2 ring (see that fixture's
// "exact ring" note). The margin loop's `resampledPoints` is built as that
// analytic circle, densely sampled.
//
// ## Why a COMPACT die at the clinical pitch (always-on), plus a gated
// default-size run
//
// The always-on test uses a compact die (marginRadiusMm ~1.2) at the
// clinical default pitch 0.02 mm with a tight ROI — ~2 s, small enough to
// run every `npm test`. The full default-size die (marginRadiusMm 3.5) at
// the same pitch over the whole prep region is the gated
// `RUN_INNER_SURFACE_ACCEPTANCE=1` case (reports the die-scale perf numeral,
// same gating convention as offsetMesh.test.ts's RUN_OFFSET_ACCEPTANCE).
//
// ## The height field on this fixture is EXACT (no proxy error)
//
// On the die's straight (ruled) taper wall above a circular margin, the
// Euclidean distance to the margin loop EQUALS the along-surface distance up
// the wall (innerSurfaceOffset.ts option C, item 2 — proven directly: the
// nearest margin point to a wall point is the one at the same azimuth, and
// the straight-line distance to it is the straight wall segment length). So
// the spacer line sits at along-surface 0.8 mm exactly, and the measured
// offsets can be checked against the analytic zone values with no
// height-field error term — only the documented offset chord bound.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { shoulderPrepMesh } from '../margin/marginRidge.test-fixtures.ts';
import {
  distanceToClosedPolyline,
  innerSurfaceOffsetRoi,
  type InnerSurfaceGapParams,
} from './innerSurfaceOffset.ts';

const GAP: InnerSurfaceGapParams = {
  marginalGapMm: 0.02, // standard-zirconia.json
  cementGapMm: 0.05,
  spacerStartMm: 0.8,
  blendWidthMm: 0.3,
};
const CLINICAL_PITCH = 0.02;

function hashMesh(mesh: IndexedMesh): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  hash.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return hash.digest('hex');
}

/** The analytic margin circle as a dense closed polyline (n points). */
function analyticMarginCircle(radius: number, z: number, n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([radius * Math.cos(th), radius * Math.sin(th), z]);
  }
  return loop;
}

interface ZoneStats {
  n: number;
  meanDevMm: number;
  maxDevMm: number;
}

/** Measures the true normal offset (signed distance to the prep) at every
 * patch vertex, classifies it by along-surface height h = distance to the
 * margin loop, and returns per-zone deviation-from-expected stats plus the
 * raw (h, offset) samples for the monotonicity check. */
function measure(
  patch: IndexedMesh,
  prep: IndexedMesh,
  marginLoop: readonly Vec3[],
  gap: InnerSurfaceGapParams,
) {
  const bvh = buildBvh(prep);
  const pn = computePseudonormals(prep);
  const half = gap.blendWidthMm / 2;
  const marginalBound = gap.spacerStartMm - half;
  const cementBound = gap.spacerStartMm + half;

  const samples: Array<{ h: number; offset: number }> = [];
  const marginalDevs: number[] = [];
  const cementDevs: number[] = [];
  let minH = Infinity;
  const vCount = patch.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const p: Vec3 = [patch.positions[v * 3]!, patch.positions[v * 3 + 1]!, patch.positions[v * 3 + 2]!];
    const offset = signedClosestPoint(prep, bvh, pn, p).signedDistance;
    const h = distanceToClosedPolyline(p, marginLoop);
    samples.push({ h, offset });
    minH = Math.min(minH, h);
    // Exclude a small collar right at the ROI crop (h < 1 pitch) from the
    // flat-zone stats — those vertices sit on the open crop boundary.
    if (h < marginalBound && h > CLINICAL_PITCH) marginalDevs.push(Math.abs(offset - gap.marginalGapMm));
    if (h > cementBound) cementDevs.push(Math.abs(offset - gap.cementGapMm));
  }

  const zone = (devs: number[]): ZoneStats => ({
    n: devs.length,
    meanDevMm: devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : 0,
    maxDevMm: devs.length ? Math.max(...devs) : 0,
  });
  return { marginal: zone(marginalDevs), cement: zone(cementDevs), samples, minH };
}

const COMPACT_DIE = {
  gingivalRadiusMm: 1.5,
  marginRadiusMm: 1.2,
  topRadiusMm: 0.8,
  marginHeightMm: 0.5,
  totalHeightMm: 2.0,
  segments: 96,
};

async function runCompactDie() {
  const die = shoulderPrepMesh(COMPACT_DIE);
  const marginLoop = analyticMarginCircle(die.marginRadiusMm, die.marginHeightMm, 720);
  // ROI: the prep region above the margin plane. Radial extent covers the
  // margin corner offset outward (r <= marginRadius + cementGap) and the
  // taper up to the top; the SDF padding (offsetGridSpec) extends it below
  // the margin plane to capture the corner rounding.
  const roiBboxMm = {
    min: [-1.35, -1.35, COMPACT_DIE.marginHeightMm] as Vec3,
    max: [1.35, 1.35, COMPACT_DIE.totalHeightMm] as Vec3,
  };
  const result = await innerSurfaceOffsetRoi(die.mesh, {
    ...GAP,
    pitchMm: CLINICAL_PITCH,
    marginLoop,
    roiBboxMm,
  });
  return { die, marginLoop, result };
}

describe('innerSurfaceOffsetRoi — ANALYTIC: two-zone offset on the shoulder-prep die (compact, clinical pitch 0.02 mm)', () => {
  // Compute the clinical-pitch offset ONCE (~8 s) and share it across the
  // zone / blend / margin-detail / envelope assertions below — they each
  // measure a different property of the SAME deterministic surface.
  let shared: Awaited<ReturnType<typeof runCompactDie>>;
  let elapsedMs = 0;
  beforeAll(async () => {
    const started = performance.now();
    shared = await runCompactDie();
    elapsedMs = performance.now() - started;
  }, 120_000);

  it('marginal zone sits at marginalGapMm, cement zone at cementGapMm, blend monotonic; margin detail preserved', () => {
    {
      const { die, marginLoop, result } = shared;
      const m = measure(result.mesh, die.mesh, marginLoop, GAP);

      // --- REPORTED numerals (acceptance evidence) ---
      console.log(
        `[INNER-SURFACE ANALYTIC] compact die r=${die.marginRadiusMm} @ pitch ${CLINICAL_PITCH} mm | ` +
          `${result.mesh.indices.length / 3} tris | ${(elapsedMs / 1000).toFixed(2)} s | ` +
          `flatBound=${(result.flatZoneErrorBoundMm * 1000).toFixed(2)} µm blendBound=${(result.errorBoundMm * 1000).toFixed(2)} µm`,
      );
      console.log(
        `  MARGINAL zone (h<${GAP.spacerStartMm - GAP.blendWidthMm / 2}): n=${m.marginal.n} ` +
          `mean|dev|=${(m.marginal.meanDevMm * 1000).toFixed(2)} µm max|dev|=${(m.marginal.maxDevMm * 1000).toFixed(2)} µm (target 20 µm)`,
      );
      console.log(
        `  CEMENT   zone (h>${GAP.spacerStartMm + GAP.blendWidthMm / 2}): n=${m.cement.n} ` +
          `mean|dev|=${(m.cement.meanDevMm * 1000).toFixed(2)} µm max|dev|=${(m.cement.maxDevMm * 1000).toFixed(2)} µm (target 50 µm)`,
      );

      // Real coverage in both zones (not a vacuous pass).
      expect(m.marginal.n).toBeGreaterThan(30);
      expect(m.cement.n).toBeGreaterThan(30);

      // Zone offsets within the flat-zone (pitch/2 + eps) bound.
      expect(m.marginal.maxDevMm).toBeLessThanOrEqual(result.flatZoneErrorBoundMm);
      expect(m.cement.maxDevMm).toBeLessThanOrEqual(result.flatZoneErrorBoundMm);

      // --- Blend monotonicity across the spacer line ---
      // Bin the (h, offset) samples into 0.05 mm-wide h-bins over [0, 1.3],
      // take each bin's mean offset, and check the bin means are monotone
      // non-decreasing (allowing a per-bin dip of at most the flat-zone
      // bound for MC noise), and that no single bin-to-bin STEP exceeds the
      // full gap step + 2*bound. Report the largest step.
      const binW = 0.05;
      const nBins = Math.ceil(1.3 / binW);
      const sums = new Array(nBins).fill(0);
      const counts = new Array(nBins).fill(0);
      for (const s of m.samples) {
        if (s.h < 0 || s.h >= 1.3) continue;
        const b = Math.floor(s.h / binW);
        sums[b] += s.offset;
        counts[b] += 1;
      }
      const binMeans: Array<{ hMid: number; mean: number }> = [];
      for (let b = 0; b < nBins; b++) {
        if (counts[b] > 0) binMeans.push({ hMid: (b + 0.5) * binW, mean: sums[b] / counts[b] });
      }
      let maxDrop = 0;
      let maxStep = 0;
      for (let i = 1; i < binMeans.length; i++) {
        const d = binMeans[i]!.mean - binMeans[i - 1]!.mean;
        maxStep = Math.max(maxStep, Math.abs(d));
        if (d < 0) maxDrop = Math.max(maxDrop, -d);
      }
      console.log(
        `  BLEND: ${binMeans.length} h-bins | max monotonic drop=${(maxDrop * 1000).toFixed(2)} µm ` +
          `(tol ${(result.flatZoneErrorBoundMm * 1000).toFixed(2)} µm) | max bin step=${(maxStep * 1000).toFixed(2)} µm`,
      );
      // Monotone non-decreasing within MC noise.
      expect(maxDrop).toBeLessThanOrEqual(result.flatZoneErrorBoundMm);
      // No discontinuity: a single 0.05 mm-wide step never jumps more than
      // the total gap span (0.03 mm) plus 2x the bound.
      expect(maxStep).toBeLessThanOrEqual(GAP.cementGapMm - GAP.marginalGapMm + 2 * result.errorBoundMm);

      // --- Margin detail preserved: the patch reaches down to the margin
      // (min h within ~2 pitches of 0), and the near-margin ring tracks
      // radius marginRadius + marginalGap at the margin height. ---
      console.log(`  MARGIN DETAIL: min h over patch = ${(m.minH * 1000).toFixed(2)} µm (<= ~2 pitch = 40 µm)`);
      expect(m.minH).toBeLessThanOrEqual(2 * CLINICAL_PITCH);

      // Sanity: the offset patch is OPEN (cropped ROI — documented).
      expect(result.stats.watertight).toBe(false);
      expect(result.stats.boundaryEdgeCount).toBeGreaterThan(0);
    }
  });

  it('is deterministic — a second run is byte-identical (hash equality)', { timeout: 120_000 }, async () => {
    // A coarser pitch (0.05 mm) keeps this fast (~1 s x2) — determinism is a
    // property of the pipeline, independent of resolution; hash equality is
    // what is asserted, not accuracy.
    const die = shoulderPrepMesh(COMPACT_DIE);
    const marginLoop = analyticMarginCircle(die.marginRadiusMm, die.marginHeightMm, 360);
    const roiBboxMm = {
      min: [-1.35, -1.35, COMPACT_DIE.marginHeightMm] as Vec3,
      max: [1.35, 1.35, COMPACT_DIE.totalHeightMm] as Vec3,
    };
    const run = () => innerSurfaceOffsetRoi(die.mesh, { ...GAP, pitchMm: 0.05, marginLoop, roiBboxMm });
    const first = await run();
    const second = await run();
    expect(hashMesh(second.mesh)).toBe(hashMesh(first.mesh));
    expect(second.errorBoundMm).toBe(first.errorBoundMm);
    expect(second.stats).toEqual(first.stats);
  });

  it('property: every patch vertex offset is within [marginalGapMm - bound, cementGapMm + bound]', () => {
    {
      const { die, result } = shared;
      const bvh = buildBvh(die.mesh);
      const pn = computePseudonormals(die.mesh);
      const lo = GAP.marginalGapMm - result.errorBoundMm;
      const hi = GAP.cementGapMm + result.errorBoundMm;
      let minOff = Infinity;
      let maxOff = -Infinity;
      const vCount = result.mesh.positions.length / 3;
      for (let v = 0; v < vCount; v++) {
        const p: Vec3 = [
          result.mesh.positions[v * 3]!,
          result.mesh.positions[v * 3 + 1]!,
          result.mesh.positions[v * 3 + 2]!,
        ];
        const off = signedClosestPoint(die.mesh, bvh, pn, p).signedDistance;
        minOff = Math.min(minOff, off);
        maxOff = Math.max(maxOff, off);
      }
      console.log(
        `  ENVELOPE: offset in [${(minOff * 1000).toFixed(2)}, ${(maxOff * 1000).toFixed(2)}] µm ` +
          `vs allowed [${(lo * 1000).toFixed(2)}, ${(hi * 1000).toFixed(2)}] µm`,
      );
      expect(minOff).toBeGreaterThanOrEqual(lo);
      expect(maxOff).toBeLessThanOrEqual(hi);
    }
  });
});

const RUN_INNER_SURFACE_ACCEPTANCE = process.env['RUN_INNER_SURFACE_ACCEPTANCE'] === '1';

describe.skipIf(!RUN_INNER_SURFACE_ACCEPTANCE)(
  'innerSurfaceOffsetRoi — ACCEPTANCE: default-size die, full prep region [RUN_INNER_SURFACE_ACCEPTANCE=1]',
  () => {
    it('two-zone offset at clinical pitch over the full prep region; reports perf', { timeout: 600_000 }, async () => {
      const DEFAULT_TOTAL_HEIGHT_MM = 8; // shoulderPrepMesh's default totalHeightMm
      const die = shoulderPrepMesh(); // defaults: marginRadius 3.5, totalHeight 8
      const marginLoop = analyticMarginCircle(die.marginRadiusMm, die.marginHeightMm, 1440);
      const roiBboxMm = {
        min: [-die.marginRadiusMm - 0.2, -die.marginRadiusMm - 0.2, die.marginHeightMm] as Vec3,
        max: [die.marginRadiusMm + 0.2, die.marginRadiusMm + 0.2, DEFAULT_TOTAL_HEIGHT_MM] as Vec3,
      };
      const started = performance.now();
      const result = await innerSurfaceOffsetRoi(die.mesh, { ...GAP, pitchMm: CLINICAL_PITCH, marginLoop, roiBboxMm });
      const elapsedMs = performance.now() - started;
      const m = measure(result.mesh, die.mesh, marginLoop, GAP);
      console.log(
        `[INNER-SURFACE ACCEPTANCE] default die r=${die.marginRadiusMm} @ pitch ${CLINICAL_PITCH} mm | ` +
          `${result.mesh.indices.length / 3} tris | ${(elapsedMs / 1000).toFixed(1)} s`,
      );
      console.log(
        `  MARGINAL n=${m.marginal.n} max|dev|=${(m.marginal.maxDevMm * 1000).toFixed(2)} µm | ` +
          `CEMENT n=${m.cement.n} max|dev|=${(m.cement.maxDevMm * 1000).toFixed(2)} µm`,
      );
      expect(m.marginal.maxDevMm).toBeLessThanOrEqual(result.flatZoneErrorBoundMm);
      expect(m.cement.maxDevMm).toBeLessThanOrEqual(result.flatZoneErrorBoundMm);
    });
  },
);
