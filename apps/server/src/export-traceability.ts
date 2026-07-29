// apps/server/src/export-traceability.ts
//
// Phase 7 Task 5 — server-side traceability-document assembly: ONE input
// shape (`TraceabilityReleaseRecord`) feeds `@dqcad/traceability`'s builder
// both AT RELEASE TIME (export-route.ts step 14, from the just-verified
// request + the server's own report) and on REGENERATION from the stored
// release record (ledger row + stored bytes) — the two paths share this
// module, so "regenerating from the stored release record is deterministic"
// is a property of construction, tested byte-for-byte
// (export-traceability.test.ts).
//
// Every value here is server-derived or server-VERIFIED before this module
// sees it: the report is the server's recompute over the re-imported bytes;
// the profile identity is registry-resolved + checksum-verified (T4-F1);
// the journal fields are the journal-verified request bindings; the
// narrowing bound is measured on the re-imported coordinates themselves.
//
// ## The f32-narrowing bound is anchored at the DELIVERED coordinates
//
// `measureF32NarrowingError` over the re-imported mesh reports a measured
// error of exactly 0 (the coordinates are already f32 — the narrowing
// happened at write time, client-side), so the document records the
// ANALYTIC bound instead: half a float32 ULP at the largest delivered
// coordinate magnitude. The source-mesh narrowing the client incurred is
// bounded by this same value (|x| changes by at most half a ULP under
// narrowing, and the T2 golden suite measures the source-side error ≤ this
// bound on every fixture) — the honest, server-derivable statement of the
// format's precision floor for THIS file.
import { measureF32NarrowingError } from '@dqcad/io';
import type {
  ExportAcknowledgment,
  ExportFormat,
  FdiTooth,
  QcReport,
  QcTraceabilityDocument,
  RestorationType,
} from '@dqcad/shared-types';
import {
  buildReleaseTraceabilityDocument,
  serializeTraceabilityDocument,
} from '@dqcad/traceability';
import { assertValidTraceabilityDocument } from '@dqcad/traceability/validate';
import { reimportExportedBytes, ExportRejectionError } from './export-validation.js';
import { hashMesh } from './journal-replay.js';
import { installedManifoldVersion } from './manifold-version.js';

/** Everything a release traceability document is built from — recoverable
 * BOTH from the in-flight release (export-route.ts) and from a stored
 * Export ledger row (`rowToTraceabilityRecord`). */
export interface TraceabilityReleaseRecord {
  caseId: string;
  restorationId: string;
  restorationType: RestorationType;
  teeth: readonly FdiTooth[];
  format: ExportFormat;
  bytesSha256: string;
  byteLength: number;
  meshContentHash: string;
  /** STL: the journaled header text (header-verified at release); null for PLY. */
  headerText: string | null;
  reimportMeshHash: string;
  exportOperationId: string;
  caseJournalHash: string;
  journalOperationCount: number;
  profile: { id: string; version: string; checksum: string };
  /** The SERVER-recomputed report (the authoritative copy). */
  serverReport: QcReport;
  acknowledgments: readonly ExportAcknowledgment[];
}

/** The Export ledger row fields this module reads (a structural subset of
 * the Prisma model — keeps this module Prisma-independent and testable). */
export interface ExportRowLike {
  caseId: string;
  restorationId: string;
  restorationType: string;
  teethJson: string;
  format: string;
  bytesSha256: string;
  byteLength: number;
  meshContentHash: string;
  headerText: string | null;
  reimportMeshHash: string;
  exportOperationId: string;
  caseJournalHash: string;
  journalOperationCount: number | null;
  profileId: string;
  profileVersion: string;
  profileChecksum: string;
  qcReportJson: string;
  acknowledgmentsJson: string;
}

/**
 * Reconstructs the release record from a stored Export ledger row.
 *
 * @throws {ExportRejectionError} `export-traceability-missing` (404) for a
 *   legacy (pre-Task-5) row that never recorded `journalOperationCount` —
 *   such a row cannot regenerate a complete document, honestly refused
 *   rather than filled with a guess.
 */
export function rowToTraceabilityRecord(row: ExportRowLike): TraceabilityReleaseRecord {
  if (row.journalOperationCount === null) {
    throw new ExportRejectionError(
      'export-traceability-missing',
      404,
      'this release predates the traceability record (no journalOperationCount on the ledger row) — ' +
        'its document cannot be regenerated',
      { bytesSha256: row.bytesSha256 },
    );
  }
  return {
    caseId: row.caseId,
    restorationId: row.restorationId,
    restorationType: row.restorationType as RestorationType,
    teeth: JSON.parse(row.teethJson) as FdiTooth[],
    format: row.format as ExportFormat,
    bytesSha256: row.bytesSha256,
    byteLength: row.byteLength,
    meshContentHash: row.meshContentHash,
    headerText: row.headerText,
    reimportMeshHash: row.reimportMeshHash,
    exportOperationId: row.exportOperationId,
    caseJournalHash: row.caseJournalHash,
    journalOperationCount: row.journalOperationCount,
    profile: { id: row.profileId, version: row.profileVersion, checksum: row.profileChecksum },
    serverReport: JSON.parse(row.qcReportJson) as QcReport,
    acknowledgments: JSON.parse(row.acknowledgmentsJson) as ExportAcknowledgment[],
  };
}

export interface BuiltTraceability {
  document: QcTraceabilityDocument;
  /** The canonical (sorted-keys, whitespace-free) serialization — the bytes
   * stored on the ledger row and served verbatim by the JSON route. */
  json: string;
}

/**
 * Builds + schema-validates + canonically serializes the release document
 * from the record and the re-imported coordinate buffer (the narrowing
 * anchor — see this file's module doc). Validation failure here is a
 * genuine server bug (builders only produce valid shapes) and escapes as
 * the typed `TraceabilityDocumentValidationError` → 500, never a silent
 * partial record.
 */
export function buildReleaseTraceability(
  record: TraceabilityReleaseRecord,
  reimportedPositions: Float64Array,
): BuiltTraceability {
  const narrowing =
    record.format === 'stl'
      ? (() => {
          const measured = measureF32NarrowingError(reimportedPositions);
          return {
            maxAbsCoordinateMm: measured.maxAbsCoordinateMm,
            halfUlpBoundMm: measured.maxHalfUlpBoundMm,
          };
        })()
      : null;
  const document = buildReleaseTraceabilityDocument({
    identity: {
      caseId: record.caseId,
      restorationId: record.restorationId,
      restorationType: record.restorationType,
      teeth: record.teeth,
    },
    serverReport: record.serverReport,
    acknowledgments: record.acknowledgments,
    materialProfile: record.profile,
    manifoldVersion: installedManifoldVersion(),
    exportFile: {
      format: record.format,
      bytesSha256: record.bytesSha256,
      byteLength: record.byteLength,
      meshContentHash: record.meshContentHash,
      headerText: record.headerText,
    },
    journal: {
      caseJournalHash: record.caseJournalHash,
      journalOperationCount: record.journalOperationCount,
      exportOperationId: record.exportOperationId,
    },
    reimportMeshHash: record.reimportMeshHash,
    f32Narrowing: narrowing,
  });
  assertValidTraceabilityDocument(document);
  return { document, json: serializeTraceabilityDocument(document) };
}

/**
 * Regenerates the document from a STORED release record: re-imports the
 * stored bytes (the same parse+intake path the release ran) and rebuilds —
 * asserting the re-imported mesh still hashes to the recorded
 * `reimportMeshHash` (a storage-integrity cross-check: regeneration must
 * describe the same geometry the release measured).
 */
export function regenerateReleaseTraceability(
  record: TraceabilityReleaseRecord,
  storedBytes: Uint8Array,
): BuiltTraceability {
  const reimport = reimportExportedBytes(storedBytes, record.format);
  const reimportMeshHash = hashMesh(reimport.mesh);
  if (reimportMeshHash !== record.reimportMeshHash) {
    throw new Error(
      `traceability regeneration integrity: the stored bytes re-import to mesh hash ${reimportMeshHash}, ` +
        `but the release recorded ${record.reimportMeshHash} — refusing to regenerate a document for ` +
        'different geometry',
    );
  }
  return buildReleaseTraceability(record, reimport.mesh.positions);
}
