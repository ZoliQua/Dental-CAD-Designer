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
  runAnatomyPlacementStage,
  identifyNeighbors,
  InsufficientNeighborsError,
  UnknownLandmarkError,
  type PipelineToothAsset,
  type AnatomyPlacementStageOptions,
  type AnatomyPlacementManualOverride,
} from './anatomyPlacement.ts';
