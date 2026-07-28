// apps/server/src/export-route.ts
//
// Phase 7 Task 4 — `POST /api/restorations/:id/export` (the independent
// backend re-validation on the EXACT exported bytes) and
// `GET /api/exports/:hash/download` (the released-bytes stream). The
// strongest form of CLAUDE.md invariant 6: the server's QC input for the
// restoration solid is the byte stream a mill would read — parsed with the
// Node io parsers and run through the kernel intake pipeline — never a
// client-shipped number array.
//
// ## The byte-derived vs riding-context boundary (decided Task 4)
//
// The RE-IMPORTED mesh replaces the restoration SOLID everywhere it appears
// in the gate inputs — `RunCrownQcInput.crownSolid`,
// `RunInlayQcInput.inlaySolid`, `RunBridgeQcInput.assembledSolid` (the
// watertight/manifold stats, the self-intersection measurement, the seating
// boolean, and the bridge marginFit's fit-patch extraction all measure IT).
// Everything else RIDES with the request (`qcContext`, schemas.ts — derived
// programmatically from the validate-qc branch schemas minus the solid):
// the prep die(s), inner/outer/fit/patch/unit surfaces, the tooth-with-cavity
// solid, margin/outline polylines, seam edges, cavity triangle indices,
// insertion axes, measured contact residuals, and the profile-resolved
// thresholds — none of which is recoverable from the mill bytes (they are
// design-time context, not the deliverable). Report metadata + acknowledged
// gates are NOT free-riding context: they are derived from VERIFIED request
// identity fields (`kernelVersion` checked against the server's own
// KERNEL_VERSION; `profileVersion` from `materialProfile.version`;
// `journalHash` stamped as `meshContentHash` — the P4 convention that
// `QcReport.journalHash` carries the finalMesh content hash; acknowledged
// gates from the journal-verified `acknowledgments`), so a context/request
// disagreement cannot be smuggled past the diff.
//
// ## Why exact-equality report comparison is legitimate (the f32 question)
//
// The client QC ran on the f64 `finalMesh` M; the server QC runs on the
// re-import R = intake(parse(bytes)). By the Task 2 equivalence R =
// `narrow32(canon(M))` for STL (exactly M for PLY): canon relabels vertices
// into triangle-scan first-occurrence order (triangle ORDER and windings
// preserved — triangle t is triangle t), and narrow32 rounds each coordinate
// to its nearest f32 (measured ≤ half-ULP; exactly 0 for WASM-lineage
// solids, whose coordinates are already f32-representable). R is therefore
// generally NOT hash-identical to M (`reimportMeshHash` ≠ `meshContentHash`
// — both are recorded), and the server deliberately does NOT require hash
// identity. What it requires is gate-RESULT identity under the established
// exact-equality diff: every gate consuming the solid is invariant under the
// vertex relabeling (triangle-ordered iteration; relabeling-stable manifold
// measurements) and the ≤half-ULP narrowing did not move any measured value
// (MEASURED bit-identical on the P4 crown / P5 inlay+onlay / P6 bridge
// fixtures — the pass-proof suites assert it on every run). If a future
// restoration's narrowing genuinely moved a gate value, the diff 409s with
// the persisted diagnostic bundle — the honest surfacing, never a smoothed
// comparison.
//
// ## Verification ladder (each step a typed, schema'd rejection)
//
//  1. bytes integrity FIRST (T3 contract)         → 400 export-bytes-integrity
//  2. URL :id vs request.restorationId            → 400 export-request-id-mismatch
//  3. qcContext branch vs restorationType         → 400 export-context-type-mismatch
//  4. case lookup                                 → 404 export-case-not-found
//  5. caseJournalHash recompute (shared
//     hashCaseJournal over the SAVED journal)     → 409 export-journal-hash-mismatch
//  6. journal verification (export op binding,
//     restoration/finalMesh, ack refs; N4:
//     operationId null → refuse)                  → 409 (three codes)
//  7. kernel version                              → 409 export-kernel-version-mismatch
//  8. parse + intake + cleanliness                → 400 (two codes)
//  9. QC recompute on the re-imported solid;
//     typed pipeline input errors                 → 400 qc-invalid-input
// 10. exact diff vs request.qcReport              → 409 export-qc-mismatch
//     (+ PERSISTED ExportDiagnostic bundle)
// 11. authorization: server report must pass
//     (failing gates all acknowledged)            → 409 export-gates-failing
// 12. release: content-addressed immutable store
//     + Export ledger row                         → 200
//
// ## Release + idempotency semantics
//
// Released bytes are stored content-addressed (`<exportsDataDir>/<sha256>`,
// the mesh-storage machinery: write-once, temp-file+rename, size-asserted on
// re-upload) — immutable, same discipline as scan files. The Export table is
// an APPEND-ONLY release ledger: re-exporting byte-identical content stores
// nothing new (`alreadyStored: true`) but records a new release event (own
// row + `releasedAt`, a RECORD field that never enters any hashed content).
// The download route re-verifies the stored bytes' hash on EVERY read —
// tamper-on-disk is a 500, corrupt bytes are never served.
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument, QcReport, RestorationExportRequest } from '@dqcad/shared-types';
import {
  runBridgeQc,
  runCrownQc,
  runInlayQc,
  BridgeQcInputError,
  MarginFitInputError,
  MinWallThicknessInputError,
  NonCavityRestorationTypeError,
  type ContactResidualInput,
  type RunBridgeQcInput,
  type RunCrownQcInput,
  type RunInlayQcInput,
} from '@dqcad/cad-pipeline';
import { hashCaseJournal } from '@dqcad/kernel-workers/journal-hash';
import {
  decodeExportBytes,
  reimportExportedBytes,
  verifyExportJournal,
  ExportRejectionError,
  type ReimportResult,
} from './export-validation.js';
import { hashMesh } from './journal-replay.js';
import { readMeshBytes, sha256HexOf, storeMeshBytes } from './mesh-storage.js';
import {
  diffQcReports,
  toBridgeConnector,
  toBridgeUnit,
  toIndexedMesh,
  toLoop,
  toSeamEdges,
  toVec3,
  type BridgeConnectorInput,
  type BridgeUnitInput,
  type MeshDataInput,
  type SeamEdgeInput,
} from './qc-input-json.js';
import {
  caseIdParamsSchema,
  exportBodySchema,
  exportDownloadResponseSchema,
  exportResponseSchema,
  meshHashParamsSchema,
} from './schemas.js';

// --- qcContext body typing (the validate-qc bodies minus the byte-derived
// solid and the request-derived metadata — see schemas.ts's export section) ---

export interface CrownExportQcContext {
  innerSurfaceMesh: MeshDataInput;
  outerSurfaceMesh: MeshDataInput;
  dieSolid: MeshDataInput;
  marginResampledPoints: number[][];
  insertionAxis: number[];
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  contacts: ContactResidualInput[];
  contactClampWarning: boolean;
  marginExclusionMm?: number;
  marginFitThresholdMm?: number;
  seatingInterferenceVolumeToleranceMm3?: number;
  contactToleranceMm?: number;
  connectors?: { label: string; minAreaMm2: number }[];
}

export interface InlayExportQcContext {
  fitSurfaceMesh: MeshDataInput;
  patchMesh: MeshDataInput;
  toothWithCavitySolid: MeshDataInput;
  cavityOutlineResampledPoints: number[][];
  insertionAxis: number[];
  thicknessMinimums: { inlayMinThicknessMm: number; onlayMinThicknessMm: number };
  marginExclusionMm: number;
  coverage?: { coverageDivider: { pointMm: number[]; normalMm: number[] }; cuspCoverageMinThicknessMm: number };
  seamEdges: SeamEdgeInput[];
  cavityTriangleIndices: number[];
  contacts: ContactResidualInput[];
  contactClampWarning: boolean;
  marginFitThresholdMm?: number;
  seamDihedralThresholdDeg?: number;
  seatingInterferenceVolumeToleranceMm3?: number;
  contactToleranceMm?: number;
}

export interface BridgeExportQcContext {
  units: BridgeUnitInput[];
  dieSolids: MeshDataInput[];
  connectors: BridgeConnectorInput[];
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  frameworkMode?: boolean;
  frameworkMinThicknessMm?: number;
  ponticRelief: { maxAbsDeviationMm: number; style: string; configuredReliefMm: number; thresholdMm?: number };
  marginFitThresholdMm?: number;
  seatingInterferenceVolumeToleranceMm3?: number;
}

export type ExportQcContext = CrownExportQcContext | InlayExportQcContext | BridgeExportQcContext;

export interface ExportRequestBody {
  request: RestorationExportRequest;
  qcContext: ExportQcContext;
}

/** Which validate-qc family a context object belongs to, via its
 * branch-required, branch-exclusive fields (the schemas make the branches
 * mutually exclusive, so this is total on schema-valid bodies). */
function contextBranch(ctx: ExportQcContext): 'crown' | 'cavity' | 'bridge' {
  if ('units' in ctx) return 'bridge';
  if ('fitSurfaceMesh' in ctx) return 'cavity';
  return 'crown';
}

/** The report metadata + acknowledged-gate set every export QC run derives
 * from VERIFIED request fields (see the module doc's boundary section). */
function reportMetadata(request: RestorationExportRequest): {
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates: string[];
} {
  return {
    kernelVersion: request.kernelVersion,
    profileVersion: request.materialProfile.version,
    journalHash: request.meshContentHash,
    acknowledgedGates: request.acknowledgments.map((a) => a.gate),
  };
}

async function runExportQc(
  request: RestorationExportRequest,
  ctx: ExportQcContext,
  reimport: ReimportResult,
): Promise<QcReport> {
  const meta = reportMetadata(request);
  const branch = contextBranch(ctx);
  if (branch === 'bridge') {
    const b = ctx as BridgeExportQcContext;
    const input: RunBridgeQcInput = {
      assembledSolid: reimport.mesh,
      units: b.units.map(toBridgeUnit),
      dieSolids: b.dieSolids.map(toIndexedMesh),
      connectors: b.connectors.map(toBridgeConnector),
      minWallThicknessMm: b.minWallThicknessMm,
      occlusalMinWallThicknessMm: b.occlusalMinWallThicknessMm,
      connectorAreaTargetMm2: b.connectorAreaTargetMm2,
      frameworkMode: b.frameworkMode,
      frameworkMinThicknessMm: b.frameworkMinThicknessMm,
      ponticRelief: {
        maxAbsDeviationMm: b.ponticRelief.maxAbsDeviationMm,
        style: b.ponticRelief.style,
        configuredReliefMm: b.ponticRelief.configuredReliefMm,
        thresholdMm: b.ponticRelief.thresholdMm,
      },
      marginFitThresholdMm: b.marginFitThresholdMm,
      seatingInterferenceVolumeToleranceMm3: b.seatingInterferenceVolumeToleranceMm3,
      ...meta,
    };
    return runBridgeQc(input);
  }
  if (branch === 'cavity') {
    const c = ctx as InlayExportQcContext;
    const input: RunInlayQcInput = {
      inlaySolid: reimport.mesh,
      fitSurfaceMesh: toIndexedMesh(c.fitSurfaceMesh),
      patchMesh: toIndexedMesh(c.patchMesh),
      toothWithCavitySolid: toIndexedMesh(c.toothWithCavitySolid),
      cavityOutlineResampledPoints: toLoop(c.cavityOutlineResampledPoints),
      insertionAxis: toVec3(c.insertionAxis),
      restorationType: request.restorationType as 'inlay' | 'onlay',
      thicknessMinimums: c.thicknessMinimums,
      coverage: c.coverage
        ? {
            coverageDivider: {
              pointMm: toVec3(c.coverage.coverageDivider.pointMm),
              normalMm: toVec3(c.coverage.coverageDivider.normalMm),
            },
            cuspCoverageMinThicknessMm: c.coverage.cuspCoverageMinThicknessMm,
          }
        : undefined,
      marginExclusionMm: c.marginExclusionMm,
      seamEdges: toSeamEdges(c.seamEdges),
      cavityTriangleIndices: Uint32Array.from(c.cavityTriangleIndices),
      contacts: c.contacts,
      contactClampWarning: c.contactClampWarning,
      marginFitThresholdMm: c.marginFitThresholdMm,
      seamDihedralThresholdDeg: c.seamDihedralThresholdDeg,
      seatingInterferenceVolumeToleranceMm3: c.seatingInterferenceVolumeToleranceMm3,
      contactToleranceMm: c.contactToleranceMm,
      ...meta,
    };
    return runInlayQc(input);
  }
  const k = ctx as CrownExportQcContext;
  const input: RunCrownQcInput = {
    crownSolid: reimport.mesh,
    innerSurfaceMesh: toIndexedMesh(k.innerSurfaceMesh),
    outerSurfaceMesh: toIndexedMesh(k.outerSurfaceMesh),
    dieSolid: toIndexedMesh(k.dieSolid),
    marginResampledPoints: toLoop(k.marginResampledPoints),
    insertionAxis: toVec3(k.insertionAxis),
    minWallThicknessMm: k.minWallThicknessMm,
    occlusalMinWallThicknessMm: k.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: k.connectorAreaTargetMm2,
    contacts: k.contacts,
    contactClampWarning: k.contactClampWarning,
    marginExclusionMm: k.marginExclusionMm,
    marginFitThresholdMm: k.marginFitThresholdMm,
    seatingInterferenceVolumeToleranceMm3: k.seatingInterferenceVolumeToleranceMm3,
    contactToleranceMm: k.contactToleranceMm,
    connectors: k.connectors,
    ...meta,
  };
  return runCrownQc(input);
}

/** Deterministic download filename from ledger-row fields only (no
 * timestamps): `<type>-<teeth>-<hash12>.<format>`. */
function downloadFilename(row: {
  restorationType: string;
  teethJson: string;
  bytesSha256: string;
  format: string;
}): string {
  const teeth = (JSON.parse(row.teethJson) as number[]).join('-');
  return `${row.restorationType}-${teeth}-${row.bytesSha256.slice(0, 12)}.${row.format}`;
}

export interface ExportRouteDeps {
  prisma: PrismaClient;
  /** Content-addressed released-bytes store directory (mesh-storage
   * machinery; immutable, write-once). */
  exportsDataDir: string;
  /** Body-size ceiling for the export POST. The body carries the base64
   * bytes (4/3 × raw + padding — the largest fixture solid is ~2.7 MB STL ≈
   * 3.6 MB base64) PLUS the riding qcContext meshes as JSON number arrays,
   * which dominate (tens of MB for a marching-cubes fit surface) — exactly
   * the payload class the validate-qc route already provisions
   * `meshMaxBytes` for, so the same ceiling is shared deliberately. */
  meshMaxBytes: number;
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { prisma, exportsDataDir, meshMaxBytes } = deps;

  app.post<{ Params: { id: string }; Body: ExportRequestBody }>(
    '/api/restorations/:id/export',
    {
      bodyLimit: meshMaxBytes,
      schema: { params: caseIdParamsSchema, body: exportBodySchema, response: exportResponseSchema },
    },
    async (request, reply) => {
      const { request: exportRequest, qcContext } = request.body;
      try {
        // 1. Bytes integrity FIRST (the Task 3 contract).
        const bytes = decodeExportBytes(exportRequest);

        // 2./3. Request-internal consistency.
        if (exportRequest.restorationId !== request.params.id) {
          throw new ExportRejectionError(
            'export-request-id-mismatch',
            400,
            `request.restorationId (${exportRequest.restorationId}) does not match the URL's :id (${request.params.id})`,
            { urlId: request.params.id, requestRestorationId: exportRequest.restorationId },
          );
        }
        const branch = contextBranch(qcContext);
        const expectedBranch =
          exportRequest.restorationType === 'bridge'
            ? 'bridge'
            : exportRequest.restorationType === 'crown'
              ? 'crown'
              : 'cavity';
        if (branch !== expectedBranch) {
          throw new ExportRejectionError(
            'export-context-type-mismatch',
            400,
            `the qcContext is a ${branch} context but request.restorationType is ${exportRequest.restorationType}`,
            { contextBranch: branch, restorationType: exportRequest.restorationType },
          );
        }

        // 4. The persisted case (the journal authority — N5 sequencing).
        const caseRow = await prisma.case.findUnique({ where: { id: exportRequest.caseId } });
        if (!caseRow) {
          throw new ExportRejectionError('export-case-not-found', 404, `no case ${exportRequest.caseId}`, {
            caseId: exportRequest.caseId,
          });
        }
        const document = JSON.parse(caseRow.documentJson) as CaseDocument;

        // 5. Journal-hash cross-check: recomputed from the SAVED journal with
        // the SAME shared implementation the client used
        // (@dqcad/kernel-workers/journal-hash), full history INCLUDING the
        // export op (the T3 scope rule).
        const savedJournalHash = await hashCaseJournal(document.history);
        if (savedJournalHash !== exportRequest.caseJournalHash) {
          throw new ExportRejectionError(
            'export-journal-hash-mismatch',
            409,
            'the request caseJournalHash does not match the SAVED case journal — the case was not saved ' +
              'before exporting (N5 sequencing), or the journal was modified/tampered since',
            {
              requestJournalHash: exportRequest.caseJournalHash,
              savedJournalHash,
              requestOperationCount: exportRequest.journalOperationCount,
              savedOperationCount: document.history.length,
            },
          );
        }

        // 6. Journal verification: export-op binding, restoration/finalMesh,
        // acknowledgment refs (N4: null → refuse; P6-T8: tampering → refuse).
        verifyExportJournal(document, exportRequest);

        // 7. Kernel version: a report recomputed on a different kernel is not
        // comparable (determinism is per kernel version) — refuse rather than
        // produce a misleading diff.
        if (exportRequest.kernelVersion !== KERNEL_VERSION) {
          throw new ExportRejectionError(
            'export-kernel-version-mismatch',
            409,
            `the export was produced on kernel ${exportRequest.kernelVersion} but this server runs ${KERNEL_VERSION}`,
            { requestKernelVersion: exportRequest.kernelVersion, serverKernelVersion: KERNEL_VERSION },
          );
        }

        // 8. Parse + intake the EXACT bytes — the re-imported solid is the
        // only restoration geometry the QC below ever sees.
        const reimport = reimportExportedBytes(bytes, exportRequest.format);
        const reimportMeshHash = hashMesh(reimport.mesh);

        // 9. Independent QC recompute (typed pipeline input errors → 400,
        // the validate-qc parity; anything else is a genuine server bug and
        // escapes to 500 — never blanket-caught).
        let serverReport: QcReport;
        try {
          serverReport = await runExportQc(exportRequest, qcContext, reimport);
        } catch (error) {
          if (
            error instanceof BridgeQcInputError ||
            error instanceof MarginFitInputError ||
            error instanceof MinWallThicknessInputError ||
            error instanceof NonCavityRestorationTypeError
          ) {
            throw new ExportRejectionError('qc-invalid-input', 400, error.message, { errorName: error.name });
          }
          throw error;
        }

        // 10. Exact-equality diff against the client report (compare-only —
        // nothing from it ever fed a gate input). Any delta → 409 + the
        // PERSISTED diagnostic bundle (the bug-report payload).
        const differences = diffQcReports(serverReport, exportRequest.qcReport);
        if (differences.length > 0) {
          const bundle = {
            reason: 'qc-mismatch',
            caseId: exportRequest.caseId,
            restorationId: exportRequest.restorationId,
            restorationType: exportRequest.restorationType,
            format: exportRequest.format,
            bytesSha256: exportRequest.bytesSha256,
            byteLength: exportRequest.byteLength,
            meshContentHash: exportRequest.meshContentHash,
            reimportMeshHash,
            caseJournalHash: exportRequest.caseJournalHash,
            exportOperationId: exportRequest.exportOperationId,
            kernelVersion: { server: KERNEL_VERSION, request: exportRequest.kernelVersion },
            materialProfile: exportRequest.materialProfile,
            differences,
            serverReport,
            clientReport: exportRequest.qcReport,
            parseDiagnostics: reimport.parseDiagnostics,
            intakeSteps: reimport.intakeReport.steps,
          };
          const diagnostic = await prisma.exportDiagnostic.create({
            data: {
              caseId: exportRequest.caseId,
              restorationId: exportRequest.restorationId,
              reason: 'qc-mismatch',
              bytesSha256: exportRequest.bytesSha256,
              bundleJson: JSON.stringify(bundle),
            },
          });
          reply.code(409);
          return {
            error: 'export-qc-mismatch',
            message:
              `client/server QcReport disagreement on ${differences.length} field(s) over the RE-IMPORTED ` +
              'export bytes — the server re-validation is authoritative; nothing was released (invariant 6). ' +
              `Diagnostic bundle persisted as ${diagnostic.id}.`,
            diagnosticId: diagnostic.id,
            differences,
            bundle,
          };
        }

        // 11. Authorization: the SERVER's report must pass — every failing
        // gate covered by a journal-verified acknowledgment (`runQcGates`
        // semantics: `passed` is true iff every gate passed or is an
        // acknowledged failure). Reaching here with a failing report means
        // the client report AGREED (no diff), i.e. a hand-built request
        // shipped a knowingly-unauthorized export — refused, never released.
        if (!serverReport.passed) {
          const failingGates = serverReport.gates.filter((g) => !g.passed && !g.acknowledged).map((g) => g.gate);
          reply.code(409);
          return {
            error: 'export-gates-failing',
            message:
              `the server re-validation FAILED ${failingGates.length} unacknowledged gate(s) on the exported ` +
              `bytes (${failingGates.join(', ')}) — the export is refused (invariant 4: gates block export)`,
            failingGates,
          };
        }

        // 12. Release: content-addressed immutable storage + ledger row.
        const stored = await storeMeshBytes(exportsDataDir, bytes);
        if (stored.hash !== exportRequest.bytesSha256) {
          // Unreachable (step 1 verified the hash over the same bytes) —
          // asserted anyway: releasing under a different address would break
          // the download contract.
          throw new Error(
            `export release integrity: stored hash ${stored.hash} != verified bytesSha256 ${exportRequest.bytesSha256}`,
          );
        }
        const row = await prisma.export.create({
          data: {
            caseId: exportRequest.caseId,
            restorationId: exportRequest.restorationId,
            restorationType: exportRequest.restorationType,
            teethJson: JSON.stringify(exportRequest.teeth),
            format: exportRequest.format,
            bytesSha256: exportRequest.bytesSha256,
            byteLength: exportRequest.byteLength,
            meshContentHash: exportRequest.meshContentHash,
            reimportMeshHash,
            exportOperationId: exportRequest.exportOperationId,
            caseJournalHash: exportRequest.caseJournalHash,
            kernelVersion: exportRequest.kernelVersion,
            profileId: exportRequest.materialProfile.id,
            profileVersion: exportRequest.materialProfile.version,
            profileChecksum: exportRequest.materialProfile.checksum,
            qcReportJson: JSON.stringify(serverReport),
            acknowledgmentsJson: JSON.stringify(exportRequest.acknowledgments),
          },
        });

        return {
          released: true as const,
          exportId: row.id,
          caseId: row.caseId,
          restorationId: row.restorationId,
          restorationType: row.restorationType,
          teeth: exportRequest.teeth,
          format: exportRequest.format,
          bytesSha256: row.bytesSha256,
          byteLength: row.byteLength,
          meshContentHash: row.meshContentHash,
          reimportMeshHash: row.reimportMeshHash,
          downloadPath: `/api/exports/${row.bytesSha256}/download`,
          releasedAt: row.releasedAt.toISOString(),
          alreadyStored: stored.alreadyExisted,
          qcReport: serverReport,
        };
      } catch (error) {
        if (error instanceof ExportRejectionError) {
          reply.code(error.httpStatus);
          return { error: error.code, message: error.message, details: error.details };
        }
        throw error;
      }
    },
  );

  // GET /api/exports/:hash/download — streams the EXACT stored released
  // bytes. The stored object's hash is re-verified on EVERY read (content-
  // addressed storage makes this a pure function check): tamper-on-disk or a
  // missing object behind an existing ledger row is a typed 500 — corrupt
  // bytes are NEVER served.
  app.get<{ Params: { hash: string } }>(
    '/api/exports/:hash/download',
    { schema: { params: meshHashParamsSchema, response: exportDownloadResponseSchema } },
    async (request, reply) => {
      const hash = request.params.hash;
      const row = await prisma.export.findFirst({
        where: { bytesSha256: hash },
        orderBy: { releasedAt: 'asc' },
      });
      if (!row) {
        reply.code(404);
        return { error: 'export-not-found', message: `no released export with bytes hash ${hash}` };
      }
      const bytes = await readMeshBytes(exportsDataDir, hash);
      if (!bytes) {
        reply.code(500);
        return {
          error: 'export-storage-integrity',
          message: `release ${row.id} exists but its stored bytes are missing — storage corrupted; refusing to serve`,
        };
      }
      const actual = sha256HexOf(bytes);
      if (actual !== hash) {
        reply.code(500);
        return {
          error: 'export-storage-integrity',
          message:
            `stored bytes for release ${row.id} hash to ${actual}, not ${hash} — tampered/corrupted on disk; ` +
            'refusing to serve',
        };
      }
      // model/stl is IANA-registered; PLY has no registered type, so the
      // generic byte stream type is the honest choice.
      reply.type(row.format === 'stl' ? 'model/stl' : 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${downloadFilename(row)}"`);
      reply.header('content-length', String(bytes.byteLength));
      return reply.send(bytes);
    },
  );
}
