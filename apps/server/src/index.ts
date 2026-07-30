import { buildApp } from './app.js';
import { authStartupLine } from './auth.js';

// Fastify API port — fixed by PLAN.md's global constraints (port 4100).
// See apps/client/vite.config.ts for the matching proxy configuration.
const PORT = 4100;

const app = await buildApp();

// F2 (misconfig hardening): emit a LOUD, non-secret auth-state line at real
// startup — a disabled gate (e.g. NODE_ENV=test leaking into production) must be
// observable, never silent. Written via `console` (not the Fastify request
// logger, which is itself off under NODE_ENV=test) so it is ALWAYS visible; the
// token is never logged, only the state + its provenance.
const authLine = authStartupLine(app.authConfig);
if (authLine.level === 'warn') {
  console.warn(`[SECURITY] ${authLine.message}`);
} else {
  console.info(`[security] ${authLine.message}`);
}

try {
  await app.listen({ port: PORT, host: 'localhost' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
