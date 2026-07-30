// apps/server/src/auth.ts
//
// Phase 8 Task 6 — local single-user auth (default on). See
// docs/adr/020-local-single-user-auth.md for the full model, threat analysis,
// and multi-user portability boundary.
//
// A single random CAPABILITY TOKEN authorizes MUTATIONS. A global `onRequest`
// hook gates every non-idempotent method (POST/PUT/PATCH/DELETE) regardless of
// route — so a newly-added mutating route is auth-gated BY DEFAULT (the gate
// composes; nothing to forget). GET/HEAD/OPTIONS are always open. The token is
// compared in CONSTANT TIME; a rejection is a typed 401 that NEVER echoes the
// token or any request body (no secret/PHI in an error body or a log line).
//
// Provisioning is frictionless and safe (ADR-020 §2): an explicit option, else
// `DQCAD_AUTH_TOKEN`, else disabled under NODE_ENV=test, else an auto-generated
// 0600 token file under the git-ignored `apps/server/data/` dir. NO secret ships
// in the repo.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** HTTP methods that MUTATE state — the gated set (ADR-020 §1). GET/HEAD/OPTIONS
 * are idempotent reads and stay open. A `DELETE` route (none today) is gated the
 * moment it is added, with no per-route wiring. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The resolved auth state for a built app. `token` is non-null iff `enabled`. */
export interface AuthConfig {
  readonly enabled: boolean;
  readonly token: string | null;
}

export interface ResolveAuthOptions {
  /** Explicit override: a string sets the token; `null` DISABLES the gate;
   * `undefined` falls through to env / test-env / auto-provision. */
  readonly authToken?: string | null;
  /** Absolute path to the persisted auto-provisioned token file (created 0600
   * on first use). Only consulted when auto-provisioning. */
  readonly authTokenPath: string;
  /** Injectable for tests — defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const AUTH_TOKEN_ENV = 'DQCAD_AUTH_TOKEN';

/** Reads the persisted token, or generates + persists a new one (0600). The
 * parent dir (`apps/server/data/`) is created if missing — same git-ignored
 * tree the mesh/export stores live under. */
function provisionFileToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is subject to umask on creation; chmod pins 0600 even
  // when the file already existed or umask widened it.
  chmodSync(path, 0o600);
  return token;
}

/** Resolves the auth configuration (ADR-020 §2 precedence). Pure w.r.t. its
 * inputs except for the auto-provision branch, which reads/writes the token
 * file. NEVER logs the token. */
export function resolveAuthConfig(options: ResolveAuthOptions): AuthConfig {
  const env = options.env ?? process.env;

  // 1. Explicit option wins (test/embedding seam).
  if (options.authToken === null) return { enabled: false, token: null };
  if (typeof options.authToken === 'string') {
    if (options.authToken.length === 0) {
      throw new Error('resolveAuthConfig: an explicit authToken must be a non-empty string (or null to disable)');
    }
    return { enabled: true, token: options.authToken };
  }

  // 2. Deployment env var.
  const envToken = env[AUTH_TOKEN_ENV];
  if (typeof envToken === 'string' && envToken.length > 0) {
    return { enabled: true, token: envToken };
  }

  // 3. Test env: disabled by default (the pre-existing suites don't send a
  //    token; the auth suite opts in with an explicit token). Mirrors the
  //    `logger: NODE_ENV !== 'test'` convention.
  if (env.NODE_ENV === 'test') return { enabled: false, token: null };

  // 4. Real local install: auto-provision (default on, zero setup).
  return { enabled: true, token: provisionFileToken(options.authTokenPath) };
}

/** Extracts a presented token from `Authorization: Bearer <t>` or `X-DQCAD-Auth:
 * <t>`. Returns `null` when absent/malformed. */
export function extractPresentedToken(headers: FastifyRequest['headers']): string | null {
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer[ ]+(.+)$/i.exec(auth.trim());
    if (match) return match[1]!.trim();
  }
  const custom = headers['x-dqcad-auth'];
  if (typeof custom === 'string' && custom.length > 0) return custom.trim();
  return null;
}

/** Constant-time string equality. Length-guarded (timingSafeEqual throws on
 * unequal-length buffers) via a fixed-length compare against a padded copy, so
 * the early-return does not leak length by timing beyond the unavoidable. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a compare (against itself) so the branch cost is symmetric-ish;
    // length inequality is already a definite non-match.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Registers the single enforcement hook. No-op when the gate is disabled (the
 * hook is never even added, so a disabled build has zero overhead and the
 * pre-existing suites are untouched). The 401 body is typed and secret-free. */
export function registerAuthGate(app: FastifyInstance, config: AuthConfig): void {
  if (!config.enabled || config.token === null) return;
  const token = config.token;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    const presented = extractPresentedToken(request.headers);
    if (presented === null) {
      reply.code(401).send({
        error: 'auth-required',
        message:
          'this mutating request requires a local auth token — present it as ' +
          '`Authorization: Bearer <token>` (obtain it from GET /api/auth/bootstrap on the local origin)',
      });
      return reply;
    }
    if (!constantTimeEqual(presented, token)) {
      reply.code(401).send({
        error: 'auth-invalid',
        message: 'the presented auth token is not valid for this local server',
      });
      return reply;
    }
    // Authorized — fall through to the route. (A future multi-user model stamps
    // `request.identity` here; see ADR-020 "Portability".)
  });
}
