// packages/kernel/src/repair — user-approved, journaled mesh repair
// operations (Task 8): removeComponents, splitNonManifoldEdges,
// fillSmallHoles. Every function here is pure (never mutates its input,
// always returns a fresh `IndexedMesh` + a journal-ready report) — see each
// file's module doc for its algorithm.
export { removeComponents } from './removeComponents.ts';
export { splitNonManifoldEdges } from './splitNonManifoldEdges.ts';
export { fillSmallHoles } from './fillSmallHoles.ts';
export {
  DEFAULT_MAX_BOUNDARY_EDGES,
  type ComponentInfo,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
  type FillSmallHolesResult,
  type RemoveComponentsReport,
  type RemoveComponentsResult,
  type RemoveComponentsSelector,
  type RepairCounts,
  type SkippedHole,
  type SkippedHoleReason,
  type SplitNonManifoldEdgesReport,
  type SplitNonManifoldEdgesResult,
} from './types.ts';
