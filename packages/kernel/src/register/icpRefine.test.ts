// packages/kernel/src/register/icpRefine.test.ts
//
// Analytic + determinism coverage for icpRefine, per this task's brief:
// (1) perturbed init on a clean icosphere pair -> RMS < 1e-6 mm; (2) seeded
// noise robustness with a documented tolerance; (3) 10% outliers ->
// inlierFraction reflects, transform stays close to the noiseless answer;
// (4) determinism hash (same seed -> identical result).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { applyMat4ToPoint, composeRigid, IDENTITY_MAT4, type Mat4 } from './transform.ts';
import { icpRefine } from './icpRefine.ts';
import { mulberry32 } from './prng.ts';
import { rotationAboutAxis } from './register.test-fixtures.ts';

/** Applies a rigid transform to every vertex of a mesh — builds the "dst"
 * fixture as a KNOWN rigid transform of the "src" fixture, so ground truth
 * is exact by construction. */
function transformMesh(mesh: IndexedMesh, transform: Mat4): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const p: Vec3 = [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
    const out = applyMat4ToPoint(transform, p);
    positions[i * 3] = out[0];
    positions[i * 3 + 1] = out[1];
    positions[i * 3 + 2] = out[2];
  }
  return { positions, indices: mesh.indices };
}

const SRC_MESH = icosphereMesh(5, 3); // 1280 tris — modest, fast BVH + closestPoint queries
const KNOWN_ROTATION = rotationAboutAxis([0.3, 0.6, -0.2], 0.35);
const KNOWN_TRANSLATION: Vec3 = [4, -2, 1.5];
const KNOWN_TRANSFORM = composeRigid(KNOWN_ROTATION, KNOWN_TRANSLATION);
const DST_MESH = transformMesh(SRC_MESH, KNOWN_TRANSFORM);
const DST_BVH = buildBvh(DST_MESH);

/** A small, deterministic perturbation of `KNOWN_TRANSFORM` — a plausible
 * "coarse align got roughly there" starting point for ICP to refine from
 * (this file's `@errorBound`-documented precondition: ICP needs a
 * reasonably close init, it does not claim global convergence). */
function perturbedInit(): Mat4 {
  const perturbRotation = rotationAboutAxis([1, 0, 0], 0.05);
  // Compose: apply the small perturbation, then the known transform's own
  // rotation — i.e. start ICP from "close to correct, off by a few degrees
  // and a bit of translation".
  const perturbedRotation: [Vec3, Vec3, Vec3] = [
    [
      KNOWN_ROTATION[0][0] * perturbRotation[0][0] + KNOWN_ROTATION[0][1] * perturbRotation[1][0] + KNOWN_ROTATION[0][2] * perturbRotation[2][0],
      KNOWN_ROTATION[0][0] * perturbRotation[0][1] + KNOWN_ROTATION[0][1] * perturbRotation[1][1] + KNOWN_ROTATION[0][2] * perturbRotation[2][1],
      KNOWN_ROTATION[0][0] * perturbRotation[0][2] + KNOWN_ROTATION[0][1] * perturbRotation[1][2] + KNOWN_ROTATION[0][2] * perturbRotation[2][2],
    ],
    [
      KNOWN_ROTATION[1][0] * perturbRotation[0][0] + KNOWN_ROTATION[1][1] * perturbRotation[1][0] + KNOWN_ROTATION[1][2] * perturbRotation[2][0],
      KNOWN_ROTATION[1][0] * perturbRotation[0][1] + KNOWN_ROTATION[1][1] * perturbRotation[1][1] + KNOWN_ROTATION[1][2] * perturbRotation[2][1],
      KNOWN_ROTATION[1][0] * perturbRotation[0][2] + KNOWN_ROTATION[1][1] * perturbRotation[1][2] + KNOWN_ROTATION[1][2] * perturbRotation[2][2],
    ],
    [
      KNOWN_ROTATION[2][0] * perturbRotation[0][0] + KNOWN_ROTATION[2][1] * perturbRotation[1][0] + KNOWN_ROTATION[2][2] * perturbRotation[2][0],
      KNOWN_ROTATION[2][0] * perturbRotation[0][1] + KNOWN_ROTATION[2][1] * perturbRotation[1][1] + KNOWN_ROTATION[2][2] * perturbRotation[2][1],
      KNOWN_ROTATION[2][0] * perturbRotation[0][2] + KNOWN_ROTATION[2][1] * perturbRotation[1][2] + KNOWN_ROTATION[2][2] * perturbRotation[2][2],
    ],
  ];
  const perturbedTranslation: Vec3 = [KNOWN_TRANSLATION[0] + 0.3, KNOWN_TRANSLATION[1] - 0.2, KNOWN_TRANSLATION[2] + 0.15];
  return composeRigid(perturbedRotation, perturbedTranslation);
}

describe('icpRefine — analytic: clean icosphere pair', () => {
  it('converges from a perturbed init to RMS < 1e-6 mm', () => {
    const result = icpRefine(SRC_MESH, DST_MESH, DST_BVH, perturbedInit(), {
      sampleCount: 400,
      seed: 1,
      maxIterations: 60,
      convergenceRelTol: 1e-9,
    });
    expect(result.converged).toBe(true);
    expect(result.rmsMm).toBeLessThan(1e-6);
    expect(result.inlierFraction).toBeGreaterThan(0.85);

    // The recovered transform itself agrees with KNOWN_TRANSFORM on a probe
    // point, not just "the sampled points happen to land close" — this is
    // the stronger claim (a genuinely correct rigid transform, not a
    // non-rigid fit that merely minimizes sampled residuals).
    const probe: Vec3 = [3, 1, -2];
    const expected = applyMat4ToPoint(KNOWN_TRANSFORM, probe);
    const actual = applyMat4ToPoint(result.transform, probe);
    expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])).toBeLessThan(1e-4);
  });

  it('is deterministic: same seed -> byte-identical result', () => {
    const run = () => {
      const result = icpRefine(SRC_MESH, DST_MESH, DST_BVH, perturbedInit(), {
        sampleCount: 200,
        seed: 42,
        maxIterations: 30,
      });
      const hash = createHash('sha256');
      hash.update(JSON.stringify(result));
      return hash.digest('hex');
    };
    expect(run()).toBe(run());
  });

  it('different seeds sample different points but converge to essentially the same transform', () => {
    const a = icpRefine(SRC_MESH, DST_MESH, DST_BVH, perturbedInit(), { sampleCount: 300, seed: 7, maxIterations: 60 });
    const b = icpRefine(SRC_MESH, DST_MESH, DST_BVH, perturbedInit(), { sampleCount: 300, seed: 8, maxIterations: 60 });
    const probe: Vec3 = [-2, 4, 1];
    const pa = applyMat4ToPoint(a.transform, probe);
    const pb = applyMat4ToPoint(b.transform, probe);
    expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(1e-4);
  });

  it('requires a coarse init: identity init on a rotated pair does not recover the true transform (local-minimum caveat, documented)', () => {
    // KNOWN_TRANSFORM includes a real rotation — starting from identity is
    // FAR outside the basin of convergence for this pair, so the result
    // must NOT resemble the true transform (this documents/proves the
    // `@errorBound` local-minimum caveat rather than just asserting it in
    // prose).
    const result = icpRefine(SRC_MESH, DST_MESH, DST_BVH, IDENTITY_MAT4, {
      sampleCount: 200,
      seed: 3,
      maxIterations: 40,
    });
    const probe: Vec3 = [3, 1, -2];
    const expected = applyMat4ToPoint(KNOWN_TRANSFORM, probe);
    const actual = applyMat4ToPoint(result.transform, probe);
    const err = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
    expect(err).toBeGreaterThan(0.5); // nowhere close to the true answer
  });
});

describe('icpRefine — seeded noise robustness', () => {
  it('recovers to within roughly the noise level when dst is perturbed by seeded jitter', () => {
    const rng = mulberry32(99);
    const jitterMm = 0.02; // 20 micron scanner-noise-scale jitter
    const jitteredPositions = new Float64Array(DST_MESH.positions.length);
    for (let i = 0; i < DST_MESH.positions.length; i++) {
      jitteredPositions[i] = DST_MESH.positions[i]! + (rng() * 2 - 1) * jitterMm;
    }
    const jitteredMesh: IndexedMesh = { positions: jitteredPositions, indices: DST_MESH.indices };
    const jitteredBvh = buildBvh(jitteredMesh);

    const result = icpRefine(SRC_MESH, jitteredMesh, jitteredBvh, perturbedInit(), {
      sampleCount: 400,
      seed: 5,
      maxIterations: 60,
    });
    expect(result.converged).toBe(true);
    // Documented tolerance: RMS should land in the same order of magnitude
    // as the injected jitter, not blow up — generous 4x margin (this is a
    // point-to-plane fit against a noisy surface, not a noise-free exact
    // match, so some inflation above the raw per-vertex jitter amplitude is
    // expected).
    expect(result.rmsMm).toBeLessThan(jitterMm * 4);
  });
});

describe('icpRefine — outlier rejection', () => {
  // Fix batch: this test's original title ("10% far-outlier samples do not
  // perturb the recovered transform...") overclaimed — it introduces NO
  // actual outliers (SRC_MESH/DST_MESH here are a clean, exact rigid pair;
  // see this test's own body comment below). What it actually verifies is
  // narrower: that `outlierRejectionFraction: 0.1` (the library default,
  // `DEFAULT_OUTLIER_REJECTION_FRACTION`) is honored on a CLEAN pair — the
  // rejection budget is applied (inlierFraction lands near 0.9) even though
  // there's nothing genuinely outlying to reject. The REAL outlier-rejection
  // test — outliers actually present, rejection measurably helping recovery
  // — is the next `it` below; renamed so ITS title, not this one's, carries
  // that requirement.
  it('outlierRejectionFraction default (0.1) is honored on a clean pair (no true outliers): inlierFraction lands near 0.9', () => {
    // Samples come from the true SRC_MESH surface (no injected outliers
    // here — see this file's next test for that) — this verifies the
    // DEFAULT outlier fraction (10%) is honored on the clean pair: fewer
    // than sampleCount are kept whenever sampleCount doesn't evenly divide,
    // and inlierFraction is close to 0.9.
    const result = icpRefine(SRC_MESH, DST_MESH, DST_BVH, perturbedInit(), {
      sampleCount: 500,
      seed: 11,
      maxIterations: 40,
      outlierRejectionFraction: 0.1,
    });
    expect(result.inlierFraction).toBeGreaterThanOrEqual(0.9);
    expect(result.inlierFraction).toBeLessThan(1);
    expect(result.rmsMm).toBeLessThan(1e-5);
  });

  it('dst geometry with a displaced (non-corresponding) outlier region still converges close to the true transform when outliers are rejected', () => {
    // Build a DAMAGED dst: DST_MESH (== a clean rigid transform of SRC_MESH)
    // with ~10% of ITS vertices displaced far along their own normal —
    // simulating a scanner artifact/blob on the TARGET surface that has no
    // genuine correspondence on src. Applying the displacement to dst only
    // (not src too) is what makes these genuine OUTLIER correspondences —
    // unlike a consistent src+dst deformation (still perfectly
    // corresponding, not an outlier at all), a src sample near this patch
    // now finds a dst closest-point that is NOT where the true rigid
    // transform would put it. With outlier rejection enabled, the recovered
    // transform should still closely match KNOWN_TRANSFORM; without it
    // (outlierRejectionFraction: 0), every sample landing near the patch
    // drags the least-squares solve away from the true answer.
    const vertexCount = DST_MESH.positions.length / 3;
    const displaced = new Float64Array(DST_MESH.positions);
    const outlierEvery = Math.max(1, Math.floor(1 / 0.1));
    for (let v = 0; v < vertexCount; v += outlierEvery) {
      const p: Vec3 = [displaced[v * 3]!, displaced[v * 3 + 1]!, displaced[v * 3 + 2]!];
      const center: Vec3 = [KNOWN_TRANSLATION[0], KNOWN_TRANSLATION[1], KNOWN_TRANSLATION[2]];
      const outward: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const len = Math.hypot(outward[0], outward[1], outward[2]) || 1;
      const displaceMm = 3; // large, unambiguous outlier displacement
      displaced[v * 3] = displaced[v * 3]! + (outward[0] / len) * displaceMm;
      displaced[v * 3 + 1] = displaced[v * 3 + 1]! + (outward[1] / len) * displaceMm;
      displaced[v * 3 + 2] = displaced[v * 3 + 2]! + (outward[2] / len) * displaceMm;
    }
    const dstWithOutliers: IndexedMesh = { positions: displaced, indices: DST_MESH.indices };
    const dstWithOutliersBvh = buildBvh(dstWithOutliers);

    const withRejection = icpRefine(SRC_MESH, dstWithOutliers, dstWithOutliersBvh, perturbedInit(), {
      sampleCount: 600,
      seed: 13,
      maxIterations: 60,
      outlierRejectionFraction: 0.15,
    });
    const withoutRejection = icpRefine(SRC_MESH, dstWithOutliers, dstWithOutliersBvh, perturbedInit(), {
      sampleCount: 600,
      seed: 13,
      maxIterations: 60,
      outlierRejectionFraction: 0,
    });

    const probe: Vec3 = [3, 1, -2];
    const expected = applyMat4ToPoint(KNOWN_TRANSFORM, probe);
    function distanceTo(actual: Vec3): number {
      return Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
    }
    const errWith = distanceTo(applyMat4ToPoint(withRejection.transform, probe));
    const errWithout = distanceTo(applyMat4ToPoint(withoutRejection.transform, probe));
    expect(errWith).toBeLessThan(errWithout);
    // Generous absolute bound (not the tight 1e-6 clean-pair budget): 10% of
    // vertices are displaced 3mm outward here, a deliberately harsh
    // scenario — the point is outlier rejection measurably helps (asserted
    // above), not that it fully erases a 3mm/10%-of-surface artifact.
    expect(errWith).toBeLessThan(0.3);
    expect(withRejection.inlierFraction).toBeGreaterThanOrEqual(0.8);
  });
});

describe('icpRefine — validation', () => {
  it('rejects a zero-triangle dst mesh', () => {
    const emptyMesh: IndexedMesh = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    const emptyBvh = buildBvh(emptyMesh);
    expect(() => icpRefine(SRC_MESH, emptyMesh, emptyBvh, IDENTITY_MAT4, { sampleCount: 10, seed: 1 })).toThrow(
      RangeError,
    );
  });
});
