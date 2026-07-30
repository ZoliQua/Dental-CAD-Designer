// apps/server/src/route-audit.ts
//
// Phase 8 Task 6 — route-schema completeness (CLAUDE.md: "Fastify routes always
// define JSON schemas (validation + serialization)"). `collectRouteRecords` is
// wired to `buildApp`'s `onRoute` seam to enumerate EVERY registered Fastify
// route (including Fastify's auto-generated HEAD siblings and @fastify/cors'
// OPTIONS handler); `auditRoutes` returns a violation string for each route that
// is missing a request schema for a part it consumes, or a success-status
// response schema. The enumeration guard test asserts `auditRoutes(real) === []`
// AND that a seeded schema-less route IS flagged (falsifiable — a new
// unschema'd route fails CI).
//
// ## The two DOCUMENTED allowlists (deliberate, not oversights)
//
// A handful of routes legitimately cannot carry a JSON body/response schema:
//  - RAW_BODY_ROUTES: the body is raw `application/octet-stream` bytes (a
//    `Buffer`), not parsed JSON — running an "object" JSON Schema against a
//    Buffer always fails, so these use a per-route `bodyLimit` guard instead
//    (see schemas.ts "Mesh storage"). They DO carry a response schema.
//  - RAW_OR_NO_SUCCESS_RESPONSE_ROUTES: the success body is a raw byte stream
//    (mesh/archive/export download) OR is deliberately un-schema'd (GET
//    /api/cases/:id — ADR-005: a strict response serializer would 500/mangle a
//    legacy-shaped stored document). These still schema their ERROR statuses.
//
// Every entry is asserted to still EXIST in the real route set by the guard, so
// a removed/renamed route cannot leave a stale allowlist entry masking a gap.
import type { onRouteHookHandler } from 'fastify';

/** A registered route, distilled from Fastify's `onRoute` `routeOptions` to the
 * fields the audit needs. */
export interface RouteRecord {
  readonly method: string;
  readonly url: string;
  readonly hasBodySchema: boolean;
  readonly hasParamsSchema: boolean;
  readonly hasQuerySchema: boolean;
  /** True iff `schema.response` declares at least one 2xx status. */
  readonly hasSuccessResponseSchema: boolean;
}

/** Methods that carry a request body (and therefore need a body schema unless
 * the body is raw bytes). */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Methods whose responses carry no JSON body of their own → exempt from the
 * response-schema requirement (HEAD is body-less; OPTIONS is CORS preflight). */
const NO_RESPONSE_BODY_METHODS: ReadonlySet<string> = new Set(['HEAD', 'OPTIONS']);

/** Body-bearing methods that a given route nonetheless consumes with NO request
 * body (a POST that reads its target from the URL and streams a response).
 * Documented allowlist — these carry no body schema because they carry no body.
 * Keyed `METHOD url`. */
export const NO_REQUEST_BODY_ROUTES: ReadonlySet<string> = new Set([
  // Exports the case identified by :id as a streamed .dqca archive; no request
  // body. (A POST — not a GET — so the local single-user auth gate protects
  // this PHI-exfiltration surface; see ADR-020.)
  'POST /api/cases/:id/archive',
]);

/** Routes whose request body is raw octet-stream bytes (no JSON body schema by
 * design; guarded by a per-route `bodyLimit`). Keyed `METHOD url`. */
export const RAW_BODY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/meshes',
  'POST /api/final-meshes',
  'POST /api/archives/import',
]);

/** Routes whose success body is a raw byte stream, or is deliberately
 * un-schema'd (documented per route). Keyed `METHOD url`. */
export const RAW_OR_NO_SUCCESS_RESPONSE_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/cases/:id', // ADR-005 — legacy-shaped stored document served verbatim
  'GET /api/meshes/:hash', // raw octet-stream bytes
  'GET /api/final-meshes/:hash', // raw octet-stream bytes
  'GET /api/exports/:hash/download', // raw released bytes
  'GET /api/exports/:id/traceability.json', // verbatim canonical JSON string
  'GET /api/exports/:id/traceability.html', // text/html string
  'POST /api/cases/:id/archive', // streamed .dqca archive bytes
]);

/** `METHOD url` key for a record (case-normalized method). */
export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/** True iff the URL declares a NAMED path parameter (`:name` segment) that
 * Fastify surfaces on `request.params` and a schema should validate. A `*`
 * wildcard (only the CORS `OPTIONS *` preflight route today) is not a named
 * parameter a route handler validates. */
function urlHasParam(url: string): boolean {
  return url.split('/').some((seg) => seg.startsWith(':'));
}

/**
 * Audits a set of route records against the schema-completeness invariant.
 * Returns a violation message per gap (empty ⇒ fully covered). Pure.
 */
export function auditRoutes(records: readonly RouteRecord[]): string[] {
  const violations: string[] = [];

  for (const r of records) {
    const method = r.method.toUpperCase();
    const key = routeKey(method, r.url);

    // OPTIONS is CORS preflight infrastructure (@fastify/cors' wildcard
    // handler), not an application route — no request/response schema applies.
    if (method === 'OPTIONS') continue;

    // Params: any URL with a path parameter must validate it.
    if (urlHasParam(r.url) && !r.hasParamsSchema) {
      violations.push(`${key}: consumes a path parameter but has no params schema`);
    }

    // Body: a body-bearing method must validate its body, unless the body is
    // raw bytes (RAW_BODY_ROUTES) or the route consumes no body at all
    // (NO_REQUEST_BODY_ROUTES) — both documented.
    if (
      BODY_METHODS.has(method) &&
      !r.hasBodySchema &&
      !RAW_BODY_ROUTES.has(key) &&
      !NO_REQUEST_BODY_ROUTES.has(key)
    ) {
      violations.push(
        `${key}: is a body-bearing method with no body schema (and is not a documented raw-body / no-body route)`,
      );
    }

    // Response: every JSON-bodied method must schema at least its success
    // status, unless it streams raw bytes / is a documented no-response route.
    if (
      !NO_RESPONSE_BODY_METHODS.has(method) &&
      !r.hasSuccessResponseSchema &&
      !RAW_OR_NO_SUCCESS_RESPONSE_ROUTES.has(key)
    ) {
      violations.push(
        `${key}: has no success-status response schema (and is not a documented raw/no-response route)`,
      );
    }
  }

  return violations;
}

/**
 * Verifies the allowlists have no STALE entries — every allowlisted route must
 * still be present in the live route set. Returns a message per stale entry
 * (empty ⇒ clean). Keeps a deleted/renamed route from silently masking a gap.
 */
export function auditAllowlistFreshness(records: readonly RouteRecord[]): string[] {
  const live = new Set(records.map((r) => routeKey(r.method, r.url)));
  const stale: string[] = [];
  for (const key of [
    ...RAW_BODY_ROUTES,
    ...RAW_OR_NO_SUCCESS_RESPONSE_ROUTES,
    ...NO_REQUEST_BODY_ROUTES,
  ]) {
    if (!live.has(key)) stale.push(`allowlist entry has no matching live route: ${key}`);
  }
  return stale;
}

/**
 * The `onRoute` collector: push into `sink` a distilled record for each route
 * Fastify registers. Wire via `buildApp({ onRoute: collectRouteRecords(sink) })`.
 * Fastify's `routeOptions.method` may be a string or array; each method becomes
 * its own record so per-method gating is auditable.
 */
export function collectRouteRecords(sink: RouteRecord[]): onRouteHookHandler {
  return (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const schema = routeOptions.schema ?? {};
    const response = (schema.response ?? {}) as Record<string, unknown>;
    const hasSuccessResponseSchema = Object.keys(response).some((status) => {
      const code = Number(status);
      return Number.isFinite(code) && code >= 200 && code < 300;
    });
    for (const method of methods) {
      sink.push({
        method,
        url: routeOptions.url,
        hasBodySchema: schema.body !== undefined,
        hasParamsSchema: schema.params !== undefined,
        hasQuerySchema: schema.querystring !== undefined,
        hasSuccessResponseSchema,
      });
    }
  };
}
