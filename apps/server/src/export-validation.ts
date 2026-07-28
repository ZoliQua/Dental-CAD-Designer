// apps/server/src/export-validation.ts
//
// Phase 7 Task 4 — the pure validation core of `POST /api/restorations/:id/
// export` (export-route.ts): byte integrity, byte re-import, and journal
// verification, each rejecting with a TYPED `ExportRejectionError` (a closed
// code set + structured details) so every rejection is a schema'd error body
// (the 19b/no-silent-failure discipline server-side; see schemas.ts's
// `exportErrorSchema`).
//
// ## The verify-bytes-hash-FIRST contract (shared-types
// `RestorationExportRequest`, Task 3)
//
// `bytesSha256`/`byteLength` are verified against the DECODED bytes before
// anything else touches them (`decodeExportBytes` is the route's first step).
// Base64 decode is deterministic and lossless, so a mismatch is tampering or
// corruption, never transport noise.
//
// ## Re-import (what the mill would read)
//
// `reimportExportedBytes` parses the EXACT bytes with the Node io parsers and
// runs the kernel intake pipeline — the documented re-import path (Phase 7
// Task 2's equivalence: the STL re-import equals `narrow32(canon(M))`, the
// f32-narrowed canonical re-index of the source solid; the PLY re-import is
// exactly `M`). The T2 equivalence CONDITIONS are then ASSERTED server-side
// (never assumed) via intake's own step reports — a byte stream whose
// re-import needed any repair (degenerate drops, orientation flips, ambiguous
// components, multiple components) is NOT the clean output of the export
// writers and is rejected typed (`export-reimport-integrity`) instead of
// silently "fixed" (invariant 5: no silent data mutation — on the server
// either).
import { createHash } from 'node:crypto';
import { intake, type IndexedMesh, type IntakeReport } from '@dqcad/kernel';
import { parsePly, parseStl, IoParseError } from '@dqcad/io';
import type { CaseDocument, Operation, RestorationExportRequest } from '@dqcad/shared-types';

/** Closed rejection code set — the `error` field of every non-200 export
 * response (schemas.ts `exportErrorSchema`; the mismatch/gates 409s carry
 * additional fields, see export-route.ts). */
export type ExportRejectionCode =
  | 'export-bytes-integrity'
  | 'export-request-id-mismatch'
  | 'export-context-type-mismatch'
  | 'export-case-not-found'
  | 'export-journal-hash-mismatch'
  | 'export-journal-verification-failed'
  | 'export-kernel-version-mismatch'
  | 'export-unjournaled-acknowledgment'
  | 'export-acknowledgment-invalid'
  | 'export-bytes-parse-failed'
  | 'export-reimport-integrity'
  | 'export-qc-mismatch'
  | 'export-gates-failing'
  | 'export-not-found'
  | 'export-storage-integrity'
  | 'qc-invalid-input';

/**
 * A typed export rejection: `code` is the closed machine-readable identifier
 * (the response's `error` field), `httpStatus` the mapped status, `details`
 * the code-specific structured diagnostics. Thrown by the helpers below and
 * by export-route.ts; the route's catch turns it into the schema'd error
 * body — never a blanket 500.
 */
export class ExportRejectionError extends Error {
  readonly code: ExportRejectionCode;
  readonly httpStatus: 400 | 404 | 409 | 500;
  readonly details: Record<string, unknown>;

  constructor(
    code: ExportRejectionCode,
    httpStatus: 400 | 404 | 409 | 500,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExportRejectionError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** Lowercase-hex SHA-256 — same digest/encoding as mesh-storage.ts's
 * `sha256HexOf` and the client's worker-side `sha256Hex`. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decodes `bytesBase64` and verifies `bytesSha256` + `byteLength` against the
 * decoded bytes — the FIRST thing the export route does with the request (the
 * Task 3 contract). `Buffer.from(..., 'base64')` never throws (it skips
 * invalid characters), so a garbled payload surfaces as a hash/length
 * mismatch — still a loud typed rejection, never a silent accept.
 *
 * @throws {ExportRejectionError} `export-bytes-integrity` (400).
 */
export function decodeExportBytes(
  request: Pick<RestorationExportRequest, 'bytesBase64' | 'bytesSha256' | 'byteLength'>,
): Buffer {
  const bytes = Buffer.from(request.bytesBase64, 'base64');
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== request.bytesSha256 || bytes.byteLength !== request.byteLength) {
    throw new ExportRejectionError(
      'export-bytes-integrity',
      400,
      'the decoded export bytes do not match the declared bytesSha256/byteLength — ' +
        'the request is corrupt or tampered; nothing was validated or released',
      {
        declaredSha256: request.bytesSha256,
        actualSha256,
        declaredByteLength: request.byteLength,
        actualByteLength: bytes.byteLength,
      },
    );
  }
  return bytes;
}

export interface ReimportResult {
  /** The byte-derived restoration solid — the geometry a mill would read,
   * and the ONLY solid the server QC measures. */
  readonly mesh: IndexedMesh;
  /** io parser diagnostics (format + warnings). */
  readonly parseDiagnostics: { readonly format: string; readonly warnings: readonly string[] };
  /** The kernel intake step reports (journal-grade re-import evidence; rides
   * into the mismatch diagnostic bundle). */
  readonly intakeReport: IntakeReport;
}

/** The intake-step conditions a CLEAN export re-import must satisfy (the T2
 * equivalence conditions, asserted source-free): no degenerate/duplicate
 * triangle drops, no orientation flips, no ambiguous components, exactly one
 * edge-connected component (the export writers guarantee a single fused
 * solid). */
function assertCleanReimport(report: IntakeReport, format: 'stl' | 'ply'): void {
  const violations: Record<string, number> = {};
  for (const step of report.steps) {
    if (step.step === 'dropDegenerateTriangles') {
      if (step.details['degenerateCount'] !== 0) violations['degenerateCount'] = step.details['degenerateCount']!;
      if (step.details['duplicateIndexCount'] !== 0)
        violations['duplicateIndexCount'] = step.details['duplicateIndexCount']!;
    }
    if (step.step === 'orientNormalsConsistently') {
      if (step.details['flippedCount'] !== 0) violations['flippedCount'] = step.details['flippedCount']!;
      if (step.details['ambiguousComponentCount'] !== 0)
        violations['ambiguousComponentCount'] = step.details['ambiguousComponentCount']!;
      if (step.details['componentCount'] !== 1) violations['componentCount'] = step.details['componentCount']!;
    }
  }
  if (Object.keys(violations).length > 0) {
    throw new ExportRejectionError(
      'export-reimport-integrity',
      400,
      `re-importing the ${format.toUpperCase()} bytes required intake repairs, so they are NOT the clean ` +
        'output of the export writers (tampered/corrupted geometry) — refused rather than silently repaired',
      { violations, intakeSteps: report.steps },
    );
  }
}

/**
 * Parses the exact export bytes with the Node io parsers and runs the kernel
 * intake pipeline — the re-import that defines what geometry the server QC
 * measures. See this module's doc for the equivalence + cleanliness contract.
 *
 * @throws {ExportRejectionError} `export-bytes-parse-failed` (400) when the
 *   io parser rejects the bytes (truncation, malformed structure);
 *   `export-reimport-integrity` (400) when intake had to repair anything.
 */
export function reimportExportedBytes(bytes: Uint8Array, format: 'stl' | 'ply'): ReimportResult {
  try {
    if (format === 'stl') {
      const { soup, diagnostics } = parseStl(bytes);
      const result = intake({ kind: 'soup', soup });
      assertCleanReimport(result.report, format);
      return {
        mesh: result.mesh,
        parseDiagnostics: { format: diagnostics.format, warnings: diagnostics.warnings.map((w) => String(w)) },
        intakeReport: result.report,
      };
    }
    const ply = parsePly(bytes);
    const result = intake({ kind: 'indexed', mesh: { positions: ply.positions, indices: ply.indices } });
    assertCleanReimport(result.report, format);
    return {
      mesh: result.mesh,
      parseDiagnostics: {
        format: ply.diagnostics.format,
        warnings: ply.diagnostics.warnings.map((w) => String(w)),
      },
      intakeReport: result.report,
    };
  } catch (error) {
    if (error instanceof IoParseError) {
      throw new ExportRejectionError(
        'export-bytes-parse-failed',
        400,
        `the export bytes do not parse as ${format.toUpperCase()}: ${error.message}`,
        { errorName: error.name, format },
      );
    }
    throw error;
  }
}

/** An ack journal op for `restorationId`+`gate`: `*-qc-ack` name suffix +
 * matching restoration + the gate either as `acknowledgedGate` or in the
 * `acknowledgedGates` list. Mirrors the client's `isAckOpFor`
 * (apps/client/src/engine/exportWorkflow.ts) — kept in semantic lockstep; a
 * server-side copy is unavoidable (the server cannot import client engine
 * code) and any drift surfaces as a spurious 409 in the pass-proof tests. */
function isAckOpFor(operation: Operation, restorationId: string, gate: string): boolean {
  if (!operation.name.endsWith('-qc-ack')) return false;
  if (operation.params['restorationId'] !== restorationId) return false;
  if (operation.params['acknowledgedGate'] === gate) return true;
  const list = operation.params['acknowledgedGates'];
  return Array.isArray(list) && list.includes(gate);
}

function verificationFailure(reason: string, message: string, details: Record<string, unknown>): ExportRejectionError {
  return new ExportRejectionError('export-journal-verification-failed', 409, message, { reason, ...details });
}

/**
 * Verifies the request against the PERSISTED case document (the N5 sequencing
 * contract: the case — export op included — is saved before the export
 * request, so the SAVED journal is the authority):
 *
 *  1. `journalOperationCount` equals the saved history length (a truncated-
 *     journal mismatch is instantly visible as a count delta);
 *  2. the journaled `restoration-export` Operation exists and binds this
 *     exact request: `outputHashes[0] === bytesSha256`, `inputHashes[0] ===
 *     meshContentHash`, matching restoration id + format;
 *  3. the restoration exists, its `type` matches, and its persisted
 *     `stages.finalMesh` IS `meshContentHash` (the bytes serialize the
 *     persisted final design, not some other mesh);
 *  4. every acknowledgment ref resolves to a real `*-qc-ack` op for this
 *     restoration + gate. `operationId: null` → 409
 *     `export-unjournaled-acknowledgment` (the N4 BINDING contract:
 *     warn-and-accept is forbidden — an unjournaled acknowledgment is
 *     exactly the hand-edited-document bypass this check exists to expose);
 *     a ref that resolves to nothing/the wrong op → 409
 *     `export-acknowledgment-invalid` (the P6-T8 ack-tampering precedent).
 *
 * The journal HASH cross-check (`caseJournalHash` recomputed with the shared
 * `hashCaseJournal`) lives in the route (it is async); this function is the
 * synchronous remainder.
 *
 * @throws {ExportRejectionError} `export-journal-verification-failed` /
 *   `export-unjournaled-acknowledgment` / `export-acknowledgment-invalid`
 *   (all 409).
 */
export function verifyExportJournal(document: CaseDocument, request: RestorationExportRequest): void {
  const history = document.history;
  if (request.journalOperationCount !== history.length) {
    throw verificationFailure(
      'operation-count-mismatch',
      `the request says ${request.journalOperationCount} journal operation(s) but the saved case has ${history.length}`,
      { requestOperationCount: request.journalOperationCount, savedOperationCount: history.length },
    );
  }

  const exportOp = history.find((op) => op.id === request.exportOperationId);
  if (!exportOp) {
    throw verificationFailure(
      'export-operation-missing',
      `the saved journal contains no operation with id ${request.exportOperationId}`,
      { exportOperationId: request.exportOperationId },
    );
  }
  if (exportOp.name !== 'restoration-export') {
    throw verificationFailure(
      'export-operation-wrong-name',
      `operation ${request.exportOperationId} is ${JSON.stringify(exportOp.name)}, not a restoration-export`,
      { exportOperationId: request.exportOperationId, name: exportOp.name },
    );
  }
  if (exportOp.outputHashes[0] !== request.bytesSha256) {
    throw verificationFailure(
      'export-operation-bytes-hash-mismatch',
      'the journaled restoration-export outputHashes[0] does not match the request bytesSha256',
      { journaled: exportOp.outputHashes[0] ?? null, request: request.bytesSha256 },
    );
  }
  if (exportOp.inputHashes[0] !== request.meshContentHash) {
    throw verificationFailure(
      'export-operation-mesh-hash-mismatch',
      'the journaled restoration-export inputHashes[0] does not match the request meshContentHash',
      { journaled: exportOp.inputHashes[0] ?? null, request: request.meshContentHash },
    );
  }
  if (exportOp.params['restorationId'] !== request.restorationId || exportOp.params['format'] !== request.format) {
    throw verificationFailure(
      'export-operation-params-mismatch',
      'the journaled restoration-export params do not match the request restorationId/format',
      {
        journaledRestorationId: exportOp.params['restorationId'] ?? null,
        journaledFormat: exportOp.params['format'] ?? null,
        requestRestorationId: request.restorationId,
        requestFormat: request.format,
      },
    );
  }

  const restoration = document.restorations.find((r) => r.id === request.restorationId);
  if (!restoration) {
    throw verificationFailure(
      'restoration-missing',
      `the saved case has no restoration ${request.restorationId}`,
      { restorationId: request.restorationId },
    );
  }
  if (restoration.type !== request.restorationType) {
    throw verificationFailure(
      'restoration-type-mismatch',
      `restoration ${request.restorationId} is a ${restoration.type}, the request says ${request.restorationType}`,
      { saved: restoration.type, request: request.restorationType },
    );
  }
  if (restoration.stages.finalMesh !== request.meshContentHash) {
    throw verificationFailure(
      'final-mesh-mismatch',
      "the request meshContentHash is not the restoration's persisted stages.finalMesh — " +
        'the bytes do not serialize the saved final design',
      { savedFinalMesh: restoration.stages.finalMesh ?? null, request: request.meshContentHash },
    );
  }

  for (const ack of request.acknowledgments) {
    if (ack.operationId === null) {
      throw new ExportRejectionError(
        'export-unjournaled-acknowledgment',
        409,
        `the acknowledgment of gate ${JSON.stringify(ack.gate)} carries no journal operation ref — ` +
          'an unjournaled acknowledgment never authorizes an export; re-acknowledge through the journaled path',
        { gate: ack.gate },
      );
    }
    const op = history.find((o) => o.id === ack.operationId);
    if (!op || !isAckOpFor(op, request.restorationId, ack.gate)) {
      throw new ExportRejectionError(
        'export-acknowledgment-invalid',
        409,
        `the acknowledgment of gate ${JSON.stringify(ack.gate)} references operation ` +
          `${ack.operationId}, which is not a journaled acknowledgment of that gate for this restoration`,
        { gate: ack.gate, operationId: ack.operationId },
      );
    }
  }
}
