// jobs/export.ts — Phase 7 Task 3: `exportRestorationMesh`, the worker-side
// manufacturing serialization of a FINAL restoration solid (the
// `Restoration.stages.finalMesh` geometry all three workflows produce) to
// binary STL or binary-LE PLY bytes, plus the SHA-256 of those exact bytes.
//
// Runs IN THE WORKER (never on the UI thread — serializing + hashing a
// multi-MB solid main-thread would blow the 50 ms budget) and composes the
// Task 2 io export layer UNCHANGED: `exportStlBinary`/`exportPlyBinary`
// carry the full validation duty (watertight + 2-manifold + consistent
// winding + outward orientation + single component, typed
// `ExportMeshInvalidError` rejects — reject, never repair) and the byte
// determinism contract (same mesh + same options ⇒ bit-identical bytes, no
// timestamps/environment anywhere). This job adds ONLY: payload validation,
// cancellation, and the worker-side byte hash (`../hash.ts`'s `sha256Hex` —
// the established hash-job machinery) that becomes the export
// `Operation.outputHashes[0]`.
//
// Determinism/replay contract (CLAUDE.md invariant 2/3): the result is a
// pure function of (positions, indices, format, headerText). `headerText`
// MUST be derived from journaled params only (the caller journals the exact
// string on the export op — apps/client/src/engine/exportFlow.ts), so
// replaying the op reproduces the exact bytes; the io layer enforces the
// mechanical bounds (≤ 80 bytes, no 'solid' prefix — Task 2's
// `assertExportableStlHeaderText`).
//
// `.ts` extension imports: this file is in the Node worker entry's import
// closure (worker-entry.node.ts → jobs/registry.ts → here) — see CLAUDE.md's
// "Import extension convention". No TS constructor parameter properties
// (P5-T1) — no classes here at all.
import { exportPlyBinary, exportStlBinary } from '@dqcad/io';
import { bytesToBase64 } from '../base64.ts';
import { sha256Hex } from '../hash.ts';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

export interface ExportRestorationMeshPayload {
  /** Float64 master buffers of the final restoration solid (kernel Float64
   * rule). Callers pass PRIVATE copies in the transfer list (`.slice()`),
   * never a session's live master buffer — same convention as
   * `SerializeMeshStlPayload`. */
  positions: Float64Array;
  indices: Uint32Array;
  /** Manufacturing format — 'stl' (binary, f32-narrowed per the documented
   * format floor) or 'ply' (binary LE, lossless f64). A journaled param. */
  format: 'stl' | 'ply';
  /** STL only — replaces the default deterministic header text. MUST come
   * from journaled params only (see this module's doc). REJECTED when
   * passed with `format: 'ply'`: silently ignoring a caller-supplied header
   * would be exactly the silent no-op class the 19b lesson forbids. */
  headerText?: string;
}

export interface ExportRestorationMeshResult {
  /** The exact file bytes to hand to the mill / Task 4 server re-validation. */
  bytes: Uint8Array;
  /** SHA-256 (lowercase hex) of `bytes`, computed worker-side over the
   * exact serialized output — the export `Operation.outputHashes[0]` and
   * `RestorationExportRequest.bytesSha256`. */
  bytesSha256: string;
  /** RFC 4648 base64 of `bytes`, encoded WORKER-SIDE (a main-thread encode
   * of a multi-MB export measured ~130 ms — over the 50 ms UI budget; P7-T3
   * review F3) — consumed verbatim as
   * `RestorationExportRequest.bytesBase64`. */
  bytesBase64: string;
  /** `bytes.byteLength` — returned explicitly so the caller journals the
   * value the hash was computed over, not a later re-measure. */
  byteLength: number;
  triangleCount: number;
}

export const exportRestorationMesh = async (
  payload: ExportRestorationMeshPayload,
  ctx: JobContext,
): Promise<ExportRestorationMeshResult> => {
  requireMeshPayload(payload.positions, payload.indices, 'exportRestorationMesh');
  if (payload.format !== 'stl' && payload.format !== 'ply') {
    throw new TypeError(
      `exportRestorationMesh: format must be 'stl' or 'ply', got ${JSON.stringify(payload.format)}`,
    );
  }
  if (payload.format === 'ply' && payload.headerText !== undefined) {
    throw new TypeError(
      'exportRestorationMesh: headerText is an STL-only option — passing it with format \'ply\' ' +
        'would be silently ignored, which this job refuses to do',
    );
  }
  if (await ctx.cancelled()) {
    throw new JobCancelledError();
  }
  ctx.progress(0);
  const mesh = { positions: payload.positions, indices: payload.indices };
  const bytes =
    payload.format === 'stl'
      ? exportStlBinary(mesh, payload.headerText === undefined ? {} : { headerText: payload.headerText })
      : exportPlyBinary(mesh);
  const bytesSha256 = await sha256Hex(bytes);
  const bytesBase64 = bytesToBase64(bytes);
  ctx.progress(1);
  return {
    bytes,
    bytesSha256,
    bytesBase64,
    byteLength: bytes.byteLength,
    triangleCount: payload.indices.length / 3,
  };
};
