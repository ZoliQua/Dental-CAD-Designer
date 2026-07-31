// apps/server/src/archive-route.ts
//
// Phase 7 Task 6 (Part B) — case archive export/import (the acceptance
// criterion: round-trip identical). Two routes:
//
//   POST /api/cases/:id/archive     → a streamed, deterministic DQCA archive of
//                                     the case's ENTIRE state (case document +
//                                     journal + settings + QC + scans + final
//                                     meshes + released exports + traceability).
//   POST /api/archives/import       → reconstruct a case from an archive into
//                                     THIS server/DB (new case, or a confirmed
//                                     overwrite), byte-for-byte identical.
//
// PHI: archives CONTAIN patient scans. Every test builds archives from SYNTHETIC
// fixtures only; no archive (or anything derived from scans/) is ever committed.
//
// Round-trip identity (the acceptance): export → import into a FRESH DB → the
// case document is deep-equal, scan/final-mesh/export bytes are byte-identical
// (content-addressed stores are idempotent + immutable), and the Export ledger
// rows are reconstructed verbatim (original ids + releasedAt preserved). No
// schema migration is needed: Prisma `create` accepts explicit ids/timestamps,
// so provenance is preserved without new columns.
//
// No-silent-mutation (invariant 5): importing over an EXISTING case id is a
// typed 409 conflict the caller must resolve with `?overwrite=true` — never a
// silent overwrite.
//
// ## TRUST BOUNDARY — integrity, NOT authenticity (review F-B1)
//
// An archive is CLIENT-SUPPLIED and UNSIGNED. The DQCA manifest gives INTEGRITY
// (self-hash over descriptive fields + whole-archive + per-entry hashes catch
// corruption/tampering of a fixed archive), NOT AUTHENTICITY — an adversary who
// rewrites the whole archive recomputes every hash. On import, the case document
// and every Export ledger row (`qcReportJson`, `traceabilityJson`,
// `acknowledgmentsJson`, hashes) are reconstructed VERBATIM. They are NOT
// re-validated: a full re-validation would re-run the export QC, but the riding
// `qcContext` (inner/outer/fit surfaces, dies, polylines) it needs is design-
// time context the release ledger deliberately never persisted (only the
// finalMesh solid + released bytes are content-addressed), so it is not
// recoverable from the archive. Re-running QC on import is therefore NOT
// tractable in this design. Instead, every imported release row is stamped
// `importedUnverified: true` (schema.prisma) so the ledger stays honest — a
// consumer of the `Export` table can always distinguish a server-re-validated
// release from an imported, author-attested one. This is a deliberate second
// ledger write-path whose provenance is explicit, never silently trusted. (A
// future hardening could re-run the geometry-only outer-envelope check on
// imported releases whose finalMesh container is present; the QC-gate re-run
// stays blocked on the un-persisted qcContext.)
import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument } from '@dqcad/shared-types';
import { canonicalStringify } from '@dqcad/clinical-profiles';
import {
  buildCaseArchive,
  CaseArchiveError,
  parseCaseArchive,
  type CaseArchiveInputEntry,
} from './case-archive.js';
import { readMeshBytes, storeMeshBytes } from './mesh-storage.js';
import { readFinalMeshBytes, storeFinalMeshContainer, FinalMeshContentMismatchError } from './final-mesh-storage.js';
import { FinalMeshContainerError } from '@dqcad/io';
import { validateCaseDocument, summarizeCaseDocumentErrors } from './case-document-validate.js';
import {
  archiveImportQuerySchema,
  archiveImportResponseSchema,
  archiveExportResponseSchema,
  caseIdParamsSchema,
} from './schemas.js';

export interface ArchiveRouteDeps {
  prisma: PrismaClient;
  meshDataDir: string;
  finalMeshDataDir: string;
  exportsDataDir: string;
  /** Body-size ceiling for the import POST. An archive bundles the case's MANY
   * scans + final meshes + released export bytes, so it is a LARGER payload
   * class than a single mesh — a DEDICATED ceiling (default 2 GB, env
   * `ARCHIVE_MAX_BYTES`), not the per-mesh limit (review bodyLimit NOTE).
   * Synthetic-fixture archives (the only ones in tests) are tiny. */
  archiveMaxBytes: number;
}

/** The JSON shape an Export ledger row serializes to inside an archive (every
 * column; `releasedAt` as an ISO string). Reconstructed verbatim on import. */
interface ArchivedExportRow {
  id: string;
  caseId: string;
  restorationId: string;
  restorationType: string;
  teethJson: string;
  format: string;
  bytesSha256: string;
  byteLength: number;
  meshContentHash: string;
  reimportMeshHash: string;
  headerText: string | null;
  exportOperationId: string;
  caseJournalHash: string;
  journalOperationCount: number | null;
  kernelVersion: string;
  profileId: string;
  profileVersion: string;
  profileChecksum: string;
  qcReportJson: string;
  acknowledgmentsJson: string;
  traceabilityJson: string | null;
  importedUnverified: boolean | null;
  /** H1 fix (server code-review) — the client-attested gate provenance; carried
   * verbatim so an archived release round-trips identically. */
  attestedGatesJson: string | null;
  releasedAt: string;
}

export function registerArchiveRoutes(app: FastifyInstance, deps: ArchiveRouteDeps): void {
  const { prisma, meshDataDir, finalMeshDataDir, exportsDataDir, archiveMaxBytes } = deps;

  // --- Export ------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/cases/:id/archive',
    { schema: { params: caseIdParamsSchema, response: archiveExportResponseSchema } },
    async (request, reply) => {
      const caseRow = await prisma.case.findUnique({ where: { id: request.params.id } });
      if (!caseRow) {
        reply.code(404);
        return { error: 'archive-case-not-found', message: `no case ${request.params.id}` };
      }
      const document = JSON.parse(caseRow.documentJson) as CaseDocument;
      const entries: CaseArchiveInputEntry[] = [];

      // The case document itself — canonical JSON so the archive is byte-stable.
      entries.push({
        name: 'case-document',
        kind: 'case-document',
        bytes: new TextEncoder().encode(canonicalStringify(document)),
      });

      // Scans: every MeshAsset's persisted file bytes (deduped by fileHash).
      const seenScan = new Set<string>();
      for (const mesh of document.meshes) {
        if (!mesh.fileHash || seenScan.has(mesh.fileHash)) continue;
        seenScan.add(mesh.fileHash);
        const bytes = await readMeshBytes(meshDataDir, mesh.fileHash);
        if (!bytes) {
          reply.code(409);
          return {
            error: 'archive-scan-missing',
            message: `scan mesh ${mesh.fileHash} referenced by the case document is not in the store`,
          };
        }
        entries.push({ name: `scan-mesh/${mesh.fileHash}`, kind: 'scan-mesh', bytes: new Uint8Array(bytes) });
      }

      // Final meshes: each restoration's persisted container (skip if absent —
      // an honest "F2 open" restoration; the archive stays valid without it).
      const seenFinal = new Set<string>();
      for (const restoration of document.restorations) {
        const hash = restoration.stages.finalMesh;
        if (!hash || seenFinal.has(hash)) continue;
        seenFinal.add(hash);
        const bytes = await readFinalMeshBytes(finalMeshDataDir, hash);
        if (bytes) {
          entries.push({ name: `final-mesh/${hash}`, kind: 'final-mesh', bytes: new Uint8Array(bytes) });
        }
      }

      // Released exports: the ledger rows + their content-addressed bytes.
      const exportRows = await prisma.export.findMany({
        where: { caseId: caseRow.id },
        orderBy: { releasedAt: 'asc' },
      });
      const seenExportBytes = new Set<string>();
      for (const row of exportRows) {
        const archived: ArchivedExportRow = { ...row, releasedAt: row.releasedAt.toISOString() };
        entries.push({
          name: `export-row/${row.id}`,
          kind: 'export-row',
          bytes: new TextEncoder().encode(canonicalStringify(archived)),
        });
        if (!seenExportBytes.has(row.bytesSha256)) {
          seenExportBytes.add(row.bytesSha256);
          const bytes = await readMeshBytes(exportsDataDir, row.bytesSha256);
          if (!bytes) {
            reply.code(409);
            return {
              error: 'archive-export-bytes-missing',
              message: `released export ${row.id} bytes ${row.bytesSha256} are not in the store`,
            };
          }
          entries.push({
            name: `export-bytes/${row.bytesSha256}`,
            kind: 'export-bytes',
            bytes: new Uint8Array(bytes),
          });
        }
      }

      const archive = buildCaseArchive(
        { id: caseRow.id, name: caseRow.name, schemaVersion: caseRow.schemaVersion, kernelVersion: KERNEL_VERSION },
        entries,
      );
      reply.type('application/octet-stream');
      reply.header('content-disposition', `attachment; filename="case-${caseRow.id}.dqca"`);
      reply.header('content-length', String(archive.byteLength));
      return reply.send(Buffer.from(archive));
    },
  );

  // --- Import ------------------------------------------------------------

  app.post<{ Body: Buffer; Querystring: { overwrite?: boolean } }>(
    '/api/archives/import',
    {
      bodyLimit: archiveMaxBytes,
      schema: { querystring: archiveImportQuerySchema, response: archiveImportResponseSchema },
    },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        reply.code(415);
        return {
          error: 'archive-invalid',
          message: `POST /api/archives/import requires Content-Type: application/octet-stream with a raw body`,
        };
      }

      let parsed;
      try {
        parsed = parseCaseArchive(new Uint8Array(body));
      } catch (error) {
        if (error instanceof CaseArchiveError) {
          reply.code(400);
          return { error: 'archive-invalid', message: error.message, entryName: error.entryName };
        }
        throw error;
      }

      const docEntry = parsed.entries.get('case-document');
      if (!docEntry) {
        reply.code(400);
        return { error: 'archive-invalid', message: 'archive has no case-document entry' };
      }
      // Parse the reconstructed document. A non-JSON case-document entry is a
      // malformed archive (400), not a 500.
      let parsedDocument: unknown;
      try {
        parsedDocument = JSON.parse(new TextDecoder().decode(docEntry.bytes));
      } catch (error) {
        reply.code(400);
        return {
          error: 'archive-invalid',
          message: `the archive's case-document entry is not parseable JSON: ${(error as Error).message}`,
          entryName: 'case-document',
        };
      }

      // MEDIUM #2 Defect B — validate the reconstructed document against the
      // SAME strict `caseDocumentSchema` that `PUT /api/cases/:id` enforces,
      // BEFORE it is persisted. Import is otherwise a second write-path that
      // could store a document PUT would reject (arbitrary `schemaVersion`,
      // missing/extra fields), which `GET /api/cases/:id` then serves verbatim
      // (ADR-005). An archive is client-supplied + unsigned (its manifest gives
      // integrity, not authenticity), so this gate is load-bearing even though
      // the route is auth-gated. Rejected with a typed 400 naming the failure.
      const validation = validateCaseDocument(parsedDocument);
      if (!validation.valid) {
        reply.code(400);
        return {
          error: 'archive-invalid',
          message:
            'the archive\'s reconstructed case-document does not satisfy the case-document schema ' +
            `(the same contract PUT /api/cases/:id enforces): ${summarizeCaseDocumentErrors(validation.errors)}`,
          entryName: 'case-document',
        };
      }
      const document = parsedDocument as CaseDocument;
      const caseId = document.id;
      const overwrite = request.query.overwrite === true;

      const existing = await prisma.case.findUnique({ where: { id: caseId } });
      if (existing && !overwrite) {
        reply.code(409);
        return {
          error: 'archive-import-conflict',
          message:
            `a case with id ${caseId} already exists — importing would overwrite it. Re-send with ` +
            '?overwrite=true to confirm (invariant 5: no silent mutation).',
          caseId,
        };
      }

      // Parse the export ledger rows (verbatim, original ids + releasedAt
      // preserved) and validate their case-scoping BEFORE any write, so a
      // hostile archive persists NOTHING.
      const exportRowEntries = [...parsed.entries.entries()].filter(([, e]) => e.kind === 'export-row');
      const exportRows: ArchivedExportRow[] = exportRowEntries.map(
        ([, e]) => JSON.parse(new TextDecoder().decode(e.bytes)) as ArchivedExportRow,
      );

      // MEDIUM #2 Defect A — cross-case ledger injection. A crafted (integrity-
      // valid, unsigned) archive can carry `export-row` entries whose `caseId`
      // names a DIFFERENT case than the one being imported. The overwrite path
      // only clears rows for THIS `caseId`, so a foreign-keyed row would inject/
      // pollute an UNRELATED case's release ledger. A legitimate archive (built
      // by the export route) only ever carries rows for its own case, so any
      // mismatch is malformed/hostile: reject with a typed 400 naming the
      // foreign id — never write a row keyed to a case other than the imported
      // one. (The rows are also RE-KEYED to `caseId` below, belt-and-suspenders.)
      for (const row of exportRows) {
        if (row.caseId !== caseId) {
          reply.code(400);
          return {
            error: 'archive-invalid',
            message:
              `an export-row entry is keyed to case ${row.caseId}, but this archive imports case ${caseId} — ` +
              'refusing to inject a release row into a different case\'s ledger (cross-case ledger injection).',
            entryName: `export-row/${row.id}`,
          };
        }
      }

      // Content-addressed stores first (idempotent + immutable): scans, final
      // meshes, released export bytes. A verified archive's entry hashes ARE the
      // content addresses, so storage re-verifies them implicitly.
      let scanCount = 0;
      let finalMeshCount = 0;
      let exportBytesCount = 0;
      for (const [name, entry] of parsed.entries) {
        if (entry.kind === 'scan-mesh') {
          await storeMeshBytes(meshDataDir, Buffer.from(entry.bytes));
          scanCount += 1;
        } else if (entry.kind === 'final-mesh') {
          try {
            await storeFinalMeshContainer(finalMeshDataDir, Buffer.from(entry.bytes));
          } catch (error) {
            if (error instanceof FinalMeshContainerError || error instanceof FinalMeshContentMismatchError) {
              reply.code(400);
              return { error: 'archive-invalid', message: error.message, entryName: name };
            }
            throw error;
          }
          finalMeshCount += 1;
        } else if (entry.kind === 'export-bytes') {
          await storeMeshBytes(exportsDataDir, Buffer.from(entry.bytes));
          exportBytesCount += 1;
        }
      }

      // Transaction: case row + its export rows are reconstructed atomically.
      await prisma.$transaction(async (tx) => {
        if (existing) {
          // Confirmed overwrite: replace the case's document + its ledger rows.
          await tx.export.deleteMany({ where: { caseId } });
          await tx.case.update({
            where: { id: caseId },
            data: {
              name: parsed.manifest.case.name,
              schemaVersion: document.schemaVersion,
              documentJson: JSON.stringify(document),
            },
          });
        } else {
          await tx.case.create({
            data: {
              id: caseId,
              name: parsed.manifest.case.name,
              schemaVersion: document.schemaVersion,
              documentJson: JSON.stringify(document),
            },
          });
        }
        for (const row of exportRows) {
          const data: Prisma.ExportUncheckedCreateInput = {
            id: row.id,
            // Re-keyed to the imported case id (verified equal above) — a row is
            // NEVER written under a foreign case id (MEDIUM #2 Defect A).
            caseId,
            restorationId: row.restorationId,
            restorationType: row.restorationType,
            teethJson: row.teethJson,
            format: row.format,
            bytesSha256: row.bytesSha256,
            byteLength: row.byteLength,
            meshContentHash: row.meshContentHash,
            reimportMeshHash: row.reimportMeshHash,
            headerText: row.headerText,
            exportOperationId: row.exportOperationId,
            caseJournalHash: row.caseJournalHash,
            journalOperationCount: row.journalOperationCount,
            kernelVersion: row.kernelVersion,
            profileId: row.profileId,
            profileVersion: row.profileVersion,
            profileChecksum: row.profileChecksum,
            qcReportJson: row.qcReportJson,
            acknowledgmentsJson: row.acknowledgmentsJson,
            traceabilityJson: row.traceabilityJson,
            // H1 fix: the client-attested gate provenance, carried verbatim
            // (null on pre-column archives) so the imported ledger row preserves
            // it round-trip.
            attestedGatesJson: row.attestedGatesJson ?? null,
            // Provenance: THIS row arrived via import, unverified — stamp it
            // regardless of what the archive claimed (review F-B1). The ledger
            // must never present an imported release as server-re-validated.
            importedUnverified: true,
            releasedAt: new Date(row.releasedAt),
          };
          await tx.export.create({ data });
        }
      });

      reply.code(overwrite && existing ? 200 : 201);
      return {
        imported: true as const,
        caseId,
        overwritten: Boolean(existing),
        counts: {
          scans: scanCount,
          finalMeshes: finalMeshCount,
          exportRows: exportRows.length,
          exportBytes: exportBytesCount,
        },
      };
    },
  );
}
