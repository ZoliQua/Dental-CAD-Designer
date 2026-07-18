// jobs/repair.ts — repairRemoveComponents / repairSplitNonManifoldEdges /
// repairFillSmallHoles (Task 8), repairSplitNonManifoldVertices (Task 11).
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move: no behavioral change.
//
// Each wraps ONE of @dqcad/kernel's pure repair/ functions (see
// packages/kernel/src/repair/*.ts's module docs for the algorithms) plus a
// before/after `analyzeMesh` call, so the caller (apps/client's repair
// preview panel) gets full `MeshStats` (watertight, manifoldEdges,
// boundaryEdgeCount, ...) on both sides without a separate round trip — the
// SAME "stats alongside the operation-specific report" split jobs/intake.ts's
// `IntakeMeshResult` uses for intake.
//
// Cancellation/progress granularity: unlike `intakeMesh` (4 real
// between-stage yield points), each repair kernel function here is ONE
// synchronous, non-yielding call — there is nothing to check cancellation
// BETWEEN internally, so (mirroring jobs/bvh.ts's `buildBvh` job) this
// offers a single checkpoint before starting, then reports 0 -> 1.
// Acceptable for Phase 1: repair operates on already-loaded, already-
// intake'd meshes (never bigger than the scan itself), and every repair
// function here is at most a small constant factor more expensive than
// intake's own analyzeMesh pass.
//
// Note: the standalone `hashMesh` job used by repair PREVIEW apply-time
// re-hashing (apps/client/src/engine/repair.ts's `applyRepairPreview`) lives
// in jobs/misc.ts, not here — see that file's module doc for why.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  removeComponents,
  splitNonManifoldEdges,
  splitNonManifoldVertices,
  fillSmallHoles,
  analyzeMesh,
  type IndexedMesh,
  type MeshStats,
  type RemoveComponentsSelector,
  type RemoveComponentsReport,
  type SplitNonManifoldEdgesReport,
  type SplitNonManifoldVerticesReport,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

export interface RepairRemoveComponentsPayload {
  positions: Float64Array;
  indices: Uint32Array;
  selector: RemoveComponentsSelector;
}

export interface RepairRemoveComponentsResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: RemoveComponentsReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RepairSplitNonManifoldEdgesPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface RepairSplitNonManifoldEdgesResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: SplitNonManifoldEdgesReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RepairSplitNonManifoldVerticesPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface RepairSplitNonManifoldVerticesResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: SplitNonManifoldVerticesReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RepairFillSmallHolesPayload {
  positions: Float64Array;
  indices: Uint32Array;
  options?: FillSmallHolesOptions;
}

export interface RepairFillSmallHolesResult {
  positions: Float64Array;
  indices: Uint32Array;
  report: FillSmallHolesReport;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export const repairRemoveComponents = async (
  payload: RepairRemoveComponentsPayload,
  ctx: JobContext,
): Promise<RepairRemoveComponentsResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'repairRemoveComponents');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = removeComponents(mesh, payload.selector);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

export const repairSplitNonManifoldEdges = async (
  payload: RepairSplitNonManifoldEdgesPayload,
  ctx: JobContext,
): Promise<RepairSplitNonManifoldEdgesResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'repairSplitNonManifoldEdges');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = splitNonManifoldEdges(mesh);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

export const repairSplitNonManifoldVertices = async (
  payload: RepairSplitNonManifoldVerticesPayload,
  ctx: JobContext,
): Promise<RepairSplitNonManifoldVerticesResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'repairSplitNonManifoldVertices');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = splitNonManifoldVertices(mesh);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};

export const repairFillSmallHoles = async (
  payload: RepairFillSmallHolesPayload,
  ctx: JobContext,
): Promise<RepairFillSmallHolesResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'repairFillSmallHoles');
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };
  const statsBefore = analyzeMesh(mesh);
  const { mesh: resultMesh, report } = fillSmallHoles(mesh, payload.options);
  const statsAfter = analyzeMesh(resultMesh);
  ctx.progress(1);
  return { positions: resultMesh.positions, indices: resultMesh.indices, report, statsBefore, statsAfter };
};
