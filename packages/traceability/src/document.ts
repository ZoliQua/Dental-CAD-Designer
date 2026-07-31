// packages/traceability/src/document.ts
//
// Phase 7 Task 5 — the traceability-document BUILDERS: pure functions from
// explicit inputs to `QcTraceabilityDocument` (shared-types/src/
// traceability.ts holds the shape + the versioned JSON Schema + the
// determinism/timestamp policy — read that module doc first).
//
// ONE builder pair, no second source of truth: the server builds `release`
// documents from its OWN re-validation results (T4's authoritative report +
// verified request identity fields); the client builds `preview` documents
// from its pre-export report. Both feed the SAME render function
// (render.ts) — the "no divergent render logic" requirement.
//
// No clinical value is produced here (CLAUDE.md invariant 7): every number
// in the document comes from the caller's inputs, which on the release path
// are the server-resolved authorities (export-profile.ts's pinning).
import type {
  ExportAcknowledgment,
  ExportFormat,
  ExportRequestMaterialProfile,
  QcReport,
  QcTraceabilityDocument,
  TraceabilityIdentity,
  TraceabilityJournalBinding,
  TraceabilityLimitation,
} from '@dqcad/shared-types';
import { TRACEABILITY_SCHEMA_VERSION } from '@dqcad/shared-types';
import { canonicalStringify } from '@dqcad/clinical-profiles';

/**
 * The outer-envelope non-certification disclosure. As of schemaVersion 2 the
 * T4-F2 gap is CLOSED for releases (mandatory finalMesh persistence + the
 * step-10.5 byte-provenance assertion — export-route.ts), so a RELEASE
 * document no longer carries this. It remains on a PREVIEW document, which
 * certifies nothing (nothing was released): the client preview honestly
 * discloses that a preview is not a certified release record. The `statement`
 * is a FIXED constant (deterministic bytes), never rendered from locale state
 * — the renderer translates the `code` for display and quotes this as the
 * record text.
 */
export const OUTER_ENVELOPE_LIMITATION: TraceabilityLimitation = {
  code: 'outer-envelope-not-certified',
  statement:
    'The release re-validation certifies the QC gate results measured on the re-imported export bytes ' +
    "and their agreement with the client report. It does NOT certify the delivered solid's outer " +
    'envelope against the designed source mesh: no gate compares the delivered outer shape to a ' +
    'reference, and the server holds no byte provenance for the final design mesh. A coordinated ' +
    'modification of the bytes that stays watertight, manifold, clear of the die(s) and consistent ' +
    'with all recorded hashes would not be detected by this release.',
};

/**
 * Stable `code` of the CLIENT-ATTESTED-GATES disclosure. Surfaced as an
 * additional `certification.limitations` entry (NOT a new document field —
 * schemaVersion stays 2, so previously-generated valid documents keep
 * validating and stay byte-identical; a release whose attested-gate list is
 * empty carries no such entry). The server's export re-validation recomputes
 * every SOLID-CONSUMING gate (watertight, manifold, self-intersection, minimum
 * wall thickness, margin fit, seating) on the re-imported mill bytes, but three
 * gates — `connectorCrossSection`/`ponticRelief` (bridge) and `contact`
 * (crown/inlay/onlay) — consume a client-MEASURED scalar whose design-time
 * inputs (connector frame/profiles, pontic↔gingiva relation, contact morph
 * residuals) are recoverable from neither the delivered bytes nor the release
 * request. This disclosure names those gates so a lab/regulator SEES which gate
 * verdicts were client-attested vs independently server-verified (invariant 6
 * disclosure; mirrors the archive `importedUnverified` / server
 * `clientAttestedGates` provenance).
 */
export const CLIENT_ATTESTED_GATES_LIMITATION_CODE = 'gates-client-attested';

/**
 * Builds the client-attested-gates disclosure limitation for a NON-EMPTY gate
 * list. The `statement` (the fixed English record text) is deterministic given
 * the gate-name list — the gate names ride VERBATIM so the disclosure is
 * legible in the JSON and the rendered HTML without a locale lookup (the
 * renderer translates the `code` for the human-facing notice). Gate order
 * follows the caller's list (the server report's gate order — deterministic).
 */
export function clientAttestedGatesLimitation(
  gates: readonly string[],
): TraceabilityLimitation {
  return {
    code: CLIENT_ATTESTED_GATES_LIMITATION_CODE,
    statement:
      'The QC results for the following gates were CLIENT-ATTESTED at release and NOT independently ' +
      `re-verified by the server: ${gates.join(', ')}. Their design-time inputs (bridge connector ` +
      'frame/profiles, pontic-to-gingiva relation, crown/inlay/onlay contact morph residuals) are ' +
      'recoverable from neither the exported mill bytes nor the release request, so the re-validation ' +
      'consumed the client-measured value rather than recomputing it. The solid-consuming gates ' +
      '(watertight, manifold, self-intersection, minimum wall thickness, margin fit, seating) WERE ' +
      'recomputed on the re-imported bytes; the gates listed here must not be read as a full-authority ' +
      'server-verified pass.',
  };
}

/** Thrown on an internally inconsistent release input (format vs narrowing
 * vs headerText) — a genuine caller bug, never a clinical outcome. */
export class ReleaseTraceabilityInputError extends Error {
  constructor(message: string) {
    super(`buildReleaseTraceabilityDocument: ${message}`);
    this.name = 'ReleaseTraceabilityInputError';
  }
}

export interface ReleaseTraceabilityInput {
  identity: TraceabilityIdentity;
  /** The SERVER-recomputed report over the re-imported bytes (the
   * authoritative copy — never the client's). */
  serverReport: QcReport;
  /** The journal-VERIFIED acknowledgments riding into the release. */
  acknowledgments: readonly ExportAcknowledgment[];
  /** The server-resolved, checksum-verified profile identity. */
  materialProfile: ExportRequestMaterialProfile;
  /** The installed manifold-3d build the server kernel ran on. */
  manifoldVersion: string;
  exportFile: {
    format: ExportFormat;
    bytesSha256: string;
    byteLength: number;
    meshContentHash: string;
    /** STL: the journaled header text (header-verified at release);
     * `null` for PLY. */
    headerText: string | null;
  };
  journal: TraceabilityJournalBinding;
  /** The gate names whose MEASURED value the server consumed from the client
   * rather than recomputing from the re-imported solid (the server route's
   * `clientAttestedGates` — the trustworthy source). Non-empty ⇒ the release
   * document carries the `gates-client-attested` disclosure; empty ⇒ no such
   * limitation (and the document stays byte-identical to the pre-disclosure
   * shape). Order is the server report's gate order (deterministic). */
  clientAttestedGates: readonly string[];
  /** Content hash of the re-imported solid the server QC measured. */
  reimportMeshHash: string;
  /** STL: the analytic f32 narrowing bound measured over the DELIVERED
   * coordinates (`@dqcad/io` `measureF32NarrowingError` currency); `null`
   * for PLY (lossless). */
  f32Narrowing: { maxAbsCoordinateMm: number; halfUlpBoundMm: number } | null;
}

/**
 * Builds the RELEASE traceability document — pure, deterministic, zero
 * timestamps (the shared-types traceability.ts policy). Enforces the
 * format-coupled invariants loudly: STL carries a headerText and a
 * narrowing bound; PLY carries neither.
 */
export function buildReleaseTraceabilityDocument(
  input: ReleaseTraceabilityInput,
): QcTraceabilityDocument {
  const { exportFile, f32Narrowing } = input;
  if (exportFile.format === 'stl') {
    if (f32Narrowing === null) {
      throw new ReleaseTraceabilityInputError(
        'an STL release must carry its f32 narrowing bound (the format narrows every coordinate — ' +
          'omitting the bound would drop the documented precision floor from the record)',
      );
    }
    if (exportFile.headerText === null) {
      throw new ReleaseTraceabilityInputError(
        'an STL release must carry the journaled headerText (the delivered header was verified against it)',
      );
    }
  } else {
    if (f32Narrowing !== null) {
      throw new ReleaseTraceabilityInputError(
        'a PLY release must not carry an f32 narrowing bound (the PLY round trip is lossless f64)',
      );
    }
    if (exportFile.headerText !== null) {
      throw new ReleaseTraceabilityInputError('a PLY release carries no headerText');
    }
  }
  return {
    schemaVersion: TRACEABILITY_SCHEMA_VERSION,
    documentKind: 'release',
    identity: input.identity,
    qc: {
      passed: input.serverReport.passed,
      kernelVersion: input.serverReport.kernelVersion,
      profileVersion: input.serverReport.profileVersion,
      // QcReport.journalHash carries the finalMesh CONTENT hash (the P4
      // convention) — renamed in the document to say what it holds.
      finalMeshContentHash: input.serverReport.journalHash,
      gates: input.serverReport.gates,
    },
    acknowledgments: input.acknowledgments,
    materialProfile: input.materialProfile,
    versions: {
      kernelVersion: input.serverReport.kernelVersion,
      manifoldVersion: input.manifoldVersion,
    },
    exportFile: { ...exportFile },
    journal: input.journal,
    reimportVerification: {
      reimportMeshHash: input.reimportMeshHash,
      meshHashRelation:
        exportFile.format === 'stl'
          ? 'stl-canonical-reindex-f32-narrowing'
          : 'ply-lossless-identity',
      // A release document exists ONLY after the exact-equality diff came
      // back empty (a mismatch is a 409, nothing released) — recorded
      // explicitly rather than implied.
      gateResultIdentity: true,
    },
    errorBounds: {
      f32Narrowing:
        f32Narrowing === null
          ? null
          : {
              basis: 'analytic-half-ulp-at-max-coordinate',
              maxAbsCoordinateMm: f32Narrowing.maxAbsCoordinateMm,
              halfUlpBoundMm: f32Narrowing.halfUlpBoundMm,
            },
      gateBoundsCarriedInGateResults: true,
    },
    // schemaVersion 2 (the T4-F2 closure): a release document exists ONLY
    // after the endpoint resolved the persisted final-design mesh and asserted
    // the delivered geometry IS that solid up to the format narrowing
    // (export-route.ts step 10.5 — mandatory since Task 8). So the outer
    // envelope IS certified, and the `outer-envelope-not-certified` disclosure
    // no longer applies to a release. The ONLY limitation a release may carry
    // is the client-attested-gates disclosure — added iff the server marked any
    // gate client-attested (empty ⇒ no entry, so the document stays
    // byte-identical to the pre-disclosure shape).
    certification: {
      outerEnvelopeCertified: true,
      limitations:
        input.clientAttestedGates.length === 0
          ? []
          : [clientAttestedGatesLimitation(input.clientAttestedGates)],
    },
  };
}

export interface PreviewTraceabilityInput {
  identity: TraceabilityIdentity;
  /** The client's CURRENT pre-export QC report. */
  report: QcReport;
  acknowledgments: readonly ExportAcknowledgment[];
  materialProfile: ExportRequestMaterialProfile;
  /** `null` in the browser (no authoritative constant for the installed
   * manifold-3d build client-side — see shared-types traceability.ts). */
  manifoldVersion: string | null;
}

/**
 * Builds the client-side PREVIEW document: same shape, same renderer, but
 * every release-evidence section is `null` (nothing was released — the
 * schema's conditional branch enforces exactly this) and the renderer
 * watermarks it.
 */
export function buildPreviewTraceabilityDocument(
  input: PreviewTraceabilityInput,
): QcTraceabilityDocument {
  return {
    schemaVersion: TRACEABILITY_SCHEMA_VERSION,
    documentKind: 'preview',
    identity: input.identity,
    qc: {
      passed: input.report.passed,
      kernelVersion: input.report.kernelVersion,
      profileVersion: input.report.profileVersion,
      finalMeshContentHash: input.report.journalHash,
      gates: input.report.gates,
    },
    acknowledgments: input.acknowledgments,
    materialProfile: input.materialProfile,
    versions: { kernelVersion: input.report.kernelVersion, manifoldVersion: input.manifoldVersion },
    exportFile: null,
    journal: null,
    reimportVerification: null,
    errorBounds: null,
    certification: { outerEnvelopeCertified: false, limitations: [OUTER_ENVELOPE_LIMITATION] },
  };
}

/**
 * The byte-stable serialization of a traceability document: canonical JSON
 * (object keys sorted recursively, no whitespace — `@dqcad/clinical-
 * profiles`' `canonicalStringify`, the same primitive the profile checksums
 * use). This is the string the server STORES with the release, SERVES
 * verbatim on the JSON route, and the goldens byte-pin: same release ⇒
 * bit-identical bytes, independent of object-construction key order.
 */
export function serializeTraceabilityDocument(document: QcTraceabilityDocument): string {
  return canonicalStringify(document);
}
