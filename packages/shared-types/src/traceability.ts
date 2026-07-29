// packages/shared-types/src/traceability.ts
//
// Phase 7 Task 5 — the QC TRACEABILITY DOCUMENT: the machine-readable
// lab/regulatory record of WHY a released export was released (docs/plans/
// phase-7-export.md Task 5; PLAN.md Phase 7 acceptance 2: "the QC JSON is
// schema-validated").
//
// ## Why a JSON SCHEMA lives in shared-types (a documented exception)
//
// This package is "type declarations only" (see index.ts's top doc). The
// schema constant below is the ONE deliberate exception, and it is still a
// DECLARATION, not logic: a plain, inert JSON-Schema data literal — exactly
// the same "schema objects are declarative data, not behavior" stance as
// apps/server/src/schemas.ts's Fastify schemas. It lives HERE (not in the
// server or the render package) because it is the single validation
// authority BOTH sides bind to: the server validates every generated release
// document against it at generation time, CI validates the pinned golden
// document against it, and `@dqcad/traceability`'s validator compiles it —
// one source, no drift (the acceptance criterion "generation validates
// against it" would be meaningless with per-consumer schema copies).
//
// ## Determinism / timestamp policy (DECIDED here, binds the generators)
//
// The document carries ZERO timestamps — no field of this shape is, or may
// ever become, a wall-clock value. `releasedAt` is a RECORD field on the
// server's Export ledger row ONLY (apps/server/prisma/schema.prisma); a
// renderer may display it alongside the document, but only as an explicitly
// labeled non-hashed envelope value passed OUT-OF-BAND (see
// `@dqcad/traceability`'s `renderTraceabilityHtml` options — the value never
// enters the document object). Consequence: the document is a pure function
// of the release record, `canonicalStringify(document)` is byte-pinnable,
// and regenerating from the stored release record reproduces identical
// bytes (tested server-side). Same-release ⇒ bit-identical JSON.
//
// ## documentKind: 'release' vs 'preview'
//
// `release` is the trustworthy copy: generated SERVER-side at release time
// from the server's OWN re-validation results (T4's authoritative report +
// verified request identity fields — nothing client-supplied that the
// server did not verify). `preview` is the client's pre-export rendering of
// its OWN QC report (same shape, same renderer, watermarked) — it carries
// NO release evidence, so the four release-evidence sections (`exportFile`,
// `journal`, `reimportVerification`, `errorBounds`) are `null` and the
// schema's conditional branch FORBIDS them being anything else (and
// requires them present-and-object for a release). `versions.
// manifoldVersion` is nullable for the same reason: the browser has no
// authoritative constant for the installed manifold-3d build; the server
// does, and a release document must carry it.
//
// schemaVersion history:
//   1 (Phase 7 Task 5) — initial shape; `outerEnvelopeCertified` typed
//     `const false` (no gate/provenance certified the delivered outer
//     envelope) with a mandatory `outer-envelope-not-certified` disclosure.
//   2 (Phase 7 Task 8, ADR-005-style evolution) — the T4-F2 closure landed:
//     the export endpoint now REFUSES a release whose final-design mesh bytes
//     are not persisted server-side (`export-final-mesh-not-persisted`), and
//     asserts the delivered geometry IS that persisted solid up to the format
//     narrowing (step 10.5). Because a release can now ONLY be produced after
//     that assertion passes, a RELEASE document's outer envelope IS certified:
//     `certification.outerEnvelopeCertified` becomes `true` for releases (and
//     the `outer-envelope-not-certified` disclosure is dropped from them). A
//     PREVIEW is not a release and certifies nothing, so it keeps
//     `outerEnvelopeCertified: false` + the disclosure. The type widens from
//     `const false` to `boolean`; the release/preview split is enforced in the
//     schema's `allOf` conditional (release pins `const true`, preview pins
//     `const false` + the disclosure). This byte change to the serialized
//     document is the SOLE sanctioned traceability golden re-pin for the flip.
import type { ExportAcknowledgment, ExportFormat, ExportRequestMaterialProfile } from './index.ts';
import type { FdiTooth, QcGateResult, RestorationType } from './index.ts';

/** Version of the `QcTraceabilityDocument` shape (bumped on breaking
 * change, with a migration note — the ADR-005 discipline). See this
 * module's schemaVersion-history doc for the 1→2 evolution (the T4-F2
 * outer-envelope certification). */
export const TRACEABILITY_SCHEMA_VERSION = 2;

export type TraceabilityDocumentKind = 'release' | 'preview';

/** What the restoration IS — the identity block a lab matches against the
 * physical order. */
export interface TraceabilityIdentity {
  caseId: string;
  restorationId: string;
  restorationType: RestorationType;
  teeth: readonly FdiTooth[];
}

/** The QC report the document records — for a `release` document this is
 * the SERVER-recomputed report over the re-imported export bytes (the
 * authoritative copy), never the client's. Gate `threshold` values are the
 * server-resolved ones (the T4-F1 profile pinning: riding thresholds are
 * verified EQUAL to the `@dqcad/clinical-profiles` authority before any
 * gate runs, so equality with the riding value IS the resolved value).
 * Every approximation bound a gate reports (its `value`/`message` fields —
 * the `@errorBound`-documented measurements) rides through VERBATIM in
 * `gates`; the document adds format-level bounds in `errorBounds` and
 * duplicates nothing. */
export interface TraceabilityQc {
  passed: boolean;
  kernelVersion: string;
  profileVersion: string;
  /** `QcReport.journalHash` — by the Phase 4 convention, the CONTENT hash
   * of the final restoration solid the report ran against (renamed here to
   * say what it holds; see `RestorationExportRequest.caseJournalHash`'s doc
   * for why the two "journal hash" currencies are distinct). */
  finalMeshContentHash: string;
  gates: readonly QcGateResult[];
}

/** The released file — the lab's verification anchors for the bytes it
 * actually received. `null` for a preview (nothing was released). */
export interface TraceabilityExportFile {
  format: ExportFormat;
  /** SHA-256 (lowercase hex) of the released bytes — re-hash the received
   * file and compare. */
  bytesSha256: string;
  byteLength: number;
  /** Content hash of the f64 source solid the bytes serialize
   * (`Restoration.stages.finalMesh`). */
  meshContentHash: string;
  /** STL: the exact journaled header text (verified byte-for-byte against
   * the delivered header at release). `null` for PLY. */
  headerText: string | null;
}

/** The journal binding — ties the release to the case's reproducible
 * operation history. `null` for a preview. */
export interface TraceabilityJournalBinding {
  /** `hashCaseJournal` over the SAVED case journal (export op included). */
  caseJournalHash: string;
  journalOperationCount: number;
  /** `Operation.id` of the journaled `restoration-export` op. */
  exportOperationId: string;
}

/** How `reimportVerification.reimportMeshHash` relates to
 * `exportFile.meshContentHash` — the documented Task 2 equivalence. */
export type TraceabilityMeshHashRelation =
  /** STL: re-import = `narrow32(canon(M))` — canonical first-occurrence
   * re-index + per-coordinate f32 narrowing; hashes legitimately differ. */
  | 'stl-canonical-reindex-f32-narrowing'
  /** PLY: lossless f64 round-trip — hashes are identical. */
  | 'ply-lossless-identity';

/** The server's independent re-import verification summary: the QC above
 * was measured on `intake(parse(bytes))`, and the exact-equality diff
 * against the client's report was EMPTY (`gateResultIdentity`) — the dual
 * validation agreed on the delivered bytes. `null` for a preview. */
export interface TraceabilityReimportVerification {
  reimportMeshHash: string;
  meshHashRelation: TraceabilityMeshHashRelation;
  /** Always `true` on a release document — a gate-result mismatch is a 409
   * (nothing released, no document generated), so a release document can
   * only ever record agreement. Carried explicitly so the record states it
   * rather than implying it. */
  gateResultIdentity: true;
}

/** The binary-STL f32 narrowing bound for THIS export's coordinates —
 * `@dqcad/io`'s `measureF32NarrowingError` currency (Phase 7 Task 2). */
export interface TraceabilityF32NarrowingBound {
  /** How the bound was obtained: the analytic worst case — half a float32
   * ULP at the largest delivered coordinate magnitude (round-to-nearest
   * rounds by at most half a ULP; ULP is monotone in magnitude). The
   * SOURCE-mesh measured error is bounded by this same value (measured and
   * asserted per fixture in Task 2's golden suite). */
  basis: 'analytic-half-ulp-at-max-coordinate';
  /** Largest |coordinate| in the delivered bytes, mm. */
  maxAbsCoordinateMm: number;
  /** The bound itself: `f32UlpAt(maxAbsCoordinateMm) / 2`, mm. */
  halfUlpBoundMm: number;
}

/** Format-level error bounds for the released bytes. `null` for a preview
 * (no bytes exist yet). */
export interface TraceabilityErrorBounds {
  /** STL: the f32 narrowing bound (the format's documented precision
   * floor). `null` for PLY (lossless f64 — the round trip is exact). */
  f32Narrowing: TraceabilityF32NarrowingBound | null;
  /** Fixed marker: every algorithmic approximation bound the QC pipeline
   * documents (`@errorBound` TSDocs) surfaces through the gate results'
   * measured values/messages, which this document carries VERBATIM in
   * `qc.gates` — stated explicitly so a reader knows where to look, and so
   * the schema records that no separate per-gate bound list exists to
   * drift out of sync. */
  gateBoundsCarriedInGateResults: true;
}

/** One honest non-certification statement. `code` is the stable
 * machine-readable identifier (renderers translate it); `statement` is the
 * fixed English record text (deterministic — never generated from locale
 * state). */
export interface TraceabilityLimitation {
  code: string;
  statement: string;
}

/** What this document did and did NOT certify. As of schemaVersion 2 (the
 * T4-F2 closure), `outerEnvelopeCertified` is `true` on a RELEASE document:
 * the release endpoint refuses unless the final-design mesh bytes are
 * persisted server-side and asserts the delivered geometry IS that solid up
 * to the format narrowing (export-route.ts step 10.5), so a release document
 * — which can only exist after that assertion passes — certifies the outer
 * envelope, and carries no `outer-envelope-not-certified` limitation. A
 * PREVIEW is not a release and certifies nothing, so it stays
 * `outerEnvelopeCertified: false` and keeps the disclosure. The type is
 * `boolean` (was `const false` at schemaVersion 1); the const per document
 * kind is pinned in the JSON schema's release/preview `allOf` conditional, so
 * the field still cannot flip freely within a kind without a schema change. */
export interface TraceabilityCertification {
  outerEnvelopeCertified: boolean;
  limitations: readonly TraceabilityLimitation[];
}

export interface TraceabilityVersions {
  /** `@dqcad/kernel`'s KERNEL_VERSION the QC ran on. */
  kernelVersion: string;
  /** The installed manifold-3d build the kernel's booleans ran on —
   * required (string) on a release document; `null` allowed only for a
   * client-built preview (see this file's module doc). */
  manifoldVersion: string | null;
}

/**
 * The QC traceability document — see this file's module doc for the
 * determinism/timestamp policy and the release/preview split. Serialized
 * with `@dqcad/clinical-profiles`' `canonicalStringify` (sorted keys, no
 * whitespace) wherever a byte-stable representation is needed.
 */
export interface QcTraceabilityDocument {
  schemaVersion: typeof TRACEABILITY_SCHEMA_VERSION;
  documentKind: TraceabilityDocumentKind;
  identity: TraceabilityIdentity;
  qc: TraceabilityQc;
  /** Journal-verified acknowledged-with-warning gates (invariant 4: a
   * signer must SEE them — the renderer flags this section prominently). */
  acknowledgments: readonly ExportAcknowledgment[];
  /** The server-verified profile identity (resolved from the registry by
   * id+version, checksum-verified — T4-F1) for a release; the client's
   * resolved identity for a preview. */
  materialProfile: ExportRequestMaterialProfile;
  versions: TraceabilityVersions;
  exportFile: TraceabilityExportFile | null;
  journal: TraceabilityJournalBinding | null;
  reimportVerification: TraceabilityReimportVerification | null;
  errorBounds: TraceabilityErrorBounds | null;
  certification: TraceabilityCertification;
}

// ---------------------------------------------------------------------------
// JSON Schema (draft-07) — the validation authority for the acceptance
// criterion "the QC JSON is schema-validated". Mirrors the types above
// field-for-field; `additionalProperties: false` everywhere (a regulatory
// record must not carry unaudited fields); the `allOf` conditional enforces
// the release/preview evidence split.
// ---------------------------------------------------------------------------

const sha256HexJsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;

/** All 32 permanent-dentition FDI codes (quadrant 1–4 × position 1–8). */
const FDI_TEETH: readonly number[] = [1, 2, 3, 4].flatMap((q) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((p) => q * 10 + p),
);

const gateResultJsonSchema = {
  type: 'object',
  required: ['gate', 'passed', 'acknowledged', 'value', 'threshold', 'unit', 'message'],
  additionalProperties: false,
  properties: {
    gate: { type: 'string', minLength: 1 },
    passed: { type: 'boolean' },
    acknowledged: { type: 'boolean' },
    value: { type: ['number', 'null'] },
    threshold: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    message: { type: 'string' },
  },
} as const;

const acknowledgmentJsonSchema = {
  type: 'object',
  required: ['gate', 'message', 'value', 'threshold', 'unit', 'operationId'],
  additionalProperties: false,
  properties: {
    gate: { type: 'string', minLength: 1 },
    message: { type: 'string' },
    value: { type: ['number', 'null'] },
    threshold: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    /** `null` never validates on a RELEASE document in practice: the server
     * refuses unjournaled acknowledgments (409) before a document can
     * exist. Kept nullable at the schema level because the shape is shared
     * with previews, where a defensive `null` ref is representable. */
    operationId: { type: ['string', 'null'] },
  },
} as const;

const exportFileJsonSchema = {
  type: 'object',
  required: ['format', 'bytesSha256', 'byteLength', 'meshContentHash', 'headerText'],
  additionalProperties: false,
  properties: {
    format: { type: 'string', enum: ['stl', 'ply'] },
    bytesSha256: sha256HexJsonSchema,
    byteLength: { type: 'integer', minimum: 1 },
    meshContentHash: sha256HexJsonSchema,
    headerText: { type: ['string', 'null'] },
  },
} as const;

const journalBindingJsonSchema = {
  type: 'object',
  required: ['caseJournalHash', 'journalOperationCount', 'exportOperationId'],
  additionalProperties: false,
  properties: {
    caseJournalHash: sha256HexJsonSchema,
    journalOperationCount: { type: 'integer', minimum: 1 },
    exportOperationId: { type: 'string', minLength: 1 },
  },
} as const;

const reimportVerificationJsonSchema = {
  type: 'object',
  required: ['reimportMeshHash', 'meshHashRelation', 'gateResultIdentity'],
  additionalProperties: false,
  properties: {
    reimportMeshHash: sha256HexJsonSchema,
    meshHashRelation: {
      type: 'string',
      enum: ['stl-canonical-reindex-f32-narrowing', 'ply-lossless-identity'],
    },
    gateResultIdentity: { type: 'boolean', const: true },
  },
} as const;

const errorBoundsJsonSchema = {
  type: 'object',
  required: ['f32Narrowing', 'gateBoundsCarriedInGateResults'],
  additionalProperties: false,
  properties: {
    f32Narrowing: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['basis', 'maxAbsCoordinateMm', 'halfUlpBoundMm'],
          additionalProperties: false,
          properties: {
            basis: { type: 'string', const: 'analytic-half-ulp-at-max-coordinate' },
            maxAbsCoordinateMm: { type: 'number', minimum: 0 },
            halfUlpBoundMm: { type: 'number', minimum: 0 },
          },
        },
      ],
    },
    gateBoundsCarriedInGateResults: { type: 'boolean', const: true },
  },
} as const;

const limitationItemsJsonSchema = {
  type: 'object',
  required: ['code', 'statement'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1 },
    statement: { type: 'string', minLength: 1 },
  },
} as const;

// The `outer-envelope-not-certified` disclosure a PREVIEW document must carry
// (schemaVersion 2 — reused in the release/preview `allOf` conditional below).
const outerEnvelopeDisclosureContains = {
  type: 'object',
  required: ['code'],
  properties: { code: { type: 'string', const: 'outer-envelope-not-certified' } },
} as const;

// Base certification shape (schemaVersion 2). `outerEnvelopeCertified` is a
// plain boolean here; the release/preview `allOf` conditional pins it to the
// correct const per document kind (release: true; preview: false + the
// disclosure). A schemaVersion-1 document pinned it `const false` with a
// mandatory disclosure for BOTH kinds; the T4-F2 closure (mandatory finalMesh
// persistence + the step-10.5 outer-envelope assertion) makes a release's
// outer envelope certified, so the const now branches on documentKind.
const certificationJsonSchema = {
  type: 'object',
  required: ['outerEnvelopeCertified', 'limitations'],
  additionalProperties: false,
  properties: {
    outerEnvelopeCertified: { type: 'boolean' },
    limitations: { type: 'array', items: limitationItemsJsonSchema },
  },
} as const;

// Release: the outer envelope IS certified (the step-10.5 assertion passed —
// a release document cannot exist otherwise). Pinned `const true`; no
// disclosure required (limitations may be empty).
const releaseCertificationJsonSchema = {
  type: 'object',
  required: ['outerEnvelopeCertified', 'limitations'],
  additionalProperties: false,
  properties: {
    outerEnvelopeCertified: { type: 'boolean', const: true },
    limitations: { type: 'array', items: limitationItemsJsonSchema },
  },
} as const;

// Preview: certifies nothing (nothing was released). Pinned `const false`, and
// the `outer-envelope-not-certified` disclosure is SCHEMA-required (minItems 1
// + contains) — a preview cannot schema-validly drop it (the S2 discipline,
// preserved for previews).
const previewCertificationJsonSchema = {
  type: 'object',
  required: ['outerEnvelopeCertified', 'limitations'],
  additionalProperties: false,
  properties: {
    outerEnvelopeCertified: { type: 'boolean', const: false },
    limitations: {
      type: 'array',
      minItems: 1,
      contains: outerEnvelopeDisclosureContains,
      items: limitationItemsJsonSchema,
    },
  },
} as const;

/**
 * The versioned JSON Schema for `QcTraceabilityDocument` (draft-07). The
 * `allOf` conditional is the release/preview evidence split: a `release`
 * document MUST carry all four evidence sections as objects (and a string
 * `manifoldVersion`); a `preview` document MUST carry them as `null`.
 */
export const QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA = {
  $id: `https://dq-dental-cad/schemas/qc-traceability-document/v${TRACEABILITY_SCHEMA_VERSION}`,
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: [
    'schemaVersion',
    'documentKind',
    'identity',
    'qc',
    'acknowledgments',
    'materialProfile',
    'versions',
    'exportFile',
    'journal',
    'reimportVerification',
    'errorBounds',
    'certification',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: TRACEABILITY_SCHEMA_VERSION },
    documentKind: { type: 'string', enum: ['release', 'preview'] },
    identity: {
      type: 'object',
      required: ['caseId', 'restorationId', 'restorationType', 'teeth'],
      additionalProperties: false,
      properties: {
        caseId: { type: 'string', minLength: 1 },
        restorationId: { type: 'string', minLength: 1 },
        restorationType: { type: 'string', enum: ['crown', 'inlay', 'onlay', 'bridge'] },
        teeth: { type: 'array', minItems: 1, items: { type: 'integer', enum: [...FDI_TEETH] } },
      },
    },
    qc: {
      type: 'object',
      required: ['passed', 'kernelVersion', 'profileVersion', 'finalMeshContentHash', 'gates'],
      additionalProperties: false,
      properties: {
        passed: { type: 'boolean' },
        kernelVersion: { type: 'string', minLength: 1 },
        profileVersion: { type: 'string', minLength: 1 },
        finalMeshContentHash: sha256HexJsonSchema,
        gates: { type: 'array', minItems: 1, items: gateResultJsonSchema },
      },
    },
    acknowledgments: { type: 'array', items: acknowledgmentJsonSchema },
    materialProfile: {
      type: 'object',
      required: ['id', 'version', 'checksum'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
        checksum: sha256HexJsonSchema,
      },
    },
    versions: {
      type: 'object',
      required: ['kernelVersion', 'manifoldVersion'],
      additionalProperties: false,
      properties: {
        kernelVersion: { type: 'string', minLength: 1 },
        manifoldVersion: { type: ['string', 'null'] },
      },
    },
    exportFile: { oneOf: [{ type: 'null' }, exportFileJsonSchema] },
    journal: { oneOf: [{ type: 'null' }, journalBindingJsonSchema] },
    reimportVerification: { oneOf: [{ type: 'null' }, reimportVerificationJsonSchema] },
    errorBounds: { oneOf: [{ type: 'null' }, errorBoundsJsonSchema] },
    certification: certificationJsonSchema,
  },
  allOf: [
    {
      if: { properties: { documentKind: { const: 'release' } }, required: ['documentKind'] },
      then: {
        properties: {
          exportFile: exportFileJsonSchema,
          journal: journalBindingJsonSchema,
          reimportVerification: reimportVerificationJsonSchema,
          errorBounds: errorBoundsJsonSchema,
          versions: {
            type: 'object',
            required: ['kernelVersion', 'manifoldVersion'],
            additionalProperties: false,
            properties: {
              kernelVersion: { type: 'string', minLength: 1 },
              manifoldVersion: { type: 'string', minLength: 1 },
            },
          },
          // schemaVersion 2: a release's outer envelope IS certified.
          certification: releaseCertificationJsonSchema,
        },
      },
      else: {
        properties: {
          exportFile: { type: 'null' },
          journal: { type: 'null' },
          reimportVerification: { type: 'null' },
          errorBounds: { type: 'null' },
          // A preview certifies nothing and must carry the disclosure.
          certification: previewCertificationJsonSchema,
        },
      },
    },
  ],
} as const;
