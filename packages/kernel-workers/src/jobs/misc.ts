// jobs/misc.ts — grab-bag of jobs that don't belong to one geometry domain:
// echoMesh/longTask (Phase 0 acceptance/progress-cancellation exercisers),
// manifoldSmoke (WASM load smoke test), rescaleMesh (unit-mistake
// correction), serializeMeshStl (Task 11 persistence WRITE half — see
// jobs/io.ts's weldMeshSoup for the READ half and its "Why binary STL..."
// module doc, shared by both), and hashMesh (Phase 2 Task 1's standalone
// worker-side re-hash job).
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move for echoMesh/longTask/
// manifoldSmoke/rescaleMesh/serializeMeshStl; hashMesh is new (this same
// task's worker-side-hashing deliverable).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import { union, volume, type IndexedMesh } from '@dqcad/kernel';
import { encodeFinalMeshContainer, writeStlBinary } from '@dqcad/io';
import { hashFloat64, hashMeshContent, sha256Hex } from '../hash.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

export interface EchoMeshPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface EchoMeshResult {
  positions: Float64Array;
  indices: Uint32Array;
}

/**
 * Acceptance round-trip job: hands the same typed-array buffers straight
 * back. On its own this only proves correctness of pass-through logic — the
 * actual "was it transferred, not copied" and "byte-identical" assertions
 * live in pool.ts's caller (WorkerPool.run) and its tests, since only the
 * caller holds the pre-transfer reference needed to check `byteLength`.
 */
export const echoMesh = async (payload: EchoMeshPayload): Promise<EchoMeshResult> => {
  if (!(payload.positions instanceof Float64Array)) {
    // Kernel Float64 rule (docs/plans/phase-0-foundation.md Global
    // Constraints): any buffer crossing the kernel-workers boundary carries
    // positions as Float64.
    throw new TypeError('echoMesh: positions must be a Float64Array');
  }
  if (!(payload.indices instanceof Uint32Array)) {
    throw new TypeError('echoMesh: indices must be a Uint32Array');
  }
  return { positions: payload.positions, indices: payload.indices };
};

export interface LongTaskPayload {
  /** Number of loop iterations to run; must be a positive integer. */
  iterations: number;
}

export interface LongTaskResult {
  /** Deterministic running sum of 0..iterations-1, for asserting the job
   * actually completed the requested amount of work. */
  sum: number;
}

// Report progress roughly this many times over a run: frequent enough to
// look smooth, infrequent enough that the Comlink round-trip per progress
// call isn't the bottleneck.
const PROGRESS_STEPS = 20;

/**
 * Deterministic long-running job used to exercise progress reporting and
 * cancellation. Cancellation here is COOPERATIVE: `ctx.cancelled()` is only
 * checked at chunk boundaries (every ~iterations/PROGRESS_STEPS loops), not
 * on every iteration. This is a deliberate, documented tradeoff — checking
 * (and awaiting, since the proxied cancelled() call is a Comlink round
 * trip) every iteration would dominate the running time for cheap
 * per-iteration work. A real abort therefore lands within one chunk of the
 * abort() call, not instantly, which is acceptable for Phase 0's geometry
 * jobs.
 */
export const longTask = async (payload: LongTaskPayload, ctx: JobContext): Promise<LongTaskResult> => {
  const { iterations } = payload;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new TypeError('longTask: iterations must be a positive integer');
  }
  const chunkSize = Math.max(1, Math.floor(iterations / PROGRESS_STEPS));
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    sum += i;
    const atChunkBoundary = i % chunkSize === chunkSize - 1 || i === iterations - 1;
    if (atChunkBoundary) {
      if (await ctx.cancelled()) {
        throw new JobCancelledError();
      }
      ctx.progress((i + 1) / iterations);
    }
  }
  return { sum };
};

/** manifoldSmoke takes no input — it builds its own fixture meshes (see
 * unitCubeMesh below) purely to prove manifold-3d's WASM loads and runs
 * inside this worker (browser or Node). */
export type ManifoldSmokePayload = Record<string, never>;

export interface ManifoldSmokeResult {
  /** Volume of the union, as computed by manifold-3d. */
  volume: number;
  /** Analytic expected volume for the fixture (see unitCubeMesh below):
   * two unit cubes overlapping by 0.5 on X have union volume 1 + 1 - 0.5 = 1.5. */
  expected: number;
}

// Unit cube (edge length 1), corner at (offsetX, 0, 0), with vertices/
// triangle winding verified against manifold-3d directly (each triangle's
// (v1-v0)x(v2-v0) cross product checked to point outward — manifold-3d
// requires CCW-from-outside winding and throws NonManifoldInputError
// (surfaced from @dqcad/kernel's `union`/etc.) for meshes with inconsistent
// or inward-facing winding).
function unitCubeMesh(offsetX: number): IndexedMesh {
  const positions = new Float64Array([
    offsetX,
    0,
    0,
    offsetX + 1,
    0,
    0,
    offsetX + 1,
    1,
    0,
    offsetX,
    1,
    0,
    offsetX,
    0,
    1,
    offsetX + 1,
    0,
    1,
    offsetX + 1,
    1,
    1,
    offsetX,
    1,
    1,
  ]);
  const indices = new Uint32Array([
    0,
    2,
    1,
    0,
    3,
    2, // bottom (-z)
    4,
    5,
    6,
    4,
    6,
    7, // top (+z)
    0,
    1,
    5,
    0,
    5,
    4, // front (-y)
    1,
    2,
    6,
    1,
    6,
    5, // right (+x)
    2,
    3,
    7,
    2,
    7,
    6, // back (+y)
    0,
    4,
    7,
    0,
    7,
    3, // left (-x)
  ]);
  return { positions, indices };
}

const MANIFOLD_SMOKE_CUBE_OFFSET_X = 0.5;
const MANIFOLD_SMOKE_EXPECTED_VOLUME = 1.5;

/**
 * Proves manifold-3d's WASM module loads and runs a real boolean op inside
 * THIS worker (browser Web Worker or Node worker_threads worker) — the
 * counterpart, at the kernel-workers layer, to @dqcad/kernel's own
 * union/volume unit tests (packages/kernel/src/boolean/manifold.test.ts),
 * which only prove the same thing on the main/test thread.
 */
export const manifoldSmoke = async (): Promise<ManifoldSmokeResult> => {
  const a = unitCubeMesh(0);
  const b = unitCubeMesh(MANIFOLD_SMOKE_CUBE_OFFSET_X);
  const unioned = await union(a, b);
  const unionVolume = await volume(unioned);
  return { volume: unionVolume, expected: MANIFOLD_SMOKE_EXPECTED_VOLUME };
};

/**
 * `rescaleMesh`: multiplies every coordinate in `positions` by `factor` — the
 * worker-side half of the client's unit-mistake correction flow (see
 * apps/client/src/engine/units.ts's bbox heuristic and importer.ts's
 * confirmation-gated call site). Deliberately format-agnostic: `positions`
 * may be either a flat 9-per-triangle soup (STL) or a 3-per-vertex indexed
 * buffer (PLY) — a uniform scalar rescale is the same flat per-coordinate
 * multiply either way, so this job never needs `indices` at all. Runs in
 * Float64 throughout (kernel Float64 rule) and is the ONLY place a mesh's
 * coordinates change due to a unit mistake — CLAUDE.md's "no silent data
 * mutation" rule is enforced by the CALLER (importer.ts always resolves an
 * explicit user confirmation, journaled as an `Operation` named
 * `unit-rescale`, before ever invoking this job); this job itself performs
 * no confirmation or journaling — it is a pure, mechanical scale.
 */
export interface RescaleMeshPayload {
  /** Float64: kernel Float64 rule. Mutated IN PLACE and returned (this
   * buffer was transferred into the worker, so the worker is its sole
   * owner — see runJob's transfer contract) rather than copied into a
   * fresh array, since a rescale is a lossless, purely multiplicative
   * per-element transform with no shape change. */
  positions: Float64Array;
  /** Must be finite and > 0 — see units.ts's CM_TO_MM_FACTOR /
   * UM_TO_MM_FACTOR for the two factors the client's heuristic ever
   * suggests; this job itself has no opinion on which factors are
   * "reasonable" (that judgment lives entirely in units.ts + the mandatory
   * user confirmation dialog). */
  factor: number;
}

export interface RescaleMeshResult {
  positions: Float64Array;
  /** SHA-256 hex of `positions`' bytes BEFORE the rescale multiply —
   * `../hash.ts`'s `hashFloat64`, computed worker-side (Phase 2 Task 1 debt
   * fix). Journaled as the `unit-rescale` `Operation.inputHashes[0]`
   * (importer.ts) — identical value to what the old main-thread
   * `hashPositionsOnly` helper (importer.ts, now removed) would have
   * produced from the same bytes. */
  beforeHash: string;
  /** SHA-256 hex of `positions`' bytes AFTER the rescale multiply — see
   * `beforeHash`'s doc; journaled as `Operation.outputHashes[0]`. */
  afterHash: string;
}

// Chunk size (element count, not bytes) for rescaleMesh's progress/
// cancellation checkpoints — same "checked only between chunks" cooperative
// pattern as longTask/chunkStream (jobs/io.ts), sized so a ~250k-triangle
// arch scan (750k position components) reports a handful of checkpoints
// rather than one giant uninterruptible pass.
const RESCALE_PROGRESS_CHUNK_ELEMENTS = 200_000;

export const rescaleMesh = async (
  payload: RescaleMeshPayload,
  ctx: JobContext,
): Promise<RescaleMeshResult> => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('rescaleMesh: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (!Number.isFinite(payload.factor) || payload.factor <= 0) {
    throw new TypeError(
      `rescaleMesh: factor must be a finite positive number, got ${payload.factor}`,
    );
  }

  const { positions, factor } = payload;
  const total = positions.length;
  // Hashed BEFORE the mutation loop below (positions is mutated IN PLACE —
  // see RescaleMeshPayload.positions' doc) so `beforeHash` reflects the
  // pre-rescale bytes, matching the old main-thread call site's ordering
  // (importer.ts hashed `positions` immediately before calling this job).
  const beforeHash = await hashFloat64(positions);
  if (total === 0) {
    ctx.progress(1);
    return { positions, beforeHash, afterHash: beforeHash };
  }

  const chunkSize = Math.max(1, Math.min(RESCALE_PROGRESS_CHUNK_ELEMENTS, total));
  for (let i = 0; i < total; i += 1) {
    positions[i] = positions[i]! * factor;
    const atChunkBoundary = i % chunkSize === chunkSize - 1 || i === total - 1;
    if (atChunkBoundary) {
      if (await ctx.cancelled()) {
        throw new JobCancelledError();
      }
      ctx.progress((i + 1) / total);
    }
  }
  const afterHash = await hashFloat64(positions);
  return { positions, beforeHash, afterHash };
};

// ---------------------------------------------------------------------------
// serializeMeshStl (Task 11: scene persistence — the WRITE half; see
// jobs/io.ts's weldMeshSoup for the READ half and its "Why binary STL..."/
// "intake-skip" module docs, which apply equally here).
// ---------------------------------------------------------------------------

export interface SerializeMeshStlPayload {
  /** Float64 master mesh buffers (kernel Float64 rule) — the caller should
   * pass PRIVATE copies in the transfer list (e.g. `positions.slice()`),
   * never a mesh's live master buffer, exactly like `BuildBvhPayload`'s
   * documented convention (transferring detaches the original ArrayBuffer,
   * and the caller's meshStore needs its master copy to keep living for
   * rendering). */
  positions: Float64Array;
  indices: Uint32Array;
}

export interface SerializeMeshStlResult {
  /** Binary STL file bytes (see jobs/io.ts's "Why binary STL..." module doc
   * for the float32 narrowing this inherently performs). */
  bytes: Uint8Array;
  /** SHA-256 hex of `bytes` — `../hash.ts`'s `sha256Hex`, computed
   * worker-side over the exact bytes this call just produced (Phase 2 Task
   * 1 debt fix). `apps/client/src/engine/persistence.ts`'s
   * `uploadMissingMeshes` uses this directly as `MeshAsset.fileHash`
   * instead of re-hashing `bytes` main-thread after the fact — identical
   * value either way, just computed where the bytes already live. */
  fileHash: string;
}

/** Expands an indexed mesh into the flat 9-per-triangle soup binary STL
 * requires — every triangle owns its own 3 vertex copies (packages/io's
 * `RawTriangleSoup` shape). */
function indexedToTriangleSoupPositions(positions: Float64Array, indices: Uint32Array): Float64Array {
  const triangleCount = indices.length / 3;
  const soup = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertexIndex = indices[t * 3 + corner]!;
      const soupOffset = t * 9 + corner * 3;
      soup[soupOffset] = positions[vertexIndex * 3]!;
      soup[soupOffset + 1] = positions[vertexIndex * 3 + 1]!;
      soup[soupOffset + 2] = positions[vertexIndex * 3 + 2]!;
    }
  }
  return soup;
}

export const serializeMeshStl = async (
  payload: SerializeMeshStlPayload,
): Promise<SerializeMeshStlResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'serializeMeshStl');
  const soupPositions = indexedToTriangleSoupPositions(payload.positions, payload.indices);
  const bytes = writeStlBinary({
    positions: soupPositions,
    normals: null,
    triangleCount: payload.indices.length / 3,
  });
  const fileHash = await sha256Hex(bytes);
  return { bytes, fileHash };
};

// ---------------------------------------------------------------------------
// serializeFinalMeshContent (Phase 7 Task 6 — the T4-F2 closure WRITE half).
// Serializes a restoration's FINAL MESH into the LOSSLESS self-describing
// container (`@dqcad/io`'s `encodeFinalMeshContainer`) whose reconstructed
// mesh hashes to the SAME `Restoration.stages.finalMesh` content hash — unlike
// `serializeMeshStl`, which narrows to f32 and cannot reproduce that hash.
// Persisted content-addressed by the client so the export endpoint can resolve
// `stages.finalMesh` to the exact Float64 design solid and certify the
// delivered outer envelope. Returns the container bytes + the content hash
// (recomputed here, worker-side, over the SAME layout the container stores —
// `apps/client/src/engine/persistence.ts` asserts it equals the document's
// `stages.finalMesh`).
// ---------------------------------------------------------------------------

export interface SerializeFinalMeshContentPayload {
  /** Float64 master mesh buffers (kernel Float64 rule) — caller passes PRIVATE
   * copies in the transfer list (`.slice()`), never a session's live master
   * buffer, same convention as `SerializeMeshStlPayload`. */
  positions: Float64Array;
  indices: Uint32Array;
}

export interface SerializeFinalMeshContentResult {
  /** The lossless final-mesh container bytes (see `encodeFinalMeshContainer`). */
  bytes: Uint8Array;
  /** `hashMeshContent(positions, indices)` — the canonical content hash the
   * reconstructed container mesh reproduces; equals `stages.finalMesh`. */
  contentHash: string;
}

export const serializeFinalMeshContent = async (
  payload: SerializeFinalMeshContentPayload,
): Promise<SerializeFinalMeshContentResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'serializeFinalMeshContent');
  const bytes = encodeFinalMeshContainer({ positions: payload.positions, indices: payload.indices });
  const contentHash = await hashMeshContent(payload.positions, payload.indices);
  return { bytes, contentHash };
};

// ---------------------------------------------------------------------------
// hashMesh (Phase 2 Task 1 debt fix): standalone worker-side re-hash for
// callers that need a `hashMeshContent`-equivalent SHA-256 content hash
// OUTSIDE of jobs/intake.ts's `intakeMesh` pipeline (which now returns
// `contentHash` directly on its result — see `IntakeMeshResult.contentHash`'s
// doc — and therefore never needs this job for its own output).
//
// The motivating caller is `apps/client/src/engine/repair.ts`'s
// `applyRepairPreview`: a repair PREVIEW (`previewRemoveComponents` etc.,
// jobs/repair.ts's `repairRemoveComponents`/`repairSplitNonManifoldEdges`/
// `repairFillSmallHoles` jobs) may run many times as the user tweaks a
// selector/options before ever clicking "Apply" — hashing eagerly on every
// preview would waste work for previews that are never applied, so the
// content hash is deferred to APPLY time, via this job, using a private
// COPY of the preview's already-computed result buffers (same "never
// transfer the live master buffer" convention as `previewRemoveComponents`'s
// own `.slice()` calls — see repair.ts). Any other future re-hash need
// (e.g. a debug/repro tool) can reach for this same job rather than growing
// another copy of `hashMeshContent`.
//
// Lives here (misc.ts), not jobs/repair.ts: it's a generic, domain-agnostic
// utility job, not specific to the repair jobs above — this is the "grab
// bag" this file already is for echoMesh/longTask/manifoldSmoke.
// ---------------------------------------------------------------------------

export interface HashMeshPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface HashMeshResult {
  /** Identical value/algorithm to `IntakeMeshResult.contentHash`
   * (jobs/intake.ts) — see `../hash.ts`'s `hashMeshContent` doc for the
   * exact byte layout. */
  contentHash: string;
}

export const hashMesh = async (payload: HashMeshPayload): Promise<HashMeshResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'hashMesh');
  const contentHash = await hashMeshContent(payload.positions, payload.indices);
  return { contentHash };
};
