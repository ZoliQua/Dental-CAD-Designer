# Phase 8 — Polish & Hardening (M8)

The MVP-close phase (PLAN.md §Phase 8): make the feature-complete app (import →
crown/inlay/onlay/bridge design → QC → export/handoff) robust, localized,
performant-without-accuracy-regression, recoverable, and secured for
single-user local use — then a structured technician beta. **No new clinical
features; no new geometry.** Everything here is polish and hardening on top of
Phases 0–7, under the same invariants.

**Phase acceptance (PLAN.md §Phase 8):**
1. **Full i18n**: EN/HU/DE/ES complete (no hardcoded user-facing strings; key
   parity enforced by test); keyboard shortcuts + command palette; onboarding tour.
2. **Performance pass WITHOUT accuracy regression**: worker-pool tuning, BVH
   caching, render LODs — **golden files remain BYTE-IDENTICAL** (the hard gate).
3. **Crash-safe autosave/recovery**; telemetry-free local error-report bundle
   (no network egress, no PHI).
4. **Security**: local single-user auth (default on); backend input validation
   (Fastify request+response schema) on EVERY route — enforced.
5. Beta with 2–3 dental technicians + structured feedback loop *(user-driven —
   tracked, not a code deliverable I can complete; the app must be beta-ready)*.

## Global constraints (bind every task)

Identical to Phases 4–7: **accuracy over speed** (the P8 headline — perf work
happens ONLY in rendering/LOD/worker-scheduling and ONLY via deterministic
caching; **any golden byte-change is a regression, not a win**); Float64 kernel;
determinism/journaling; QC gates unchanged; no hardcoded clinical defaults;
booleans via the manifold wrapper; layer rule ui→engine→kernel-workers→kernel;
KERNEL_VERSION **0.26.0** (NO bump expected — polish/hardening touches no kernel
geometry; a bump would signal an accidental accuracy change → investigate);
tests-first; NO commit trailers (author Zoltán Dul only); `scans/` is PHI, never
committed; NEVER touch the user's live dev server (:5198) or committed
server/port files (the P4-T13 incident); no TS constructor parameter properties
in worker-loaded closures (P5-T1); serialized kernel-built assets for
cross-layer fixtures (P5-T8); ADR-014 synthetic-data disclosure where fixture
data shows in the UI.

**The one rule that dominates this phase:** *a golden file changing is the
alarm.* Every perf/caching/LOD change must leave `npm run test:golden`
byte-identical; where a change is render-only, prove it can't reach exported
geometry. Determinism (invariant 2) is not negotiable for a cache.

**Commit-date convention (carry-in):** per the user's convention
([[commit-date-convention]]) P8 commits are redistributed to **2026-07-30 or
later, ≤12/day** at PUSH time (mirrors the P0–P7 redistribution) — subagents
commit with natural local dates; I handle the redistribution before any push.

## Carry-ins (standing tracked-pendings — fold where they fit, do NOT silently drop)

- Real-scan certifications (P3 retraction-cord crown, P4 tooth-11, P5 cavity,
  P6 bridge) — inputs only the user provides; beta-readiness (T-beta) surfaces them.
- The live multi-material picker (bridges/crowns default zirconia 1.4.0; the
  fresh-case export path is consistent via the shared resolver) — a natural
  fit for the i18n/UX + security-profile work (T1/T6); decide if in-scope.
- selfIntersection gate is a manifold-construction proxy (P4 follow-up) — the
  hardening phase is the right place to add the true geometric check IF tractable
  without a golden change (T2/T6 decide; do not weaken the gate).
- The stale `origin/phase-2-kernel-core` remote branch holds old-dated commit
  copies (a housekeeping loose end, not code) — note in wrap-up.

---

## Task 1 — i18n completeness: parity enforcement + hardcoded-string eradication

1. A **locale key-parity test** (all four EN/HU/DE/ES have exactly the same key
   set — 0 missing / 0 extra), run in CI. Fix every gap found (real translations,
   HU clinically consistent for a dentist).
2. A **hardcoded-string guard**: a lint rule or a scanning test that fails on
   user-facing string literals in `apps/client/src/ui` outside the i18n system
   (allowlist the genuine non-strings). Fix every hit (route through i18n).
3. Number/unit/date formatting localized per the display convention (µm/mm at
   1 µm resolution; locale-aware but deterministic where hashed content is involved).

**Verify:** parity + no-hardcoded tests green (falsifiable — each fails on a
seeded violation); chain green. Commit.

---

## Task 2 — Keyboard shortcuts + command palette + onboarding tour

1. **Keyboard shortcuts** for the core actions (view nav, tool switch, run QC,
   export, undo/redo where present) — a single registry (source of truth),
   discoverable, i18n'd labels, no conflict with browser/OS defaults; a shortcuts
   help overlay.
2. **Command palette** (pattern from the Odontogram module): fuzzy-searchable
   list of the SAME registered actions (no second source of truth), keyboard-driven,
   i18n'd, a11y (focus trap, ARIA).
3. **Onboarding tour** (first-run, dismissible, re-triggerable) — the import →
   design → QC → export path; i18n ×4; never blocks; state persisted (seen/not).

**Verify:** DOM/browser-lane tests (shortcut fires action; palette finds+runs;
tour renders+dismisses+persists); i18n parity; chain green. Commit.

---

## Task 3 — Performance pass *(the hard gate: goldens BYTE-IDENTICAL)*

1. **A perf harness** measuring representative ops (die-offset, boolean, QC,
   large-scan import, render frame budget) with reported before/after numbers —
   honest, machine-load-attributed (the P2/P6 lesson).
2. **Worker-pool tuning** (pool size, job scheduling, cancellation, cache
   consolidation — the P4 carry-in "duplicated per-worker caches to consolidate")
   — deterministic: results independent of scheduling (invariant 2).
3. **BVH caching** (reuse built BVH across ops on the same immutable mesh —
   hash-keyed; the cache is a pure memo, provably result-identical).
4. **Render LODs** (decimated Float32 render copies — engine-only, per CLAUDE.md;
   NEVER reachable from exported/kernel geometry — prove the isolation).
5. **THE GATE**: `npm run test:golden` BYTE-IDENTICAL before/after; determinism
   goldens + journal-replay bit-identical; the UI-thread never blocks >50 ms.

**Verify:** measured speedups + goldens byte-identical (the falsifiable gate:
a cache that changed a result must fail a test); chain green. Commit.

---

## Task 4 — Crash-safe autosave & recovery

1. **Autosave**: periodic + on-significant-change persistence of the case
   (journal + document + settings) to local storage — non-blocking, debounced,
   never mid-write-corrupt (atomic write); reuses the existing persistence layer.
2. **Recovery**: on launch, detect an unclean shutdown → offer to restore →
   the restored case is state-IDENTICAL (journal replay bit-identical, all hashes
   equal — the P7-T1/T6 reconstruction discipline). No silent data loss, no
   silent overwrite (user confirms).
3. Falsifiable: a simulated crash mid-edit → recovery restores the exact
   pre-crash journaled state; a clean exit → no spurious recovery prompt.

**Verify:** crash→recover round-trip identity proven; clean-exit no-prompt;
chain green. Commit.

---

## Task 5 — Telemetry-free local error-report bundle

1. On an unhandled error (client and/or server), produce a **downloadable local
   bundle**: app + kernel + manifold versions, the case id + journal HASH (not
   the scan bytes), the error + stack, recent in-memory log ring — **NO PHI**
   (no scan geometry, no patient identifiers), **NO network egress** (assert:
   nothing is sent anywhere; it is a local file the user chooses to share).
2. A privacy assertion test: the bundle contains none of the PHI-class fields;
   no fetch/XHR/beacon fires on error-bundle creation.
3. i18n ×4 for the surface; ADR for the telemetry-free / local-only decision.

**Verify:** bundle contents + the no-egress + no-PHI assertions (falsifiable);
chain green. Commit.

---

## Task 6 — Security: route-schema completeness + local single-user auth

1. **Route-schema audit + fill**: a test that ENUMERATES every Fastify route and
   asserts each has a request body/params/query schema AND a response schema
   (CLAUDE.md invariant) — fill every gap found; the enumeration test prevents
   regressions (a new unschema'd route fails CI).
2. **Local single-user auth** (default on): a minimal, local, single-user gate
   (no cloud, no third-party) protecting mutating routes; the default single-user
   flow stays frictionless; no credential stored in plaintext; portable to
   the multi-user future without rework (document the boundary). NO PHI/secret in
   logs. Decide honestly what "single-user default" means for a local desktop app
   and document it (ADR).
3. Backend input validation is genuinely enforced (schema-invalid → 4xx typed,
   never a 500 or silent accept — the P7 discipline).

**Verify:** route-enumeration schema test green (falsifiable — a seeded
unschema'd route fails); auth gate tests (protected route rejects unauthed,
accepts authed); chain green. Commit.

---

## Task 7 — Phase gate: e2e, beta-readiness, docs, wrap-up

1. **e2e** (`e2e/phase8.spec.ts`, isolated bootstrap — the P4-T13 lesson): the
   new UX through the real UI — a shortcut + the command palette runs an action;
   the onboarding tour shows+dismisses; an autosave→simulated-reload→recovery
   restores state; the auth gate; an error→local bundle. Deterministic waits.
2. **Beta-readiness checklist** (the PLAN item 5 the code enables): what a
   technician beta needs (install/run docs, the feedback loop mechanism, the
   known-issues + tracked-pending list incl. the real-scan certs) — honest,
   in `docs/demos/phase-8.md`.
3. **`docs/demos/phase-8.md`** — the acceptance ledger: the four code criteria
   with measured evidence + test names (i18n parity, goldens-byte-identical perf
   numbers, recovery round-trip, route-schema coverage + auth); the ADRs; the
   open items + carry-ins; KERNEL_VERSION 0.26.0 (no bump — prove no golden moved
   across the whole phase).
4. **ADR(s)** for the real decisions (perf-cache determinism; telemetry-free
   error bundle; local single-user auth model).

**Verify:** all suites + e2e green; goldens byte-identical across the phase;
docs complete. Commit.
