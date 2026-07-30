// apps/client/src/engine/apiAuth.ts
//
// Phase 8 Task 6 — the client half of the local single-user auth (ADR-020 §3).
// The browser cannot read the server's token file, so it obtains the active
// capability token once at startup from the same-origin bootstrap
// (`GET /api/auth/bootstrap`) and attaches it to MUTATING requests via
// `authHeaders()`.
//
// FRICTIONLESS + OPT-IN: only the real app entry (`main.tsx`) calls `initAuth()`.
// The existing client test harnesses never call it, so `authHeaders()` resolves
// to `{}` immediately (no bootstrap fetch, no behavior change) — a dev/single-
// user run "just works". `initAuth()` is tolerant: a failed/absent bootstrap (a
// disabled-gate build) simply yields no token, and mutations proceed unauthed
// (the server gate is likewise disabled in that configuration).

const BOOTSTRAP_PATH = '/api/auth/bootstrap';

let cachedToken: string | null = null;
/** The single in-flight/settled bootstrap. `null` until `initAuth()` runs — so
 * an un-initialized client (tests) never triggers a fetch. */
let bootstrapPromise: Promise<void> | null = null;

/**
 * Fetches the local capability token from the same-origin bootstrap, once.
 * Idempotent (subsequent calls return the same settled promise). Tolerant: any
 * failure leaves the token null (mutations then go unauthenticated, which is
 * correct against a disabled-gate server). Call from the app entry point.
 */
export function initAuth(apiBase = '/api'): Promise<void> {
  bootstrapPromise ??= (async () => {
    try {
      const response = await fetch(`${apiBase}${BOOTSTRAP_PATH}`);
      if (!response.ok) return;
      const data = (await response.json()) as { token?: string | null };
      cachedToken = typeof data.token === 'string' && data.token.length > 0 ? data.token : null;
    } catch {
      // A disabled-gate build / unreachable bootstrap → no token; harmless.
      cachedToken = null;
    }
  })();
  return bootstrapPromise;
}

/**
 * The auth header(s) to attach to a MUTATING request. Awaits an in-flight
 * bootstrap so a mutation fired right after startup still carries the token.
 * Returns `{}` when the client was never initialized (tests) or the gate is
 * disabled — so no behavior changes in those cases.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  if (bootstrapPromise) await bootstrapPromise;
  return cachedToken ? { authorization: `Bearer ${cachedToken}` } : {};
}

/** Test-only reset of the module singletons. */
export function __resetAuthForTests(): void {
  cachedToken = null;
  bootstrapPromise = null;
}
