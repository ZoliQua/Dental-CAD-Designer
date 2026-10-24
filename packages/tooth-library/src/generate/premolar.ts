// packages/tooth-library/src/generate/premolar.ts
//
// Deterministic parametric premolar crown generator (Phase 9 Task 4) — both
// premolars of every quadrant (toothParams.ts's `PREMOLAR_FDI_PARAMS`).
// PLACEHOLDER ANATOMY — see toothParams.ts's module doc and README.md.
//
// The molar's posterior table (generate/posterior.ts) with TWO cusps: a
// buccal cusp at full height and a lingual cusp scaled by
// `lingualCuspScale`, the central fossa (the central groove's deepest
// point) between them, and the two marginal ridges.
import type { FdiTooth } from '@dqcad/shared-types';
import type { CanonicalFrame } from '../schema.ts';
import type { MolarAsset } from './molar.ts';
import { buildPosteriorCrown, posteriorMorphTargets, type PosteriorCusp } from './posterior.ts';
import { PREMOLAR_FDI_PARAMS, type PremolarParams } from './toothParams.ts';

const DEG = Math.PI / 180;

const PREMOLAR_LANDMARK_ORDER = [
  'buccalCusp',
  'lingualCusp',
  'centralFossa',
  'mesialMarginalRidge',
  'distalMarginalRidge',
] as const;

const IDENTITY_FRAME: CanonicalFrame = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

/** Same asset shape as the molar generator's. */
export type PremolarAsset = MolarAsset;

function premolarCusps(params: PremolarParams): PosteriorCusp[] {
  return [
    { name: 'buccalCusp', angleRad: 90 * DEG, heightScale: 1 },
    { name: 'lingualCusp', angleRad: 270 * DEG, heightScale: params.lingualCuspScale },
  ];
}

/** Pure per-vertex morph deltas (see molar.ts's `molarMorphTargets`). */
export function premolarMorphTargets(
  positions: Float64Array,
  params: PremolarParams,
  wallTopZ: number,
) {
  return posteriorMorphTargets(positions, params, wallTopZ, premolarCusps(params));
}

/**
 * Generates a watertight, deterministic premolar crown for `fdi` (a key of
 * `PREMOLAR_FDI_PARAMS`). Pure: same `fdi` ⇒ byte-identical output.
 */
export function generatePremolarAsset(fdi: FdiTooth): PremolarAsset {
  const params = PREMOLAR_FDI_PARAMS[fdi];
  if (!params) {
    throw new RangeError(
      `generatePremolarAsset: fdi ${fdi} is not a supported premolar (see PREMOLAR_FDI_PARAMS)`,
    );
  }
  const { mesh, landmarks, wallTopZ } = buildPosteriorCrown(
    params,
    premolarCusps(params),
    PREMOLAR_LANDMARK_ORDER,
  );
  return {
    fdi,
    toothType: 'premolar',
    mesh,
    landmarks,
    canonicalFrame: IDENTITY_FRAME,
    morphTargets: premolarMorphTargets(mesh.positions, params, wallTopZ),
  };
}

export const PREMOLAR_FDI_CODES: readonly FdiTooth[] = Object.keys(PREMOLAR_FDI_PARAMS).map(
  (k) => Number(k) as FdiTooth,
);
