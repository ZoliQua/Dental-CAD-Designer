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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** HTTP methods that MUTATE state — the gated set (ADR-020 §1). GET/HEAD/OPTIONS
 * are idempotent reads and stay open. A `DELETE` route (none today) is gated the
 * moment it is added, with no per-route wiring. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Where the resolved config came from — a NON-SECRET provenance tag used to
 * emit an honest, loud startup signal (F2; never carries the token itself). */
export type AuthSource =
  | 'explicit-token'
  | 'explicit-disabled'
  | 'env'
  | 'test-env-disabled'
  | 'auto-provisioned';

/** The resolved auth state for a built app. `token` is non-null iff `enabled`. */
export interface AuthConfig {
  readonly enabled: boolean;
  readonly token: string | null;
  readonly source: AuthSource;
}

declare module 'fastify' {
  // The resolved auth config, decorated onto the built app so the real startup
  // entry (index.ts) can emit the loud state signal (F2) from a single source
  // of truth. Non-secret provenance + the token; never logged directly.
  interface FastifyInstance {
    authConfig: AuthConfig;
  }
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
  if (options.authToken === null) return { enabled: false, token: null, source: 'explicit-disabled' };
  if (typeof options.authToken === 'string') {
    if (options.authToken.length === 0) {
      throw new Error('resolveAuthConfig: an explicit authToken must be a non-empty string (or null to disable)');
    }
    return { enabled: true, token: options.authToken, source: 'explicit-token' };
  }

  // 2. Deployment env var.
  const envToken = env[AUTH_TOKEN_ENV];
  if (typeof envToken === 'string' && envToken.length > 0) {
    return { enabled: true, token: envToken, source: 'env' };
  }

  // 3. Test env: disabled by default (the pre-existing suites don't send a
  //    token; the auth suite opts in with an explicit token). Mirrors the
  //    `logger: NODE_ENV !== 'test'` convention.
  if (env.NODE_ENV === 'test') return { enabled: false, token: null, source: 'test-env-disabled' };

  // 4. Real local install: auto-provision (default on, zero setup).
  return { enabled: true, token: provisionFileToken(options.authTokenPath), source: 'auto-provisioned' };
}

/** A NON-SECRET, human-readable startup line describing the auth gate state
 * (F2 — misconfig hardening: a silent disable must be observable). `warn` when
 * the gate is OFF so a prod-misconfig (e.g. NODE_ENV=test leaking into
 * production) is LOUD; `info` when on. Never contains the token. Emitted at real
 * server startup (index.ts) so it is visible even if the Fastify request logger
 * is off, and NOT per `buildApp` (tests stay quiet). */
export function authStartupLine(config: AuthConfig): { level: 'warn' | 'info'; message: string } {
  if (config.enabled) {
    const how =
      config.source === 'auto-provisioned'
        ? 'auto-provisioned local token'
        : config.source === 'env'
          ? 'DQCAD_AUTH_TOKEN env'
          : 'explicit token';
    return { level: 'info', message: `auth gate: ENABLED (${how}); mutating routes require a bearer token` };
  }
  const why =
    config.source === 'test-env-disabled'
      ? 'NODE_ENV=test'
      : config.source === 'explicit-disabled'
        ? 'explicitly disabled (authToken=null)'
        : 'no token';
  return {
    level: 'warn',
    message: `auth gate: DISABLED (${why}) — ALL mutating routes are OPEN (no auth). This must not be a production run.`,
  };
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

/** Genuinely constant-time string equality (N1): both inputs are SHA-256'd to a
 * fixed 32-byte digest before the `timingSafeEqual`, so neither the comparison
 * time nor an early return leaks the input LENGTH — the compare always runs over
 * equal-length digests regardless of `a`/`b` length. (Collision resistance of
 * SHA-256 means equal digests ⇔ equal inputs for any realistic token.) */
export function constantTimeEqual(a: string, b: string): boolean {
  const ad = createHash('sha256').update(a, 'utf8').digest();
  const bd = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ad, bd);
}

/** Registers the single enforcement hook. No-op when the gate is disabled (the
 * hook is never even added, so a disabled build has zero overhead and the
 * pre-existing suites are untouched). The 401 body is typed and secret-free.
 *
 * N3 (documented, benign): this `onRequest` hook is registered before the
 * @fastify/cors plugin's own hook, so a 401 emitted here can short-circuit
 * BEFORE CORS sets `Access-Control-Allow-Origin`. Harmless for the modeled flow
 * — the browser still receives the 401 status; a cross-origin page simply can't
 * READ the 401 body (which is correct: it carries no secret anyway). If a future
 * flow needs the 401 body readable cross-origin, register CORS before the gate. */
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
