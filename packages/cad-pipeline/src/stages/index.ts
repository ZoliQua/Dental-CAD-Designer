// packages/cad-pipeline/src/stages — the 6 fixed-order crown-design stages
// (inner surface, anatomy placement, adaptation/morphing, shell
// construction, freeform, QC — docs/plans/phase-4-crown-design.md). The
// first real stage (`innerSurface.ts`, the two-zone cement-gap offset)
// arrives Phase 4 Task 3.
export {
  runInnerSurfaceStage,
  prepRegionRoiBbox,
  MissingMarginLoopError,
  MissingClinicalParamError,
  type InnerSurfaceStageOptions,
} from './innerSurface.ts';

export {
  runCavityInnerSurfaceStage,
  MissingCavityOutlineError,
  MissingClinicalParamError as CavityInnerSurfaceMissingClinicalParamError,
  type CavityInnerSurfaceStageOptions,
} from './cavityInnerSurface.ts';

export {
  runCavityOcclusalPatchStage,
  MissingCavityOutlineError as CavityOcclusalPatchMissingCavityOutlineError,
  type CavityOcclusalPatchStageOptions,
  type CavityOcclusalPatchStageResult,
} from './cavityOcclusalPatch.ts';

export {
  runCavityProximalContactStage,
  AmbiguousProximalPairingError,
  CavityProximalContactMissingClinicalParamError,
  type CavityProximalContactStageOptions,
  type CavityProximalContactStageResult,
  type CavityProximalContactBoxParams,
} from './cavityProximalContact.ts';

export {
  runAnatomyPlacementStage,
  identifyNeighbors,
  InsufficientNeighborsError,
  UnknownLandmarkError,
  type PipelineToothAsset,
  type AnatomyPlacementStageOptions,
  type AnatomyPlacementManualOverride,
} from './anatomyPlacement.ts';

export {
  runMorphingStage,
  buildMorphPlan,
  MORPH_RBF_KERNEL,
  MissingMarginLoopError as MorphingMissingMarginLoopError,
  MissingAntagonistError,
  MissingClinicalParamError as MorphingMissingClinicalParamError,
  type MorphingStageOptions,
} from './morphing.ts';

export {
  runShellStage,
  MissingMarginLoopError as ShellMissingMarginLoopError,
  MissingClinicalParamError as ShellMissingClinicalParamError,
  type ShellStageOptions,
} from './shell.ts';

export {
  runCavityShellStage,
  type CavityShellStageOptions,
  type CavityShellStageResult,
} from './cavityShell.ts';

export {
  runCavityCuspCoverageStage,
  MissingCavityOutlineError as CuspCoverageMissingOutlineError,
  type CavityCuspCoverageStageOptions,
  type CavityCuspCoverageStageResult,
} from './cavityCuspCoverage.ts';

export {
  runSculptStage,
  MissingMarginLoopError as SculptMissingMarginLoopError,
  EmptySculptGestureError,
  type SculptStageOptions,
} from './sculpt.ts';
