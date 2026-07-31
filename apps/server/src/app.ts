import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import type { Case } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyInstance, onRouteHookHandler } from 'fastify';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument, QcReport, RestorationType } from '@dqcad/shared-types';
import {
  runBridgeQc,
  runCrownQc,
  runInlayQc,
  BridgeQcInputError,
  MarginFitInputError,
  MinWallThicknessInputError,
  NonCavityRestorationTypeError,
  type CavityThicknessMinimums,
  type ConnectorCrossSection,
  type ContactResidualInput,
  type CoverageDivider,
  type RunBridgeQcInput,
  type RunCrownQcInput,
  type RunInlayQcInput,
} from '@dqcad/cad-pipeline';
import {
  loadToothAssetFromBytes,
  ToothAssetMetadataChecksumError,
  ToothAssetMetadataValidationError,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
} from '@dqcad/tooth-library';
import { createEmptyCaseDocument } from './case-document.js';
import { registerExportRoutes } from './export-route.js';
import { registerArchiveRoutes } from './archive-route.js';
import { MeshStorageIntegrityError, readMeshBytes, statMeshBytes, storeMeshBytes } from './mesh-storage.js';
import { FinalMeshContainerError } from '@dqcad/io';
import {
  FinalMeshContentMismatchError,
  readFinalMeshBytes,
  statFinalMesh,
  storeFinalMeshContainer,
} from './final-mesh-storage.js';
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
  listToothLibraryAssets,
  readLatestToothLibraryMetadata,
  seedStarterToothLibrary,
  seedToothLibraryAsset,
  ToothLibraryStorageIntegrityError,
} from './tooth-library-storage.js';
import { resolveAuthConfig, registerAuthGate } from './auth.js';
import {
  authBootstrapResponseSchema,
  caseIdParamsSchema,
  createCaseBodySchema,
  createCaseResponseSchema,
  healthResponseSchema,
  listCasesResponseSchema,
  listToothLibraryResponseSchema,
  meshHashParamsSchema,
  patchCaseBodySchema,
  patchCaseResponseSchema,
  postMeshResponseSchema,
  postFinalMeshResponseSchema,
  putCaseBodySchema,
  putCaseResponseSchema,
  toothFdiParamsSchema,
  toothLibraryAssetResponseSchema,
  uploadToothLibraryBodySchema,
  uploadToothLibraryResponseSchema,
  validateQcBodySchema,
  validateQcResponseSchema,
} from './schemas.js';

// Vite dev server origin — fixed by PLAN.md's global constraints (port 5173).
// See apps/client/vite.config.ts for the matching proxy configuration.
const VITE_ORIGIN = 'http://localhost:5173';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Task 11: default max upload size for a single mesh file (binary STL) —
// see docs/plans/phase-1-import-viewer.md's Task 11 brief ("size limit
// configurable, default 300 MB"). Overridable via `BuildAppOptions.meshMaxBytes`
// (tests) or the `MESH_MAX_BYTES` env var (deployment).
const DEFAULT_MESH_MAX_BYTES = 300 * 1024 * 1024;

function resolveMeshMaxBytes(): number {
  const fromEnv = process.env.MESH_MAX_BYTES ? Number(process.env.MESH_MAX_BYTES) : NaN;
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MESH_MAX_BYTES;
}

// Phase 7 Task 6 (Part B, review bodyLimit NOTE): a case archive bundles MANY
// scans + final meshes + released exports, so it is a LARGER size class than a
// single mesh — a dedicated ceiling (default 2 GB) rather than sharing the
// per-mesh limit, overridable via `ARCHIVE_MAX_BYTES` (deployment) or
// `BuildAppOptions.archiveMaxBytes` (tests).
const DEFAULT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function resolveArchiveMaxBytes(): number {
  const fromEnv = process.env.ARCHIVE_MAX_BYTES ? Number(process.env.ARCHIVE_MAX_BYTES) : NaN;
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_ARCHIVE_MAX_BYTES;
}

// apps/server/data/meshes — see mesh-storage.ts's module doc. Git-ignored
// (see .gitignore's `apps/server/data/` entry); created on first upload.
const DEFAULT_MESH_DATA_DIR = fileURLToPath(new URL('../data/meshes', import.meta.url));

// apps/server/data/tooth-library — see tooth-library-storage.ts's module
// doc. Git-ignored, same as DEFAULT_MESH_DATA_DIR; seeded with the
// @dqcad/tooth-library starter set at every `buildApp` call (idempotent).
const DEFAULT_TOOTH_LIBRARY_DATA_DIR = fileURLToPath(new URL('../data/tooth-library', import.meta.url));

// apps/server/data/exports — the content-addressed store of RELEASED export
// bytes (Phase 7 Task 4; see export-route.ts's module doc). Git-ignored, same
// parent as DEFAULT_MESH_DATA_DIR; immutable/write-once like scan files.
const DEFAULT_EXPORTS_DATA_DIR = fileURLToPath(new URL('../data/exports', import.meta.url));

// apps/server/data/final-meshes — the content-addressed store of restoration
// FINAL-MESH container bytes (Phase 7 Task 6; see final-mesh-storage.ts).
// Keyed by the mesh CONTENT hash (`Restoration.stages.finalMesh`) so the export
// endpoint can certify the delivered outer envelope. Git-ignored, same parent
// as DEFAULT_MESH_DATA_DIR; immutable/write-once.
const DEFAULT_FINAL_MESH_DATA_DIR = fileURLToPath(new URL('../data/final-meshes', import.meta.url));

// apps/server/data/auth-token — the auto-provisioned local single-user
// capability token (Phase 8 Task 6; see auth.ts + ADR-020). Git-ignored (same
// `apps/server/data/` tree as the mesh/export stores), created 0600 on first
// real (non-test, no env-token) start; NEVER committed.
const DEFAULT_AUTH_TOKEN_PATH = fileURLToPath(new URL('../data/auth-token', import.meta.url));

interface CaseSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

interface CreateCaseBody {
  name: string;
}

interface PatchCaseBody {
  name: string;
}

function toCaseSummary(row: Case): CaseSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    schemaVersion: row.schemaVersion,
  };
}

// --- Task 11: validate-qc request body typing + context reconstruction ---
// (The JSON → kernel reconstruction helpers + the report differ live in
// qc-input-json.ts, shared with the Phase 7 export route.)

interface CrownValidateQcBody {
  /** Optional (absent for the legacy crown client); the route treats absent /
   * 'crown' as the crown path. Bridges have their own branch (Phase 6 Task 8). */
  restorationType?: 'crown';
  crownSolid: MeshDataInput;
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
  connectors?: ConnectorCrossSection[];
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: string[];
  /** OPTIONAL cross-check — see the route + schemas.ts. Never trusted. */
  clientReport?: QcReport;
}

// Phase 5 Task 9 — the inlay/onlay validate-qc body. Mirrors cad-pipeline's
// `RunInlayQcInput` over JSON (see schemas.ts's inlay branch). `restorationType`
// is REQUIRED and pinned to 'inlay'/'onlay' — it is the discriminator the route
// dispatches on.
interface InlayValidateQcBody {
  restorationType: 'inlay' | 'onlay';
  inlaySolid: MeshDataInput;
  fitSurfaceMesh: MeshDataInput;
  patchMesh: MeshDataInput;
  toothWithCavitySolid: MeshDataInput;
  cavityOutlineResampledPoints: number[][];
  insertionAxis: number[];
  thicknessMinimums: CavityThicknessMinimums;
  /** The cavity marginal-transition band — rides WITH the request (a
   * geometry-scoped parameter; the server uses the exact value the client used,
   * and the bit-identical proof catches any divergence). */
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
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: string[];
  /** OPTIONAL cross-check — see the route + schemas.ts. Never trusted. */
  clientReport?: QcReport;
}

// Phase 6 Task 8 — the bridge validate-qc body. Mirrors cad-pipeline's
// `RunBridgeQcInput` over JSON (see schemas.ts's bridge branch). `restorationType`
// is REQUIRED and pinned to 'bridge' — the discriminator the route dispatches on.
// The largest input surface yet: the fused solid, every per-unit surface, the
// abutment dies, the measured connectors, the profile-resolved thresholds, the
// framework mode, the pontic-relief measurement scalars, and every geometry-scoped
// parameter — all riding WITH the request so the server recomputes independently.
interface BridgeValidateQcBody {
  restorationType: 'bridge';
  assembledSolid: MeshDataInput;
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
  kernelVersion: string;
  profileVersion: string;
  journalHash: string;
  acknowledgedGates?: string[];
  /** OPTIONAL cross-check — see the route + schemas.ts. Never trusted. */
  clientReport?: QcReport;
}

/** The route's discriminated body: crown OR cavity OR bridge (schemas.ts's `oneOf`). */
type ValidateQcBody = CrownValidateQcBody | InlayValidateQcBody | BridgeValidateQcBody;

/** Narrows the union to the cavity branch (`restorationType: 'inlay'|'onlay'`). */
function isInlayBody(body: ValidateQcBody): body is InlayValidateQcBody {
  const t = (body as { restorationType?: RestorationType }).restorationType;
  return t === 'inlay' || t === 'onlay';
}

/** Narrows the union to the bridge branch (`restorationType: 'bridge'`). Absent
 * `restorationType` (the legacy crown client) or 'crown' → the crown path. */
function isBridgeBody(body: ValidateQcBody): body is BridgeValidateQcBody {
  return (body as { restorationType?: RestorationType }).restorationType === 'bridge';
}

interface UploadToothLibraryBody {
  metadata: unknown;
  meshBase64: string;
}

/** Rebuilds a `RunCrownQcInput` from the crown validate-qc body (Phase 4 Task
 * 11). Pure JSON → kernel reconstruction; the server recomputes, never trusts. */
function reconstructCrownQcInput(b: CrownValidateQcBody): RunCrownQcInput {
  return {
    crownSolid: toIndexedMesh(b.crownSolid),
    innerSurfaceMesh: toIndexedMesh(b.innerSurfaceMesh),
    outerSurfaceMesh: toIndexedMesh(b.outerSurfaceMesh),
    dieSolid: toIndexedMesh(b.dieSolid),
    marginResampledPoints: toLoop(b.marginResampledPoints),
    insertionAxis: toVec3(b.insertionAxis),
    minWallThicknessMm: b.minWallThicknessMm,
    occlusalMinWallThicknessMm: b.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: b.connectorAreaTargetMm2,
    contacts: b.contacts,
    contactClampWarning: b.contactClampWarning,
    marginExclusionMm: b.marginExclusionMm,
    marginFitThresholdMm: b.marginFitThresholdMm,
    seatingInterferenceVolumeToleranceMm3: b.seatingInterferenceVolumeToleranceMm3,
    contactToleranceMm: b.contactToleranceMm,
    connectors: b.connectors,
    kernelVersion: b.kernelVersion,
    profileVersion: b.profileVersion,
    journalHash: b.journalHash,
    acknowledgedGates: b.acknowledgedGates,
  };
}

/** Rebuilds a `RunInlayQcInput` from the inlay/onlay validate-qc body (Phase 5
 * Task 9) — the restoration-type-aware context reconstruction. Every value comes
 * from the request (the meshes, the cavity outline, the seam/coverage geometry,
 * the profile-resolved thickness minimums, AND the geometry-scoped
 * `marginExclusionMm` band that rides with the request); the server then runs
 * `runInlayQc` INDEPENDENTLY. `cavityTriangleIndices` is rebuilt as a `Uint32Array`
 * (the worker-payload currency), so the seam gate's excluded-triangle set is
 * byte-for-byte what the client used. */
function reconstructInlayQcInput(b: InlayValidateQcBody): RunInlayQcInput {
  const coverage: RunInlayQcInput['coverage'] = b.coverage
    ? {
        coverageDivider: {
          pointMm: toVec3(b.coverage.coverageDivider.pointMm),
          normalMm: toVec3(b.coverage.coverageDivider.normalMm),
        } satisfies CoverageDivider,
        cuspCoverageMinThicknessMm: b.coverage.cuspCoverageMinThicknessMm,
      }
    : undefined;
  return {
    inlaySolid: toIndexedMesh(b.inlaySolid),
    fitSurfaceMesh: toIndexedMesh(b.fitSurfaceMesh),
    patchMesh: toIndexedMesh(b.patchMesh),
    toothWithCavitySolid: toIndexedMesh(b.toothWithCavitySolid),
    cavityOutlineResampledPoints: toLoop(b.cavityOutlineResampledPoints),
    insertionAxis: toVec3(b.insertionAxis),
    restorationType: b.restorationType,
    thicknessMinimums: b.thicknessMinimums,
    coverage,
    marginExclusionMm: b.marginExclusionMm,
    seamEdges: toSeamEdges(b.seamEdges),
    cavityTriangleIndices: Uint32Array.from(b.cavityTriangleIndices),
    contacts: b.contacts,
    contactClampWarning: b.contactClampWarning,
    marginFitThresholdMm: b.marginFitThresholdMm,
    seamDihedralThresholdDeg: b.seamDihedralThresholdDeg,
    seatingInterferenceVolumeToleranceMm3: b.seatingInterferenceVolumeToleranceMm3,
    contactToleranceMm: b.contactToleranceMm,
    kernelVersion: b.kernelVersion,
    profileVersion: b.profileVersion,
    journalHash: b.journalHash,
    acknowledgedGates: b.acknowledgedGates,
  };
}

/** Rebuilds a `RunBridgeQcInput` from the bridge validate-qc body (Phase 6 Task
 * 8) — the whole-bridge context reconstruction (the largest input surface).
 * EVERY value comes from the request: the fused solid, every per-unit surface,
 * the abutment dies, the measured connectors, the profile-resolved thresholds,
 * the framework mode, AND the geometry-scoped pontic-relief scalars + tolerance
 * overrides that ride with the request. The server then runs `runBridgeQc`
 * INDEPENDENTLY (invariant 6). */
function reconstructBridgeQcInput(b: BridgeValidateQcBody): RunBridgeQcInput {
  return {
    assembledSolid: toIndexedMesh(b.assembledSolid),
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
    kernelVersion: b.kernelVersion,
    profileVersion: b.profileVersion,
    journalHash: b.journalHash,
    acknowledgedGates: b.acknowledgedGates,
  };
}

export interface BuildAppOptions {
  /** Injectable for tests; defaults to a fresh PrismaClient reading DATABASE_URL. */
  prisma?: PrismaClient;
  /** Injectable for tests (an isolated temp dir) — defaults to
   * apps/server/data/meshes. See mesh-storage.ts. */
  meshDataDir?: string;
  /** Injectable for tests — defaults to `MESH_MAX_BYTES` env var or 300 MB. */
  meshMaxBytes?: number;
  /** Injectable for tests (an isolated temp dir) — defaults to
   * apps/server/data/tooth-library. See tooth-library-storage.ts. */
  toothLibraryDataDir?: string;
  /** Injectable for tests (an isolated temp dir) — defaults to
   * apps/server/data/exports. See export-route.ts. */
  exportsDataDir?: string;
  /** Injectable for tests (an isolated temp dir) — defaults to
   * apps/server/data/final-meshes. See final-mesh-storage.ts. */
  finalMeshDataDir?: string;
  /** Injectable for tests — defaults to `ARCHIVE_MAX_BYTES` env var or 2 GB. */
  archiveMaxBytes?: number;
  /** Phase 8 Task 6 — local single-user auth (ADR-020). A `string` sets the
   * capability token (gate ON); `null` DISABLES the gate; `undefined`
   * (production default) resolves from `DQCAD_AUTH_TOKEN`, else disabled under
   * NODE_ENV=test, else an auto-provisioned 0600 token file. */
  authToken?: string | null;
  /** Injectable for tests (an isolated temp path) — defaults to
   * apps/server/data/auth-token. Only consulted when auto-provisioning. */
  authTokenPath?: string;
  /** Test seam: an `onRoute` hook registered BEFORE any route, so the
   * route-schema audit (route-audit.ts) can enumerate every registered route
   * with its schemas. Unused in production. */
  onRoute?: onRouteHookHandler;
}

/** App factory: builds and configures a Fastify instance without
 * listening. ASYNC (Phase 4 Task 2 — was sync through Phase 3): seeds the
 * `@dqcad/tooth-library` starter set (`seedStarterToothLibrary`,
 * idempotent, deterministic — see that module's doc) before returning, so
 * `GET /api/tooth-library` never races an in-flight seed. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Vitest sets NODE_ENV=test; keep the test run's output pristine.
  //
  // `ajv.customOptions.removeAdditional: false` overrides Fastify's own
  // default (`removeAdditional: true`), which otherwise SILENTLY STRIPS any
  // property not listed in a schema instead of rejecting the request —
  // meaning every `additionalProperties: false` in schemas.ts (in
  // particular `caseDocumentSchema`, this task's "schema-validated against
  // shared-types shape" requirement) would be a no-op. With this override, an
  // unrecognized field on `PUT /api/cases/:id`'s body is a genuine 400.
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    ajv: { customOptions: { removeAdditional: false } },
  });
  // Register the route-audit collector FIRST (before any route/plugin), so it
  // fires as each route — including Fastify's auto-generated HEAD siblings and
  // @fastify/cors' OPTIONS handler — is registered (test seam; see route-audit.ts).
  if (options.onRoute) {
    app.addHook('onRoute', options.onRoute);
  }

  // Phase 8 Task 6 — resolve + install the local single-user auth gate (ADR-020).
  // Registered here so the `onRequest` hook precedes every route (incl. the
  // body-parser), rejecting an unauthorized mutation before its body is read.
  const authConfig = resolveAuthConfig({
    authToken: options.authToken,
    authTokenPath: options.authTokenPath ?? DEFAULT_AUTH_TOKEN_PATH,
  });
  registerAuthGate(app, authConfig);
  // Expose the resolved state (single source of truth) so the real startup
  // entry (index.ts) can emit the loud auth-state signal (F2). Decorated, not
  // logged here — buildApp runs per-test, and the loud signal belongs at
  // process startup, not on every app build.
  app.decorate('authConfig', authConfig);

  const prisma = options.prisma ?? new PrismaClient();
  const meshDataDir = options.meshDataDir ?? DEFAULT_MESH_DATA_DIR;
  const meshMaxBytes = options.meshMaxBytes ?? resolveMeshMaxBytes();
  const toothLibraryDataDir = options.toothLibraryDataDir ?? DEFAULT_TOOTH_LIBRARY_DATA_DIR;
  const exportsDataDir = options.exportsDataDir ?? DEFAULT_EXPORTS_DATA_DIR;
  const finalMeshDataDir = options.finalMeshDataDir ?? DEFAULT_FINAL_MESH_DATA_DIR;
  const archiveMaxBytes = options.archiveMaxBytes ?? resolveArchiveMaxBytes();

  await seedStarterToothLibrary(toothLibraryDataDir, meshDataDir);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  void app.register(cors, { origin: VITE_ORIGIN });

  // Task 11: POST /api/meshes' body is raw bytes, not JSON — Fastify has no
  // built-in parser for application/octet-stream (only json/text/urlencoded
  // ship by default), so without this every upload would 415. `parseAs:
  // 'buffer'` hands the handler the exact bytes with no re-encoding. See
  // schemas.ts's "Mesh storage" section doc for why this route has no
  // `schema.body`.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.get('/api/health', { schema: { response: healthResponseSchema } }, async () => ({
    status: 'ok' as const,
    version: packageJson.version,
    kernelVersion: KERNEL_VERSION,
  }));

  // Phase 8 Task 6 — the local single-user auth bootstrap (ADR-020 §3). The
  // same-origin client reads the active capability token once at startup and
  // attaches it to mutating requests. `null` when the gate is disabled. Open GET
  // BY DESIGN: CORS restricts which origin may READ this response, which is what
  // keeps the token out of a cross-origin attacker's hands (the CSRF defense).
  app.get('/api/auth/bootstrap', { schema: { response: authBootstrapResponseSchema } }, async () => ({
    token: authConfig.token,
  }));

  app.get('/api/cases', { schema: { response: listCasesResponseSchema } }, async () => {
    const cases = await prisma.case.findMany({ orderBy: { createdAt: 'asc' } });
    return cases.map(toCaseSummary);
  });

  app.post<{ Body: CreateCaseBody }>(
    '/api/cases',
    { schema: { body: createCaseBodySchema, response: createCaseResponseSchema } },
    async (request, reply) => {
      const id = randomUUID();
      const documentJson = JSON.stringify(
        createEmptyCaseDocument(id, new Date().toISOString()),
      );

      const created = await prisma.case.create({
        data: {
          id,
          name: request.body.name,
          schemaVersion: 2,
          documentJson,
        },
      });

      reply.code(201);
      return toCaseSummary(created);
    },
  );

  app.patch<{ Params: { id: string }; Body: PatchCaseBody }>(
    '/api/cases/:id',
    {
      schema: {
        params: caseIdParamsSchema,
        body: patchCaseBodySchema,
        response: patchCaseResponseSchema,
      },
    },
    async (request, reply) => {
      const existing = await prisma.case.findUnique({ where: { id: request.params.id } });
      if (!existing) {
        reply.code(404);
        throw new Error('case not found');
      }
      const updated = await prisma.case.update({
        where: { id: request.params.id },
        data: { name: request.body.name },
      });
      return toCaseSummary(updated);
    },
  );

  // NO `schema.response` here — deliberately (Task-11-review Critical 4):
  // see schemas.ts's comment where `getCaseResponseSchema` used to live for
  // why a strict response schema on this route silently corrupts/500s on a
  // legacy-shaped stored document. `params` validation is unaffected.
  app.get<{ Params: { id: string } }>(
    '/api/cases/:id',
    { schema: { params: caseIdParamsSchema } },
    async (request, reply) => {
      const found = await prisma.case.findUnique({ where: { id: request.params.id } });
      if (!found) {
        reply.code(404);
        throw new Error('case not found');
      }
      return JSON.parse(found.documentJson) as CaseDocument;
    },
  );

  // Task 11: full-document save. `schema.body` (putCaseBodySchema, same
  // shape as caseDocumentSchema) is what enforces "schema-validated against
  // shared-types shape, schemaVersion checked" (schemaVersion's `const: 2`
  // in the schema rejects anything else — including a legacy schemaVersion-1
  // document, see caseDocumentSchema's doc — with a 400 before this handler
  // ever runs). `request.params.id` (the URL) is the authority for WHICH case
  // gets overwritten — a `body.id` that disagrees with it is almost
  // certainly a client bug (saving into the wrong case), so it's rejected
  // rather than silently trusted. `updatedAt` is maintained by Prisma's
  // `@updatedAt` (schema.prisma) on every `update` call, not set here.
  // Last-write-wins: no optimistic-concurrency / conflict check (YAGNI per
  // this task's guardrails — no multi-user support in Phase 1).
  app.put<{ Params: { id: string }; Body: CaseDocument }>(
    '/api/cases/:id',
    {
      schema: {
        params: caseIdParamsSchema,
        body: putCaseBodySchema,
        response: putCaseResponseSchema,
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        reply.code(400);
        throw new Error(
          `CaseDocument.id (${request.body.id}) does not match the URL's :id (${request.params.id})`,
        );
      }
      const existing = await prisma.case.findUnique({ where: { id: request.params.id } });
      if (!existing) {
        reply.code(404);
        throw new Error('case not found');
      }
      const updated = await prisma.case.update({
        where: { id: request.params.id },
        data: {
          schemaVersion: request.body.schemaVersion,
          documentJson: JSON.stringify(request.body),
        },
      });
      return toCaseSummary(updated);
    },
  );

  // Task 11: content-addressed mesh storage — see mesh-storage.ts's module
  // doc. `bodyLimit` here (not a global Fastify constructor option) keeps
  // the 300 MB-by-default ceiling scoped to just this upload route; every
  // other route keeps Fastify's own default body limit.
  app.post<{ Body: Buffer }>(
    '/api/meshes',
    { bodyLimit: meshMaxBytes, schema: { response: postMeshResponseSchema } },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        reply.code(415);
        throw new Error(
          `POST /api/meshes requires Content-Type: application/octet-stream with a raw body, got ${JSON.stringify(request.headers['content-type'] ?? null)}`,
        );
      }
      try {
        const { hash, byteLength } = await storeMeshBytes(meshDataDir, body);
        return { hash, byteLength };
      } catch (error) {
        if (error instanceof MeshStorageIntegrityError) {
          reply.code(500);
          throw error;
        }
        throw error;
      }
    },
  );

  // NOTE: registered BEFORE the GET route below — Fastify's default
  // `exposeHeadRoutes: true` auto-generates a sibling HEAD handler for every
  // GET route, so a custom HEAD handler must be defined first (see Fastify's
  // Server.md#exposeHeadRoutes doc) or this registration would collide with
  // the auto-generated one.
  app.head<{ Params: { hash: string } }>(
    '/api/meshes/:hash',
    { schema: { params: meshHashParamsSchema } },
    async (request, reply) => {
      const size = await statMeshBytes(meshDataDir, request.params.hash);
      if (size === null) {
        reply.code(404);
        return reply.send();
      }
      reply.header('content-length', String(size));
      reply.type('application/octet-stream');
      reply.code(200);
      return reply.send();
    },
  );

  app.get<{ Params: { hash: string } }>(
    '/api/meshes/:hash',
    { schema: { params: meshHashParamsSchema } },
    async (request, reply) => {
      const bytes = await readMeshBytes(meshDataDir, request.params.hash);
      if (!bytes) {
        reply.code(404);
        throw new Error(`no mesh stored for hash ${request.params.hash}`);
      }
      reply.type('application/octet-stream');
      return bytes;
    },
  );

  // Phase 7 Task 6 (Part A — the T4-F2 closure): content-addressed final-mesh
  // container storage. POST stores a lossless container keyed by the DECODED
  // mesh's content hash (server-computed, never trusted); the client HEAD-checks
  // first (idempotent skip) and asserts the returned hash equals its own
  // `stages.finalMesh`. `bodyLimit` shares the mesh ceiling (a final solid is
  // the same size class as a scan mesh).
  app.post<{ Body: Buffer }>(
    '/api/final-meshes',
    { bodyLimit: meshMaxBytes, schema: { response: postFinalMeshResponseSchema } },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        reply.code(415);
        throw new Error(
          `POST /api/final-meshes requires Content-Type: application/octet-stream with a raw body, got ${JSON.stringify(request.headers['content-type'] ?? null)}`,
        );
      }
      try {
        const { contentHash, byteLength } = await storeFinalMeshContainer(finalMeshDataDir, body);
        return { contentHash, byteLength };
      } catch (error) {
        if (error instanceof FinalMeshContainerError || error instanceof FinalMeshContentMismatchError) {
          reply.code(400);
          return { error: error.name, message: error.message };
        }
        throw error;
      }
    },
  );

  app.head<{ Params: { hash: string } }>(
    '/api/final-meshes/:hash',
    { schema: { params: meshHashParamsSchema } },
    async (request, reply) => {
      const size = await statFinalMesh(finalMeshDataDir, request.params.hash);
      if (size === null) {
        reply.code(404);
        return reply.send();
      }
      reply.header('content-length', String(size));
      reply.type('application/octet-stream');
      reply.code(200);
      return reply.send();
    },
  );

  app.get<{ Params: { hash: string } }>(
    '/api/final-meshes/:hash',
    { schema: { params: meshHashParamsSchema } },
    async (request, reply) => {
      const bytes = await readFinalMeshBytes(finalMeshDataDir, request.params.hash);
      if (!bytes) {
        reply.code(404);
        throw new Error(`no final mesh stored for content hash ${request.params.hash}`);
      }
      reply.type('application/octet-stream');
      return bytes;
    },
  );

  // Phase 4 Task 2: tooth-library asset metadata. Mesh bytes are fetched
  // via the mesh route directly above, using the returned metadata's own
  // `meshChecksum` — see tooth-library-storage.ts's module doc and
  // packages/tooth-library/src/README.md's "Backend routes" section for
  // why there is no separate binary route here.
  app.get('/api/tooth-library', { schema: { response: listToothLibraryResponseSchema } }, async () => {
    return listToothLibraryAssets(toothLibraryDataDir);
  });

  app.get<{ Params: { fdi: string } }>(
    '/api/tooth-library/:fdi',
    { schema: { params: toothFdiParamsSchema, response: toothLibraryAssetResponseSchema } },
    async (request, reply) => {
      const fdi = Number(request.params.fdi);
      const metadata = await readLatestToothLibraryMetadata(toothLibraryDataDir, fdi);
      if (!metadata) {
        reply.code(404);
        throw new Error(`no tooth-library asset stored for FDI ${fdi}`);
      }
      return metadata;
    },
  );

  // Phase 4 Task 11: admin upload of a tooth-library asset — content-addressed
  // (mesh bytes → the P1 store), versioned + write-once (T2's
  // `seedToothLibraryAsset`), and schema/checksum/watertight validated
  // server-side by REUSING `@dqcad/tooth-library`'s `loadToothAssetFromBytes`
  // (the exact validation the loader does — invariant 4/5's "corrupt → loud
  // typed error"). A tampered checksum / non-watertight mesh / malformed
  // metadata is a loud 4xx; a conflicting (same fdi+version, different bytes)
  // asset is a 409 integrity error — an asset version is immutable.
  app.post<{ Body: UploadToothLibraryBody }>(
    '/api/tooth-library',
    { schema: { body: uploadToothLibraryBodySchema, response: uploadToothLibraryResponseSchema } },
    async (request, reply) => {
      // base64 → bytes. `Buffer.from(_, 'base64')` never throws (it drops
      // invalid chars), so a garbled payload simply fails the checksum gate
      // below — still a loud rejection, never a silent accept.
      const meshBytes = new Uint8Array(Buffer.from(request.body.meshBase64, 'base64'));

      let metadata;
      try {
        // Independent validation: recomputes the mesh checksum from the bytes,
        // re-parses + welds the mesh and asserts watertight, and re-verifies
        // the metadata checksum — never trusts the claimed checksums.
        ({ metadata } = loadToothAssetFromBytes(request.body.metadata, meshBytes));
      } catch (error) {
        if (
          error instanceof ToothMeshChecksumError ||
          error instanceof ToothMeshNotWatertightError ||
          error instanceof ToothAssetMetadataValidationError ||
          error instanceof ToothAssetMetadataChecksumError
        ) {
          reply.code(400);
          throw error;
        }
        throw error;
      }

      try {
        await seedToothLibraryAsset(toothLibraryDataDir, meshDataDir, metadata, meshBytes);
      } catch (error) {
        if (error instanceof ToothLibraryStorageIntegrityError) {
          reply.code(409);
          throw error;
        }
        throw error;
      }

      reply.code(201);
      return metadata;
    },
  );

  // Phase 4 Task 11 / Phase 5 Task 9 / Phase 6 Task 8: THE dual-validation route
  // (CLAUDE.md invariant 6). Re-runs the restoration-type-aware QC gate suite
  // INDEPENDENTLY in the Node server from the mesh set + the exact QC context the
  // client used, and returns the server-side `QcReport` — bit-identical to the
  // client's (deterministic, DOM/Three-free gates). The body is a discriminated
  // union (schemas.ts's `oneOf`): a crown body → `runCrownQc`; an inlay/onlay
  // body (`restorationType: 'inlay'|'onlay'`) → `runInlayQc`; a bridge body
  // (`restorationType: 'bridge'`) → `runBridgeQc` (the whole-bridge 11-gate set).
  // The server NEVER trusts a client-sent report: `clientReport`, if present, is a
  // cross-check only — a disagreement is a 409 hard error with a per-field
  // diagnostic bundle (the "client/server QC mismatch = hard error" convention).
  //
  // `bodyLimit` is raised to `meshMaxBytes` (the mesh-upload ceiling) because a
  // cavity fit surface (marching-cubes at ~20 µm pitch) serializes to well past
  // Fastify's 1 MiB default; the crown path fit comfortably under it but shares
  // the same generous ceiling now.
  app.post<{ Params: { id: string }; Body: ValidateQcBody }>(
    '/api/restorations/:id/validate-qc',
    {
      bodyLimit: meshMaxBytes,
      schema: { params: caseIdParamsSchema, body: validateQcBodySchema, response: validateQcResponseSchema },
    },
    async (request, reply) => {
      const b = request.body;

      // Independent recompute — the source of truth (invariant 6). Dispatch on
      // the discriminator: bridge → runBridgeQc; inlay/onlay → runInlayQc; else
      // (absent/'crown') → runCrownQc.
      //
      // P7-T1 (the P6-T8 carry-in): a body can be SCHEMA-valid (passes the AJV
      // oneOf) yet semantically invalid for the QC pipeline — e.g. an abutment
      // unit without `fitRegion` (schema-optional; the AJV schema cannot
      // express "required iff kind==='abutment'"), or an empty margin/outline
      // polyline. Those surface as TYPED input errors from the reconstruction/
      // gate pipeline and are the CLIENT's fault → 400 with the diagnostic
      // message, on all three branches uniformly. Anything else is a genuine
      // server bug and still escapes to 500 — never blanket-caught.
      let report: QcReport;
      try {
        report = isBridgeBody(b)
          ? await runBridgeQc(reconstructBridgeQcInput(b))
          : isInlayBody(b)
            ? await runInlayQc(reconstructInlayQcInput(b))
            : await runCrownQc(reconstructCrownQcInput(b));
      } catch (error) {
        if (
          error instanceof BridgeQcInputError ||
          error instanceof MarginFitInputError ||
          error instanceof MinWallThicknessInputError ||
          error instanceof NonCavityRestorationTypeError ||
          error instanceof MeshIndexOutOfBoundsError
        ) {
          reply.code(400);
          return { error: 'qc-invalid-input' as const, errorName: error.name, message: error.message };
        }
        throw error;
      }

      if (b.clientReport) {
        const differences = diffQcReports(report, b.clientReport);
        if (differences.length > 0) {
          reply.code(409);
          return {
            error: 'qc-client-server-mismatch' as const,
            message:
              `client/server QcReport disagreement on ${differences.length} field(s) — ` +
              'the server re-validation is authoritative; the export is blocked (invariant 6).',
            differences,
          };
        }
      }

      return report;
    },
  );

  // Phase 7 Task 4: POST /api/restorations/:id/export (independent
  // re-validation on the exact exported bytes) + GET /api/exports/:hash/
  // download — see export-route.ts's module doc for the full design.
  registerExportRoutes(app, { prisma, exportsDataDir, finalMeshDataDir, meshMaxBytes });

  // Phase 7 Task 6 (Part B): case archive export/import — POST
  // /api/cases/:id/archive (streamed archive bytes) + POST /api/archives/import
  // (reconstruct into a new/overwritten case). See archive-route.ts.
  registerArchiveRoutes(app, {
    prisma,
    meshDataDir,
    finalMeshDataDir,
    exportsDataDir,
    archiveMaxBytes,
  });

  return app;
}
