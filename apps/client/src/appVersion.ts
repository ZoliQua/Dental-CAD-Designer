// apps/client/src/appVersion.ts
//
// The client app's own version tag — bumped manually alongside
// client-facing changes worth tracking in exported artifacts (Phase 3 Task
// 7's dev-only reference-margin export, engine/marginEditor.ts's
// `exportReferenceMargin()`, is the first consumer). Deliberately
// independent of two other version concepts already in this codebase:
//   - `apps/client/package.json`'s `version` field — still the workspace's
//     unused "0.0.0" placeholder; CLAUDE.md's "Definition of done" never
//     asks for it to be bumped, and no other code reads it.
//   - `@dqcad/kernel-workers`'s `KERNEL_VERSION` — pins KERNEL ALGORITHM
//     behavior (the golden-file version-gate discipline, CLAUDE.md/
//     scripts/check-golden-version-gate.ts). A client-side UI/wiring change
//     (e.g. this file's own constant) has nothing to do with kernel numeric
//     output and must never be conflated with it.
//
// A plain hardcoded string (not a build-time `define`/env-var injection):
// this stays a SINGLE source of truth resolvable identically under every
// Vitest project this repo runs (`client`, the plain node-lane project with
// no custom Vite config, AND `client-dom`, the browser-mode project — see
// apps/client/vitest.config.ts's own doc for why those two intentionally
// have DIFFERENT Vite plugin setups) without needing to wire a matching
// `define` into both.
export const APP_VERSION = '0.1.0';
