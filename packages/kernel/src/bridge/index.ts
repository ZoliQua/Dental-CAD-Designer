// packages/kernel/src/bridge/index.ts — public surface of the bridge/ module
// (Phase 6). See sharedAxis.ts's module doc for the shared-insertion-axis
// assessment + suggestion (the reuse map over the P3/P4 axis+undercut
// machinery).
export {
  assessSharedAxis,
  suggestSharedAxis,
  type SharedAxisRegionReport,
  type SharedAxisAssessment,
  type AssessSharedAxisOptions,
  type SharedAxisSuggestion,
} from './sharedAxis.ts';
