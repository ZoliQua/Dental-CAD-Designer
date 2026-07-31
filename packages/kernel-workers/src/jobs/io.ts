// jobs/io.ts — file-bytes <-> mesh conversion jobs: parseMeshFile (bytes ->
// mesh, streaming) and weldMeshSoup (re-weld a soup read back from a
// persisted STL — the read half of Task 11's serialize/reload round trip;
// see jobs/misc.ts's serializeMeshStl for the write half and this file's
// "Why binary STL..."/"intake-skip" module docs below for why the two live
// in different domain files despite being a matched pair).
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move: no behavioral change.
//
// `.ts` extension (not this repo's usual `.js`): every file under jobs/ is
// loaded natively by Node inside worker_threads (via worker-entry.node.ts
// -> jobs/registry.ts -> here), which doesn't map `.js` specifiers to `.ts`
// files — see tsconfig.json's allowImportingTsExtensions comment and
// CLAUDE.md's "Import extension convention".
import {
  iterateInFixedChunks,
  IoStreamCancelledError,
  parsePlyStream,
  parseStlStream,
  type ParseFormat,
} from '@dqcad/io';
import {
  weldVertices,
  analyzeMesh,
  countsOf,
  makeStepReport,
  MESH_WELD_EPSILON_MM,
  type IntakeReport,
  type IntakeStepCounts,
  type MeshStats,
} from '@dqcad/kernel';
import { sha256Hex } from '../hash.ts';
import { JobCancelledError, type JobContext } from './context.ts';

/**
 * `parseMeshFile`: parses an STL or PLY file's raw bytes off the UI thread,
 * via packages/io's CHUNKED streaming parsers (`parseStlStream`/
 * `parsePlyStream`) rather than their whole-buffer `parseStl`/`parsePly`
 * entry points — so this job actually exercises the streaming, O(chunk)-
 * scanning-memory core (Task 3's chunked-parsing requirement), not just
 * "the parser, running in a worker".
 *
 * The payload still arrives as ONE transferable `Uint8Array` (matching
 * this file's existing `echoMesh`/`meshBuffers` convention, and how a
 * caller that already read a whole file into memory — e.g. via a
 * browser `File.arrayBuffer()`, or this package's own perf test reading a
 * fixture off disk — naturally has the bytes) rather than the caller
 * itself producing a chunk-by-chunk stream across the Comlink boundary
 * (which would mean one Comlink round trip per chunk — far more
 * expensive than the single structured-clone-avoiding transfer this does
 * instead). Inside the worker, `chunkStream()` below RE-SLICES that single
 * buffer into `chunkBytes`-sized pieces and feeds THOSE to
 * `parseStlStream`/`parsePlyStream` as a real `AsyncIterable<Uint8Array>`
 * — so peak ADDITIONAL memory during parsing is still bounded to O(chunk),
 * and progress/cancellation are checked at real chunk boundaries, exactly
 * as they would be for a genuine multi-message stream. This is a
 * deliberate, documented transport-vs-parsing-memory distinction: the
 * payload transport is O(file) (one buffer in, one buffer out — the same
 * as every other job in this registry), but the PARSING itself never
 * holds more than one buffer's worth of scratch state beyond the input/
 * output buffers already present.
 *
 * ## fileHash (worker-side hashing — Phase 2 Task 1 debt fix)
 *
 * `payload.bytes` is hashed (SHA-256 hex, `../hash.ts`'s `sha256Hex`) as the
 * VERY FIRST thing this handler does, before `chunkStream`/parsing ever
 * touches it — `payload.bytes` is a plain, still-fully-intact `Uint8Array`
 * at that point (transferring a buffer INTO this worker doesn't detach it
 * FROM this worker; only the caller's copy was detached), so hashing here
 * sees the exact same raw file bytes the old main-thread
 * `apps/client/src/engine/hash.ts`'s `sha256Hex(rawBytes)` call used to hash
 * — same algorithm, same input bytes, same output value, just off the UI
 * thread. This was Phase 1's single biggest documented perf suspect (see
 * `e2e/perf.spec.ts`'s module doc and `docs/demos/phase-1.md`'s "Perf guard"
 * note): a whole-file `crypto.subtle` hash on the main thread, competing
 * with rAF for the UI thread's attention on a ~120 MB file.
 */
export interface ParseMeshFilePayload {
  format: 'stl' | 'ply';
  bytes: Uint8Array;
  /** Re-chunking size fed to the streaming core — defaults to 1 MiB (see
   * `DEFAULT_CHUNK_BYTES` below), matching stl/stream.ts's own internal
   * binary batch size. */
  chunkBytes?: number;
}

/** STL's `parseStlStream` always yields an unindexed triangle soup (see
 * packages/io's `RawTriangleSoup` doc) — `indices`/`vertexCount`/
 * `faceCount` have no meaning for this format, so this is a distinct
 * result shape from `PlyMeshResult` rather than a lossy shared one. */
export interface StlSoupResult {
  kind: 'stl-soup';
  /** SHA-256 hex of the RAW input file bytes (`payload.bytes`), computed
   * worker-side BEFORE parsing starts — see `parseMeshFile`'s doc's
   * "fileHash" section. Journaled as `Operation.inputHashes[0]` for the
   * `import-mesh` op (apps/client/src/engine/importer.ts). */
  fileHash: string;
  positions: Float64Array;
  normals: Float64Array | null;
  triangleCount: number;
  format: ParseFormat;
  warnings: readonly string[];
}

/** PLY's `parsePlyStream` always yields an indexed mesh (see packages/io's
 * `PlyMesh` doc) — `indices` is always present (possibly empty, for a
 * point-cloud PLY with no face element). */
export interface PlyMeshResult {
  kind: 'ply-mesh';
  /** SHA-256 hex of the RAW input file bytes — see `StlSoupResult.fileHash`'s
   * doc (identical contract, format-agnostic). */
  fileHash: string;
  positions: Float64Array;
  normals: Float64Array | null;
  colors: Float64Array | null;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
  format: ParseFormat;
  warnings: readonly string[];
}

export type ParseMeshFileResult = StlSoupResult | PlyMeshResult;

const DEFAULT_CHUNK_BYTES = 1 << 20; // 1 MiB — see ParseMeshFilePayload's doc.

/** How often (ms) the PLY parse path polls `ctx.cancelled()` to drive the
 * AbortSignal it threads into `parsePlyStream` — see the "signal threading"
 * note in `parseMeshFile`. Small enough to cancel a wedged/slow parse
 * promptly, large enough that the (possibly Comlink-proxied, async)
 * `ctx.cancelled()` call isn't hammered. */
const CANCEL_POLL_INTERVAL_MS = 25;

/** Re-slices `bytes` into `chunkBytes`-sized `AsyncIterable<Uint8Array>`
 * chunks (zero-copy `subarray` views — see packages/io's
 * `iterateInFixedChunks`), checking `ctx.cancelled()` once per chunk (this
 * job's "between chunks" cancellation granularity). On cancellation this
 * THROWS `JobCancelledError` (rather than merely ending the iteration) —
 * `parseStlStream`/`parsePlyStream` (packages/io) just `await` on pulling
 * their next chunk internally, so a rejection here propagates straight out
 * as the streaming call's own rejection, WITH THE RIGHT ERROR TYPE already
 * (`JobCancelledError`, recognized by name in pool.ts's
 * `isJobCancelledError`) — deliberately not routed through packages/io's
 * own `AbortSignal`/`IoStreamCancelledError` mechanism, which exists for io
 * callers that have no kernel-workers `JobCancelledError` to reach for (io
 * has no dependency on kernel-workers — see the layer rule in CLAUDE.md).
 */
async function* chunkStream(
  bytes: Uint8Array,
  chunkBytes: number,
  ctx: JobContext,
): AsyncGenerator<Uint8Array, void, void> {
  for await (const chunk of iterateInFixedChunks(bytes, Math.max(1, chunkBytes))) {
    if (await ctx.cancelled()) {
      throw new JobCancelledError();
    }
    yield chunk;
  }
}

export const parseMeshFile = async (
  payload: ParseMeshFilePayload,
  ctx: JobContext,
): Promise<ParseMeshFileResult> => {
  if (!(payload.bytes instanceof Uint8Array)) {
    throw new TypeError('parseMeshFile: bytes must be a Uint8Array');
  }
  // See this job's "fileHash" doc above: hashed FIRST, before any chunking/
  // parsing touches `payload.bytes`.
  const fileHash = await sha256Hex(payload.bytes);
  const chunkBytes = payload.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const chunks = chunkStream(payload.bytes, chunkBytes, ctx);

  if (payload.format === 'stl') {
    const { soup, diagnostics } = await parseStlStream(chunks, payload.bytes.byteLength, {
      onProgress: ctx.progress,
    });
    const result: StlSoupResult = {
      kind: 'stl-soup',
      fileHash,
      positions: soup.positions,
      normals: soup.normals,
      triangleCount: soup.triangleCount,
      format: diagnostics.format,
      warnings: diagnostics.warnings,
    };
    return result;
  }

  // Signal threading (parser-DoS defense-in-depth): pass parsePlyStream an
  // AbortSignal so a slow OR wedged PLY parse stays cancellable on a bounded,
  // per-row cadence — NOT only when `chunkStream` is next pulled. Once the
  // re-sliced source drains, `chunkStream` is never pulled again, so its
  // per-chunk `ctx.cancelled()` check can't fire; stream.ts's per-row
  // `checkCancelled(signal)` can, but only if a signal is actually threaded
  // in (it previously was not). `ctx.cancelled()` is the (possibly async,
  // Comlink-proxied) cancellation flag, so it's polled on a bounded interval
  // to drive the signal. io reports an aborted stream as `IoStreamCancelledError`
  // (it has no dependency on kernel-workers — see chunkStream's doc); it's
  // translated back to `JobCancelledError`, the type pool.ts recognizes, so
  // both cancellation routes (chunkStream-throw and signal-abort) surface
  // identically to the caller.
  const abort = new AbortController();
  const cancelPoll = setInterval(() => {
    void Promise.resolve(ctx.cancelled()).then((isCancelled) => {
      if (isCancelled) {
        abort.abort();
      }
    });
  }, CANCEL_POLL_INTERVAL_MS);
  let mesh;
  try {
    mesh = await parsePlyStream(chunks, {
      totalBytes: payload.bytes.byteLength,
      onProgress: ctx.progress,
      signal: abort.signal,
    });
  } catch (error) {
    if (error instanceof IoStreamCancelledError) {
      throw new JobCancelledError();
    }
    throw error;
  } finally {
    clearInterval(cancelPoll);
  }
  const result: PlyMeshResult = {
    kind: 'ply-mesh',
    fileHash,
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    faceCount: mesh.faceCount,
    format: mesh.diagnostics.format,
    warnings: mesh.diagnostics.warnings,
  };
  return result;
};

// ---------------------------------------------------------------------------
// weldMeshSoup (Task 11: scene persistence — the READ half of the
// serialize/reload round trip; see jobs/misc.ts's serializeMeshStl for the
// WRITE half, which shares this section's "Why binary STL..." rationale).
//
// apps/client/src/engine cannot import `@dqcad/io` directly (layer rule:
// engine -> kernel-workers|state|shared-types only), so both halves of the
// "store a mesh as binary STL" round trip have to happen in a worker job —
// see docs/plans/phase-1-import-viewer.md Task 11's brief: "solve via a
// kernel-workers job... so serialization happens in the worker".
//
// ## Why binary STL for storage, and why that means a lossy round trip
//
// The case document stores each MeshAsset's geometry SEPARATELY from the
// document JSON (server: content-addressed files under
// apps/server/data/meshes/<hash>; client: engine/meshStore.ts, keyed by
// MeshAsset.contentHash) — jobs/misc.ts's `serializeMeshStl` is what turns
// an already intake'd (welded, degenerate-dropped, oriented) `IndexedMesh`
// back into a binary STL BYTE STREAM for that storage, and `weldMeshSoup`
// below is what turns bytes read back (via `parseMeshFile`, format 'stl')
// back into an `IndexedMesh` for `MeshStore.register`.
//
// Binary STL has no concept of shared/indexed vertices — writing ALWAYS
// expands the indexed mesh into an unindexed triangle soup (one vertex
// triple per triangle corner), and `writeStlBinary` (packages/io) narrows
// every coordinate to float32 (that package's own documented, inherent
// lossy boundary of the file format — see stl/binary.ts's `writeStlBinary`
// doc). This means re-parsing a saved mesh's STL bytes and re-welding it
// (see `weldMeshSoup` below) reproduces the SAME topology/shape (well within
// the 1 µm display-resolution budget — float32 relative precision at
// case-scale mm coordinates is on the order of 1e-5 mm) but NOT bit-identical
// Float64 values, and therefore NOT the same `hashMeshContent` result the
// client computed at import time. `MeshAsset.contentHash` (shared-types)
// deliberately stays the ORIGINAL, in-session hash — engine/persistence.ts's
// load path passes that stored `contentHash` straight into
// `MeshStore.register()` rather than recomputing it from the reloaded
// (quantized) buffers, so a case's SceneNode.meshId / MeshAsset.contentHash
// linkage never has to survive the STL round trip byte-for-byte. See
// `MeshAsset.fileHash`'s doc (shared-types) for the separate hash that DOES
// key the server's content-addressed file store.
//
// ## Why `weldMeshSoup` is NOT `intakeMesh` again ("intake-skip")
//
// A loaded mesh's geometry has ALREADY been through the full intake
// pipeline once, at original import time (weld -> dropDegenerateTriangles ->
// orientNormalsConsistently -> analyze) — that work, and its `IntakeReport`,
// is already durably recorded in the case's `history` journal (the
// `import-mesh`/`unit-rescale` Operations importer.ts appended then). Running
// dropDegenerateTriangles/orientNormalsConsistently a SECOND time on load
// would (by the Global Constraints' determinism guarantee) be a structural
// no-op on an already-clean, already-oriented mesh — but it would still cost
// real CPU on every load, and treating a load as a second "intake" would
// misleadingly suggest a NEW journal-worthy event happened, when nothing did.
// `weldMeshSoup` therefore reconstructs ONLY the piece binary STL actually
// threw away — the shared-vertex indexing — via `weldVertices` alone, and
// returns a single-step `IntakeReport` (`step: 'weld'`) purely so its result
// shape satisfies `EngineMeshRecord.report`'s type without fabricating
// degenerate/orient step data that never ran.
// ---------------------------------------------------------------------------

export interface WeldMeshSoupPayload {
  /** Float64, 9-values-per-triangle unindexed soup — e.g. `parseMeshFile`'s
   * `StlSoupResult.positions` after reading a persisted mesh back. */
  positions: Float64Array;
}

/** Same shape as jobs/intake.ts's `IntakeMeshResult` MINUS `contentHash` —
 * see this section's module doc for why this is a distinct job rather than
 * a call to `intakeMesh` ("intake-skip"). Deliberately NOT aliased to
 * `IntakeMeshResult` (as it was before Phase 2 Task 1 added
 * `IntakeMeshResult.contentHash`): a re-weld from a float32-narrowed STL
 * round trip is NOT bit-identical to the original mesh (see this section's
 * module doc's "Why binary STL... lossy round trip"), so hashing IT would
 * produce a value distinct from — and never used in place of — the
 * document's original `MeshAsset.contentHash` (persistence.ts's `openCase`
 * always passes the STORED `contentHash` to `MeshStore.register`, never a
 * freshly recomputed one — see that function's doc). Computing an unused
 * hash here would be pure waste, and returning one that looks like a
 * content hash but isn't THE content hash invites exactly the kind of bug
 * this comment is meant to prevent. */
export interface WeldMeshSoupResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
}

export const weldMeshSoup = async (
  payload: WeldMeshSoupPayload,
  ctx: JobContext,
): Promise<WeldMeshSoupResult> => {
  if (!(payload.positions instanceof Float64Array)) {
    throw new TypeError('weldMeshSoup: positions must be a Float64Array (kernel Float64 rule)');
  }
  if (payload.positions.length % 9 !== 0) {
    throw new TypeError('weldMeshSoup: positions length must be a multiple of 9 (9 values per triangle)');
  }
  if (await ctx.cancelled()) {
    throw new JobCancelledError();
  }
  ctx.progress(0);
  const triangleCount = payload.positions.length / 9;
  const before: IntakeStepCounts = { vertexCount: triangleCount * 3, triangleCount };
  const mesh = weldVertices({ positions: payload.positions, normals: null, triangleCount });
  const stats = analyzeMesh(mesh);
  const report: IntakeReport = {
    weldEpsilonMm: MESH_WELD_EPSILON_MM,
    steps: [makeStepReport('weld', before, countsOf(mesh), {})],
  };
  ctx.progress(1);
  return { positions: mesh.positions, indices: mesh.indices, stats, report };
};
