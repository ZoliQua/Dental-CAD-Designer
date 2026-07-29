// apps/server/src/export-request.testutil.ts
//
// Phase 7 Task 4 — shared test harness for the export endpoint suites: builds
// the FULL client-side export request state (the Task 3 machinery mirrored
// server-test-side, since apps/server cannot import apps/client engine code)
// against a REAL app instance:
//
//   serialize bytes with the T2 io export writers (exactly what the client's
//   `exportRestorationMesh` worker job runs) → journal the `restoration-export`
//   Operation (the T3 op shape, ack ops included) → persist the case document
//   through the real PUT route (the N5 sequencing contract: case saved BEFORE
//   the export request) → hash the SAVED journal with the SAME shared
//   `hashCaseJournal` → assemble `{ request, qcContext }`.
//
// Tamper knobs (`mutateBytes`, `mutateHistory`, `skipPersistExportOp`) keep
// ALL derived bookkeeping CONSISTENT with the mutation — that is what makes
// the falsifiable rejection tests strong: a byte-flip test with a stale hash
// would only prove the hash gate works, not that the re-validation itself
// catches consistent adversarial tampering. NOT a `.test.ts` — imported by
// the export suites, never run as a suite itself.
import type { FastifyInstance } from 'fastify';
import { STANDARD_ZIRCONIA_PROFILE, type MaterialProfile } from '@dqcad/clinical-profiles';
import { exportPlyBinary, exportStlBinary } from '@dqcad/io';
import { KERNEL_VERSION, type IndexedMesh } from '@dqcad/kernel';
import { hashCaseJournal } from '@dqcad/kernel-workers/journal-hash';
import type {
  CaseDocument,
  ExportAcknowledgment,
  FdiTooth,
  Operation,
  QcReport,
  Restoration,
  RestorationExportRequest,
  RestorationType,
} from '@dqcad/shared-types';
import { hashMesh } from './journal-replay.js';
import { sha256HexOf } from './mesh-storage.js';

/** Fixed op timestamp — `Operation.timestamp` is audit-display-only and
 * excluded from the journal hash; a constant keeps harness output
 * deterministic. */
const OP_TIMESTAMP = '2026-01-01T00:00:00.000Z';

let opCounter = 0;
/** Deterministic op ids (`Operation.id` is excluded from the journal hash,
 * but stable ids make failure output reproducible). */
function nextOpId(prefix: string): string {
  opCounter += 1;
  return `${prefix}-${opCounter}`;
}

/** Mirrors the client's `exportStlHeaderText` (exportFlow.ts): a pure
 * function of journaled params only — never a timestamp. */
export function exportHeaderText(type: RestorationType, teeth: readonly FdiTooth[]): string {
  return `DQ-Dental-CAD; units=mm; ${type} ${teeth.join(' ')}`;
}

/** Strips the byte-derived solid + the request-derived metadata from a
 * serialized validate-qc body, leaving exactly the export `qcContext` (the
 * same subtraction schemas.ts performs on the schema side). */
export function toExportQcContext(
  validateQcBody: Record<string, unknown>,
  solidKey: 'crownSolid' | 'inlaySolid' | 'assembledSolid',
): Record<string, unknown> {
  const ctx = { ...validateQcBody };
  for (const key of [
    solidKey,
    'restorationType',
    'kernelVersion',
    'profileVersion',
    'journalHash',
    'acknowledgedGates',
    'clientReport',
  ]) {
    delete ctx[key];
  }
  return ctx;
}

export interface ExportHarnessOptions {
  app: FastifyInstance;
  restorationType: RestorationType;
  teeth: readonly FdiTooth[];
  /** Bridge only — subset of `teeth`; defaults to `[]`. */
  pontics?: readonly FdiTooth[];
  /** The f64 final restoration solid the bytes serialize. */
  finalMesh: IndexedMesh;
  /** The client QC report — `journalHash` MUST equal `hashMesh(finalMesh)`
   * and `profileVersion` MUST equal the REAL registry profile's version
   * (the identities the real flow guarantees; asserted here). */
  clientReport: QcReport;
  /** The riding context (`toExportQcContext` output). */
  qcContext: Record<string, unknown>;
  format: 'stl' | 'ply';
  /** The REGISTRY profile whose thresholds the fixture was designed against
   * (F1: the server resolves + pins it). Defaults to standard zirconia; the
   * inlay/onlay fixtures use the e.max profile (their 1.0/1.5 mm minimums
   * are the e.max IFU values). */
  profile?: MaterialProfile;
  restorationId?: string;
  /** Tamper knob: transforms the serialized bytes BEFORE any hashing/op
   * construction, so every derived field stays consistent with the
   * mutation (the strong falsifiability setup). */
  mutateBytes?: (bytes: Uint8Array) => Uint8Array;
  /** Tamper knob: transforms the PERSISTED history; `caseJournalHash` and
   * `journalOperationCount` are recomputed over the MUTATED history so the
   * hash gate passes and the deeper journal verification is what must
   * catch it. */
  mutateHistory?: (history: Operation[]) => Operation[];
  /** Tamper knob: persist the case WITHOUT the export op while the request
   * still hashes the full journal — the N5 "case not saved before export"
   * scenario (journal-hash mismatch). */
  skipPersistExportOp?: boolean;
}

export interface ExportHarness {
  body: { request: RestorationExportRequest; qcContext: Record<string, unknown> };
  request: RestorationExportRequest;
  bytes: Uint8Array;
  caseId: string;
  restorationId: string;
  finalMeshHash: string;
  ackOps: readonly Operation[];
  exportOp: Operation;
  persistedDocument: CaseDocument;
}

function ackOpNameFor(type: RestorationType): string {
  return type === 'bridge' ? 'bridge-qc-ack' : type === 'crown' ? 'crown-qc-ack' : 'inlay-qc-ack';
}

/** The acknowledgments a client would assemble (`collectAcknowledgments`):
 * one per acknowledged gate in the report, snapshot + journal ref. */
function acknowledgmentsFromReport(report: QcReport, ackOpIdByGate: ReadonlyMap<string, string>): ExportAcknowledgment[] {
  return report.gates
    .filter((g) => g.acknowledged)
    .map((g) => ({
      gate: g.gate,
      message: g.message,
      value: g.value,
      threshold: g.threshold,
      unit: g.unit,
      operationId: ackOpIdByGate.get(g.gate) ?? null,
    }));
}

/**
 * Builds the full persisted-case + request state (see the module doc).
 * Asserts its own preconditions loudly (report freshness identity, profile
 * version consistency) — a harness misuse must fail the test, not produce a
 * confusing endpoint rejection.
 */
export async function buildExportHarness(options: ExportHarnessOptions): Promise<ExportHarness> {
  const { app, restorationType, teeth, finalMesh, clientReport, qcContext, format } = options;
  const finalMeshHash = hashMesh(finalMesh);
  if (clientReport.journalHash !== finalMeshHash) {
    throw new Error(
      `buildExportHarness: clientReport.journalHash (${clientReport.journalHash}) must equal ` +
        `hashMesh(finalMesh) (${finalMeshHash}) — run the client QC with the freshness identity`,
    );
  }
  // The REAL registry profile identity (F1 fix round): the server resolves +
  // checksum-verifies the profile from @dqcad/clinical-profiles, so the
  // harness ships the genuine id/version/checksum (a fabricated checksum is
  // now a 409 — proven by its own negative test via cloneBody tampering).
  const profile = options.profile ?? STANDARD_ZIRCONIA_PROFILE;
  if (clientReport.profileVersion !== profile.version) {
    throw new Error(
      `buildExportHarness: clientReport.profileVersion (${clientReport.profileVersion}) must equal the ` +
        `registry profile version (${profile.version}) — run the client QC with profileVersion overridden`,
    );
  }
  const restorationId = options.restorationId ?? `resto-${restorationType}-${nextOpId('h')}`;

  // 1. Serialize with the T2 export writers (what the worker job runs),
  //    then apply the byte tamper knob BEFORE any bookkeeping.
  const headerText = format === 'stl' ? exportHeaderText(restorationType, teeth) : undefined;
  const cleanBytes =
    format === 'stl' ? exportStlBinary(finalMesh, { headerText }) : exportPlyBinary(finalMesh);
  const bytes = options.mutateBytes ? options.mutateBytes(cleanBytes) : cleanBytes;
  const bytesSha256 = sha256HexOf(bytes);
  const byteLength = bytes.byteLength;

  // 2. Journal ops: one ack op per acknowledged gate (the journaled
  //    acknowledgment the export refs), then the restoration-export op (the
  //    T3 op shape, exportFlow.ts).
  const ackOps: Operation[] = clientReport.gates
    .filter((g) => g.acknowledged)
    .map((g) => ({
      id: nextOpId('ack-op'),
      name: ackOpNameFor(restorationType),
      params: { restorationId, acknowledgedGate: g.gate, acknowledgedGates: [g.gate] },
      inputHashes: [finalMeshHash],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: OP_TIMESTAMP,
    }));
  const ackOpIdByGate = new Map(ackOps.map((op) => [op.params['acknowledgedGate'] as string, op.id]));
  const acknowledgments = acknowledgmentsFromReport(clientReport, ackOpIdByGate);

  const exportOp: Operation = {
    id: nextOpId('export-op'),
    name: 'restoration-export',
    params: {
      restorationId,
      restorationType,
      teeth: [...teeth],
      format,
      ...(headerText === undefined ? {} : { headerText }),
      byteLength,
      acknowledgedGates: acknowledgments.map((a) => a.gate),
      ackOperationIds: acknowledgments.map((a) => a.operationId),
    },
    inputHashes: [finalMeshHash],
    outputHashes: [bytesSha256],
    kernelVersion: KERNEL_VERSION,
    timestamp: OP_TIMESTAMP,
  };

  const fullHistory: Operation[] = [...ackOps, exportOp];
  let persistedHistory: Operation[] = options.skipPersistExportOp ? [...ackOps] : fullHistory;
  if (options.mutateHistory) {
    persistedHistory = options.mutateHistory(persistedHistory.map((op) => ({ ...op, params: { ...op.params } })));
  }

  // 3. Create + persist the case through the REAL routes (N5: saved before
  //    the export request is sent).
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: `export-harness-${restorationId}` },
  });
  if (created.statusCode !== 201) {
    throw new Error(`buildExportHarness: case create failed (${created.statusCode}): ${created.body}`);
  }
  const caseId = (created.json() as { id: string }).id;

  const restoration: Restoration = {
    id: restorationId,
    type: restorationType,
    teeth: [...teeth],
    pontics: [...(options.pontics ?? [])],
    targetNodeId: null,
    marginLines: {},
    insertionAxis: [0, 0, 1],
    params: {
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.8,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    },
    stages: { finalMesh: finalMeshHash },
    qc: clientReport,
  };
  const persistedDocument: CaseDocument = {
    id: caseId,
    schemaVersion: 2,
    createdAt: OP_TIMESTAMP,
    meshes: [],
    scene: [],
    restorations: [restoration],
    measurements: [],
    history: persistedHistory,
    settings: { materialProfileId: profile.id, profileVersion: profile.version },
  };
  const put = await app.inject({ method: 'PUT', url: `/api/cases/${caseId}`, payload: persistedDocument });
  if (put.statusCode !== 200) {
    throw new Error(`buildExportHarness: case save failed (${put.statusCode}): ${put.body}`);
  }

  // 4. The request. `caseJournalHash` covers the journal the CLIENT believes
  //    it saved: the full history normally; the MUTATED history when
  //    `mutateHistory` simulates a consistent adversary (hash gate passes,
  //    deeper verification must catch); the full history when
  //    `skipPersistExportOp` simulates the missed save (hash gate catches).
  const hashedHistory = options.mutateHistory ? persistedHistory : fullHistory;
  const request: RestorationExportRequest = {
    schemaVersion: 1,
    caseId,
    restorationId,
    restorationType,
    teeth: [...teeth],
    format,
    ...(headerText === undefined ? {} : { headerText }),
    meshContentHash: finalMeshHash,
    exportOperationId: exportOp.id,
    bytesBase64: Buffer.from(bytes).toString('base64'),
    bytesSha256,
    byteLength,
    qcReport: clientReport,
    acknowledgments,
    caseJournalHash: await hashCaseJournal(hashedHistory),
    journalOperationCount: hashedHistory.length,
    materialProfile: { id: profile.id, version: profile.version, checksum: profile.checksum },
    kernelVersion: KERNEL_VERSION,
  };

  return {
    body: { request, qcContext },
    request,
    bytes,
    caseId,
    restorationId,
    finalMeshHash,
    ackOps,
    exportOp,
    persistedDocument,
  };
}

/** Deep-clones a harness body through JSON — for per-test tampering of a
 * shared harness without cross-test contamination. */
export function cloneBody(body: ExportHarness['body']): ExportHarness['body'] {
  return JSON.parse(JSON.stringify(body)) as ExportHarness['body'];
}
