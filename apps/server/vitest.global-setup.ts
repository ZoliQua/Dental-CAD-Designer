import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Matches the `env.DATABASE_URL` set for the `server` vitest project in the
// root vitest.config.ts (relative to prisma/schema.prisma's directory).
const TEST_DATABASE_URL = 'file:./test.db';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const testDbFile = fileURLToPath(new URL('./prisma/test.db', import.meta.url));

/**
 * Vitest globalSetup for the `server` project: applies committed migrations to a
 * throwaway SQLite file so `app.inject()` tests hit a real, freshly-migrated schema
 * without touching the developer's dev.db. Runs once before the test file(s), then
 * tears the file down.
 */
export default function setup(): () => void {
  if (existsSync(testDbFile)) {
    rmSync(testDbFile);
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });

  return () => {
    if (existsSync(testDbFile)) {
      rmSync(testDbFile);
    }
  };
}
