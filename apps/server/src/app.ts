import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import type { Case } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { createEmptyCaseDocument } from './case-document.js';
import {
  createCaseBodySchema,
  createCaseResponseSchema,
  healthResponseSchema,
  listCasesResponseSchema,
} from './schemas.js';

// Vite dev server origin — fixed by PLAN.md's global constraints (port 5173).
// See apps/client/vite.config.ts for the matching proxy configuration.
const VITE_ORIGIN = 'http://localhost:5173';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
}

/** App factory: builds and configures a Fastify instance without listening. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  // Vitest sets NODE_ENV=test; keep the test run's output pristine.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const prisma = options.prisma ?? new PrismaClient();

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  void app.register(cors, { origin: VITE_ORIGIN });

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
          schemaVersion: 1,
          documentJson,
        },
      });

      reply.code(201);
      return toCaseSummary(created);
    },
  );

  return app;
}
