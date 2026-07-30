# ADR-020 — Local single-user auth for the DQ-Dental-CAD server

**Status:** Accepted (Phase 8 Task 6)
**Date:** 2026-07
**Supersedes / relates:** ADR-017 (server-authoritative export re-validation) — the
auth gate *wraps* that logic, it never alters it.

## Context

DQ-Dental-CAD is a **local, single-user desktop-class** application: a Fastify API
(`:4100`) plus a Vite SPA (`:5173`, `/api` proxied to the server). Through Phase 7
every route was **unauthenticated** — anyone able to reach `http://localhost:4100`
could create/overwrite cases, upload meshes, release exports, or import archives
(the last two touch content-addressed release bytes; the archive-export route
streams *all* of a case's data, including patient scans).

Phase 8's security criterion (PLAN.md §Phase 8.4) requires a **local single-user
auth that is default-on**, protecting the mutating routes, while keeping a fresh
local install **frictionless** (no painful setup), with **no hardcoded secret in
the repo, in logs, or in any error body**, and **portable to a future multi-user
model without rework**.

## Threat model (what this gate is and is not for)

The server binds loopback. The realistic threats for a local single-user app are:

1. **Cross-origin forged mutations (CSRF / drive-by).** A malicious web page open
   in the user's browser can *issue* cross-origin requests to
   `http://localhost:4100/api/...`. CORS already restricts which origin may
   *read* a response (`origin: http://localhost:5173`), but a "simple" request
   (e.g. a form POST) still **reaches** the handler even when the response is
   unreadable. Without a gate, that forged request mutates state.
2. **Accidental unauthenticated tooling / scripts** hitting the API by mistake.

**Out of scope** (documented, not defended here): a *hostile local process* running
as the same OS user. It can already read the token file directly; the OS user
boundary is the trust boundary for a single-user local app. Network authenticity /
multi-tenant identity is explicitly a **future** concern (see "Portability").

## Decision

### 1. A capability **bearer token**, checked by a Fastify `onRequest` hook

A single random **capability token** authorizes mutations. A global `onRequest`
hook (`registerAuthGate`, `apps/server/src/auth.ts`) gates **every non-idempotent
method — `POST` / `PUT` / `PATCH` / `DELETE`** — regardless of route. The token is
presented as `Authorization: Bearer <token>` (or `X-DQCAD-Auth: <token>`) and
compared in **constant time** (`crypto.timingSafeEqual`). Missing → `401
auth-required`; mismatch → `401 auth-invalid` (typed JSON, **never** echoing the
token or any request body). `GET` / `HEAD` / `OPTIONS` are always open.

**Why gate by HTTP method, not a per-route opt-in:** it makes the gate *compose*
— a newly-added mutating route is auth-gated **by default**, with nothing to
forget. The route-enumeration guard (Task 6 Deliverable 1) plus the auth-composition
test together prove every mutating route rejects an unauthenticated request. The
hook runs **before** body parsing, so an unauthorized upload is refused before its
(potentially large) body is read.

Read-only routes stay open **by design**: `GET /api/health`, `GET /api/cases`,
`GET /api/cases/:id`, `GET|HEAD /api/meshes/:hash`, `GET|HEAD /api/final-meshes/:hash`,
`GET /api/tooth-library[/:fdi]`, `GET /api/exports/:hash/download`, and
`GET /api/exports/:id/traceability.{json,html}`. They expose no mutation; a
single-user local read needs zero friction. (Data *exfiltration* over reads is not
the modeled threat — the same user already owns the files on disk.)

### 2. Frictionless, safe default **provisioning** (no secret in the repo)

Token source, in precedence order (`resolveAuthConfig`):

1. **Explicit option** `BuildAppOptions.authToken` — a `string` sets the token;
   `null` **disables** the gate. (Test/embedding seam.)
2. **`DQCAD_AUTH_TOKEN` env var** (non-empty) — deployment / multi-machine.
3. **Test environment** (`NODE_ENV === 'test'`) with no explicit token → **disabled**.
   This mirrors the existing `logger: NODE_ENV !== 'test'` convention and keeps the
   pre-existing server suites (P4–P7 dual-validation/export) exercising QC/export
   logic **without** auth churn. The gate is proven on/enforcing by the dedicated
   auth suite, which opts in with an explicit token.
4. **Otherwise (a real local install): auto-provision.** A cryptographically
   random 32-byte token (hex) is generated on first start and persisted to
   `apps/server/data/auth-token` (the already-git-ignored `apps/server/data/`
   dir) with mode `0600`; subsequent starts read it back. **Default-on, zero
   setup.**

The token is a randomly-generated **local session capability**, not a
user password. It is stored as-is under `0600` file permissions (the OS user
boundary is the trust boundary) rather than hashed-at-rest, because the server
must be able to hand the *same* token to the local browser client (below); a
one-way hash would make that impossible. It is **never** written to a log line and
**never** placed in an error body. Nothing about it is committed — the repo ships
no token and no default/shared secret.

### 3. The client obtains the token via a same-origin **bootstrap** (the seam)

The browser cannot read the server's token file. The server exposes
**`GET /api/auth/bootstrap`** → `{ token: string | null }` (open GET; `null` when
the gate is disabled). The client fetches it **once at startup** (`initAuth()` in
`apps/client/src/engine/apiAuth.ts`, called from `main.tsx`), caches the token,
and attaches it to mutating requests.

Why an **open GET** returning the token is acceptable under the threat model:
CORS approves *reading* the bootstrap response only for the allowed app origin
(`http://localhost:5173`). A cross-origin attacker page can *trigger* the GET but
**cannot read its body** (Same-Origin Policy — no `Access-Control-Allow-Origin`
for their origin), so it never learns the token, so it cannot forge an
*authenticated* mutation. This is precisely the CSRF defense in threat #1: the
token is a secret the legitimate same-origin app can obtain and the cross-origin
attacker cannot. (A hostile local process reads the file directly — out of scope,
as above.)

The client wiring is **opt-in and tolerant**: `initAuth()` is only called by the
real app entry point; the existing client test harnesses never call it, so
`authHeaders()` returns `{}` and no behavior changes. If the bootstrap fails or
returns `null`, the client simply sends no token (a disabled-gate / dev run "just
works").

## Portability to multi-user (the boundary is a seam)

- **The gate is a hook.** `registerAuthGate(app, config)` is the single
  enforcement point. A multi-user model replaces the `AuthConfig` resolution and
  the token check with a session/identity lookup **without touching any route
  handler** — the handlers never see auth.
- **Identity is a seam.** Today `AuthConfig` carries one token (single user). A
  future `resolveAuthConfig` can return a verifier (`(presented) => Identity | null`)
  and the hook can stamp `request.identity`; routes that later need per-user
  scoping read that seam. Nothing in the QC/export/persistence logic assumes
  "single user" — the change is localized to `auth.ts` + the hook.
- **Transport auth is separable.** Moving off loopback (real multi-machine) swaps
  the bootstrap for a real login/OIDC exchange; the *bearer-token-on-mutations*
  contract with the server is unchanged.

## Consequences

- Fresh local install: **default-on**, auto-provisioned, no setup — frictionless.
- No secret in source, logs, or error bodies; the token file is `0600`, git-ignored.
- The P7 export/validate-qc dual-validation behavior is **byte-identical** — the
  gate wraps, never alters, those handlers (their suites stay green with the
  test-env default).
- A new mutating route is auth-gated automatically (method-based), and the
  route-enumeration guard fails CI if it lacks request/response schemas.
- Accepted limitation: reads are open and a hostile same-OS-user process is not
  defended — both are explicit, documented properties of the single-user local
  model, revisited when multi-user lands.
</content>
</invoke>
