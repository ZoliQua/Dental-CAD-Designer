// packages/tooth-library/src/generate/molar.ts
//
// Deterministic parametric molar crown generator — the first and second
// molars of every quadrant (toothParams.ts's `MOLAR_FDI_PARAMS`).
// PLACEHOLDER ANATOMY — see toothParams.ts's module doc and README.md.
//
// Shape model (generate/posterior.ts, shared with the premolar): an axial
// WALL (a symmetric elliptical ring stack, cervical to the base of the
// occlusal table — same ring/stitch machinery the incisor generator uses)
// topped by an OCCLUSAL TABLE built as several concentric contour rings
// shrinking from the wall's own top ring inward to a single center vertex.
// Each contour ring's elevation is a function of its radial position `s`
// (0 at the wall boundary, 1 at the center) and angle `theta`: a general
// dome rise, four Gaussian cusp bumps at the mesiobuccal/distobuccal/
// mesiolingual/distolingual quadrant angles, two mesial/distal marginal-
// ridge bumps near the table's rim, and a central-fossa Gaussian dip peaked
// at the very center — so "4 cusp-tip landmarks" and "a central fossa" both
// fall out of the same elevation formula, at specific, exactly-known (ring,
// angle) grid points (never found by search). The four-cusp table stands in
// for the lower molars' five cusps too: placeholder anatomy.
import type { FdiTooth } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { CanonicalFrame, MorphTarget, ToothLandmarks, ToothType } from '../schema.ts';
import { buildPosteriorCrown, posteriorMorphTargets, type PosteriorCusp } from './posterior.ts';
import { MOLAR_FDI_PARAMS, type MolarParams } from './toothParams.ts';

const DEG = Math.PI / 180;

/** In the original summation order (distobuccal, mesiobuccal, mesiolingual,
 * distolingual) — FDI 16 stays byte-identical (molar.test.ts's pin). */
const MOLAR_CUSPS: readonly PosteriorCusp[] = [
  { name: 'distobuccalCusp', angleRad: 45 * DEG, heightScale: 1 },
  { name: 'mesiobuccalCusp', angleRad: 135 * DEG, heightScale: 1 },
  { name: 'mesiolingualCusp', angleRad: 225 * DEG, heightScale: 1 },
  { name: 'distolingualCusp', angleRad: 315 * DEG, heightScale: 1 },
];

const MOLAR_LANDMARK_ORDER = [
  'mesiobuccalCusp',
  'distobuccalCusp',
  'mesiolingualCusp',
  'distolingualCusp',
  'centralFossa',
  'mesialMarginalRidge',
  'distalMarginalRidge',
] as const;

export interface MolarAsset {
  fdi: FdiTooth;
  toothType: ToothType;
  mesh: IndexedMesh;
  landmarks: ToothLandmarks;
  canonicalFrame: CanonicalFrame;
  morphTargets: readonly MorphTarget[];
}

const IDENTITY_FRAME: CanonicalFrame = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

/**
 * Pure per-vertex morph deltas — a function of each vertex's own final
 * (x, y, z) alone (see incisor.ts's `incisorMorphTargets` doc for why this
 * matters: `assets.ts` re-derives a starter asset's shipped `morphTargets`
 * against the CANONICAL mesh from re-parsing+re-welding its own STL bytes).
 */
export function molarMorphTargets(positions: Float64Array, params: MolarParams, wallTopZ: number): MorphTarget[] {
  return posteriorMorphTargets(positions, params, wallTopZ, MOLAR_CUSPS);
}

/**
 * Generates a watertight, deterministic molar crown for `fdi` (a key of
 * `MOLAR_FDI_PARAMS`). Pure function: same `fdi` always produces
 * byte-identical output (no `Math.random`, no clock/env dependence).
 */
export function generateMolarAsset(fdi: FdiTooth): MolarAsset {
  const params = MOLAR_FDI_PARAMS[fdi];
  if (!params) {
    throw new RangeError(`generateMolarAsset: fdi ${fdi} is not a supported molar (see MOLAR_FDI_PARAMS)`);
  }
  const { mesh, landmarks, wallTopZ } = buildPosteriorCrown(params, MOLAR_CUSPS, MOLAR_LANDMARK_ORDER);
  return {
    fdi,
    toothType: 'molar',
    mesh,
    landmarks,
    canonicalFrame: IDENTITY_FRAME,
    morphTargets: molarMorphTargets(mesh.positions, params, wallTopZ),
  };
}

export const MOLAR_FDI_CODES: readonly FdiTooth[] = Object.keys(MOLAR_FDI_PARAMS).map((k) => Number(k) as FdiTooth);
