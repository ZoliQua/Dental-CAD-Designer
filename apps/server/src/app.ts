import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import type { Case } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument } from '@dqcad/shared-types';
import { createEmptyCaseDocument } from './case-document.js';
import { MeshStorageIntegrityError, readMeshBytes, statMeshBytes, storeMeshBytes } from './mesh-storage.js';
import {
  caseIdParamsSchema,
  createCaseBodySchema,
  createCaseResponseSchema,
  healthResponseSchema,
  listCasesResponseSchema,
  meshHashParamsSchema,
  patchCaseBodySchema,
  patchCaseResponseSchema,
  postMeshResponseSchema,
  putCaseBodySchema,
  putCaseResponseSchema,
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

export interface BuildAppOptions {
  /** Injectable for tests; defaults to a fresh PrismaClient reading DATABASE_URL. */
  prisma?: PrismaClient;
  /** Injectable for tests (an isolated temp dir) — defaults to
   * apps/server/data/meshes. See mesh-storage.ts. */
  meshDataDir?: string;
  /** Injectable for tests — defaults to `MESH_MAX_BYTES` env var or 300 MB. */
  meshMaxBytes?: number;
}

/** App factory: builds and configures a Fastify instance without listening. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
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

  return app;
}
