// JSON schemas for every route: used by Fastify/AJV for request validation and by
// fast-json-stringify for response serialization.

export const healthResponseSchema = {
  200: {
    type: 'object',
    required: ['status', 'version', 'kernelVersion'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', const: 'ok' },
      version: { type: 'string' },
      kernelVersion: { type: 'string' },
    },
  },
} as const;

const caseSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt', 'schemaVersion'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    schemaVersion: { type: 'integer' },
  },
} as const;

export const listCasesResponseSchema = {
  200: {
    type: 'array',
    items: caseSummarySchema,
  },
} as const;

export const createCaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export const createCaseResponseSchema = {
  201: caseSummarySchema,
} as const;

export const patchCaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export const patchCaseResponseSchema = {
  200: caseSummarySchema,
} as const;

export const caseIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// CaseDocument (Task 11: PUT/GET /api/cases/:id) — mirrors
// packages/shared-types/src/index.ts's `CaseDocument` shape. `meshes`,
// `scene`, `measurements`, `history`, and `settings` (this task's actual
// scope) are validated field-by-field; `restorations` is typed to its known
// top-level shape but left permissive on its more loosely-typed nested
// fields (`stages`, `qc`) — Phase 1 never produces restorations (ImportPanel/
// Sidebar don't create them yet), and Phase 3 owns that shape's evolution.
// ---------------------------------------------------------------------------

const vec3Schema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
} as const;

const meshAssetSchema = {
  type: 'object',
  required: ['id', 'contentHash', 'name', 'unit', 'triangleCount'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    contentHash: { type: 'string' },
    name: { type: 'string' },
    unit: { type: 'string', const: 'mm' },
    triangleCount: { type: 'integer', minimum: 0 },
    // Absent for a MeshAsset never yet saved to the server — see its doc in
    // shared-types for why this is a separate hash from contentHash.
    fileHash: { type: 'string' },
  },
} as const;

const sceneNodeSchema = {
  type: 'object',
  required: ['id', 'meshId', 'role', 'transform', 'visible', 'opacity'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    meshId: { type: 'string' },
    role: {
      type: 'string',
      enum: ['upperJaw', 'lowerJaw', 'prepDie', 'antagonist', 'situ', 'gingiva'],
    },
    transform: { type: 'array', items: { type: 'number' }, minItems: 16, maxItems: 16 },
    visible: { type: 'boolean' },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

// schemaVersion 2 (Phase 3 Task 1) — see shared-types' `MarginAnchor` doc
// for the field semantics ("triangle + barycentric, the SurfacePoint
// currency"). Replaces the schemaVersion-1 `vertexAnchors: number[]` shape;
// migration from a v1 document happens CLIENT-SIDE only (apps/client/src/
// engine/caseDocumentMigration.ts) — the server never sees/accepts a v1
// document (`caseDocumentSchema`'s `schemaVersion` `const: 2` below rejects
// it outright).
const marginAnchorSchema = {
  type: 'object',
  required: ['position', 'triangleIndex', 'barycentric'],
  additionalProperties: false,
  properties: {
    position: vec3Schema,
    triangleIndex: { type: 'integer' },
    // Producer-guaranteed invariant (shared-types' `MarginAnchor.barycentric`
    // doc): each weight in [0, 1] — enforced here so a malformed/out-of-range
    // component is a 400 at the boundary rather than silently accepted.
    barycentric: {
      type: 'array',
      items: { type: 'number', minimum: 0, maximum: 1 },
      minItems: 3,
      maxItems: 3,
    },
  },
} as const;

const marginLineSchema = {
  type: 'object',
  required: ['anchors', 'closed'],
  additionalProperties: false,
  properties: {
    anchors: { type: 'array', items: marginAnchorSchema },
    closed: { type: 'boolean' },
    // Optional (shared-types' `MarginLine.resampledPoints?`) — absent until
    // something actually resamples the fitted spline.
    resampledPoints: { type: 'array', items: vec3Schema },
  },
} as const;

// The 32 valid FDI tooth codes (quadrants 1-4 x positions 1-8) — mirrors
// shared-types' `FdiTooth` template-literal union at the JSON-Schema level
// (AJV has no notion of a TS template-literal type, so this is written out
// as an explicit `enum`, generated the same way the TS type derives itself:
// quadrant x position cross product, not hand-typed digit-by-digit).
const FDI_TOOTH_NUMBERS: readonly number[] = [1, 2, 3, 4].flatMap((quadrant) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((position) => quadrant * 10 + position),
);

const fdiToothSchema = { type: 'integer', enum: FDI_TOOTH_NUMBERS } as const;

// PLAN.md §3's parameter table — same ranges packages/clinical-profiles/src/
// materialProfile.ts's `validateMaterialProfileShape` enforces on a material
// PROFILE's values; enforced here too on a RESTORATION's (possibly
// profile-derived, possibly hand-overridden — Phase 4+) own `params`, so a
// malformed/corrupted PUT body is a 400 at the server boundary regardless of
// where the values originated client-side.
const restorationParamsSchema = {
  type: 'object',
  required: [
    'cementGapMm',
    'marginalGapMm',
    'spacerStartMm',
    'minWallThicknessMm',
    'proximalContactPenetrationMm',
    'occlusalContactMm',
  ],
  additionalProperties: false,
  properties: {
    cementGapMm: { type: 'number', minimum: 0.02, maximum: 0.12 },
    marginalGapMm: { type: 'number', minimum: 0, maximum: 0.05 },
    spacerStartMm: { type: 'number', minimum: 0.5, maximum: 1.0 },
    minWallThicknessMm: { type: 'number', minimum: 0.4, maximum: 5 },
    proximalContactPenetrationMm: { type: 'number', minimum: -0.05, maximum: 0.1 },
    occlusalContactMm: { type: 'number', minimum: -0.2, maximum: 0.1 },
  },
} as const;

// Mirrors shared-types' `QcGateResult`/`QcReport` (Phase 3 has no producer
// for these yet — `qc` is always `null` until a later phase's QC gates run
// — but the shape is fully known already, so it's validated exactly, not
// left permissive "for now").
const qcGateResultSchema = {
  type: 'object',
  required: ['gate', 'passed', 'acknowledged', 'value', 'threshold', 'unit', 'message'],
  additionalProperties: false,
  properties: {
    gate: { type: 'string' },
    passed: { type: 'boolean' },
    acknowledged: { type: 'boolean' },
    value: { type: ['number', 'null'] },
    threshold: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    message: { type: 'string' },
  },
} as const;

export const qcReportSchema = {
  type: 'object',
  required: ['gates', 'passed', 'kernelVersion', 'profileVersion', 'journalHash'],
  additionalProperties: false,
  properties: {
    gates: { type: 'array', items: qcGateResultSchema },
    passed: { type: 'boolean' },
    kernelVersion: { type: 'string' },
    profileVersion: { type: 'string' },
    journalHash: { type: 'string' },
  },
} as const;

// Mirrors shared-types' `Restoration.stages` — the 4 crown-pipeline contentHash
// strings (Phase 4) plus the 4 cavity (inlay/onlay) pipeline fields (Phase 5),
// all optional. `finalMesh` is shared by both families (the final restoration
// solid). Kept in lockstep with shared-types' `Restoration.stages`; the
// inlay/onlay QC endpoint that consumes these lands in Phase 5 Task 9.
const restorationStagesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    innerSurface: { type: 'string' },
    anatomyPlacement: { type: 'string' },
    morphState: { type: 'string' },
    finalMesh: { type: 'string' },
    fitSurface: { type: 'string' },
    occlusalPatch: { type: 'string' },
    proximalContacts: { type: 'string' },
    cuspCoverage: { type: 'string' },
    // Phase 6 Task 7 — bridge (multi-unit) pipeline stage hashes; additive,
    // all optional (a given restoration only populates its own family's fields).
    bridgeAbutmentSurfaces: { type: 'string' },
    bridgePontic: { type: 'string' },
    bridgeConnectors: { type: 'string' },
    bridgeFramework: { type: 'string' },
  },
} as const;

// schemaVersion 2 (Phase 3 Task 2): tightened to the REAL shared-types
// `Restoration` shape end-to-end — `pontics`/`targetNodeId` (this task's new
// fields), `teeth` restricted to the 32 valid FDI codes, `params` bounded per
// PLAN.md §3, and `stages`/`qc` validated against their real (if not yet
// producible) shapes rather than left permissive. Replaces this section's
// prior "typed to its known top-level shape but left permissive on nested
// fields" state (Phase 1) now that Phase 3 actually produces restorations.
const restorationSchema = {
  type: 'object',
  required: [
    'id',
    'type',
    'teeth',
    'pontics',
    'targetNodeId',
    'marginLines',
    'insertionAxis',
    'params',
    'stages',
    'qc',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['crown', 'inlay', 'onlay', 'bridge'] },
    teeth: { type: 'array', items: fdiToothSchema },
    // Bridge-only (shared-types' `Restoration.pontics` doc) — always `[]`
    // for crown/inlay/onlay; not cross-validated against `teeth` at the
    // schema level (AJV can't express "subset of another property" without
    // a keyword extension) — engine/restorations.ts's `normalizePontics` is
    // the actual enforcement point client-side; this only bounds each entry
    // to a real FDI code.
    pontics: { type: 'array', items: fdiToothSchema },
    targetNodeId: { type: ['string', 'null'] },
    // Keyed by FDI tooth number (a string in JSON) — permissive on values'
    // exact shape beyond object-ness is deliberately NOT relaxed here; each
    // present entry must still be a valid MarginLine.
    marginLines: { type: 'object', additionalProperties: marginLineSchema },
    insertionAxis: vec3Schema,
    params: restorationParamsSchema,
    stages: restorationStagesSchema,
    qc: { anyOf: [{ type: 'null' }, qcReportSchema] },
  },
} as const;

const measurementPointSchema = {
  type: 'object',
  required: ['nodeId', 'position'],
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' },
    position: vec3Schema,
  },
} as const;

const measurementSchema = {
  type: 'object',
  required: ['id', 'kind', 'points', 'value', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['pointToPoint', 'pointToSurface', 'angle'] },
    points: { type: 'array', items: measurementPointSchema },
    value: { type: 'number' },
    createdAt: { type: 'string' },
  },
} as const;

const operationSchema = {
  type: 'object',
  required: ['id', 'name', 'params', 'inputHashes', 'outputHashes', 'kernelVersion', 'timestamp'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    // `Operation.params` (shared-types) is `Readonly<Record<string, unknown>>`
    // — arbitrary, operation-specific detail. `additionalProperties: true` is
    // required on BOTH sides: it's what lets AJV accept any keys in the PUT
    // body, and what stops fast-json-stringify from dropping them on GET's
    // response (see restorationSchema's `stages`/`qc` for the same gotcha).
    params: { type: 'object', additionalProperties: true },
    inputHashes: { type: 'array', items: { type: 'string' } },
    outputHashes: { type: 'array', items: { type: 'string' } },
    kernelVersion: { type: 'string' },
    timestamp: { type: 'string' },
  },
} as const;

const caseSettingsSchema = {
  type: 'object',
  required: ['materialProfileId', 'profileVersion'],
  additionalProperties: false,
  properties: {
    materialProfileId: { type: 'string' },
    profileVersion: { type: 'string' },
  },
} as const;

/** The full `CaseDocument` shape (shared-types) — used both to validate
 * `PUT /api/cases/:id`'s request body and to serialize `GET
 * /api/cases/:id`'s response. `schemaVersion`'s `const: 2` is what makes an
 * unsupported/legacy document version a 400 (AJV rejects any other value)
 * rather than something the route handler has to check itself — this
 * INCLUDES a schemaVersion-1 document: the server has no migration logic of
 * its own (Phase 3 Task 1's brief: "migration happens client-side on
 * load"), so a v1 `PUT` is rejected exactly like any other malformed body,
 * and the CLIENT is responsible for having already migrated (apps/client/
 * src/engine/caseDocumentMigration.ts) before ever attempting to save. */
export const caseDocumentSchema = {
  type: 'object',
  required: [
    'id',
    'schemaVersion',
    'createdAt',
    'meshes',
    'scene',
    'restorations',
    'measurements',
    'history',
    'settings',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    schemaVersion: { type: 'integer', const: 2 },
    createdAt: { type: 'string' },
    patientRef: { type: 'string' },
    meshes: { type: 'array', items: meshAssetSchema },
    scene: { type: 'array', items: sceneNodeSchema },
    restorations: { type: 'array', items: restorationSchema },
    measurements: { type: 'array', items: measurementSchema },
    history: { type: 'array', items: operationSchema },
    settings: caseSettingsSchema,
  },
} as const;

export const putCaseBodySchema = caseDocumentSchema;

export const putCaseResponseSchema = {
  200: caseSummarySchema,
} as const;

// GET /api/cases/:id has NO response schema (Task-11-review Critical 4) —
// deliberately, not an oversight. `caseDocumentSchema` above is STRICT
// (`additionalProperties: false`, a full `required` list) because it is ALSO
// `putCaseBodySchema` — a gate the CLIENT must satisfy before writing.
// Reusing it for GET's response was wrong: Fastify compiles any
// `schema.response` entry through `@fastify/fast-json-stringify-compiler`
// (fast-json-stringify), which THROWS on a missing required property and
// SILENTLY DROPS any property not listed in `properties` — so a document
// stored before a schema migration added a required field (e.g. a
// pre-backfill-v2 `Restoration` missing `pontics`/`targetNodeId`), or one
// still carrying a since-removed field (e.g. an old `controlPoints`), could
// NEVER reach the client: the server 500s (or silently mangles the JSON)
// before the bytes leave it — even though `apps/client/src/engine/
// caseDocumentMigration.ts` exists PRECISELY to accept and upgrade exactly
// that shape once it arrives. Omitting `schema.response` entirely for this
// route makes Fastify fall back to plain `JSON.stringify` (no schema
// involved at all) — whatever is in `documentJson` comes back byte-
// equivalent (as JSON) to what `JSON.parse(found.documentJson)` produced.
// The client's migration layer is the validator for a GET'd document, not
// the server's response serializer. `PUT`'s `putCaseBodySchema` (request-
// side, strict) is UNCHANGED — the server still only ever ACCEPTS a
// current-shape document; it just no longer refuses to hand back one it
// already has stored. See docs/adr/005-case-document-schema-evolution.md.

// ---------------------------------------------------------------------------
// Mesh storage (Task 11): POST/GET/HEAD /api/meshes[/:hash]. The raw-bytes
// upload route (`POST /api/meshes`) deliberately has NO `schema.body` —
// AJV's JSON-Schema body validation only makes sense for the parsed-JSON
// content types Fastify's default parsers produce; this route's body is a
// `Buffer` (via a custom `application/octet-stream` content-type parser
// registered in app.ts), and running an "object" JSON Schema against a raw
// Buffer would always fail. The route's max-size guard is a per-route
// Fastify `bodyLimit` option instead (see app.ts) — the JSON-schema'd part
// of this route is only its response.
// ---------------------------------------------------------------------------

export const meshHashParamsSchema = {
  type: 'object',
  required: ['hash'],
  additionalProperties: false,
  properties: {
    hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const;

export const postMeshResponseSchema = {
  200: {
    type: 'object',
    required: ['hash', 'byteLength'],
    additionalProperties: false,
    properties: {
      hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      byteLength: { type: 'integer', minimum: 0 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Tooth library (Phase 4 Task 2): GET /api/tooth-library[/:fdi]. Mesh BYTES
// are deliberately NOT part of either response — they're already reachable
// at the existing `GET /api/meshes/:hash` route (mesh-storage.ts, above)
// using the metadata's own `meshChecksum` as `:hash`. See
// apps/server/src/tooth-library-storage.ts's module doc and
// packages/tooth-library/src/README.md's "Backend routes" section.
// ---------------------------------------------------------------------------

export const toothFdiParamsSchema = {
  type: 'object',
  required: ['fdi'],
  additionalProperties: false,
  properties: {
    fdi: { type: 'string', pattern: '^[1-4][1-8]$' },
  },
} as const;

export const listToothLibraryResponseSchema = {
  200: {
    type: 'array',
    items: {
      type: 'object',
      required: ['fdi', 'version', 'toothType'],
      additionalProperties: false,
      properties: {
        fdi: fdiToothSchema,
        version: { type: 'string' },
        toothType: { type: 'string', enum: ['incisor', 'molar'] },
      },
    },
  },
} as const;

const vec3TupleSchema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
} as const;

const toothCanonicalFrameSchema = {
  type: 'object',
  required: ['origin', 'mesialDistal', 'buccoLingual', 'occlusoGingival'],
  additionalProperties: false,
  properties: {
    origin: vec3TupleSchema,
    mesialDistal: vec3TupleSchema,
    buccoLingual: vec3TupleSchema,
    occlusoGingival: vec3TupleSchema,
  },
} as const;

const toothMorphTargetSchema = {
  type: 'object',
  required: ['name', 'vertexDeltas'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    vertexDeltas: { type: 'array', items: { type: 'number' } },
  },
} as const;

/** The full validated `ToothAssetMetadata` shape (mirrors
 * `@dqcad/tooth-library`'s `schema.ts`). Extracted so the SAME shape validates
 * BOTH the `GET /api/tooth-library/:fdi` response AND the `POST
 * /api/tooth-library` admin-upload body/response (Task 11) — the upload's
 * deeper checksum/watertight validation is done by the tooth-library loader,
 * not AJV, so this schema is only the structural gate. */
export const toothAssetMetadataSchema = {
  type: 'object',
  required: [
    'fdi',
    'version',
    'toothType',
    'provenance',
    'landmarks',
    'canonicalFrame',
    'morphTargets',
    'meshChecksum',
    'metadataChecksum',
  ],
  additionalProperties: false,
  properties: {
    fdi: fdiToothSchema,
    version: { type: 'string' },
    toothType: { type: 'string', enum: ['incisor', 'molar'] },
    provenance: { type: 'string' },
    landmarks: { type: 'object', additionalProperties: vec3TupleSchema },
    canonicalFrame: toothCanonicalFrameSchema,
    morphTargets: { type: 'array', items: toothMorphTargetSchema },
    meshChecksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    metadataChecksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const;

export const toothLibraryAssetResponseSchema = {
  200: toothAssetMetadataSchema,
} as const;

// ---------------------------------------------------------------------------
// POST /api/tooth-library — admin upload of a library asset (Phase 4 Task 11).
// Content-addressed + versioned + schema/checksum/watertight validated
// server-side (the same validation `@dqcad/tooth-library`'s loader does; the
// mesh bytes go through the P1 content-addressed mesh store, write-once). The
// mesh bytes ride in the JSON body as base64 (these assets are small — a
// single atomic admin action uploads the whole asset), decoded and handed to
// `loadToothAssetFromBytes` for the real (checksum + watertight) validation.
// ---------------------------------------------------------------------------

export const uploadToothLibraryBodySchema = {
  type: 'object',
  required: ['metadata', 'meshBase64'],
  additionalProperties: false,
  properties: {
    metadata: toothAssetMetadataSchema,
    meshBase64: { type: 'string', minLength: 1 },
  },
} as const;

export const uploadToothLibraryResponseSchema = {
  201: toothAssetMetadataSchema,
} as const;

// ---------------------------------------------------------------------------
// POST /api/restorations/:id/validate-qc — the dual-validation route (Phase 4
// Task 11, the headline). Takes the crown mesh set + the exact QC context the
// client passed to `runCrownQc`, re-runs `runCrownQc` INDEPENDENTLY in the
// Node server (cad-pipeline is DOM/Three-free), and returns the server-side
// `QcReport`. The client and server reports must be bit-identical (invariant
// 6). An OPTIONAL `clientReport` is a cross-check ONLY — never a source of
// truth: the server always recomputes; if `clientReport` is present and
// disagrees, the response is a 409 hard error with a per-field diagnostic.
//
// Meshes ride as plain `{ positions, indices }` number arrays — JSON round-
// trips a Float64 exactly (ECMAScript shortest-round-trip Number<->String), so
// the server reconstructs bit-identical Float64Array/Uint32Array inputs and a
// deterministic `runCrownQc` yields a bit-identical report.
// ---------------------------------------------------------------------------

const meshDataInputSchema = {
  type: 'object',
  required: ['positions', 'indices'],
  additionalProperties: false,
  properties: {
    positions: { type: 'array', items: { type: 'number' } },
    indices: { type: 'array', items: { type: 'integer', minimum: 0 } },
  },
} as const;

const contactResidualInputSchema = {
  type: 'object',
  required: [
    'kind',
    'targetPenetrationMm',
    'achievedSignedDistanceMm',
    'contactResidualMm',
    'regionResidualMm',
    'clampBound',
  ],
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    targetPenetrationMm: { type: 'number' },
    achievedSignedDistanceMm: { type: 'number' },
    contactResidualMm: { type: 'number' },
    regionResidualMm: { type: 'number' },
    clampBound: { type: 'boolean' },
  },
} as const;

const connectorCrossSectionInputSchema = {
  type: 'object',
  required: ['label', 'minAreaMm2'],
  additionalProperties: false,
  properties: {
    label: { type: 'string' },
    minAreaMm2: { type: 'number' },
  },
} as const;

// The CROWN branch (Phase 4 Task 11). `restorationType` is OPTIONAL here
// (`enum: ['crown']`) so the existing client/tests that POST a crown body
// WITHOUT it keep validating; the route handler treats an absent/`crown` type as
// the crown path. `additionalProperties: false` still rejects the cavity-only and
// bridge-only fields — so a cavity or bridge body can NEVER validate against this
// branch (it lacks `crownSolid` and carries `inlaySolid`/`assembledSolid` etc.).
// Phase 6 Task 8: `bridge` is REMOVED from this enum (it was a placeholder that
// fell through to the crown path); bridges now have their OWN branch below.
export const crownValidateQcBodySchema = {
  type: 'object',
  required: [
    'crownSolid',
    'innerSurfaceMesh',
    'outerSurfaceMesh',
    'dieSolid',
    'marginResampledPoints',
    'insertionAxis',
    'minWallThicknessMm',
    'occlusalMinWallThicknessMm',
    'connectorAreaTargetMm2',
    'contacts',
    'contactClampWarning',
    'kernelVersion',
    'profileVersion',
    'journalHash',
  ],
  additionalProperties: false,
  properties: {
    restorationType: { type: 'string', enum: ['crown'] },
    crownSolid: meshDataInputSchema,
    innerSurfaceMesh: meshDataInputSchema,
    outerSurfaceMesh: meshDataInputSchema,
    dieSolid: meshDataInputSchema,
    marginResampledPoints: { type: 'array', items: vec3Schema },
    insertionAxis: vec3Schema,
    minWallThicknessMm: { type: 'number' },
    occlusalMinWallThicknessMm: { type: 'number' },
    connectorAreaTargetMm2: { type: 'number' },
    contacts: { type: 'array', items: contactResidualInputSchema },
    contactClampWarning: { type: 'boolean' },
    marginExclusionMm: { type: 'number' },
    marginFitThresholdMm: { type: 'number' },
    seatingInterferenceVolumeToleranceMm3: { type: 'number' },
    contactToleranceMm: { type: 'number' },
    connectors: { type: 'array', items: connectorCrossSectionInputSchema },
    kernelVersion: { type: 'string' },
    profileVersion: { type: 'string' },
    journalHash: { type: 'string' },
    acknowledgedGates: { type: 'array', items: { type: 'string' } },
    /** OPTIONAL cross-check only — the server NEVER trusts this; it recomputes
     * independently and 409s on any disagreement (invariant 6). */
    clientReport: qcReportSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// The INLAY/ONLAY branch (Phase 5 Task 9). Mirrors cad-pipeline's
// `RunInlayQcInput`: the cavity mesh set (`inlaySolid`/`fitSurfaceMesh`/
// `patchMesh`/`toothWithCavitySolid`), the cavity outline, the seam/coverage
// geometry, the profile-resolved thickness minimums, and — riding WITH the
// request — the cavity `marginExclusionMm` band (a geometry-scoped parameter:
// the server MUST use the exact value the client used, and the bit-identical
// dual-validation proof catches any divergence). `restorationType` is REQUIRED
// and pinned to `['inlay', 'onlay']` — that is what disambiguates this branch
// from the crown one and what the route handler dispatches on.
// ---------------------------------------------------------------------------

const seamEdgeInputSchema = {
  type: 'object',
  required: ['a', 'b', 'segment'],
  additionalProperties: false,
  properties: {
    a: vec3Schema,
    b: vec3Schema,
    segment: { type: 'string' },
  },
} as const;

const coverageDividerInputSchema = {
  type: 'object',
  required: ['pointMm', 'normalMm'],
  additionalProperties: false,
  properties: {
    pointMm: vec3Schema,
    normalMm: vec3Schema,
  },
} as const;

const cavityCoverageInputSchema = {
  type: 'object',
  required: ['coverageDivider', 'cuspCoverageMinThicknessMm'],
  additionalProperties: false,
  properties: {
    coverageDivider: coverageDividerInputSchema,
    cuspCoverageMinThicknessMm: { type: 'number' },
  },
} as const;

const cavityThicknessMinimumsInputSchema = {
  type: 'object',
  required: ['inlayMinThicknessMm', 'onlayMinThicknessMm'],
  additionalProperties: false,
  properties: {
    inlayMinThicknessMm: { type: 'number' },
    onlayMinThicknessMm: { type: 'number' },
  },
} as const;

export const inlayValidateQcBodySchema = {
  type: 'object',
  required: [
    'restorationType',
    'inlaySolid',
    'fitSurfaceMesh',
    'patchMesh',
    'toothWithCavitySolid',
    'cavityOutlineResampledPoints',
    'insertionAxis',
    'thicknessMinimums',
    'marginExclusionMm',
    'seamEdges',
    'cavityTriangleIndices',
    'contacts',
    'contactClampWarning',
    'kernelVersion',
    'profileVersion',
    'journalHash',
  ],
  additionalProperties: false,
  properties: {
    restorationType: { type: 'string', enum: ['inlay', 'onlay'] },
    inlaySolid: meshDataInputSchema,
    fitSurfaceMesh: meshDataInputSchema,
    patchMesh: meshDataInputSchema,
    toothWithCavitySolid: meshDataInputSchema,
    cavityOutlineResampledPoints: { type: 'array', items: vec3Schema },
    insertionAxis: vec3Schema,
    thicknessMinimums: cavityThicknessMinimumsInputSchema,
    // The cavity marginal-transition band — rides WITH the request (see this
    // section's doc); the server passes it straight into `runInlayQc`.
    marginExclusionMm: { type: 'number' },
    // ONLAY covered-cusp coverage — present only for an onlay carrying a
    // coverage selection (drives the region-scoped cuspCoverage gate).
    coverage: cavityCoverageInputSchema,
    seamEdges: { type: 'array', items: seamEdgeInputSchema },
    cavityTriangleIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
    contacts: { type: 'array', items: contactResidualInputSchema },
    contactClampWarning: { type: 'boolean' },
    marginFitThresholdMm: { type: 'number' },
    seamDihedralThresholdDeg: { type: 'number' },
    seatingInterferenceVolumeToleranceMm3: { type: 'number' },
    contactToleranceMm: { type: 'number' },
    kernelVersion: { type: 'string' },
    profileVersion: { type: 'string' },
    journalHash: { type: 'string' },
    acknowledgedGates: { type: 'array', items: { type: 'string' } },
    /** OPTIONAL cross-check only — the server NEVER trusts this; it recomputes
     * independently and 409s on any disagreement (invariant 6). */
    clientReport: qcReportSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// The BRIDGE branch (Phase 6 Task 8). Mirrors cad-pipeline's `RunBridgeQcInput`
// — the largest input surface yet: the fused watertight `assembledSolid`, the
// per-unit surfaces (inner/outer + margin loop + insertion axis + the abutment's
// fit-region descriptor), the abutment prep `dieSolids` (for the whole-bridge
// seating simulation), the measured `connectors` (each carrying its
// kernel-measured min cross-section area + its own positional target), the
// profile-resolved thickness/connector thresholds, the framework mode, the
// pontic-relief measurement scalars, and — riding WITH the request (the P5
// precedent) — every geometry-scoped parameter, so the server recomputes the
// EXACT gates the client did and the bit-identical proof catches any divergence.
// `restorationType` is REQUIRED and pinned to `['bridge']` — the discriminator the
// route dispatches on.
// ---------------------------------------------------------------------------

const fitRegionInputSchema = {
  type: 'object',
  required: ['axisPointMm', 'axis', 'maxRadialMm', 'minAxialMm', 'maxAxialMm'],
  additionalProperties: false,
  properties: {
    axisPointMm: vec3Schema,
    axis: vec3Schema,
    maxRadialMm: { type: 'number' },
    minAxialMm: { type: 'number' },
    maxAxialMm: { type: 'number' },
  },
} as const;

const bridgeUnitInputSchema = {
  type: 'object',
  required: ['label', 'kind', 'innerSurfaceMesh', 'outerSurfaceMesh', 'insertionAxis', 'marginLoop'],
  additionalProperties: false,
  properties: {
    label: { type: 'string' },
    kind: { type: 'string', enum: ['abutment', 'pontic'] },
    innerSurfaceMesh: meshDataInputSchema,
    outerSurfaceMesh: meshDataInputSchema,
    insertionAxis: vec3Schema,
    marginLoop: { type: 'array', items: vec3Schema },
    marginExclusionMm: { type: 'number' },
    // REQUIRED for an abutment (the marginFit gate extracts its intaglio patch
    // off the assembled solid with it), absent for a pontic — the route handler
    // enforces the abutment/pontic pairing (AJV can't express the conditional).
    fitRegion: fitRegionInputSchema,
  },
} as const;

const bridgeConnectorInputSchema = {
  type: 'object',
  required: ['label', 'minAreaMm2'],
  additionalProperties: false,
  properties: {
    label: { type: 'string' },
    minAreaMm2: { type: 'number' },
    // The two FDI teeth this connector spans (for the positional-target rule).
    teeth: { type: 'array', items: fdiToothSchema, minItems: 2, maxItems: 2 },
    // This connector's OWN positional target (pre-resolved via the FDI rule).
    targetMm2: { type: 'number' },
  },
} as const;

const ponticReliefInputSchema = {
  type: 'object',
  required: ['maxAbsDeviationMm', 'style', 'configuredReliefMm'],
  additionalProperties: false,
  properties: {
    maxAbsDeviationMm: { type: 'number' },
    style: { type: 'string' },
    configuredReliefMm: { type: 'number' },
    thresholdMm: { type: 'number' },
  },
} as const;

export const bridgeValidateQcBodySchema = {
  type: 'object',
  required: [
    'restorationType',
    'assembledSolid',
    'units',
    'dieSolids',
    'connectors',
    'minWallThicknessMm',
    'occlusalMinWallThicknessMm',
    'connectorAreaTargetMm2',
    'ponticRelief',
    'kernelVersion',
    'profileVersion',
    'journalHash',
  ],
  additionalProperties: false,
  properties: {
    restorationType: { type: 'string', enum: ['bridge'] },
    assembledSolid: meshDataInputSchema,
    units: { type: 'array', items: bridgeUnitInputSchema, minItems: 1 },
    dieSolids: { type: 'array', items: meshDataInputSchema, minItems: 1 },
    connectors: { type: 'array', items: bridgeConnectorInputSchema },
    minWallThicknessMm: { type: 'number' },
    occlusalMinWallThicknessMm: { type: 'number' },
    connectorAreaTargetMm2: { type: 'number' },
    frameworkMode: { type: 'boolean' },
    frameworkMinThicknessMm: { type: 'number' },
    ponticRelief: ponticReliefInputSchema,
    marginFitThresholdMm: { type: 'number' },
    seatingInterferenceVolumeToleranceMm3: { type: 'number' },
    kernelVersion: { type: 'string' },
    profileVersion: { type: 'string' },
    journalHash: { type: 'string' },
    acknowledgedGates: { type: 'array', items: { type: 'string' } },
    /** OPTIONAL cross-check only — the server NEVER trusts this; it recomputes
     * independently and 409s on any disagreement (invariant 6). */
    clientReport: qcReportSchema,
  },
} as const;

// The route's body schema is the discriminated union of the three branches.
// Fastify/AJV `oneOf` requires EXACTLY ONE to validate: a crown body (has
// `crownSolid`, lacks `inlaySolid`/`assembledSolid`) matches only the crown
// branch; an inlay/onlay body (`restorationType: 'inlay'|'onlay'` + `inlaySolid`)
// matches only the inlay branch; a bridge body (`restorationType: 'bridge'` +
// `assembledSolid`/`units`) matches only the bridge branch; a malformed body
// matches none → 400. `additionalProperties: false` on all three branches makes
// the field sets mutually exclusive, so there is no oneOf ambiguity.
export const validateQcBodySchema = {
  oneOf: [crownValidateQcBodySchema, inlayValidateQcBodySchema, bridgeValidateQcBodySchema],
} as const;

// ---------------------------------------------------------------------------
// POST /api/restorations/:id/export (Phase 7 Task 4) — the independent
// re-validation on the exact exported bytes (CLAUDE.md invariant 6 in its
// strongest form: the server's QC input is what a mill would read, never a
// client-shipped array for the restoration solid).
//
// The body is `{ request, qcContext }`:
//  - `request` is the Task 3 `RestorationExportRequest` currency VERBATIM
//    (shared-types) — bytes (base64) + integrity hashes + the client QcReport
//    (compare-only, never trusted) + journal/profile/kernel identity.
//  - `qcContext` is the RIDING geometry context — exactly the matching
//    validate-qc branch MINUS (a) the restoration solid (crownSolid /
//    inlaySolid / assembledSolid: byte-derived — the server re-imports it
//    from `request.bytesBase64`, the one place the bytes are authoritative)
//    and (b) the request-level metadata (`kernelVersion`/`profileVersion`/
//    `journalHash`/`acknowledgedGates`/`clientReport`/`restorationType`),
//    which the route derives from verified `request` fields so a context/
//    request disagreement cannot be smuggled in. The subtraction is
//    performed PROGRAMMATICALLY from the validate-qc branch schemas
//    (`omitBodySchemaProperties`) so the boundary is defined in one place
//    and can never drift from the validate-qc contract.
// ---------------------------------------------------------------------------

interface BodyObjectSchema {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** `schema` minus the named properties (removed from both `properties` and
 * `required`). Throws if a named property does not exist — a rename in the
 * source schema must fail loudly here, not silently widen the derived one. */
function omitBodySchemaProperties(schema: BodyObjectSchema, omit: readonly string[]): BodyObjectSchema {
  const properties: Record<string, unknown> = { ...schema.properties };
  for (const name of omit) {
    if (!(name in properties)) {
      throw new Error(`omitBodySchemaProperties: property ${JSON.stringify(name)} not found in schema`);
    }
    delete properties[name];
  }
  return {
    type: 'object',
    required: schema.required.filter((r) => !omit.includes(r)),
    additionalProperties: false,
    properties,
  };
}

/** Request-level fields present on every validate-qc branch that the export
 * route derives from the VERIFIED `request` instead (see the section doc). */
const EXPORT_CONTEXT_REQUEST_DERIVED = [
  'restorationType',
  'kernelVersion',
  'profileVersion',
  'journalHash',
  'acknowledgedGates',
  'clientReport',
] as const;

export const crownExportQcContextSchema = omitBodySchemaProperties(crownValidateQcBodySchema, [
  'crownSolid',
  ...EXPORT_CONTEXT_REQUEST_DERIVED,
]);

export const inlayExportQcContextSchema = omitBodySchemaProperties(inlayValidateQcBodySchema, [
  'inlaySolid',
  ...EXPORT_CONTEXT_REQUEST_DERIVED,
]);

export const bridgeExportQcContextSchema = omitBodySchemaProperties(bridgeValidateQcBodySchema, [
  'assembledSolid',
  ...EXPORT_CONTEXT_REQUEST_DERIVED,
]);

const sha256HexSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;

const exportAcknowledgmentSchema = {
  type: 'object',
  required: ['gate', 'message', 'value', 'threshold', 'unit', 'operationId'],
  additionalProperties: false,
  properties: {
    gate: { type: 'string' },
    message: { type: 'string' },
    value: { type: ['number', 'null'] },
    threshold: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    // `null` is accepted by the SCHEMA (the shared-types shape allows it) but
    // REFUSED by the route with a distinct 409 (`export-unjournaled-
    // acknowledgment`) — the N4 contract: an acknowledgment without a journal
    // ref is never a valid authorization; schema-rejecting it would hide the
    // typed diagnostic behind a generic 400.
    operationId: { type: ['string', 'null'] },
  },
} as const;

/** Mirrors shared-types' `RestorationExportRequest` (schemaVersion 1). */
export const restorationExportRequestSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'caseId',
    'restorationId',
    'restorationType',
    'teeth',
    'format',
    'meshContentHash',
    'exportOperationId',
    'bytesBase64',
    'bytesSha256',
    'byteLength',
    'qcReport',
    'acknowledgments',
    'caseJournalHash',
    'journalOperationCount',
    'materialProfile',
    'kernelVersion',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    caseId: { type: 'string', minLength: 1 },
    restorationId: { type: 'string', minLength: 1 },
    restorationType: { type: 'string', enum: ['crown', 'inlay', 'onlay', 'bridge'] },
    teeth: { type: 'array', items: fdiToothSchema, minItems: 1 },
    format: { type: 'string', enum: ['stl', 'ply'] },
    headerText: { type: 'string', maxLength: 80 },
    meshContentHash: sha256HexSchema,
    exportOperationId: { type: 'string', minLength: 1 },
    bytesBase64: { type: 'string', minLength: 1 },
    bytesSha256: sha256HexSchema,
    byteLength: { type: 'integer', minimum: 1 },
    qcReport: qcReportSchema,
    acknowledgments: { type: 'array', items: exportAcknowledgmentSchema },
    caseJournalHash: sha256HexSchema,
    journalOperationCount: { type: 'integer', minimum: 0 },
    materialProfile: {
      type: 'object',
      required: ['id', 'version', 'checksum'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
        checksum: sha256HexSchema,
      },
    },
    kernelVersion: { type: 'string', minLength: 1 },
  },
} as const;

// The three context branches are mutually exclusive under `oneOf`: each keeps
// `additionalProperties: false` and requires fields the other branches forbid
// (crown: `dieSolid`+`marginResampledPoints`; inlay/onlay: `fitSurfaceMesh`+
// `patchMesh`; bridge: `units`+`dieSolids`+`ponticRelief`), so exactly one
// branch can validate. The route separately enforces that the branch MATCHES
// `request.restorationType` (400 `export-context-type-mismatch`).
export const exportBodySchema = {
  type: 'object',
  required: ['request', 'qcContext'],
  additionalProperties: false,
  properties: {
    request: restorationExportRequestSchema,
    qcContext: {
      oneOf: [crownExportQcContextSchema, inlayExportQcContextSchema, bridgeExportQcContextSchema],
    },
  },
} as const;

// Every rejection is a TYPED, schema'd error body (the 19b/no-silent-failure
// discipline server-side): `error` is the closed rejection code the route
// maps from `ExportRejectionError.code`, `message` the human diagnostic,
// `details` the code-specific structured payload. The 400 shape must ALSO
// survive Fastify's own AJV validation-error serialization (statusCode/code/
// error='Bad Request'/message) — same constraint as validateQcResponseSchema's
// 400, so it stays permissive (no additionalProperties: false).
const exportErrorSchema = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    /** Code-specific structured diagnostics (free-form object). */
    details: { type: 'object', additionalProperties: true },
    /** Present on Fastify's own validation-error shape. */
    statusCode: { type: 'number' },
    code: { type: 'string' },
  },
} as const;

const qcReportDifferenceSchema = {
  type: 'object',
  required: ['path', 'server', 'client'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    server: {},
    client: {},
  },
} as const;

export const exportResponseSchema = {
  200: {
    type: 'object',
    required: [
      'released',
      'exportId',
      'caseId',
      'restorationId',
      'restorationType',
      'teeth',
      'format',
      'bytesSha256',
      'byteLength',
      'meshContentHash',
      'reimportMeshHash',
      'downloadPath',
      'releasedAt',
      'alreadyStored',
      'qcReport',
    ],
    additionalProperties: false,
    properties: {
      released: { type: 'boolean', const: true },
      exportId: { type: 'string' },
      caseId: { type: 'string' },
      restorationId: { type: 'string' },
      restorationType: { type: 'string' },
      teeth: { type: 'array', items: fdiToothSchema },
      format: { type: 'string', enum: ['stl', 'ply'] },
      bytesSha256: sha256HexSchema,
      byteLength: { type: 'integer', minimum: 1 },
      meshContentHash: sha256HexSchema,
      /** Canonical hash of the byte-derived re-imported solid the server QC
       * measured — differs from `meshContentHash` by the documented canonical
       * re-index + f32 narrowing (see export-route.ts's module doc). */
      reimportMeshHash: sha256HexSchema,
      downloadPath: { type: 'string' },
      /** Server release timestamp — a RECORD field only (never hashed). */
      releasedAt: { type: 'string' },
      /** True iff byte-identical content was already in the store (an
       * idempotent re-release — same object, new ledger row). */
      alreadyStored: { type: 'boolean' },
      /** The SERVER-recomputed report (the authoritative copy). */
      qcReport: qcReportSchema,
    },
  },
  400: exportErrorSchema,
  404: exportErrorSchema,
  409: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
      /** `export-qc-mismatch` only: the per-field client/server diff. */
      differences: { type: 'array', items: qcReportDifferenceSchema },
      /** `export-qc-mismatch` only: the persisted ExportDiagnostic row id. */
      diagnosticId: { type: 'string' },
      /** `export-qc-mismatch` only: the full diagnostic bundle (also
       * persisted server-side under `diagnosticId`). */
      bundle: { type: 'object', additionalProperties: true },
      /** `export-gates-failing` only: failing unacknowledged gate ids. */
      failingGates: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

// GET /api/exports/:hash/download — the 200 body is the raw released bytes
// (no JSON schema; serialized as a Buffer with explicit content-type/
// disposition headers), so only the error statuses carry response schemas.
export const exportDownloadResponseSchema = {
  404: exportErrorSchema,
  500: exportErrorSchema,
} as const;

export const validateQcResponseSchema = {
  200: qcReportSchema,
  // Phase 7 Task 1 (the P6-T8 carry-in): a SCHEMA-valid but semantically
  // invalid body (a typed QC input error thrown during the server's
  // independent recompute) maps to 400 with the diagnostic. This schema must
  // stay PERMISSIVE (no `additionalProperties: false`, `required` covering
  // both shapes): Fastify serializes its OWN AJV validation-error 400s
  // through the same 400 response schema, and their body
  // (`statusCode`/`code`/`error: 'Bad Request'`/`message`) must survive
  // serialization unchanged alongside our `qc-invalid-input` shape.
  400: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      /** Present on the qc-invalid-input shape: the typed error's class name. */
      errorName: { type: 'string' },
      /** Present on Fastify's own validation-error shape. */
      statusCode: { type: 'number' },
      code: { type: 'string' },
    },
  },
  409: {
    type: 'object',
    required: ['error', 'message', 'differences'],
    additionalProperties: false,
    properties: {
      error: { type: 'string', const: 'qc-client-server-mismatch' },
      message: { type: 'string' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'server', 'client'],
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            // Either side of a differing scalar (number|string|boolean|null).
            server: {},
            client: {},
          },
        },
      },
    },
  },
} as const;
