import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import type { Case } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { KERNEL_VERSION, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import type { CaseDocument, QcGateResult, QcReport } from '@dqcad/shared-types';
import {
  runCrownQc,
  type ConnectorCrossSection,
  type ContactResidualInput,
  type RunCrownQcInput,
} from '@dqcad/cad-pipeline';
import {
  loadToothAssetFromBytes,
  ToothAssetMetadataChecksumError,
  ToothAssetMetadataValidationError,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
} from '@dqcad/tooth-library';
import { createEmptyCaseDocument } from './case-document.js';
import { MeshStorageIntegrityError, readMeshBytes, statMeshBytes, storeMeshBytes } from './mesh-storage.js';
import {
  listToothLibraryAssets,
  readLatestToothLibraryMetadata,
  seedStarterToothLibrary,
  seedToothLibraryAsset,
  ToothLibraryStorageIntegrityError,
} from './tooth-library-storage.js';
import {
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

// apps/server/data/meshes — see mesh-storage.ts's module doc. Git-ignored
// (see .gitignore's `apps/server/data/` entry); created on first upload.
const DEFAULT_MESH_DATA_DIR = fileURLToPath(new URL('../data/meshes', import.meta.url));

// apps/server/data/tooth-library — see tooth-library-storage.ts's module
// doc. Git-ignored, same as DEFAULT_MESH_DATA_DIR; seeded with the
// @dqcad/tooth-library starter set at every `buildApp` call (idempotent).
const DEFAULT_TOOTH_LIBRARY_DATA_DIR = fileURLToPath(new URL('../data/tooth-library', import.meta.url));

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

interface MeshDataInput {
  positions: number[];
  indices: number[];
}

interface ValidateQcBody {
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

interface UploadToothLibraryBody {
  metadata: unknown;
  meshBase64: string;
}

interface QcReportDifference {
  path: string;
  server: unknown;
  client: unknown;
}

/** Rebuilds a kernel `IndexedMesh` (Float64 positions, Uint32 indices — the
 * Float64 invariant holds; no Float32 anywhere) from the JSON number arrays.
 * JSON round-trips a Float64 exactly, so this is bit-identical to the mesh the
 * client hashed/measured. */
function toIndexedMesh(data: MeshDataInput): IndexedMesh {
  return { positions: new Float64Array(data.positions), indices: Uint32Array.from(data.indices) };
}

function toVec3(a: readonly number[]): Vec3 {
  const [x, y, z] = a;
  if (x === undefined || y === undefined || z === undefined) {
    // Unreachable — the JSON schema pins these arrays to exactly 3 numbers.
    throw new Error('expected a 3-component vector');
  }
  return [x, y, z];
}

/** Independent (never client-trusting) diff of the server-computed report
 * against an optional client-supplied one — every scalar that differs becomes
 * one `{ path, server, client }` diagnostic entry. Exact equality (`!==`), so a
 * single-ULP float divergence surfaces rather than being smoothed over. */
function diffQcReports(server: QcReport, client: QcReport): QcReportDifference[] {
  const diffs: QcReportDifference[] = [];
  const scalar = (path: string, s: unknown, c: unknown): void => {
    if (s !== c) diffs.push({ path, server: s, client: c });
  };
  scalar('passed', server.passed, client.passed);
  scalar('kernelVersion', server.kernelVersion, client.kernelVersion);
  scalar('profileVersion', server.profileVersion, client.profileVersion);
  scalar('journalHash', server.journalHash, client.journalHash);
  scalar('gates.length', server.gates.length, client.gates.length);
  const n = Math.min(server.gates.length, client.gates.length);
  const fields: readonly (keyof QcGateResult)[] = [
    'gate',
    'passed',
    'acknowledged',
    'value',
    'threshold',
    'unit',
    'message',
  ];
  for (let i = 0; i < n; i++) {
    const s = server.gates[i]!;
    const c = client.gates[i]!;
    for (const f of fields) scalar(`gates[${i}].${f}`, s[f], c[f]);
  }
  return diffs;
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
  const prisma = options.prisma ?? new PrismaClient();
  const meshDataDir = options.meshDataDir ?? DEFAULT_MESH_DATA_DIR;
  const meshMaxBytes = options.meshMaxBytes ?? resolveMeshMaxBytes();
  const toothLibraryDataDir = options.toothLibraryDataDir ?? DEFAULT_TOOTH_LIBRARY_DATA_DIR;

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

  // Phase 4 Task 11: THE dual-validation route (CLAUDE.md invariant 6). Re-runs
  // `runCrownQc` INDEPENDENTLY in the Node server from the crown mesh set + the
  // exact QC context the client used, and returns the server-side `QcReport` —
  // bit-identical to the client's (deterministic, DOM/Three-free gates). The
  // server NEVER trusts a client-sent report: `clientReport`, if present, is a
  // cross-check only — a disagreement is a 409 hard error with a per-field
  // diagnostic bundle (the "client/server QC mismatch = hard error" convention).
  app.post<{ Params: { id: string }; Body: ValidateQcBody }>(
    '/api/restorations/:id/validate-qc',
    { schema: { params: caseIdParamsSchema, body: validateQcBodySchema, response: validateQcResponseSchema } },
    async (request, reply) => {
      const b = request.body;
      const input: RunCrownQcInput = {
        crownSolid: toIndexedMesh(b.crownSolid),
        innerSurfaceMesh: toIndexedMesh(b.innerSurfaceMesh),
        outerSurfaceMesh: toIndexedMesh(b.outerSurfaceMesh),
        dieSolid: toIndexedMesh(b.dieSolid),
        marginResampledPoints: b.marginResampledPoints.map(toVec3),
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

      // Independent recompute — the source of truth (invariant 6).
      const report = await runCrownQc(input);

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

  return app;
}
