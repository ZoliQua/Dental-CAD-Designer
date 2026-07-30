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

## Threat model — what this gate DOES and DOES NOT defend (stated honestly)

The server binds **loopback** (`index.ts` → `host: 'localhost'`), which is
load-bearing: it is the *bind*, not the token, that handles network exposure.

**Defended:**

1. **Other hosts / accidental network exposure (LAN).** A different machine
   cannot reach `127.0.0.1:4100` at all — the loopback bind refuses it. The token
   is not what stops this; the bind is.
2. **Cross-origin forged mutations (CSRF / drive-by).** A malicious web page open
   in the user's browser can *issue* cross-origin requests to
   `http://localhost:4100/api/...`. CORS restricts which origin may *read* a
   response (`origin: http://localhost:5173`), but a "simple" request (e.g. a form
   POST) still **reaches** the handler even when the response is unreadable. The
   token gate blocks the forged mutation: the attacker page cannot *read* the
   token from the CORS-restricted bootstrap, so it cannot forge an *authenticated*
   request. This defense is real and is the primary purpose of the gate.

**NOT defended (explicit — no overclaim):**

- **Any local process / any other OS user on this host.** `127.0.0.1:4100` is
  reachable cross-user on a shared machine, and `GET /api/auth/bootstrap` serves
  the token to *any* such caller over loopback. So a *deliberate* same-host caller
  (including a different OS user who is blocked from reading the `0600` token
  file) can simply `curl` the bootstrap and obtain the token. **The effective
  trust boundary is therefore "any process able to reach loopback on this host,"
  not "the same OS user."** Against deliberate local callers the gate is, by
  design, **CSRF-only** (N2): it stops cross-origin browser forgery, not a local
  process that asks for the token.
- **Multi-tenant identity / network authenticity** — a **future** concern (see
  "Portability").

The `0600` mode on the token file (below) is **defense-in-depth**, NOT the trust
boundary: it avoids casual file reads, accidental inclusion in a backup/commit,
and world-readable exposure. It does **not** establish an OS-user boundary — the
open loopback bootstrap deliberately serves the same token to local callers. We
do not claim otherwise. (A stronger, optional future fix that WOULD restore an
OS-user boundary: gate the bootstrap itself on a same-user check or a
launch-time nonce / file-based token handoff instead of an open HTTP GET. We
chose the open bootstrap here — see §3 — and make its limit explicit rather than
hide it.)

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
user password. It is stored as-is under `0600` file permissions (defense-in-depth
— see the threat model; this is **not** claimed as the trust boundary, which the
open bootstrap sets at "any local process") rather than hashed-at-rest, because
the server must be able to hand the *same* token to the local browser client
(below); a one-way hash would make that impossible. It is **never** written to a
log line and **never** placed in an error body. Nothing about it is committed —
the repo ships no token and no default/shared secret.

**F2 — the disable is never silent.** At real startup (`index.ts`) the server
emits a loud, **non-secret** auth-state line via `console` (visible even when the
Fastify request logger is off, e.g. under `NODE_ENV=test`): `WARN` when the gate
is DISABLED (naming why — `NODE_ENV=test` / `authToken=null` / no token) and
`info` when ENABLED (naming provenance, never the token). An operator who
accidentally runs production with `NODE_ENV=test` sees `[SECURITY] auth gate:
DISABLED …` immediately. `authStartupLine` (auth.ts) is a pure, tested formatter.

### 3. The client obtains the token via a same-origin **bootstrap** (the seam)

The browser cannot read the server's token file. The server exposes
**`GET /api/auth/bootstrap`** → `{ token: string | null }` (open GET; `null` when
the gate is disabled). The client fetches it **once at startup** (`initAuth()` in
`apps/client/src/engine/apiAuth.ts`, called from `main.tsx`), caches the token,
and attaches it to mutating requests.

Why an **open GET** returning the token is acceptable — and its exact limit:
CORS approves *reading* the bootstrap response only for the allowed app origin
(`http://localhost:5173`). A cross-origin attacker page can *trigger* the GET but
**cannot read its body** (Same-Origin Policy — no `Access-Control-Allow-Origin`
for their origin), so it never learns the token, so it cannot forge an
*authenticated* mutation. This is precisely the CSRF defense (threat #2): the
token is a secret the legitimate same-origin app can obtain and the cross-origin
attacker cannot.

**Its limit, stated plainly (F1/N2):** the same open GET serves the token to ANY
*deliberate* local caller on loopback — a `curl`, a script, or a different OS user
who cannot read the `0600` file. So the bootstrap flattens the trust boundary to
"any local process on this host"; against deliberate local callers the gate is
CSRF-only. We **choose** the open bootstrap (it keeps the single-user local run
frictionless — no key handshake, no OS-user probe) and document its boundary
honestly rather than imply a stronger one. The stronger fixes (a same-OS-user
check on the bootstrap, a launch-time nonce, or a file-based token handoff that
never traverses HTTP) are recorded as future hardening, not implemented here.

**N3 (documented):** the auth `onRequest` hook is registered before
@fastify/cors' hook, so a 401 from the gate can omit `Access-Control-Allow-Origin`.
Harmless — the browser still sees the 401; a cross-origin page merely can't read
the (secret-free) 401 body. Reorder CORS before the gate if a future flow needs
that body cross-origin.

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
- A disabled gate is **loud** at startup (F2), never silent.
- **Accepted, documented limitations** — explicit properties of the single-user
  local model, revisited when multi-user lands: (a) reads are open; (b) the
  effective trust boundary is "any process able to reach loopback on this host,"
  so any deliberate local caller can obtain the token via the bootstrap and the
  gate is CSRF-only against them (the `0600` file is defense-in-depth, not that
  boundary); (c) a 401 may lack CORS headers (N3).
</content>
</invoke>
