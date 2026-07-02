import { buildApp } from './app.js';

// Fastify API port — fixed by PLAN.md's global constraints (port 4100).
// See apps/client/vite.config.ts for the matching proxy configuration.
const PORT = 4100;

const app = buildApp();

try {
  await app.listen({ port: PORT, host: 'localhost' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
