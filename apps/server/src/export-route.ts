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
// ## The byte-derived vs riding vs server-pinned boundary (decided Task 4;
// ## corrected by the F1 fix round)
//
// THREE input classes, not two:
//  - BYTE-DERIVED: the restoration SOLID. The re-imported mesh replaces it
//    everywhere it appears in the gate inputs — `RunCrownQcInput.crownSolid`,
//    `RunInlayQcInput.inlaySolid`, `RunBridgeQcInput.assembledSolid` (the
//    watertight/manifold stats, the self-intersection measurement, the
//    seating boolean, and the bridge marginFit's fit-patch extraction all
//    measure IT).
//  - RIDING (geometry-scoped, genuinely unrecoverable from mill bytes): the
//    prep die(s), inner/outer/fit/patch/unit surfaces, the tooth-with-cavity
//    solid, margin/outline polylines, seam edges, cavity triangle indices,
//    insertion axes, and MEASURED values (contact residuals, connector
//    minimum areas, the pontic-relief deviation scalar). Design-time
//    context, not the deliverable — the validate-qc precedent holds for
//    THIS class.
//  - SERVER-PINNED (the F1 correction): clinical gate THRESHOLDS. They have
//    an authoritative server-side source (`@dqcad/clinical-profiles`), so
//    riding them unverified let a request loosen a gate invisibly at the
//    release boundary (the review's demonstrated 295 µm-wall exploit). The
//    route resolves the profile by id+version, verifies its checksum, and
//    verifies every profile-derived constant in `qcContext` equals the
//    resolved value under the client engines' own resolution rules
//    (export-profile.ts; divergence → 409, never silent substitution). The
//    free tolerance knobs with no profile source are schema-FORBIDDEN in
//    the export contexts entirely (schemas.ts EXPORT_CONTEXT_FORBIDDEN_KNOBS
//    — both sides use the cad-pipeline gate defaults). Report metadata +
//    acknowledged gates are likewise derived from VERIFIED request identity
//    fields (`kernelVersion` checked against the server's own
//    KERNEL_VERSION; `profileVersion` from the resolved profile's version;
//    `journalHash` stamped as `meshContentHash` — the P4 convention that
//    `QcReport.journalHash` carries the finalMesh content hash; acknowledged
//    gates from the journal-verified `acknowledgments`), so a
//    context/request disagreement cannot be smuggled past the diff.
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
//  6. journal verification (export op binding
//     incl. headerText, restoration/finalMesh,
//     ack refs; N4: operationId null → refuse)    → 409 (three codes)
//  7. kernel version                              → 409 export-kernel-version-mismatch
//  8. material-profile pinning (F1): resolve by
//     id+version, verify checksum, verify every
//     riding profile-derived threshold            → 409 (three codes)
//  9. delivered STL header vs journaled
//     headerText (N1)                             → 400 export-header-mismatch
// 10. parse + intake + cleanliness                → 400 (two codes)
// 10.5 MANDATORY finalMesh byte provenance +
//     outer-envelope certification (Task 8):
//     absent → 409 export-final-mesh-not-persisted;
//     mismatch → 409 export-outer-envelope-mismatch
// 11. QC recompute on the re-imported solid;
//     typed pipeline input errors                 → 400 qc-invalid-input
// 12. exact diff vs request.qcReport              → 409 export-qc-mismatch
//     (+ PERSISTED ExportDiagnostic bundle)
// 13. authorization: server report must pass
//     (failing gates all acknowledged)            → 409 export-gates-failing
// 14. release: content-addressed immutable store
//     + Export ledger row                         → 200
//
// ## OUTER-ENVELOPE CERTIFICATION (review F2 — CLOSED Phase 7 Task 6 Part A;
// ## see ADR-015 + step 10.5 below)
//
// The F2 gap: a coordinated byte tamper that moves a welded vertex IDENTICALLY
// across all its per-triangle soup occurrences, outward and away from the
// die(s), welds cleanly, stays watertight/manifold/single-component, and left
// EVERY gate value unchanged (thickness/marginFit measure the RIDING
// inner/outer surfaces; the solid-consuming gates are insensitive to an outward
// move) — so the server report matched the client report while the delivered
// bytes carried moved geometry. It RELEASED. The step-10.5 assertion below is
// the SOLE source of the `export-outer-envelope-mismatch` code, so the
// always-on `moved-vertex → 409` regression (export-outer-envelope.test.ts)
// fails the instant the block is removed — that green test IS the guard (there
// is deliberately NO env switch that can disable the assertion in a
// deployment).
//
// The closure: the client now persists the finalMesh bytes content-addressed
// (the lossless `@dqcad/io` DQFM container → `POST /api/final-meshes`, keyed by
// `stages.finalMesh`), and step 10.5 resolves `stages.finalMesh`
// (journal-verified to equal `meshContentHash`) to the exact Float64 design
// solid and asserts `hashMesh(reimport) === hashMesh(narrow32(canon(
// storedFinalMesh)))`. A mismatch is a typed 409 with a persisted diagnostic —
// the moved-vertex construction is rejected post-fix.
//
// SCOPE of the defense (Task 8 — HARDENED to mandatory): the certification is
// no longer conditional. The endpoint REFUSES a release whose finalMesh bytes
// are not persisted (`export-final-mesh-not-persisted`, 409), so there is no
// F2-open release path left: every release either certifies the outer envelope
// (byte-provenance asserted) or is refused. With the defense now unconditional,
// the T5 disclosure flips — a release document records
// `outerEnvelopeCertified: true` (traceability schemaVersion 2; see
// shared-types traceability.ts's schemaVersion history + the T8 report's
// ADR-005-style note). Previews still certify nothing and keep the disclosure.
//
// ## Facet normals (review N1c — position stated)
//
// STL per-facet normal fields are NOT verified: intake recomputes normals
// from vertex winding and discards stored ones, so re-validation certifies
// the GEOMETRY regardless of what the normal fields claim, and the T2 writer
// guarantees winding-outward orientation of the shipped bytes. A mill that
// recomputes from winding (the norm, and what this repo's own parsers do) is
// unaffected; a mill that TRUSTS stored normals could see tampered normal
// fields on a consistent-adversary tamper. A "stored normal agrees with
// winding" check is a possible cheap follow-up; today the position is
// documented, not enforced.
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
import type {
  CaseDocument,
  QcReport,
  QcTraceabilityDocument,
  RestorationExportRequest,
} from '@dqcad/shared-types';
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
import { EXPORT_STL_HEADER_TEXT, exportPlyBinary, exportStlBinary } from '@dqcad/io';
import type { IndexedMesh } from '@dqcad/kernel';
import {
  decodeExportBytes,
  reimportExportedBytes,
  verifyExportJournal,
  verifyStlHeaderBytes,
  ExportRejectionError,
  type ReimportResult,
} from './export-validation.js';
import { readFinalMesh } from './final-mesh-storage.js';
import { renderTraceabilityHtml, type TraceabilityLocale } from '@dqcad/traceability';
import { validateTraceabilityDocument } from '@dqcad/traceability/validate';
import { resolveExportMaterialProfile, verifyProfileThresholds } from './export-profile.js';
import { buildReleaseTraceability, type TraceabilityReleaseRecord } from './export-traceability.js';
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
  MeshIndexOutOfBoundsError,
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
  exportTraceabilityParamsSchema,
  exportTraceabilityQuerySchema,
  exportTraceabilityResponseSchema,
  meshHashParamsSchema,
} from './schemas.js';

// --- qcContext body typing (the validate-qc bodies minus the byte-derived
// solid and the request-derived metadata — see schemas.ts's export section) ---

// The free tolerance knobs (marginFit/seamDihedral/seating/contact overrides,
// crown `connectors`, per-unit `marginExclusionMm`, `ponticRelief.thresholdMm`)
// are deliberately ABSENT from these types — schema-forbidden (schemas.ts
// EXPORT_CONTEXT_FORBIDDEN_KNOBS, the F1 fix round).

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
  /** The client's journaled morph→shell heal @errorBound (mm) — a RIDING param
   * the server cannot recompute from the delivered bytes (the pre-heal outer is
   * design-time), SUMMED by the contact gate exactly as the client did so the
   * client-attested contact verdict agrees. Omitted ⇒ 0. */
  healErrorBoundMm?: number;
}

export interface InlayExportQcContext {
  fitSurfaceMesh: MeshDataInput;
  patchMesh: MeshDataInput;
  toothWithCavitySolid: MeshDataInput;
  cavityOutlineResampledPoints: number[][];
  insertionAxis: number[];
  thicknessMinimums: { inlayMinThicknessMm: number; onlayMinThicknessMm: number };
  marginExclusionMm: number;
  coverage?: {
    coverageDivider: { pointMm: number[]; normalMm: number[] };
    cuspCoverageMinThicknessMm: number;
  };
  seamEdges: SeamEdgeInput[];
  cavityTriangleIndices: number[];
  contacts: ContactResidualInput[];
  contactClampWarning: boolean;
}

export interface BridgeExportQcContext {
  units: Omit<BridgeUnitInput, 'marginExclusionMm'>[];
  dieSolids: MeshDataInput[];
  connectors: BridgeConnectorInput[];
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  frameworkMode?: boolean;
  frameworkMinThicknessMm?: number;
  ponticRelief: { maxAbsDeviationMm: number; style: string; configuredReliefMm: number };
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

// --- H1 fix (server code-review): the client-attested gate disclosure ------
//
// The export re-validation re-measures the SOLID-CONSUMING gates on the
// re-imported mill bytes (watertight, manifold, self-intersection, min-wall,
// marginFit, seating — invariant 6, literally). THREE gates instead consume a
// client-MEASURED scalar the server cannot recompute from the delivered bytes:
//   - `connectorCrossSection` (bridge): `connectors[i].minAreaMm2`. The kernel
//     `measureConnectorMinArea(mesh, frame, profileA, profileB)` needs the
//     design-time connector FRAME (axis/origin/span from the per-unit solid
//     centroids) and the 2D connector PROFILES (default ellipse OR the editable
//     per-connector profiles) — NONE of which is carried in the export request
//     or recoverable from the fused assembled solid alone. Not tractable to
//     recompute server-side.
//   - `ponticRelief` (bridge): `maxAbsDeviationMm`. `measurePonticRelief` needs
//     the design-time GINGIVA mesh + the pontic-base acceptance patch — neither
//     in the request nor the mill bytes.
//   - `contact` (crown/cavity): `contactResidualMm`/`regionResidualMm`. These
//     are the Task-6 morph residuals against the antagonist/neighbour meshes —
//     design-time context, never in the deliverable.
//
// DECISION (ADR-017 extension): recompute is NOT tractable for any of the three,
// so the HONEST MINIMUM applies — the release RECORD (this response + the Export
// ledger row) explicitly marks these gates CLIENT-ATTESTED, mirroring the
// archive `importedUnverified` provenance. The gate's `passed:true` is therefore
// never presented as a full-authority server-verified pass: a consumer can
// always distinguish a fully-recomputed release from one whose fracture/relief/
// contact gates rest on attested measurements. See the module doc's RIDING
// class — the boundary is unchanged; what changes is that the trust is now
// DISCLOSED, not silent.
const CLIENT_ATTESTED_GATE_NAMES = {
  connectorCrossSection: 'connectorCrossSection',
  ponticRelief: 'ponticRelief',
  contact: 'contact',
} as const;

/**
 * The gate names in `report` whose MEASURED value the server consumed from the
 * client rather than recomputing from the re-imported solid. Computed by
 * intersecting the branch's known client-measured gate set with the gates that
 * ACTUALLY appear in the server report (so e.g. a crown's N/A connector stub —
 * which trusts no client scalar — is never listed, and the single-crown path
 * lists only `contact`). Deterministic; order follows the report's gate order.
 */
function clientAttestedGates(ctx: ExportQcContext, report: QcReport): string[] {
  const branch = contextBranch(ctx);
  const measured = new Set<string>();
  if (branch === 'bridge') {
    const b = ctx as BridgeExportQcContext;
    // A bridge always spans ≥1 connector; list it only when real connectors are
    // supplied (the gate consumes their `minAreaMm2`), never the N/A stub.
    if (b.connectors.length > 0) measured.add(CLIENT_ATTESTED_GATE_NAMES.connectorCrossSection);
    measured.add(CLIENT_ATTESTED_GATE_NAMES.ponticRelief);
  } else {
    // crown + cavity: the contact gate consumes the client morph residuals.
    measured.add(CLIENT_ATTESTED_GATE_NAMES.contact);
  }
  return report.gates.map((g) => g.gate).filter((name) => measured.has(name));
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
  // NOTE (F1): every threshold read from `ctx` below has already been
  // verified EQUAL to its server-resolved authority (verifyProfileThresholds
  // — called before this function), so feeding the riding values IS running
  // with server-resolved thresholds; the free tolerance knobs no longer
  // exist in the export contexts at all (both sides use gate defaults).
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
      },
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
    healErrorBoundMm: k.healErrorBoundMm,
    marginExclusionMm: k.marginExclusionMm,
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

/** The canonical, format-narrowed re-index of a Float64 solid — exactly what
 * a CLEAN export of `mesh` re-imports to (the T2 equivalence: STL =
 * `narrow32(canon(mesh))`, PLY = `canon(mesh)`). Computed by serializing with
 * the SAME certified export writers and re-importing with the SAME intake path
 * the delivered bytes go through, so `hashMesh` of this reference is directly
 * comparable to `reimportMeshHash` with no bespoke canon/narrow32
 * re-implementation. */
function referenceReimportHash(mesh: IndexedMesh, format: 'stl' | 'ply'): string {
  const bytes = format === 'stl' ? exportStlBinary(mesh) : exportPlyBinary(mesh);
  return hashMesh(reimportExportedBytes(bytes, format).mesh);
}

export interface ExportRouteDeps {
  prisma: PrismaClient;
  /** Content-addressed released-bytes store directory (mesh-storage
   * machinery; immutable, write-once). */
  exportsDataDir: string;
  /** Content-addressed final-mesh container store (final-mesh-storage.ts) —
   * keyed by `stages.finalMesh`; the outer-envelope certification's byte
   * provenance (Phase 7 Task 6 Part A, the F2 closure). */
  finalMeshDataDir: string;
  /** Body-size ceiling for the export POST. The body carries the base64
   * bytes (4/3 × raw + padding — the largest fixture solid is ~2.7 MB STL ≈
   * 3.6 MB base64) PLUS the riding qcContext meshes as JSON number arrays,
   * which dominate (tens of MB for a marching-cubes fit surface) — exactly
   * the payload class the validate-qc route already provisions
   * `meshMaxBytes` for, so the same ceiling is shared deliberately. */
  meshMaxBytes: number;
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { prisma, exportsDataDir, finalMeshDataDir, meshMaxBytes } = deps;

  app.post<{ Params: { id: string }; Body: ExportRequestBody }>(
    '/api/restorations/:id/export',
    {
      bodyLimit: meshMaxBytes,
      schema: {
        params: caseIdParamsSchema,
        body: exportBodySchema,
        response: exportResponseSchema,
      },
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
          throw new ExportRejectionError(
            'export-case-not-found',
            404,
            `no case ${exportRequest.caseId}`,
            {
              caseId: exportRequest.caseId,
            },
          );
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

        // 6. Journal verification: export-op binding (headerText included),
        // restoration/finalMesh, acknowledgment refs (N4: null → refuse;
        // P6-T8: tampering → refuse). Returns the verified restoration (its
        // saved, schema-bounded params feed the crown threshold authority).
        const restoration = verifyExportJournal(document, exportRequest);

        // 7. Kernel version: a report recomputed on a different kernel is not
        // comparable (determinism is per kernel version) — refuse rather than
        // produce a misleading diff.
        if (exportRequest.kernelVersion !== KERNEL_VERSION) {
          throw new ExportRejectionError(
            'export-kernel-version-mismatch',
            409,
            `the export was produced on kernel ${exportRequest.kernelVersion} but this server runs ${KERNEL_VERSION}`,
            {
              requestKernelVersion: exportRequest.kernelVersion,
              serverKernelVersion: KERNEL_VERSION,
            },
          );
        }

        // 8. Material-profile pinning (review F1): resolve the profile
        // server-side by id+version, verify its checksum, and verify every
        // riding profile-derived threshold equals the resolved authority —
        // a loosened threshold is a typed 409, never a silent release-gate
        // weakening (invariant 4).
        const profile = resolveExportMaterialProfile(exportRequest.materialProfile);
        verifyProfileThresholds(exportRequest, qcContext, profile, restoration);

        // 9. Delivered STL header must be the journaled headerText's exact
        // writer rendering (review N1) — a header tamper is refused even
        // with fully consistent hash bookkeeping.
        if (exportRequest.format === 'stl') {
          verifyStlHeaderBytes(bytes, exportRequest.headerText);
        }

        // 10. Parse + intake the EXACT bytes — the re-imported solid is the
        // only restoration geometry the QC below ever sees.
        const reimport = reimportExportedBytes(bytes, exportRequest.format);
        const reimportMeshHash = hashMesh(reimport.mesh);

        // 10.5. OUTER-ENVELOPE CERTIFICATION — MANDATORY (Phase 7 Task 8; the
        // T4-F2 closure, hardened from the Task-6 opt-in). Resolve
        // `stages.finalMesh` (journal-verified at step 6 to equal
        // request.meshContentHash) to the EXACT Float64 design solid and assert
        // the delivered geometry IS that solid, up to the T2 narrowing:
        // `reimportMeshHash === hashMesh(narrow32(canon(storedFinalMesh)))`.
        // This is the reference-envelope check the solid-consuming gates cannot
        // provide (they are insensitive to an outward vertex move — the F2
        // limitation).
        //
        // Task 8 makes the byte provenance MANDATORY: when `stages.finalMesh`
        // is not resolvable server-side (never uploaded), the release is
        // REFUSED (`export-final-mesh-not-persisted`, 409) — no release without
        // the provenance the certification needs. This closes the Task-6
        // opt-in gap where a client that skipped the finalMesh upload reached
        // the F2-open path and released uncertified. The normal client flow
        // uploads the finalMesh container before exporting
        // (persistence.uploadMissingFinalMeshes → POST /api/final-meshes), so a
        // legitimate export always resolves here; a request whose finalMesh was
        // never persisted is refused, not released. Because a release can now
        // only be produced after this assertion passes, every released
        // document's outer envelope IS certified — the T5
        // `outerEnvelopeCertified` disclosure flips to `true` (traceability
        // schemaVersion 2; see shared-types traceability.ts).
        const storedFinalMesh = await readFinalMesh(finalMeshDataDir, exportRequest.meshContentHash);
        if (!storedFinalMesh) {
          reply.code(409);
          return {
            error: 'export-final-mesh-not-persisted',
            message:
              'the final-design mesh bytes (stages.finalMesh = ' +
              `${exportRequest.meshContentHash}) are not persisted server-side, so the delivered outer ` +
              'envelope cannot be certified against the design solid — the release is REFUSED (Task 8: ' +
              'finalMesh persistence is mandatory; upload it via POST /api/final-meshes before exporting). ' +
              'Nothing was released (invariant 6).',
            meshContentHash: exportRequest.meshContentHash,
          };
        }
        const referenceHash = referenceReimportHash(storedFinalMesh, exportRequest.format);
        if (referenceHash !== reimportMeshHash) {
          const bundle = {
            reason: 'outer-envelope-mismatch',
            caseId: exportRequest.caseId,
            restorationId: exportRequest.restorationId,
            restorationType: exportRequest.restorationType,
            format: exportRequest.format,
            bytesSha256: exportRequest.bytesSha256,
            meshContentHash: exportRequest.meshContentHash,
            reimportMeshHash,
            referenceHash,
            parseDiagnostics: reimport.parseDiagnostics,
          };
          const diagnostic = await prisma.exportDiagnostic.create({
            data: {
              caseId: exportRequest.caseId,
              restorationId: exportRequest.restorationId,
              reason: 'outer-envelope-mismatch',
              bytesSha256: exportRequest.bytesSha256,
              bundleJson: JSON.stringify(bundle),
            },
          });
          reply.code(409);
          return {
            error: 'export-outer-envelope-mismatch',
            message:
              'the re-imported export geometry does not match the persisted design solid ' +
              `(stages.finalMesh) up to the format narrowing — the delivered OUTER ENVELOPE is not the ` +
              'certified design (a moved/tampered vertex the solid-consuming gates cannot see); nothing ' +
              `was released (invariant 6). Diagnostic bundle persisted as ${diagnostic.id}.`,
            diagnosticId: diagnostic.id,
            referenceHash,
            reimportMeshHash,
          };
        }
        // Reaching here: the outer envelope is certified (byte-provenance
        // asserted). The release document records `outerEnvelopeCertified:
        // true` by construction (schemaVersion 2) — see step 14.

        // 11. Independent QC recompute (typed pipeline input errors → 400,
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
            error instanceof NonCavityRestorationTypeError ||
            error instanceof MeshIndexOutOfBoundsError
          ) {
            throw new ExportRejectionError('qc-invalid-input', 400, error.message, {
              errorName: error.name,
            });
          }
          throw error;
        }

        // 12. Exact-equality diff against the client report (compare-only —
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

        // 13. Authorization: the SERVER's report must pass — every failing
        // gate covered by a journal-verified acknowledgment (`runQcGates`
        // semantics: `passed` is true iff every gate passed or is an
        // acknowledged failure). Reaching here with a failing report means
        // the client report AGREED (no diff), i.e. a hand-built request
        // shipped a knowingly-unauthorized export — refused, never released.
        if (!serverReport.passed) {
          const failingGates = serverReport.gates
            .filter((g) => !g.passed && !g.acknowledged)
            .map((g) => g.gate);
          reply.code(409);
          return {
            error: 'export-gates-failing',
            message:
              `the server re-validation FAILED ${failingGates.length} unacknowledged gate(s) on the exported ` +
              `bytes (${failingGates.join(', ')}) — the export is refused (invariant 4: gates block export)`,
            failingGates,
          };
        }

        // 13.5. H1 fix: the client-attested gate disclosure. Reaching here the
        // server report PASSED (every solid-consuming gate recomputed on the
        // re-imported bytes). These gates' MEASURED value could not be
        // recomputed from the delivered bytes (see clientAttestedGates' doc) —
        // record them so the release is never presented as a full-authority
        // server-verified pass for them (invariant 6 disclosure, mirroring the
        // archive `importedUnverified` provenance).
        const attestedGates = clientAttestedGates(qcContext, serverReport);

        // 14. Release: content-addressed immutable storage + ledger row +
        // the Task 5 traceability document (built from the SERVER's report
        // and the VERIFIED request bindings, schema-validated at generation,
        // stored as canonical JSON — the same record-assembly module the
        // regeneration path uses, so stored and regenerated documents are
        // byte-identical by construction).
        const stored = await storeMeshBytes(exportsDataDir, bytes);
        if (stored.hash !== exportRequest.bytesSha256) {
          // Unreachable (step 1 verified the hash over the same bytes) —
          // asserted anyway: releasing under a different address would break
          // the download contract.
          throw new Error(
            `export release integrity: stored hash ${stored.hash} != verified bytesSha256 ${exportRequest.bytesSha256}`,
          );
        }
        const releaseRecord: TraceabilityReleaseRecord = {
          caseId: exportRequest.caseId,
          restorationId: exportRequest.restorationId,
          restorationType: exportRequest.restorationType,
          // VERIFIED at step 6 (review B1): request = saved restoration =
          // journaled export op, exact sequence — so feeding the request
          // value IS the saved authority (the T4-F1 equality pattern).
          teeth: exportRequest.teeth,
          format: exportRequest.format,
          bytesSha256: exportRequest.bytesSha256,
          byteLength: exportRequest.byteLength,
          meshContentHash: exportRequest.meshContentHash,
          // STL: verified byte-for-byte against the delivered header (step
          // 9); when the request carried none, the delivered header IS the
          // writer's deterministic default (step 9 verified exactly that),
          // so the record states it explicitly.
          headerText:
            exportRequest.format === 'stl'
              ? (exportRequest.headerText ?? EXPORT_STL_HEADER_TEXT)
              : null,
          reimportMeshHash,
          exportOperationId: exportRequest.exportOperationId,
          caseJournalHash: exportRequest.caseJournalHash,
          journalOperationCount: exportRequest.journalOperationCount,
          profile: exportRequest.materialProfile,
          serverReport,
          acknowledgments: exportRequest.acknowledgments,
          // H1 fix: thread the client-attested gate list (computed at step 13.5,
          // also stored as `attestedGatesJson`) INTO the traceability document
          // so the regulatory record discloses them (a `gates-client-attested`
          // limitation). The regeneration path reads the same list from the
          // stored column, so release + regeneration build byte-identical docs.
          clientAttestedGates: attestedGates,
        };
        const traceability = buildReleaseTraceability(releaseRecord, reimport.mesh.positions);
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
            headerText: releaseRecord.headerText,
            reimportMeshHash,
            exportOperationId: exportRequest.exportOperationId,
            caseJournalHash: exportRequest.caseJournalHash,
            journalOperationCount: exportRequest.journalOperationCount,
            kernelVersion: exportRequest.kernelVersion,
            profileId: exportRequest.materialProfile.id,
            profileVersion: exportRequest.materialProfile.version,
            profileChecksum: exportRequest.materialProfile.checksum,
            qcReportJson: JSON.stringify(serverReport),
            acknowledgmentsJson: JSON.stringify(exportRequest.acknowledgments),
            traceabilityJson: traceability.json,
            // H1 fix: provenance of the client-attested gates (never hashed).
            attestedGatesJson: JSON.stringify(attestedGates),
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
          traceabilityJsonPath: `/api/exports/${row.id}/traceability.json`,
          traceabilityHtmlPath: `/api/exports/${row.id}/traceability.html`,
          releasedAt: row.releasedAt.toISOString(),
          alreadyStored: stored.alreadyExisted,
          qcReport: serverReport,
          clientAttestedGates: attestedGates,
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

  // --- Task 5: the traceability document routes. Keyed by the export
  // LEDGER ROW id (per release event), unlike the per-content download
  // `:hash` — a re-release shares bytes but has its own row + document. ---

  /** Shared row lookup + READ-PATH INTEGRITY GATE (review S1 — the
   * download-route symmetry: corrupt bytes are never served, and neither is
   * a corrupt regulatory record). 404 typed for an unknown id; 404
   * `export-traceability-missing` for a legacy (pre-Task-5) row; a stored
   * document that no longer PARSES or no longer VALIDATES against the
   * shared-types schema — a tampered/corrupted row — is a typed 500, never
   * served. Cheap on every read: the ajv validator is compiled once at
   * module load. */
  async function findTraceabilityRow(
    id: string,
  ): Promise<{ json: string; document: QcTraceabilityDocument; releasedAt: Date }> {
    const row = await prisma.export.findUnique({ where: { id } });
    if (!row) {
      throw new ExportRejectionError('export-not-found', 404, `no released export with id ${id}`, {
        id,
      });
    }
    if (row.traceabilityJson === null) {
      throw new ExportRejectionError(
        'export-traceability-missing',
        404,
        `release ${id} predates the traceability record — no stored document`,
        { id },
      );
    }
    let document: QcTraceabilityDocument;
    try {
      document = JSON.parse(row.traceabilityJson) as QcTraceabilityDocument;
    } catch {
      throw new ExportRejectionError(
        'export-storage-integrity',
        500,
        `the stored traceability document for release ${id} is not parseable JSON — ` +
          'tampered/corrupted row; refusing to serve',
        { id },
      );
    }
    const validation = validateTraceabilityDocument(document);
    if (!validation.valid) {
      throw new ExportRejectionError(
        'export-storage-integrity',
        500,
        `the stored traceability document for release ${id} no longer validates against the schema — ` +
          'tampered/corrupted row; refusing to serve a corrupt regulatory record',
        { id, errors: validation.errors },
      );
    }
    return { json: row.traceabilityJson, document, releasedAt: row.releasedAt };
  }

  // GET /api/exports/:id/traceability.json — serves the STORED canonical
  // document bytes VERBATIM (`reply.send(string)` with a JSON content type
  // bypasses re-serialization deliberately: the stored string IS the
  // deterministic, byte-pinnable core — see schemas.ts's traceability
  // section). No timestamp appears anywhere in this body (the shared-types
  // traceability.ts policy; `releasedAt` stays on the ledger row).
  app.get<{ Params: { id: string } }>(
    '/api/exports/:id/traceability.json',
    {
      schema: {
        params: exportTraceabilityParamsSchema,
        response: exportTraceabilityResponseSchema,
      },
    },
    async (request, reply) => {
      try {
        const stored = await findTraceabilityRow(request.params.id);
        reply.type('application/json; charset=utf-8');
        return reply.send(stored.json);
      } catch (error) {
        if (error instanceof ExportRejectionError) {
          reply.code(error.httpStatus);
          return { error: error.code, message: error.message, details: error.details };
        }
        throw error;
      }
    },
  );

  // GET /api/exports/:id/traceability.html?lang=en|hu|de|es — the PDF-ready
  // human rendering of the SAME stored JSON (one render function, shared
  // with the client preview — no second source of truth). The row's
  // `releasedAt` is passed ONLY as the renderer's labeled non-hashed record
  // envelope (the Task 5 timestamp policy). Deterministic per (row, lang):
  // pure function of stored fields.
  app.get<{ Params: { id: string }; Querystring: { lang: TraceabilityLocale } }>(
    '/api/exports/:id/traceability.html',
    {
      schema: {
        params: exportTraceabilityParamsSchema,
        querystring: exportTraceabilityQuerySchema,
        response: exportTraceabilityResponseSchema,
      },
    },
    async (request, reply) => {
      try {
        const stored = await findTraceabilityRow(request.params.id);
        const html = renderTraceabilityHtml(stored.document, {
          locale: request.query.lang,
          releasedAt: stored.releasedAt.toISOString(),
        });
        reply.type('text/html; charset=utf-8');
        return reply.send(html);
      } catch (error) {
        if (error instanceof ExportRejectionError) {
          reply.code(error.httpStatus);
          return { error: error.code, message: error.message, details: error.details };
        }
        throw error;
      }
    },
  );
}
