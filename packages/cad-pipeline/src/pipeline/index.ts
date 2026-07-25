// packages/cad-pipeline/src/pipeline — PipelineContext + RestorationStageResult.
// See context.ts / stageResult.ts module docs.
export type {
  PipelineContext,
  PipelineMaterialProfile,
  PipelineConnectorAreaTargets,
  PipelineMeshHandle,
  PipelineMarginLoop,
  CrownPipelineContext,
  InlayPipelineContext,
  OnlayPipelineContext,
  CavityPipelineContext,
} from './context.ts';
export {
  RestorationTypeMismatchError,
  assertCrownContext,
  assertCavityContext,
} from './context.ts';
export type { RestorationStageResult, PipelineStageName } from './stageResult.ts';
