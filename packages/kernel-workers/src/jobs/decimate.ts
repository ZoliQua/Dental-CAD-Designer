// jobs/decimate.ts — decimateMesh (Phase 2 Task 10): QEM edge-collapse
// decimation for RENDER LODs, via @dqcad/kernel's decimate/ module — see
// that package's decimate.ts for the algorithm, determinism argument,
// boundary policy, and `@errorBound`.
//
// HARD INVARIANT (this task's brief): the kernel's Float64 data of record
// is NEVER decimated implicitly. This job's result is a SEPARATE mesh used
// only as an engine render copy (apps/client/src/engine/lod.ts) — callers
// must never write it back over a mesh's master buffers, and the engine
// wiring never does (its own tests hash the master buffers before/after to
// prove it).
//
// ## Progress & cancellation
//
// A real ~250k-triangle scan decimates in seconds (measured ~9 s to 20% on
// arch-case-01-upperjaw) — far past the "heavy compute in workers with
// progress + cooperative cancellation" threshold. This job therefore does
// NOT call the kernel's blocking `decimateMesh` convenience function — it
// drives the SAME algorithm through `beginDecimation`'s chunked
// `DecimationSession` (the identical code path: `decimateMesh` itself is
// `beginDecimation` + one unbounded `step()` + `finish()`), awaiting
// `ctx.cancelled()` and reporting `ctx.progress` between fixed-size collapse
// chunks. Chunking is pure scheduling — the collapse SEQUENCE is identical
// regardless of chunk boundaries (pinned by the kernel's own
// chunked-vs-blocking byte-identity test, decimate.test.ts), so this job's
// result is byte-identical to a direct `decimateMesh` call.
//
// Progress budget: setup (buildHalfedge + quadrics + initial queue)
// 0→0.05, collapse loop 0.05→0.98 (scaled by the session's own
// `progressFraction()` — display-only, see its doc), compaction 0.98→1.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { beginDecimation, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

/** Accepted collapses per progress/cancellation checkpoint. ~4k collapses
 * is ~100-300 ms of work at real-scan scale (measured on the 250k upperjaw
 * fixture) — responsive enough for a progress bar and prompt cancellation,
 * coarse enough that the per-chunk `await ctx.cancelled()` round trip stays
 * negligible against the chunk's own compute. */
const COLLAPSES_PER_CHUNK = 4096;

export interface DecimateMeshPayload {
  positions: Float64Array;
  indices: Uint32Array;
  /** Stop once the live triangle count reaches this — see @dqcad/kernel's
   * `DecimateMeshOptions.targetTriangleCount`. At least one of
   * `targetTriangleCount`/`errorBoundMm` is required (kernel-validated). */
  targetTriangleCount?: number;
  /** Max accepted QEM error, mm — see @dqcad/kernel's decimate.ts
   * `@errorBound` for exactly what this bounds (heuristic
   * distance-to-accumulated-planes, not a hard Euclidean surface bound). */
  errorBoundMm?: number;
}

export interface DecimateMeshResult {
  /** The decimated mesh's buffers (transferred, not cloned — registry.ts's
   * `transferablesOf`). RENDER-ONLY — see this module's doc. */
  positions: Float64Array;
  indices: Uint32Array;
  inputTriangleCount: number;
  outputTriangleCount: number;
  collapseCount: number;
  /** Max accepted `sqrt(QEM cost)`, mm — see @dqcad/kernel's decimate.ts
   * `@errorBound`. */
  maxErrorMm: number;
}

/**
 * `decimateMesh` worker job — see this file's module doc for the chunked
 * progress/cancellation contract and the byte-identity argument vs. the
 * kernel's own blocking `decimateMesh`.
 *
 * @throws {TypeError} for invalid options/payload (checked before any heavy
 * work — kernel-side validation happens inside `beginDecimation`, which
 * runs before the first progress checkpoint).
 * @throws {NonManifoldEdgeError} (@dqcad/kernel) if the input mesh is not
 * edge-manifold — repair first.
 */
export const decimateMeshJob = async (
  payload: DecimateMeshPayload,
  ctx: JobContext,
): Promise<DecimateMeshResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'decimateMesh');
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const session = beginDecimation(mesh, {
    ...(payload.targetTriangleCount !== undefined
      ? { targetTriangleCount: payload.targetTriangleCount }
      : {}),
    ...(payload.errorBoundMm !== undefined ? { errorBoundMm: payload.errorBoundMm } : {}),
  });
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.05);

  while (!session.isDone()) {
    session.step(COLLAPSES_PER_CHUNK);
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.05 + 0.93 * session.progressFraction());
  }

  const result = session.finish();
  ctx.progress(1);

  return {
    positions: result.mesh.positions,
    indices: result.mesh.indices,
    inputTriangleCount: result.inputTriangleCount,
    outputTriangleCount: result.outputTriangleCount,
    collapseCount: result.collapseCount,
    maxErrorMm: result.maxErrorMm,
  };
};
