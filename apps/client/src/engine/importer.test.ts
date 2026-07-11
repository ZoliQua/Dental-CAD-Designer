// engine/importer.ts tests — run through the REAL WorkerPool (Node
// worker_threads path, same as packages/kernel-workers' own job tests),
// exercising parseMeshFile -> [unit confirmation] -> [rescaleMesh] ->
// intakeMesh -> caseStore registration end to end.
//
// Binary STL bytes are built BY HAND here (DataView, following the format
// spec documented in packages/io/src/stl/binary.ts's module doc) rather
// than imported from @dqcad/io's writer helpers — apps/client/src/engine/**
// is not allowed to depend on packages/io directly (eslint boundaries
// policy: engine -> kernel-workers|state|shared-types only); packages/io's
// own parser correctness is already covered by its own package's tests and
// by kernel-workers' parseMeshFile.test.ts. This file's job is to exercise
// THIS module's orchestration (progress publishing, the unit-confirmation
// gate, journal Operations, caseStore/meshStore wiring) — a hand-rolled
// binary STL is a perfectly valid input for that.
import { beforeEach, describe, expect, it } from 'vitest';
import { useCaseStore } from '../state/caseStore';
import { useImportStore } from '../state/importStore';
import { caseStore } from './caseStore';
import {
  cancelImport,
  importMeshFile,
  resolveUnitConfirmation,
  sanitizeBasename,
  type ByteChunkSource,
  type ImportSource,
} from './importer';

const STL_HEADER_BYTES = 80;
const STL_RECORD_BYTES = 50;

interface Triangle {
  normal: readonly [number, number, number];
  vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

/** Hand-rolled binary STL writer — see this file's module doc. Detection in
 * packages/io (see binary.ts's module doc) is purely byte-length-consistency
 * based (`84 + triangleCount * 50`), so the 80-byte header's actual content
 * is irrelevant and left zeroed. */
function buildBinaryStlBytes(triangles: readonly Triangle[]): Uint8Array {
  const buffer = new ArrayBuffer(STL_HEADER_BYTES + 4 + triangles.length * STL_RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint32(STL_HEADER_BYTES, triangles.length, true);
  let offset = STL_HEADER_BYTES + 4;
  for (const triangle of triangles) {
    for (const component of triangle.normal) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
    for (const vertex of triangle.vertices) {
      for (const component of vertex) {
        view.setFloat32(offset, component, true);
        offset += 4;
      }
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** Two disjoint triangles (not watertight — that's fine, importer.ts never
 * requires watertightness) spanning the given max extent along X, scaled
 * down proportionally on Y/Z, so `bboxMaxExtentMm` is exactly `extentMm`. */
function twoTriangleStlBytes(extentMm: number): Uint8Array {
  const y = extentMm * 0.5;
  const z = extentMm * 0.2;
  return buildBinaryStlBytes([
    { normal: [0, 0, 1], vertices: [[0, 0, 0], [extentMm, 0, 0], [0, y, 0]] },
    { normal: [0, 0, 1], vertices: [[extentMm, 0, 0], [extentMm, y, z], [0, y, 0]] },
  ]);
}

/** Splits `bytes` into `chunkSize`-byte pieces (deliberately NOT aligned to
 * any STL record boundary) — proves the "chunked File.stream() reader" byte
 * source is genuinely reassembled correctly regardless of where chunk
 * boundaries fall, not just handed a single whole-file chunk. */
function chunkedSource(bytes: Uint8Array, chunkSize: number): ByteChunkSource {
  return {
    totalBytes: bytes.length,
    chunks: async function* () {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
      }
    },
  };
}

function stlSource(id: string, name: string, bytes: Uint8Array, chunkSize = 37): ImportSource {
  return { id, name, format: 'stl', bytes: chunkedSource(bytes, chunkSize) };
}

beforeEach(() => {
  caseStore.resetForTests();
  useImportStore.setState({ files: {}, pendingUnitConfirmation: null });
});

describe('sanitizeBasename', () => {
  it('passes through a plain filename unchanged', () => {
    expect(sanitizeBasename('arch-case-01-upperjaw.stl')).toBe('arch-case-01-upperjaw.stl');
  });

  it('strips POSIX and Windows path components, keeping only the basename', () => {
    expect(sanitizeBasename('/Users/tech/scans/arch.stl')).toBe('arch.stl');
    expect(sanitizeBasename('C:\\scans\\arch.stl')).toBe('arch.stl');
  });
});

describe('importMeshFile — happy path (no unit suspicion)', () => {
  it('imports an arch-scale STL end to end and journals import-mesh', async () => {
    const bytes = twoTriangleStlBytes(60); // well within the 40-80mm arch band
    const outcome = await importMeshFile(stlSource('f1', 'arch.stl', bytes));

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') throw new Error('unreachable');

    const doc = useCaseStore.getState().document;
    expect(doc.meshes).toHaveLength(1);
    expect(doc.meshes[0]!.name).toBe('arch.stl');
    expect(doc.meshes[0]!.contentHash).toBe(outcome.contentHash);
    expect(doc.history.map((op) => op.name)).toEqual(['import-mesh']);
    expect(doc.history[0]!.params.fileName).toBe('arch.stl');
    expect(doc.history[0]!.params.format).toBe('stl');
    expect(doc.history[0]!.outputHashes).toEqual([outcome.contentHash]);

    const fileState = useImportStore.getState().files.f1!;
    expect(fileState.phase).toBe('done');
    expect(fileState.progress).toBe(1);
    expect(fileState.meshContentHash).toBe(outcome.contentHash);

    // No unit confirmation was ever shown.
    expect(useImportStore.getState().pendingUnitConfirmation).toBeNull();

    const record = caseStore.getMeshRecord(outcome.contentHash);
    expect(record).toBeDefined();
    expect(record?.positions).toBeInstanceOf(Float64Array);
    expect(record?.renderPositions).toBeInstanceOf(Float32Array);
  });

  it('publishes intermediate progress phases in order', async () => {
    const bytes = twoTriangleStlBytes(60);
    const phases: string[] = [];
    const unsubscribe = useImportStore.subscribe((state) => {
      const phase = state.files.f2?.phase;
      if (phase && phases[phases.length - 1] !== phase) phases.push(phase);
    });

    await importMeshFile(stlSource('f2', 'arch.stl', bytes));
    unsubscribe();

    expect(phases).toEqual(['reading', 'parsing', 'intake', 'registering', 'done']);
  });

  it('sanitizes a path-like source name before display and journaling', async () => {
    const bytes = twoTriangleStlBytes(60);
    const outcome = await importMeshFile(stlSource('f3', '/tmp/scans/arch.stl', bytes));
    expect(outcome.status).toBe('done');
    expect(useImportStore.getState().files.f3!.name).toBe('arch.stl');
    expect(useCaseStore.getState().document.history[0]!.params.fileName).toBe('arch.stl');
  });
});

describe('importMeshFile — unit-rescale confirmation', () => {
  it('suspends for confirmation, applies the suggested factor, and journals unit-rescale before import-mesh', async () => {
    const bytes = twoTriangleStlBytes(6); // < 8mm -> suspect cm
    const runPromise = importMeshFile(stlSource('f4', 'tiny.stl', bytes));

    await vi_waitFor(() => useImportStore.getState().pendingUnitConfirmation !== null);
    const pending = useImportStore.getState().pendingUnitConfirmation!;
    expect(pending.fileId).toBe('f4');
    expect(pending.suspectedUnit).toBe('cm');
    expect(pending.suggestedFactor).toBe(10);

    resolveUnitConfirmation('f4', 'apply-factor');
    const outcome = await runPromise;

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') throw new Error('unreachable');
    expect(useImportStore.getState().pendingUnitConfirmation).toBeNull();

    const doc = useCaseStore.getState().document;
    expect(doc.history.map((op) => op.name)).toEqual(['unit-rescale', 'import-mesh']);
    const rescaleOp = doc.history[0]!;
    expect(rescaleOp.params.factor).toBe(10);
    expect(rescaleOp.params.suspectedUnit).toBe('cm');
    expect(rescaleOp.inputHashes).not.toEqual(rescaleOp.outputHashes);

    // Registered mesh is scaled up by 10x — original extent 6mm -> ~60mm.
    const record = caseStore.getMeshRecord(outcome.contentHash)!;
    expect(record.stats.bbox.max[0] - record.stats.bbox.min[0]).toBeCloseTo(60, 0);
  });

  it('keeps mm (no rescale) when the user declines, and journals no unit-rescale op', async () => {
    const bytes = twoTriangleStlBytes(6);
    const runPromise = importMeshFile(stlSource('f5', 'tiny.stl', bytes));

    await vi_waitFor(() => useImportStore.getState().pendingUnitConfirmation !== null);
    resolveUnitConfirmation('f5', 'keep-mm');
    const outcome = await runPromise;

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') throw new Error('unreachable');
    const doc = useCaseStore.getState().document;
    expect(doc.history.map((op) => op.name)).toEqual(['import-mesh']);

    const record = caseStore.getMeshRecord(outcome.contentHash)!;
    expect(record.stats.bbox.max[0] - record.stats.bbox.min[0]).toBeCloseTo(6, 0);
  });
});

describe('importMeshFile — cancellation', () => {
  it('cancelling immediately (before any byte is read) resolves as cancelled', async () => {
    // The AbortController is registered synchronously before importMeshFile's
    // first `await` (see importer.ts), and reading from an async iterable
    // always suspends at its first `.next()` — so a synchronous abort()
    // called right after kicking off the promise, with no intervening
    // microtask, deterministically lands before the first chunk is
    // processed. No real work (worker jobs, journal entries) ever runs.
    const bytes = twoTriangleStlBytes(60);
    const source = stlSource('f6', 'arch.stl', bytes);
    const runPromise = importMeshFile(source);
    cancelImport('f6');
    const outcome = await runPromise;

    expect(outcome.status).toBe('cancelled');
    expect(useImportStore.getState().files.f6!.phase).toBe('cancelled');
    expect(useCaseStore.getState().document.history).toHaveLength(0);
  });

  it('cancelling while the unit-confirmation dialog is SHOWING clears it immediately and resolves as cancelled', async () => {
    const bytes = twoTriangleStlBytes(6); // triggers confirmation
    const runPromise = importMeshFile(stlSource('f7', 'tiny.stl', bytes));

    await vi_waitFor(() => useImportStore.getState().pendingUnitConfirmation !== null);
    cancelImport('f7');
    // The dialog is dismissed by the abort itself — no user answer needed.
    expect(useImportStore.getState().pendingUnitConfirmation).toBeNull();
    resolveUnitConfirmation('f7', 'apply-factor'); // stale answer after cancel — must be a no-op
    const outcome = await runPromise;

    expect(outcome.status).toBe('cancelled');
    expect(useImportStore.getState().files.f7!.phase).toBe('cancelled');
    expect(useCaseStore.getState().document.history).toHaveLength(0);
  });

  it('cancelling an import whose confirmation is QUEUED behind another dialog never shows its stale dialog', async () => {
    const bytesA = twoTriangleStlBytes(6);
    const bytesB = twoTriangleStlBytes(5);
    const runA = importMeshFile(stlSource('f8', 'tiny-a.stl', bytesA));
    await vi_waitFor(() => useImportStore.getState().pendingUnitConfirmation?.fileId === 'f8');
    // B reaches its own confirmation point while A's dialog is showing, so
    // B's request parks in the queue behind A's.
    const runB = importMeshFile(stlSource('f9', 'tiny-b.stl', bytesB));
    await vi_waitFor(() => useImportStore.getState().files.f9?.phase === 'awaiting-unit-confirmation');

    cancelImport('f9'); // cancel B while it is QUEUED (A's dialog still up)
    resolveUnitConfirmation('f8', 'keep-mm'); // now answer A

    const [outcomeA, outcomeB] = await Promise.all([runA, runB]);
    expect(outcomeA.status).toBe('done');
    expect(outcomeB.status).toBe('cancelled');
    // B's dialog must never have appeared: the only pending confirmation
    // ever observed was A's, and after A's answer nothing is pending.
    expect(useImportStore.getState().pendingUnitConfirmation).toBeNull();
    expect(useImportStore.getState().files.f9!.phase).toBe('cancelled');
    // Only A's import was journaled.
    expect(useCaseStore.getState().document.history.map((op) => op.name)).toEqual(['import-mesh']);
  });
});

/** Polls a condition with real timers (WorkerPool/Comlink use real
 * postMessage scheduling, so fake timers aren't usable here). */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('vi_waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
