// jobs/intake.ts — intakeMesh: runs @dqcad/kernel's mesh-intake pipeline
// (weld -> drop degenerate -> orient normals -> analyze) off the UI thread.
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move: no behavioral change
// (beyond this task's OWN `contentHash` addition, made to the monolith
// first and carried over unchanged by this split — see IntakeMeshResult's
// doc).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  weldVertices,
  dropDegenerateTriangles,
  orientNormalsConsistently,
  analyzeMesh,
  countsOf,
  makeStepReport,
  MESH_WELD_EPSILON_MM,
  type IndexedMesh,
  type IntakeReport,
  type IntakeStepReport,
  type MeshStats,
} from '@dqcad/kernel';
import { hashMeshContent } from '../hash.ts';
import { JobCancelledError, type JobContext } from './context.ts';

/**
 * `intakeMesh`: runs @dqcad/kernel's mesh-intake pipeline (weld -> drop
 * degenerate -> orient normals -> analyze; see
 * packages/kernel/src/intake/intake.ts) off the UI thread.
 *
 * Mirrors kernel `IntakeInput`'s two shapes, flattened into one payload
 * (Comlink structured-clones plain objects fine, but a flat discriminated
 * shape keeps the transfer list trivially buildable by the caller):
 *  - `kind: 'soup'` — `positions` is a flat 9-per-triangle soup (e.g. STL
 *    parser output); the weld stage runs. `indices` must be absent.
 *  - `kind: 'indexed'` — `positions`/`indices` form an `IndexedMesh` (e.g.
 *    PLY parser output); the weld stage is skipped (see intake.ts's module
 *    doc for when to expand to soup instead).
 *
 * ## Progress + cancellation granularity (BETWEEN stages)
 *
 * Unlike kernel `intake()` (fully synchronous, no cancellation — see its
 * module doc), this job sequences the four stages itself, `await`ing
 * `ctx.cancelled()` and reporting `ctx.progress()` between each — so an
 * abort lands at the next stage boundary (each stage is one uninterruptible
 * CPU-bound chunk; for a ~250k-triangle arch scan each stage is roughly
 * hundreds of ms, an acceptable cancellation latency for Phase 1 intake).
 *
 * Transferables: input `positions`/`indices` buffers should be moved in via
 * `RunJobOptions.transfer`; the result's mesh buffers are moved back
 * automatically by runJob's `transferablesOf` (they're top-level typed-array
 * fields on the result, see below).
 */
export interface IntakeMeshPayload {
  kind: 'soup' | 'indexed';
  /** Float64: 9-per-triangle soup when `kind === 'soup'`, 3-per-vertex
   * shared positions when `kind === 'indexed'`. */
  positions: Float64Array;
  /** Required (3 per triangle) when `kind === 'indexed'`; must be omitted
   * when `kind === 'soup'`. */
  indices?: Uint32Array;
}

/** Flat result shape (mesh buffers at top level, not nested) so runJob's
 * one-level-deep `transferablesOf` moves them back zero-copy — same
 * convention as every other job in this registry. `stats`/`report` are
 * plain JSON-able objects, structured-cloned normally. */
export interface IntakeMeshResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
  /** SHA-256 hex content hash of the FINAL (post-intake) `positions`/
   * `indices` buffers — `../hash.ts`'s `hashMeshContent`, computed
   * worker-side (Phase 2 Task 1 debt fix; see `MeshAsset.contentHash`'s
   * doc, packages/shared-types). Identical byte layout/value to what the
   * old main-thread `apps/client/src/engine/hash.ts`'s `hashMeshContent`
   * would have produced from the same `positions`/`indices` — only WHERE
   * it's computed changed, never the algorithm. */
  contentHash: string;
}

// Stage weights for intakeMesh's progress fractions: 4 between-stage
// checkpoints (after weld/skip-weld, after dropDegenerate, after orient,
// after analyze), evenly spaced. When the weld stage is skipped (indexed
// input) progress starts at the same first checkpoint anyway (the
// "prepare mesh" stage is then trivially cheap) — keeping the fraction
// sequence identical for both input kinds so UI progress bars behave the
// same regardless of source format.
const INTAKE_STAGE_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;

/** See IntakeMeshPayload's doc: sequences the kernel intake stages with an
 * `await ctx.cancelled()` + `ctx.progress()` checkpoint between each —
 * deliberately NOT a call to kernel `intake()` (which is synchronous
 * end-to-end and offers no between-stage yield points; see its module doc
 * for this exact division of labor). The report is assembled with the same
 * `countsOf`/`makeStepReport` helpers `intake()` itself uses, so both call
 * paths produce the identical journal-ready `IntakeReport` shape. */
export const intakeMesh = async (
  payload: IntakeMeshPayload,
  ctx: JobContext,
): Promise<IntakeMeshResult> => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('intakeMesh: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.kind !== 'soup' && payload.kind !== 'indexed') {
    throw new TypeError(
      `intakeMesh: kind must be "soup" or "indexed", got ${JSON.stringify(payload.kind)}`,
    );
  }

  const checkpoint = async (stage: number): Promise<void> => {
    if (await ctx.cancelled()) {
      throw new JobCancelledError();
    }
    ctx.progress(INTAKE_STAGE_FRACTIONS[stage]!);
  };

  const steps: IntakeStepReport[] = [];
  let mesh: IndexedMesh;
  if (payload.kind === 'soup') {
    if (payload.indices !== undefined) {
      throw new TypeError('intakeMesh: indices must be omitted for kind "soup"');
    }
    if (payload.positions.length % 9 !== 0) {
      throw new TypeError(
        'intakeMesh: soup positions length must be a multiple of 9 (9 values per triangle)',
      );
    }
    const triangleCount = payload.positions.length / 9;
    const soup = { positions: payload.positions, normals: null, triangleCount };
    mesh = weldVertices(soup);
    steps.push(
      makeStepReport('weld', { vertexCount: triangleCount * 3, triangleCount }, countsOf(mesh), {}),
    );
  } else {
    if (!(payload.indices instanceof Uint32Array)) {
      throw new TypeError('intakeMesh: indices must be a Uint32Array for kind "indexed"');
    }
    mesh = { positions: payload.positions, indices: payload.indices };
  }
  await checkpoint(0);

  const beforeDrop = countsOf(mesh);
  const dropped = dropDegenerateTriangles(mesh);
  steps.push(
    makeStepReport('dropDegenerateTriangles', beforeDrop, countsOf(dropped.mesh), {
      degenerateCount: dropped.degenerateCount,
      duplicateIndexCount: dropped.duplicateIndexCount,
    }),
  );
  await checkpoint(1);

  const beforeOrient = countsOf(dropped.mesh);
  const oriented = orientNormalsConsistently(dropped.mesh);
  steps.push(
    makeStepReport('orientNormalsConsistently', beforeOrient, countsOf(oriented.mesh), {
      flippedCount: oriented.flippedCount,
      componentCount: oriented.componentCount,
      ambiguousComponentCount: oriented.ambiguousComponentCount,
    }),
  );
  await checkpoint(2);

  const stats = analyzeMesh(oriented.mesh);
  await checkpoint(3);

  const report: IntakeReport = { weldEpsilonMm: MESH_WELD_EPSILON_MM, steps };
  const contentHash = await hashMeshContent(oriented.mesh.positions, oriented.mesh.indices);
  const result: IntakeMeshResult = {
    positions: oriented.mesh.positions,
    indices: oriented.mesh.indices,
    stats,
    report,
    contentHash,
  };
  return result;
};
