// packages/tooth-library — Versioned anatomical tooth assets and morph
// targets used by the anatomy-placement pipeline stage (Task 5). See
// src/README.md for the full format doc (third-party import target) and
// src/generate/README.md for the starter set's provenance/licensing note.
//
// `.ts`-extension internal imports (matching `@dqcad/clinical-profiles`'s
// own convention, not just the strict CLAUDE.md "kernel-workers Node-entry
// closure" minimum): this package is a leaf `clinical-profiles` sibling
// that Task 5's future anatomy-placement WORKER job is very likely to pull
// into that exact closure next, and `allowImportingTsExtensions`
// (tsconfig.base.json) is already enabled repo-wide — following
// clinical-profiles' precedent now avoids a mechanical rename later.
//
// Public surface: the FORMAT (schema.ts), the LOADER (loader.ts) — the
// only module downstream pipeline code should import from — and the
// starter asset registry (assets.ts), exposed for tooling/tests/the server
// seeding routine. `generate/*` (the procedural generators themselves) is
// this package's own internal implementation of the starter set; nothing
// outside this package should depend on it directly (a third-party asset
// never needs it — see the format doc).
export type {
  CanonicalFrame,
  MorphTarget,
  RawToothAssetMetadataJson,
  ToothAssetMetadata,
  ToothLandmarks,
  ToothType,
} from './schema.ts';
export {
  PLACEHOLDER_PROVENANCE_PREFIX,
  ToothAssetMetadataChecksumError,
  ToothAssetMetadataValidationError,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
  assertOrthonormalFrame,
  computeMeshChecksum,
  computeToothAssetMetadataChecksum,
  loadToothAssetMetadata,
  validateToothAssetMetadataShape,
} from './schema.ts';

export type { StarterToothAsset } from './assets.ts';
export { STARTER_ASSET_VERSION, STARTER_FDI_CODES, STARTER_TOOTH_ASSETS } from './assets.ts';

export type { ToothAsset } from './loader.ts';
export {
  ToothLibraryFdiNotFoundError,
  loadToothAssetFromBytes,
  loadToothAssetFromServer,
  loadToothAssetInProcess,
} from './loader.ts';

export type { IncisorAsset } from './generate/incisor.ts';
export { INCISOR_FDI_CODES, generateIncisorAsset, incisorMorphTargets } from './generate/incisor.ts';
export type { MolarAsset } from './generate/molar.ts';
export { MOLAR_FDI_CODES, generateMolarAsset, molarMorphTargets } from './generate/molar.ts';
export {
  CENTRAL_INCISOR_PARAMS,
  FIRST_MOLAR_PARAMS,
  INCISOR_FDI_PARAMS,
  LATERAL_INCISOR_PARAMS,
  MOLAR_FDI_PARAMS,
  type IncisorTypeParams,
  type MolarParams,
} from './generate/toothParams.ts';
