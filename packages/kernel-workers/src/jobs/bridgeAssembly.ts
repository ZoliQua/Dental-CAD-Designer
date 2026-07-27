// jobs/bridgeAssembly.ts — the BRIDGE ASSEMBLY worker job (Phase 6 Task 6):
// fuses the bridge's units + connectors into ONE watertight single-component
// solid via @dqcad/kernel's `assembleBridge` (boolean union through the
// manifold-3d WASM wrapper — heavy + async, so it belongs off the UI thread).
// A thin driver over the kernel op: it computes NO value the op doesn't, so a
// payload yields a byte-identical fused solid vs a direct kernel call (pinned by
// bridgeAssemblyJob.test.ts) at a fixed manifold-3d version.
//
// ## Progress / cancellation
//
// The union folds one solid at a time, so progress is PER-FOLD (via the kernel
// op's own `onProgress`) with a cooperative cancel check up front and after; a
// disjoint / non-watertight fuse surfaces as the kernel's typed `BridgeAssemblyError`
// (propagated unchanged — never swallowed).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import { assembleBridge, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

/** One solid to fuse (flat Float64 xyz + triangle indices — transferable). */
export interface BridgeAssemblySolidPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface BridgeAssemblyPayload {
  /** Every solid to fuse (units then connectors) — at least one. */
  solids: readonly BridgeAssemblySolidPayload[];
}

export interface BridgeAssemblyResultPayload {
  positions: Float64Array;
  indices: Uint32Array;
  watertight: boolean;
  componentCount: number;
  inputCount: number;
  volumeMm3: number | null;
  triangleCount: number;
}

function validate(payload: BridgeAssemblyPayload): void {
  if (payload.solids.length === 0) throw new TypeError('bridgeAssembly: at least one solid is required');
  for (const s of payload.solids) {
    if (s.positions.length < 9 || s.indices.length < 3) {
      throw new TypeError('bridgeAssembly: each solid needs >= 3 vertices and >= 1 triangle');
    }
  }
}

/**
 * `bridgeAssembly` worker job — see this file's module doc. Fuses every solid into
 * one; byte-identical to a direct `assembleBridge` call at a fixed manifold-3d
 * version.
 *
 * @throws {TypeError} for empty/degenerate input (before heavy work).
 * @throws {JobCancelledError} on cooperative cancellation.
 * @throws {BridgeAssemblyError} (propagated) on a disjoint / non-watertight fuse.
 */
export const bridgeAssemblyJob = async (
  payload: BridgeAssemblyPayload,
  ctx: JobContext,
): Promise<BridgeAssemblyResultPayload> => {
  validate(payload);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const solids: IndexedMesh[] = payload.solids.map((s) => ({ positions: s.positions, indices: s.indices }));
  const result = await assembleBridge(solids, (f) => ctx.progress(f));

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(1);
  return {
    positions: result.solid.positions,
    indices: result.solid.indices,
    watertight: result.watertight,
    componentCount: result.componentCount,
    inputCount: result.inputCount,
    volumeMm3: result.volumeMm3,
    triangleCount: result.triangleCount,
  };
};
