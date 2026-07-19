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
    barycentric: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
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
    cementGapMm: { type: 'number' },
    marginalGapMm: { type: 'number' },
    spacerStartMm: { type: 'number' },
    minWallThicknessMm: { type: 'number' },
    proximalContactPenetrationMm: { type: 'number' },
    occlusalContactMm: { type: 'number' },
  },
} as const;

const restorationSchema = {
  type: 'object',
  required: ['id', 'type', 'teeth', 'marginLines', 'insertionAxis', 'params', 'stages', 'qc'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['crown', 'inlay', 'onlay', 'bridge'] },
    teeth: { type: 'array', items: { type: 'integer' } },
    // Keyed by FDI tooth number (a string in JSON) — permissive on values'
    // exact shape beyond object-ness is deliberately NOT relaxed here; each
    // present entry must still be a valid MarginLine.
    marginLines: { type: 'object', additionalProperties: marginLineSchema },
    insertionAxis: vec3Schema,
    params: restorationParamsSchema,
    // `stages`/`qc`: Phase 3 territory (see this section's module doc) —
    // structurally an object (or null for qc), contents unchecked here.
    // `additionalProperties: true` matters for the RESPONSE side too:
    // fast-json-stringify (which serializes GET's response) drops any key
    // not explicitly declared unless a schema says it may pass arbitrary
    // ones through.
    stages: { type: 'object', additionalProperties: true },
    qc: { type: ['object', 'null'], additionalProperties: true },
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

export const getCaseResponseSchema = {
  200: caseDocumentSchema,
} as const;

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
