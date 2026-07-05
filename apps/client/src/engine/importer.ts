// apps/client/src/engine/importer.ts
//
// Orchestrates one imported file end to end:
//
//   byte source (chunked read) -> parseMeshFile (worker) -> unit heuristic
//   -> [ALWAYS a confirmation dialog if the heuristic suspects mm was
//        wrong] -> [rescaleMesh (worker), journaled 'unit-rescale'] ->
//   intakeMesh (worker) -> MeshStore.register -> CaseStore.registerImportedMesh
//   (journals 'import-mesh')
//
// Progress and status for each file are published into
// state/importStore.ts as the pipeline advances (mirrors engine/workers.ts's
// direct-write-into-a-zustand-store pattern) — this module never returns
// progress via a callback prop; ui/ reads state/importStore.ts instead.
//
// ## Byte source injection (File.stream() vs. tests)
//
// `ImportSource.bytes` is a `ByteChunkSource` — `{ totalBytes, chunks() }` —
// rather than a raw `File`, specifically so this module has no hard
// dependency on the DOM `File`/`ReadableStream` APIs at its core: `fromFile`
// below is a thin adapter for real browser usage (reads via
// `file.stream()`, chunk-by-chunk, so the UI thread yields between reads
// rather than blocking on a single `file.arrayBuffer()`), while
// importer.test.ts feeds a synthetic `ByteChunkSource` built directly from
// an array of `Uint8Array` chunks — no DOM, runs under Vitest's `node`
// environment via the real (Node worker_threads) WorkerPool.
import {
  JobCancelledError,
  KERNEL_VERSION,
  type IntakeMeshPayload,
  type ParseMeshFileResult,
} from '@dqcad/kernel-workers';
import type { MeshRole, Operation } from '@dqcad/shared-types';
import { useImportStore, type ImportPhase, type PendingUnitConfirmation } from '../state/importStore';
import { caseStore } from './caseStore';
import { hashMeshContent, sha256Hex } from './hash';
import { computeBboxMm, suggestUnitRescale } from './units';
import { getPool } from './workers';

export type MeshFormat = 'stl' | 'ply';

export interface ByteChunkSource {
  /** Best-known total size, used only to size the initial read buffer and
   * to compute read progress — `readAllBytes` below tolerates this being
   * wrong (it grows the buffer if actual bytes exceed it). */
  totalBytes: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface ImportSource {
  /** Caller-assigned unique id — the key used in state/importStore.ts and
   * for cancellation/unit-confirmation routing. */
  id: string;
  /** Raw source name (e.g. `File.name`) — sanitized to a basename before
   * ever being displayed or journaled; see `sanitizeBasename`. */
  name: string;
  format: MeshFormat;
  bytes: ByteChunkSource;
}

/** Strips any path components, keeping only the final segment — the journal
 * `Operation`'s `params.fileName` (and the UI's display name) must never
 * carry a full path (docs/plans/phase-1-import-viewer.md Task 5 §5:
 * "source filename SANITIZED — basename only"). Browser `File.name` is
 * already a basename in every modern browser, but this is defensive against
 * any caller (tests, a future drag-and-drop source that surfaces a relative
 * path) that isn't. */
export function sanitizeBasename(rawName: string): string {
  const segments = rawName.split(/[\\/]/).filter((segment) => segment.length > 0);
  const base = segments[segments.length - 1];
  return base && base.length > 0 ? base : 'unnamed';
}

function detectFormatFromName(name: string): MeshFormat {
  return name.toLowerCase().endsWith('.ply') ? 'ply' : 'stl';
}

/** Adapts a browser `ReadableStream<Uint8Array>` (as returned by
 * `File.stream()`) into a plain `AsyncIterable<Uint8Array>` via manual
 * `getReader()` pumping — `ReadableStream` is not directly async-iterable
 * in every browser/TS lib target this project supports. */
async function* streamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Builds an `ImportSource` from a real browser `File` — reads via
 * `file.stream()` (chunked), never `file.arrayBuffer()` (which would pull
 * the entire file into memory in one go with no yield points). */
export function fromFile(file: File, id: string = crypto.randomUUID()): ImportSource {
  return {
    id,
    name: file.name,
    format: detectFormatFromName(file.name),
    bytes: {
      totalBytes: file.size,
      chunks: () => streamToAsyncIterable(file.stream()),
    },
  };
}

/**
 * Reads every chunk of `source` into one contiguous `Uint8Array` (required —
 * `parseMeshFile`'s payload is a single transferable buffer, see
 * kernel-workers/src/jobs.ts's module doc for why). Grows the buffer if
 * actual bytes exceed `source.totalBytes` (a hint, not a hard guarantee for
 * injected test sources); reports fractional progress as bytes accumulate.
 */
async function readAllBytes(
  source: ByteChunkSource,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let buffer = new Uint8Array(Math.max(0, source.totalBytes));
  let offset = 0;
  const ensureCapacity = (minLength: number): void => {
    if (minLength <= buffer.length) return;
    const grown = new Uint8Array(Math.max(buffer.length * 2, minLength, 1024));
    grown.set(buffer.subarray(0, offset));
    buffer = grown;
  };
  for await (const chunk of source.chunks()) {
    if (signal.aborted) {
      throw new JobCancelledError('import cancelled while reading file bytes');
    }
    ensureCapacity(offset + chunk.length);
    buffer.set(chunk, offset);
    offset += chunk.length;
    const denominator = Math.max(source.totalBytes, offset, 1);
    onProgress(Math.min(1, offset / denominator));
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

export type UnitConfirmationChoice = 'keep-mm' | 'apply-factor';

const activeControllers = new Map<string, AbortController>();

/**
 * Sequential confirmation queue: state/importStore.ts's
 * `pendingUnitConfirmation` holds AT MOST one request at a time (it's a
 * single dialog, not a list). If a second file needs confirmation while one
 * is already pending, this promise chain makes it simply wait its turn
 * rather than clobbering the first file's pending request.
 */
let confirmationQueue: Promise<void> = Promise.resolve();

function requestUnitConfirmation(request: PendingUnitConfirmation): Promise<UnitConfirmationChoice> {
  const resultPromise = new Promise<UnitConfirmationChoice>((resolve) => {
    const runWhenTurnArrives = confirmationQueue.then(
      () =>
        new Promise<void>((releaseTurn) => {
          pendingResolvers.set(request.fileId, (choice) => {
            releaseTurn();
            resolve(choice);
          });
          useImportStore.getState().setPendingUnitConfirmation(request);
        }),
    );
    confirmationQueue = runWhenTurnArrives;
  });
  return resultPromise;
}

const pendingResolvers = new Map<string, (choice: UnitConfirmationChoice) => void>();

/** UI calls this (never importer.ts itself) when the user picks an option in
 * the unit-confirmation dialog — there is deliberately no timeout or
 * default: CLAUDE.md invariant 5, "No silent data mutation... explicit user
 * confirmation". */
export function resolveUnitConfirmation(fileId: string, choice: UnitConfirmationChoice): void {
  const resolve = pendingResolvers.get(fileId);
  if (!resolve) return;
  pendingResolvers.delete(fileId);
  useImportStore.getState().setPendingUnitConfirmation(null);
  resolve(choice);
}

/** UI calls this from a per-file cancel button. Aborts whichever
 * worker job (or byte-read loop) is currently in flight for `fileId`; a
 * no-op if the file already reached a terminal phase. */
export function cancelImport(fileId: string): void {
  activeControllers.get(fileId)?.abort();
}

function isJobCancelledError(error: unknown): boolean {
  return error instanceof JobCancelledError || (error instanceof Error && error.name === 'JobCancelledError');
}

function setPhase(id: string, phase: ImportPhase, progress = 0): void {
  useImportStore.getState().updateFile(id, { phase, progress });
}

export type ImportOutcome =
  | { status: 'done'; contentHash: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Runs the full import pipeline for one file (see module doc). Never
 * throws — cancellation and failures both resolve to a discriminated
 * `ImportOutcome`, with state/importStore.ts updated to match either way.
 */
export async function importMeshFile(input: ImportSource): Promise<ImportOutcome> {
  const displayName = sanitizeBasename(input.name);
  const controller = new AbortController();
  activeControllers.set(input.id, controller);
  useImportStore.getState().upsertFile({
    id: input.id,
    name: displayName,
    phase: 'reading',
    progress: 0,
    error: null,
    meshContentHash: null,
  });

  try {
    const rawBytes = await readAllBytes(
      input.bytes,
      (fraction) => setPhase(input.id, 'reading', fraction),
      controller.signal,
    );
    const fileHash = await sha256Hex(rawBytes);

    setPhase(input.id, 'parsing', 0);
    const parsed: ParseMeshFileResult = await getPool().run(
      'parseMeshFile',
      { format: input.format, bytes: rawBytes },
      {
        transfer: [rawBytes.buffer],
        signal: controller.signal,
        onProgress: (fraction) => setPhase(input.id, 'parsing', fraction),
      },
    );

    let positions = parsed.positions;
    const indices = parsed.kind === 'ply-mesh' ? parsed.indices : undefined;

    const operations: Operation[] = [];
    const suggestion = suggestUnitRescale(computeBboxMm(positions));
    if (suggestion) {
      setPhase(input.id, 'awaiting-unit-confirmation', 0);
      const choice = await requestUnitConfirmation({
        fileId: input.id,
        fileName: displayName,
        maxExtentMm: suggestion.maxExtentMm,
        suspectedUnit: suggestion.suspectedUnit,
        suggestedFactor: suggestion.factor,
      });
      if (controller.signal.aborted) {
        throw new JobCancelledError('import cancelled while awaiting unit confirmation');
      }
      if (choice === 'apply-factor') {
        setPhase(input.id, 'rescaling', 0);
        const beforeHash = await hashPositionsOnly(positions);
        const rescaled = await getPool().run(
          'rescaleMesh',
          { positions, factor: suggestion.factor },
          {
            transfer: [positions.buffer],
            signal: controller.signal,
            onProgress: (fraction) => setPhase(input.id, 'rescaling', fraction),
          },
        );
        positions = rescaled.positions;
        const afterHash = await hashPositionsOnly(positions);
        operations.push({
          id: crypto.randomUUID(),
          name: 'unit-rescale',
          params: {
            fileName: displayName,
            factor: suggestion.factor,
            suspectedUnit: suggestion.suspectedUnit,
          },
          inputHashes: [beforeHash],
          outputHashes: [afterHash],
          kernelVersion: KERNEL_VERSION,
          timestamp: new Date().toISOString(),
        });
      }
      // 'keep-mm' — proceed with the original (unscaled) positions; no
      // Operation is journaled, since nothing was mutated.
    }

    setPhase(input.id, 'intake', 0);
    const intakePayload: IntakeMeshPayload = indices
      ? { kind: 'indexed', positions, indices }
      : { kind: 'soup', positions };
    const transferList: Transferable[] = [positions.buffer];
    if (indices) transferList.push(indices.buffer);
    const intakeResult = await getPool().run('intakeMesh', intakePayload, {
      transfer: transferList,
      signal: controller.signal,
      onProgress: (fraction) => setPhase(input.id, 'intake', fraction),
    });

    setPhase(input.id, 'registering', 0);
    const contentHash = await hashMeshContent(intakeResult.positions, intakeResult.indices);
    operations.push({
      id: crypto.randomUUID(),
      name: 'import-mesh',
      params: {
        fileName: displayName,
        format: input.format,
        triangleCount: intakeResult.indices.length / 3,
        vertexCount: intakeResult.positions.length / 3,
        contentHash,
      },
      inputHashes: [fileHash],
      outputHashes: [contentHash],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date().toISOString(),
    });

    caseStore.registerImportedMesh({
      contentHash,
      name: displayName,
      format: input.format,
      positions: intakeResult.positions,
      indices: intakeResult.indices,
      stats: intakeResult.stats,
      report: intakeResult.report,
      operations,
    });

    useImportStore.getState().updateFile(input.id, {
      phase: 'done',
      progress: 1,
      meshContentHash: contentHash,
    });
    return { status: 'done', contentHash };
  } catch (error) {
    if (isJobCancelledError(error)) {
      useImportStore.getState().updateFile(input.id, { phase: 'cancelled', progress: 0 });
      return { status: 'cancelled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    useImportStore.getState().updateFile(input.id, { phase: 'error', progress: 0, error: message });
    return { status: 'error', message };
  } finally {
    activeControllers.delete(input.id);
    pendingResolvers.delete(input.id);
  }
}

async function hashPositionsOnly(positions: Float64Array): Promise<string> {
  return sha256Hex(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
}

/** Fire-and-forget entry point for ui/: kicks off every source's pipeline
 * concurrently (each `importMeshFile` call manages its own state/
 * importStore.ts entry independently) and never rejects — failures surface
 * only via each file's own `phase: 'error'` state. */
export function importMeshFiles(sources: readonly ImportSource[]): void {
  for (const source of sources) {
    void importMeshFile(source);
  }
}

/** Convenience for ui/'s file-picker/drop-overlay handlers: builds one
 * `ImportSource` per accepted `File` and starts importing all of them. */
export function importFiles(files: readonly File[]): void {
  importMeshFiles(files.map((file) => fromFile(file)));
}

/** UI action for the role-assignment dropdown: places an already-imported
 * (registered) mesh into the scene under `role`. */
export function addMeshToScene(meshContentHash: string, role: MeshRole): void {
  caseStore.addSceneNode(meshContentHash, role);
}
