// packages/cad-pipeline — Restoration design stages (inner surface, anatomy, adaptation,
// shell construction, QC gates). Populated starting Phase 4.
//
// Phase 4 Task 1: package scaffold (`pipeline/` — `PipelineContext` +
// `RestorationStageResult`; `gates/` — the QC gate runner). Layer rule
// (eslint.config.js's boundaries policy): this package imports only
// `@dqcad/kernel`, `@dqcad/io`, `@dqcad/shared-types` — never
// `@dqcad/clinical-profiles`, never `three`, never `@dqcad/kernel-workers`.
// No pipeline STAGES exist yet (Task 3+) — `stages/` is intentionally empty.
export * from './pipeline/index.ts';
export * from './gates/index.ts';
