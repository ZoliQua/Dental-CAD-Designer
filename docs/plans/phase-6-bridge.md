# Phase 6 — Bridge (M6 "Multi-unit")

Multi-unit restorations (PLAN.md §Phase 6): abutments (the crown pipeline per
abutment under a SHARED insertion axis) + pontics (library teeth with a
gingival interface — hygienic / ovate / modified-ridge-lap — against a gingiva
mesh at configurable relief/pressure) + connectors (auto-placed, editable 2D
cross-section profiles, live area readout, material-minimum area gate) +
framework vs full-contour mode + whole-bridge QC.

**Phase acceptance (PLAN.md):**
1. A **3-unit posterior bridge on fixtures passes ALL gates** (single watertight
   solid; per-unit thickness; per-connector area; per-abutment margin fit).
2. The **connector area gate BLOCKS a 5 mm² posterior connector** (falsifiable).
3. The **pontic–gingiva relation matches the configured relief within ±20 µm**
   (measured, per interface style).
Plus standing invariants: per-abutment margin fit ≤ 10 µm; full journal
reproducibility (record → replay bit-identical); QC gates never weakened.

## Global constraints (bind every task)

Identical to Phases 4/5 (docs/plans/phase-4-crown-design.md, phase-5-inlay-onlay.md):
accuracy over speed; Float64 kernel; determinism/journaling; gates block export
(acknowledge-with-warning journaled, never bypassed — and the P5 ADR-010
bounded+localized acknowledgment pattern where an acknowledgment is load-bearing);
no hardcoded clinical defaults (new bridge params live in `clinical-profiles/`
with source notes + checksum/version discipline); booleans via the manifold
wrapper; layer rule; KERNEL_VERSION discipline (current: **0.21.0**);
tests-first with analytic closed-form fixtures; NO commit trailers (author
Zoltán Dul only); `scans/` is PHI, never committed; NEVER touch the user's live
dev server or committed server/port files (the P4-T13 incident); no TS
constructor parameter properties in worker-loaded closures (the P5-T1 landmine);
serialized kernel-built assets — never ported constructions — for cross-layer
test fixtures (the P5-T8 lesson).

**Fixture reality:** synthetic-fixture-driven (like P5): a closed-form 3-unit
posterior bridge fixture. Real bridge scans join the real-case tracked-pendings.

## Phase 5 carry-ins (fold into the matching tasks)

- `marginExclusionMm` bands → profile promotion (T1): the cavity bands
  (inlay 1.3 / onlay 1.8, T6/T7-derived) move from engine constants into
  `clinical-profiles` fields alongside the existing crown feather (0.2);
  wire the client/server callers through them.
- The tooth library may need a posterior asset beyond molar-16 for the pontic
  (premolar) — T1/T3 decide (placeholder-provenance discipline).
- Still out of scope (tracked): selfIntersection true-geometric gate; live-UI
  material picker (bridges default zirconia — the classic bridge material,
  matching the profile the live UI already uses); real scans.

---

## Task 1 — Profile params, the 3-unit bridge fixture, scaffold

1. `clinical-profiles`: bridge/pontic/framework fields — `frameworkMinThicknessMm`
   (zirconia 0.5 per PLAN table; e.max documented), pontic interface params
   (`ponticHygienicClearanceMm`, `ponticRidgeLapReliefMm`, `ponticOvateDepthMm` —
   defaults with honest source notes; the ±20 µm acceptance binds geometry to
   the CONFIGURED value, so documented-placeholder defaults are acceptable),
   plus the P5 carry-in: `inlayMarginExclusionMm` (1.3) + `onlayMarginExclusionMm`
   (1.8) promoted into the schema (derivation notes from P5 T6/T7) with the
   existing crown `marginExclusionMm` retained; version bumps + checksums;
   `PipelineMaterialProfile` mirror + constructors + parity test updated; the
   client/server callers (P5 T8/T9) switch from engine constants to the profile
   fields (bit-identical values — prove no behavior change).
2. **The 3-unit posterior bridge fixture** (kernel test-fixtures, closed-form —
   the P6 `shoulderPrepMesh`/`modCavityMesh` equivalent): two shoulder-prep
   abutment dies (REUSE `shoulderPrepMesh`) at parameterized closed-form
   positions flanking a **pontic-site gingiva RIDGE segment** with a closed-form
   surface profile (so pontic–gingiva relief is measurable analytically);
   parallel die axes by construction (shared insertion axis exists) with a
   **tilt knob** (non-parallel dies → no valid shared axis; the falsifiable
   axis case); optional antagonist plane. Watertight components, deterministic,
   parameterized (span, die dims, ridge profile, tilt).
3. Scaffold: `BridgePipelineContext` (multi-abutment margins — `marginLoops`
   already keys by FdiTooth; pontic sites + the gingiva mesh handle + unit
   adjacency), type-level guard rails (bridge vs crown/cavity stages), YAGNI —
   no bridge stages yet.

**Verify:** full chain green; fixture closed-form assertions; profile parity +
caller equivalence proven. Commit.

---

## Task 2 — Shared insertion axis + per-abutment inner surfaces *(per-abutment margin fit ≤ 10 µm)*

1. **Shared-axis suitability**: undercut scan across BOTH abutment prep regions
   relative to ONE candidate axis (reuse P3 axis + undercut machinery;
   `suggestInsertionAxis` extended/wrapped for the union region). Falsifiable:
   parallel dies → a shared axis with zero undercut exists (found + verified);
   tilted-die variant → undercut detected on any single axis (reported).
2. Per-abutment margin machinery (both dies' margin loops through the P3/P4
   currency) + **per-abutment inner surfaces**: the P4 `innerSurfaceSolid`
   per abutment with the SHARED axis; **margin fit ≤ 10 µm PER ABUTMENT**
   (measured + reported — the acceptance element).
3. Stage + worker + journal (multi-abutment: one op per abutment or one
   journaled multi-unit op — decide + document; replay-identical).

**Verify:** per-abutment fit + axis falsifiability measured/reported; chain
green. Commit.

---

## Task 3 — Pontic + gingival interface *(acceptance-critical: relief within ±20 µm)*

1. Pontic placement at the pontic site (P4 anatomy-placement machinery;
   neighbors = the two abutment units; library posterior asset — add a premolar
   generator if needed, placeholder provenance).
2. **The gingival interface** (kernel op): shape the pontic base against the
   gingiva mesh per style — **hygienic** (uniform clearance ≥ configured mm),
   **modified ridge-lap** (buccal contact at configured pressure/relief,
   lingual relief), **ovate** (controlled penetration depth into the ridge) —
   deterministic construction + a **measured relief field** (pontic base ↔
   gingiva signed distance, dense sampling).
3. **The ±20 µm acceptance measurable**: per style, the measured relief matches
   the CONFIGURED value within ±20 µm on the closed-form ridge (REPORT measured
   min/max/mean deviation per style; falsifiable — a mis-configured/unshaped
   base fails).
4. Stage + worker + journal (style + relief params journaled).

**Verify:** relief deviations per style measured/reported < ±20 µm; chain
green. Commit.

---

## Task 4 — Connectors *(acceptance-critical: the 5 mm² posterior connector BLOCKS)*

1. **Auto-placement**: a connector solid between each adjacent unit pair
   (abutment↔pontic ×2 for the 3-unit) — a deterministic loft between two
   closed 2D cross-section profiles on the facing proximal surfaces (default
   profiles auto-derived from the proximal geometry; documented construction).
2. **Editable cross-section curves**: the API takes the 2 closed 2D profiles
   (closed polylines in the connector's cross-section plane) — deterministic,
   journaled as design params.
3. **The area measurement**: minimum cross-section area along the connector
   axis (the gate value; documented method + error bound; live-readout-ready —
   fast enough for interactive use, measure).
4. **`connectorCrossSectionGate` filled in** (the P4 T9 stub): per-connector
   min area ≥ the profile minimum by position (posterior 9 / anterior 7 mm²);
   **a 5 mm² posterior connector → BLOCKS** (the acceptance; falsifiable pair
   with a healthy connector passing).

**Verify:** area measurement validated on closed-form profiles (analytic
areas); the 5 mm² block + healthy pass; chain green. Commit.

---

## Task 5 — Framework mode vs full-contour

1. **Framework cutback**: reduced anatomy for veneering — the unit outer
   surfaces offset inward by a veneering-space param (profile field, source
   note; reuse the offset machinery), margins/fit surfaces EXACT (the cutback
   touches outer anatomy only — the P4/P5 fit-surface-preservation discipline).
2. Mode is a journaled design decision; the thickness gate switches to
   `frameworkMinThicknessMm` in framework mode (falsifiable: a cutback below
   the framework minimum blocks).
3. Full-contour remains the default path (unchanged behavior proven).

**Verify:** cutback measured (offset within bound; fit surfaces byte-exact);
mode-switched gate falsifiable; chain green. Commit.

---

## Task 6 — Bridge assembly + whole-bridge QC *(acceptance-critical: the 3-unit passes ALL gates)*

1. **Assembly**: units + connectors → a SINGLE watertight solid (manifold
   wrapper union; repair-before-boolean; re-validate watertight + manifold +
   single-component; typed errors on failure — the P4/P5 discipline; document
   why union vs weld here — the connectors are genuinely separate solids).
2. **`runBridgeQc`**: watertight/manifold/selfIntersection(proxy)/**per-unit
   thickness** (mode-aware)/**per-connector area**/**per-abutment margin fit**
   (re-measured on the assembled solid)/pontic-relief gate (±20 µm)/seating
   (the whole bridge onto both dies along the shared axis)/contact where
   applicable. Acknowledge semantics reused.
3. **ACCEPTANCE**: the 3-unit posterior fixture bridge passes ALL gates
   (REPORT the full measured table); the 5 mm² connector variant blocks; the
   relief acceptance rides along. Any survive-assembly deltas explained.

**Verify:** the full gate table + falsifiable blocks measured/reported; chain
green. Commit.

---

## Task 7 — UI: bridge staged workflow

Extend the restoration-type-aware workflow (P5 T8's shared core) for bridges:
multi-abutment margin/axis status, pontic style + relief config, connector
editor (profile curves + LIVE area readout + per-connector gate status),
framework/full-contour toggle, whole-bridge QC table. Invalidation cascade,
honest failure, journaled acknowledge, i18n ×4, node-lane + browser-lane
(serialized kernel fixture asset per the P5-T8 lesson), layer rule.

**Verify:** browser-lane critical path; i18n parity; chain green. Commit.

---

## Task 8 — Server: dual-validation + persistence for bridges

Extend `validate-qc` (discriminated union gains the bridge branch) →
`runBridgeQc` server-side, bit-identical proof (all-pass 3-unit + a failing
connector case + any acknowledged-gate round-trip); bridge `stages` + `qc`
persistence lossless; server-side journal replay of a bridge stage; schemas.

**Verify:** bit-identical proofs; persistence + replay; chain green. Commit.

---

## Task 9 — End-to-end acceptance + journal reproducibility *(the phase gate)*

The complete-bridge harness (mirroring P4/P5 journal-libs): the full coupled
chain (axis → per-abutment inner surfaces → pontic + interface → connectors →
[framework] → assembly → QC) recorded as ONE journal → replayed fresh → every
stage hash bit-identical; the PLAN acceptance table measured in the assembled
chain (all gates; 5 mm² blocks; relief ±20 µm; per-abutment fit ≤ 10 µµm);
runtime; BLOCKED-with-numbers if anything is unreachable.

**Verify:** acceptance + reproducibility proven with measured numbers. Commit.

---

## Task 10 — e2e, docs, phase wrap-up

`e2e/phase6.spec.ts` (the bridge workflow through the real UI on the fixture;
isolated bootstrap, the P4-T13 lesson); `docs/demos/phase-6.md` (honest
acceptance ledger: measured table + test names, open items, KERNEL delta);
ADR(s) for real decisions (connector loft/area method; pontic interface
construction; shared-axis approach). Full chain + e2e green.

**Verify:** all green; docs complete. Commit.
