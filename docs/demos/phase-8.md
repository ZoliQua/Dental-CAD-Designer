# Phase 8 — Polish & Hardening (M8): demo script + acceptance evidence

Status: **the PLAN §Phase-8 acceptance is MET on all four CODE criteria** —
full i18n (parity-enforced) + shortcuts/palette/tour; a performance pass that
left every golden **byte-identical**; crash-safe autosave/recovery; and security
(route-schema completeness + local single-user auth), each measured by a real
test named below AND proven through the real product UI end to end
(`e2e/phase8.spec.ts`, 6/6, two consecutive clean runs). The fifth PLAN item —
the 2–3 technician beta — is **user-driven and tracked, not a code deliverable**;
this task certifies the app is beta-ready and writes the beta-readiness checklist.

This document is the complete, honest ledger a human uses to judge Phase 8 and
decide the merge. Every number below was measured by an actual test/report this
session or a prior Phase 8 task session (cited by file/task); nothing is asserted
without a source, and the Open Items section lists every known gap without
softening.

Branch `phase-8-polish`. `KERNEL_VERSION` at phase end: **0.26.0** — **no bump
this phase** (Phase 6 and Phase 7 also ended at 0.26.0). Polish/hardening composes
the EXISTING kernel geometry: no task touched `packages/kernel|io(core)|
cad-pipeline` geometry math, proven by the byte-identical goldens below — so no
version bump and no `docs/CHANGELOG-kernel.md` entry (the decision the plan asked
to be made and documented; see "KERNEL_VERSION across the phase").

## Scope caveat, stated plainly

Phase 8 is polish and hardening on the feature-complete, **fixture-proven** app —
exactly like Phases 5–7. It adds **no new clinical feature and no new geometry**.
The standing real-scan certifications (P3 retraction-cord crown margin accuracy,
P4 real tooth-11 crown, P5 real inlay/onlay cavity, P6 real multi-abutment bridge)
remain **TRACKED-PENDING** — inputs only the user provides — and are NOT closed
here (Open Items). The technician beta (PLAN item 5) is the user's to run; the
code enables it and the beta-readiness checklist below says exactly what a tester
needs.

## Headline: the four PLAN code acceptance criteria, all met

1. **Full i18n** (EN/HU/DE/ES): key parity is ENFORCED by test (0 missing / 0
   extra at every depth); a hardcoded-string guard fails on user-facing literals
   in `ui/`; keyboard shortcuts + command palette + onboarding tour ship. ✓ — T1/T2.
2. **Performance pass WITHOUT accuracy regression**: measured baselines for the
   representative ops, and — THE GATE — **goldens byte-identical across the whole
   phase** (`test-fixtures/` tree hash `db94d0c3baa3`, unchanged). ✓ — T3.
3. **Crash-safe autosave/recovery** (state-identical, journal-replay bit-identical)
   + a **telemetry-free, PHI-free, no-egress** local error bundle. ✓ — T4/T5.
4. **Security**: a route-enumeration test asserts EVERY Fastify route carries a
   request+response schema (or a documented exemption), and a local single-user
   auth gate (default on) protects every mutating method. ✓ — T6.

Plus the standing invariants held: Float64 kernel; determinism/journaling; QC
gates unchanged; no hardcoded clinical defaults; the layer rule; dual validation
stays dual (T6's auth gate WRAPS, never alters, the P7 export/validate-qc path,
which stayed byte-identical).

## The four criteria — measured evidence + test names

### 1. i18n completeness + shortcuts/palette/tour (T1, T2)

| what | measured | test |
|---|---|---|
| Locale key parity | **677 leaf keys × EN/HU/DE/ES, 0 missing / 0 extra** at every depth (T1 measured 615, grew to 677 as T2 `actions`/`commandPalette`/`shortcutsHelp`/`tour`, T4 `recovery`, T5 `errorReport` were added — parity held at every step) | `i18n/locales.test.ts` (falsifiable: deleting `hu.app` fails it) |
| Hardcoded-string guard | AST scan of every non-test `ui/**` source → **0 violations** (units/symbols allowlisted, unit-shape-validated + frozen) | `i18n/scanHardcodedStrings.test.ts` (falsifiable: a seeded `<span title="…">` fails it) |
| The 4 raw-`error.message` renders fixed | Cavity/Crown/Bridge failed-start + MeasureToolbar now render a TRANSLATED frame (`t('…startErrorOther',{message})`) — the scanner's admitted blind spot, behaviorally locked | `ui/DesignPanelErrorI18n.dom.test.tsx` (HU frame asserted; reverting one site fails it) |
| Single-registry actions | ONE frozen `APP_ACTIONS`; palette, shortcuts-help, and the global dispatcher all read it and nothing else; unique ids + unique chord signatures | `ui/actions/registry.test.ts` |
| Keyboard shortcuts | `1`–`6` views, `Cmd/Ctrl+S` save, `Cmd/Ctrl+K` palette, `?` help, `Delete`/`Backspace` margin-delete (contextual) — editable-target-guarded, no browser-default conflict | `ui/actions/shortcuts.test.ts`, `GlobalShortcuts.dom.test.tsx` |
| Command palette | Cmd/Ctrl+K opens; fuzzy filter of the one registry; ↑/↓/Enter/Esc; focus-trap + ARIA; disabled action never runs (click or Enter) | `CommandPalette.dom.test.tsx` |
| Onboarding tour | first-run auto-open, Skip/Done/Escape/backdrop dismiss + persist seen (`dqcad.tour.seen`, no PHI), re-triggerable; single-modal exclusion so an Escape can't silently kill an unfinished tour | `OnboardingTour.dom.test.tsx`, `OverlayExclusion.dom.test.tsx` |

The three overlays are mutually exclusive (exactly one focus trap live at a time —
the T2 F1 a11y fix).

### 2. Performance pass — the byte-identical-golden gate (T3)

The perf infrastructure was already at the right shape on measurement: the P4
carry-in cache consolidation was done in **P4-T1** (`meshCache.ts`, 6→1 shared
pair), and the size:1 "measurement pool" was retired in **P2-T12** for affinity
routing. The honest, non-churn outcome: build the missing consolidated perf
harness, certify each lever by measurement, and prove the gate held. **No kernel
geometry math was touched; no production code changed in T3.**

Baseline (`test/golden/perf-harness.perf.test.ts`, env-gated `RUN_PERF=1`; 2 runs,
Apple-class dev machine, 12 logical cores, normal load — machine-load-attributed,
a *picture* not a benchmark; the tripwires are order-of-magnitude bounds):

| Op | Input | Result | Wall-clock (run 1 / 2) | Tripwire |
|----|-------|--------|------|----------|
| die-offset (`offsetMesh`, banded-ROI SDF→MC→cleanup) | 5,120-tri icosphere r=5 mm, pitch 0.05 mm, d=−0.03 mm | 371,888 out-tris, watertight+manifold | **6,694 / 7,163 ms** | 120,000 ms |
| boolean (manifold `union`) | two overlapping 2 mm cubes | 28 tris, vol 12.0000 mm³ (analytic ✓) | **4 / 4 ms** | 30,000 ms |
| QC topology (`analyzeMesh`) | 20,480-tri icosphere | watertight, manifold, 1 comp | **6.5 / 5.0 ms** | 30,000 ms |
| BVH build + 1000 closest-point queries | 20,480-tri icosphere | distances exact | **build 12.2/11.9 ms; 1000 q 13.3/12.6 ms (0.013 ms/q)** | — |
| large-scan import (`writeStlBinary`→`parseStl`) | 81,920-tri / 3.9 MB binary STL | round-trips exact tri count | **7 / 7 ms** | 60,000 ms |
| render-LOD (`decimateMesh`, engine render copy) | 81,920→16,384 tris | maxErr 0.6507 mm, genuinely decimated | **2,834 / 2,791 ms** | 60,000 ms |

**THE PHASE INVARIANT (held): goldens byte-identical across the ENTIRE phase.**
`git status --porcelain test-fixtures/` is **EMPTY**; the `test-fixtures/` tree
hash is **`db94d0c3baa3`** (`db94d0c3baa337217d9d043ddd6e5b8841267ef7`), identical
before and after every Phase 8 task and after this task's `npm run test:golden`
(257 passed / 15 skipped). Determinism goldens + journal-replay stayed
bit-identical. `KERNEL_VERSION` stayed **0.26.0** — a bump would itself be the
alarm for an accidental accuracy change. Cache-determinism is proven falsifiably
(offset cache-hit SHA-256-identical to the cache-free kernel call; BVH cache
analytic-distance guard; consolidated halfedge/curvature array-equality). LOD
isolation is proven (masters keep the same array refs + bytes after an LOD build;
export/QC slice the masters, never a render copy). ADR-021 records the discipline.

> Note (T3 report correction): the T3 report cited a STALE tree hash
> (`8cfd936…`); the correct, current, byte-identical-across-the-phase hash is
> **`db94d0c3baa3`** (verified this task, `git rev-parse HEAD:test-fixtures`).

### 3. Crash-safe recovery (T4) + telemetry-free error bundle (T5)

| what | measured | test |
|---|---|---|
| Autosave (crash-safe LOCAL layer, on top of the 30 s server autosave) | debounced 2 s; content-addressed IndexedDB payload + a synchronous localStorage commit marker (write-then-swap atomicity); non-blocking | `crashRecovery.test.ts`, `crashRecovery.dom.test.tsx` |
| Recovery state-identity | restored `CaseDocument` deep-equals pre-crash AND `hashCaseJournal(restored)===hashCaseJournal(preCrash)` (journal replay bit-identical) | `recovery.test.ts` "crash → detect → RESTORE" (real server round-trip) |
| No false positive / no silent loss | clean exit → NO prompt; corrupt payload → `corrupt` (never restored); a FOREIGN tab's clean close cannot mask this tab's crash (SF1 sessionId guard); a never-uploaded mesh is NAMED (`incomplete` surface), never silently dropped (SF2) | `crashRecovery.test.ts` FALSIFIABLE #1–#4, SF1; `recovery.test.ts` SF2 |
| No silent overwrite | Restore installs locally + marks `unsaved`; the server is untouched until the user's visible save re-syncs; Discard/corrupt need explicit acknowledgment | `recovery.test.ts` |
| Error bundle — NO egress | zero `fetch`/`XHR`/`WebSocket`/`sendBeacon` across build+serialize+download; the download is a local `blob:` → `<a download>` | `diagnosticBundle.no-egress.test.ts` (falsifiable: a seeded `fetch` IS caught) |
| Error bundle — NO PHI | allowlist-not-denylist: only `case.id`, journal HASH, counts, versions, error, the scalar log ring — never patientRef/scan/name/settings | `diagnosticBundle.no-phi.test.ts` (falsifiable: the same marker in an allowlisted field IS found) |

### 4. Security — route-schema completeness + local single-user auth (T6)

| what | measured | test |
|---|---|---|
| Route-schema enumeration guard | every registered Fastify route (incl. auto HEAD siblings + CORS OPTIONS) asserted to carry params/body/response schemas or a documented exemption; the two real gaps found were resolved (`archive` no-body allowlist, CORS `OPTIONS *` excluded) | `route-schema-audit.test.ts` (falsifiable: a seeded schema-less `POST /api/bogus` + a real `onRoute` probe both fail) |
| Input validation genuinely enforced | schema-invalid body/params/query/content-type → a typed **4xx, never a 500 or silent accept**; `additionalProperties:false` genuinely rejects (the `removeAdditional:false` override) | `route-input-validation.test.ts` |
| Local single-user auth (default on) | a random capability token gates EVERY mutating method (POST/PUT/PATCH/DELETE) via one `onRequest` hook (composes by default); constant-time compare; 401 never echoes the token/body; GET/HEAD/OPTIONS open | `auth-gate.test.ts` (every mutating route → 401 unauthed, not-401 authed; falsifiable) |
| Frictionless provisioning + honest threat model | explicit token → env → test-disabled → auto-provisioned 0600 file; loud startup signal on disable; the CSRF-only-against-local-callers boundary stated honestly | ADR-020; `auth.ts` unit tests |

## A real gap this task surfaced — then FIXED at the root (the auth-bootstrap 404)

Driving the REAL UI against an **auth-ENABLED** isolated server (not the
test-env-disabled unit lane) revealed a genuine defect the unit tests structurally
could not see — the same class of real-UI catch as Phase 7's `profileVersion`
409. `apps/client/src/engine/apiAuth.ts` defined `BOOTSTRAP_PATH =
'/api/auth/bootstrap'` and `initAuth(apiBase = '/api')` fetched
`` `${apiBase}${BOOTSTRAP_PATH}` `` → **`/api/api/auth/bootstrap`** (a doubled
`/api`), a 404. So the client obtained **no token**, and against the default-on
gate EVERY mutating request (create case, save, upload) got **401** — the
default-on auth feature was broken for every real-UI run. The unit suite masked it
because (a) `NODE_ENV=test` disables the gate, so mutations don't need a token, and
(b) `apiAuth.test.ts` stubbed `fetch` globally and never asserted the URL.

**Fixed at the root:** `BOOTSTRAP_PATH` is now `'/auth/bootstrap'` (relative to
`apiBase`, mirroring `persistence.ts`'s `API_BASE + '/cases'` convention), so
`initAuth()` fetches the correct `/api/auth/bootstrap`. A new falsifiable
regression asserts the exact URL:
`apiAuth.test.ts` › "bootstraps the CORRECT same-origin URL (no doubled /api
prefix)" (`expect(fetchSpy).toHaveBeenCalledWith('/api/auth/bootstrap')`) —
**proven falsifiable**: reverting `BOOTSTRAP_PATH` makes exactly that test fail
with `/api/api/auth/bootstrap`. The auth-enabled e2e now completes the full authed
flow (create → import → save → restoration) end to end.

## THIS TASK — the polish/hardening UX through the real UI (`e2e/phase8.spec.ts`)

The tables above prove each unit/DOM/server layer. This task adds the missing
layer: driving the real product UI in a real Chromium browser against an ISOLATED
stack (below), with the **auth gate ENABLED** and honestly exercised. One
`describe.serial` block shares one page + context so `localStorage` (the tour
flag, the recovery marker) and the loaded case persist across steps and the single
simulated reload, exactly as a real session would.

### Coverage (6 tests, all green, two consecutive clean runs, ~8 s each)

| step | result |
|---|---|
| **Onboarding tour** — first-run auto-open; Skip dismisses + persists `dqcad.tour.seen='true'`; a REAL reload proves it does NOT re-show | PASS |
| **Keyboard shortcut** — the bare `?` chord fires `help.shortcuts` through the single global dispatcher (`useGlobalShortcuts` → the registry), opening the shortcuts-help overlay; closed via its real close button | PASS |
| **Command palette** — Cmd/Ctrl+K opens; typing "shortcut" FILTERS the one registry (help.shortcuts stays, case.save disappears); Escape closes; re-open → click the option RUNS the action (shortcuts-help opens) and CLOSES the palette | PASS |
| **Auth gate (ENABLED, honest)** — a mutating `POST /api/cases` WITHOUT a token → **401 `auth-required`**; the same-origin bootstrap returns a non-empty token (gate genuinely on); the SAME POST WITH the bearer token → **201**. The whole real-UI flow below also mutates successfully, which only works because `main.tsx`'s `initAuth()` bootstrapped the token (the second, implicit proof — and the reason the bootstrap bug above HAD to be fixed) | PASS |
| **Autosave → simulated crash → recovery** — import a die, SAVE (mesh uploaded, `fileHash` stamped, snapshot cleared), create a restoration (an un-synced journaled edit the server never received), let the 2 s crash-safe snapshot commit (`cleanShutdown=false` marker + IndexedDB payload), SIMULATE A CRASH by rewriting the marker's owning `sessionId` (so this page's `pagehide` can't mark it clean — the exact unclean-shutdown condition), reload → the RECOVERY prompt is offered (no silent auto-restore/discard) with the case name → Restore → a CLEAN restore (die mesh reconstructed from the server by `fileHash`; NOT the SF2 incomplete surface): the active case name AND the un-synced restoration chip both come back — state-identical recovery of work the server never saw | PASS |
| **Telemetry-free error bundle** — a synthetic `window` error raises the non-blocking error surface; "Download diagnostic bundle" produces a LOCAL file from a **`blob:` object URL** (no http egress) whose JSON carries `app.kernelVersion 0.26.0` + the error but NOT the loaded case's name (no PHI) — the live backing for the `no-egress`/`no-phi` unit assertions | PASS |

**What this e2e covers and does NOT cover (say exactly):** it covers all six P8
UX surfaces live (tour persistence, a keyboard chord firing through the registry,
the palette open/filter/run/close, the ENABLED auth gate's 401-without / 201-with
honesty, the autosave→crash→recovery round-trip with a clean state-identical
restore, and the local blob-download error bundle with no egress / no PHI). It
does NOT design a crown to a finalMesh (that coupled path is proven live by
`e2e/phase{4,7}.spec.ts`) — the recovery step needs only a valid importable die,
not a buildable crown. The recovery `incomplete`/`corrupt` surfaces and the tour
focus-trap internals are covered at the DOM lane
(`recovery.test.ts` SF2, `RecoveryPrompt.dom.test.tsx`, `OnboardingTour.dom.test.tsx`).

### Isolated e2e infrastructure (the P4-T13 precedent — NON-NEGOTIABLE)

**NEVER edited** the committed `apps/server/src/index.ts`,
`apps/client/vite.config.ts`, or `playwright.config.ts` — all watched by / used by
a developer's own live dev process (the P4-T13 incident: an edit to `index.ts`
once restarted a live `tsx watch` onto a temp port against the REAL dev database).
Instead, all UNTRACKED and removed after the session (final `git status` shows
only the committed files):

- A standalone server-bootstrap script (in scratch, outside the repo) imported
  `buildApp` (`apps/server/src/app.ts` — `meshDataDir`/`toothLibraryDataDir`/
  `exportsDataDir`/`finalMeshDataDir`/`authToken`/`authTokenPath` are `BuildAppOptions`
  for exactly this reason) and listened on **`:4398`**, against an ISOLATED temp
  SQLite DB (`prisma migrate deploy` against a throwaway `mkdtemp` file) and
  isolated temp mesh/tooth-library/exports/final-mesh/auth-token dirs, with the
  **auth gate ENABLED** (an explicit `authToken`).
- A SEPARATE untracked Vite config served the client on **`:5398`**, proxying
  `/api` to the isolated `:4398` (so the client bootstraps the token same-origin).
- A SEPARATE untracked Playwright config (`baseURL :5398`, NO `webServer`) ran the
  spec against the manually-started isolated stack.
- The developer's live `:5198` and the committed `:5173`/`:4100` were never
  touched (verified: nothing listened on any of them at session start; the
  orchestration refuses to start if `:4398`/`:5398` are occupied, and hard-kills
  only those two ports on teardown). `scans/` (PHI) was never staged; the e2e uses
  a synthetic in-process die only; no secret/token is committed (the bootstrap
  token is a scratch-only literal, and the auto-provisioned token file lives under
  the git-ignored `apps/server/data/`).

## KERNEL_VERSION across the phase (0.26.0 → 0.26.0, no bump)

Phase 7 ended at `0.26.0`. Phase 8 is polish/hardening: **no task touched
`packages/kernel|io(core)|cad-pipeline` geometry** — every T1–T7 report verified
byte-identical geometry/QC goldens, and this task re-verified the `test-fixtures/`
tree hash `db94d0c3baa3` unchanged with `git status test-fixtures/` empty. The T3
perf harness is env-gated synthetic-geometry test code (reads/writes no fixture);
the T4/T5/T6 work is client/engine/server code that no golden flows through. So no
version bump and no changelog entry — the deliberate, documented decision (this is
the phase invariant that held).

## Beta-readiness checklist (PLAN item 5 — the code enables it; the beta is the user's to run)

A 2–3 dental-technician beta with a structured feedback loop needs the following;
each is READY unless marked. The beta itself (recruiting testers, collecting the
feedback) is the user-driven, tracked item — not a code deliverable this task can
complete.

- **Install / run.** `npm install` → `npm run dev` (client `:5173`, server
  `:4100`, workers). First launch auto-provisions the local auth token (0600,
  git-ignored) and the SQLite DB migrates automatically (`predev`/`db:migrate`).
  The onboarding tour walks import → design → QC → export on first run. READY.
  *(Gap for a non-developer tester: there is no packaged desktop installer — a beta
  technician runs it from a dev checkout. Tracked as a beta-logistics item, not a
  code criterion.)*
- **Auth default-on works for a real run.** The default-on gate now genuinely
  authenticates the real UI (the bootstrap 404 above is fixed) — a single-user
  local run "just works" with no setup. READY (this task).
- **Structured feedback mechanism — the telemetry-free channel.** A tester who
  hits a problem uses the **local error-report bundle** (T5): the non-blocking
  "Something went wrong → Download diagnostic bundle" surface produces a
  PHI-free, no-egress local file (versions + error + journal hash + counts + the
  scalar event ring) the tester chooses to send. This is the intended feedback
  channel — no server telemetry, no PHI leaves the machine. READY. Document to
  testers: "attach the diagnostic bundle; it contains no patient data and is sent
  only if you choose to."
- **Crash safety for a real workflow.** Autosave + crash recovery protect
  un-synced work across an unexpected close (state-identical restore). READY.
- **Localization.** Full EN/HU/DE/ES at parity — a HU-speaking technician gets a
  clinically-consistent Hungarian UI. READY.
- **Known issues + tracked-pending (tell the testers up front):**
  - The app is **fixture-proven, not yet real-scan-certified** for margin
    accuracy / real crown / real inlay-onlay / real bridge (the standing P3/P4/P5/P6
    pendings) — a beta on real scans is exactly how those inputs arrive, but the
    testers should know the clinical certifications are open.
    (Dr. Dul's field feedback on the margin editor — 20–200 anchor slider, bulk
    delete, section-in-magnifier, gingiva-obscured margins — is the kind of signal
    the beta should capture.)
  - No **live multi-material picker** yet: every case defaults to standard-zirconia
    1.4.0 (the shared resolver; a fresh case exports consistently). e.max/other
    profiles exist in the registry but are not UI-selectable. Tracked carry-in.
  - `selfIntersection` QC gate is a manifold-construction PROXY (a FAIL is always
    genuine; a PASS means "manifold-3d accepts the solid", not "provably
    self-intersection-free"). Carried from P4/5/6, out of this phase's scope.
  - Auth **future hardening** (ADR-020 N2): the gate is CSRF-only against
    deliberate local callers on loopback; a same-OS-user bootstrap check / launch
    nonce is recorded future hardening, not needed for the single-user beta.
  - The T5 error-bundle `error.message` is the one allowlisted field that could
    echo input text — it is developer-technical, never a place to interpolate raw
    case content (reviewer NOTE, documented).

## Open items & carry-ins (honest, complete — nothing softened)

1. **Fixture-proven, no real patient scan — TRACKED-PENDING.** As Phases 5–7. Not
   a code fix; needs the standing real cases (item 2). The beta surfaces them.
2. **Standing real-scan certifications carry forward, NOT closed here:** P3
   retraction-cord crown margin accuracy; P4 real tooth-11 crown; P5 real
   inlay/onlay scan (+ the onlay seating fillet-removal item, ADR-010); P6 real
   multi-abutment bridge. None block Phase 8's code acceptance.
3. **Live multi-material picker — tracked carry-in** (from P7 open item 3). The QC
   stamp + export path share one resolver (`engine/materialProfile.ts`), so a fresh
   case defaults to standard-zirconia 1.4.0 consistently; a UI to pick e.max/others
   (setting `settings.materialProfileId`) is not yet built. A natural fit for the
   i18n/UX + security-profile work but deliberately left out of the hardening phase.
4. **The auth-bootstrap 404 — FIXED this task** (the doubled `/api`), with a
   falsifiable regression; the default-on gate now authenticates the real UI.
5. **Auth future hardening (ADR-020 N2/F1):** the effective trust boundary is "any
   process reachable on loopback" (the open bootstrap serves the token to any local
   caller); the gate is CSRF-only against deliberate local callers. A
   same-OS-user bootstrap check / launch nonce / file handoff are recorded future
   hardening — not needed for the single-user local model.
6. **T5 `error.message` echo NOTE:** the one allowlisted bundle field that could
   in principle carry input text; developer-technical, reviewed as such, never a
   place to interpolate raw case content.
7. **`selfIntersection` remains a manifold-construction PROXY** (carried from
   P4/5/6; out of scope per the phase plan — the true geometric check was assessed
   and left, as it could not be added without risking a golden change).
8. **T4 documented boundaries** (all fail-safe, none a defect): a ~2 s
   worst-case data-loss window (the debounce); Restore→autosave re-sync is
   last-writer-wins (pre-existing to the persistence layer, single-user/local);
   cross-store durability lag fails safe (never a corrupt restore); single-slot
   local snapshot (single active case).
9. **`qcContext` serialized on the UI thread (P7-T7 follow-up):** for a large
   marching-cubes surface the export-request serialization can exceed the 50 ms
   budget; a worker-side serialization is the honest follow-up, flagged not done.
10. **The stale `origin/phase-2-kernel-core` remote branch** holds old-dated commit
    copies — a housekeeping loose end (not code), noted for the eventual cleanup.
11. **Beta is user-driven** (PLAN item 5): recruiting 2–3 technicians + running the
    structured feedback loop is tracked, not a code deliverable — the app is
    beta-ready (checklist above).

## ADRs (this phase)

- **`docs/adr/019-telemetry-free-error-bundle.md`** (T5) — the telemetry-free,
  local-only, PHI-free-by-allowlist error bundle + the medical-data rationale.
- **`docs/adr/020-local-single-user-auth.md`** (T6) — the capability-token gate on
  every mutating method, the frictionless provisioning precedence, and the HONEST
  threat model (CSRF-only against deliberate local callers; the loopback boundary;
  the multi-user portability seam).
- **`docs/adr/021-perf-cache-determinism-and-the-byte-identical-golden-gate.md`**
  (T3, recorded here) — every performance cache is a provably-pure memo verified by
  a byte-identity test, and the byte-identical golden is the enforcement gate; the
  legitimacy of an "already optimal — here are the measurements" outcome.

## Full local acceptance chain (this task, this session — explicit exit codes)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit **0** (all workspaces) |
| `npm run lint` | exit **0** (0 errors; the 2 pre-existing warnings in the untouched `test/golden/onlay-acceptance.test.ts`) |
| `npm test` | exit **0** — **3312 passed / 20 skipped** (334 files / 5 skipped) |
| `npm run test:golden` | exit **0** — **257 passed / 15 skipped**; `git status test-fixtures/` empty; tree hash `db94d0c3baa3`; KERNEL_VERSION 0.26.0 |
| `e2e/phase8.spec.ts` (isolated bootstrap, auth ENABLED; ×2 consecutive) | exit **0** both — **6/6 passed, ~8 s** each |

Goldens unchanged across the whole phase — no kernel/pipeline op touched, no
`KERNEL_VERSION` bump, no `test-fixtures/` diff. The only production-code change
this task is the one-line auth-bootstrap-path fix (+ its regression test) — client
wiring, which no golden flows through.

## Demo script — the polish/hardening workflow

`npm run dev` (client `:5173`, server `:4100`), open the client URL, then:

1. **First run** — the onboarding tour walks import → design → QC → export. Skip
   or step through; it never re-shows (persisted). Re-open it any time from the
   command palette → "Show onboarding tour".
2. **Keyboard + palette** — press `?` for the shortcuts help; `Cmd/Ctrl+K` for the
   command palette (fuzzy-search the same actions; ↑/↓/Enter/Esc). `1`–`6` are the
   standard views; `Cmd/Ctrl+S` saves.
3. **Design + auth** — create a case, import a scan, design a restoration. Every
   save/upload silently carries the local auth token (bootstrapped once at startup;
   the default-on gate is invisible to a single-user run).
4. **Crash safety** — edits autosave locally within ~2 s. If the app/tab dies with
   un-synced work, the next launch offers to RESTORE it (state-identical) or
   discard it — never silently either way.
5. **Something went wrong** — on an unexpected error a non-blocking banner offers
   "Download diagnostic bundle": a local file (versions + error + journal hash +
   counts, NO patient data, nothing uploaded) you choose whether to share.

See `.superpowers/sdd/p8-task-7-report.md` for this task's full handoff (the e2e
coverage detail, the auth-bootstrap finding, the isolated-infra teardown), and the
`.superpowers/sdd/p8-task-{1..6}-report.md` reports for each criterion's
implementation detail.
