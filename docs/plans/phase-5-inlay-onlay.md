# Phase 5 — Inlay / Onlay (M5 "Cavity restorations")

The cavity-driven variant of the Phase 4 crown pipeline (PLAN.md §Phase 5). A margin
line traces the **cavity outline**; the inner surface is a **cavity offset** with
insertion-axis blockout; the outer surface is an **occlusal anatomy patch blended
G1-continuously into the surrounding intact tooth surface**. Onlay = inlay + selected
cusp-coverage regions with onlay thickness minimums.

**Phase acceptance (PLAN.md):**
1. An inlay on a **fixture MOD cavity** passes the full QC gate run.
2. The boundary blend is **G1-continuous: dihedral angle < 5° along the seam** (measured).
3. **Seating simulation clean** (inlay ∩ cavity die: no penetration beyond configured interference).
Plus the standing invariants: margin fit ≤ 10 µm on the cavity outline; full journal
reproducibility (record → replay bit-identical); QC gates never weakened.

## Global constraints (bind every task)

Identical to Phase 4's (docs/plans/phase-4-crown-design.md): accuracy over speed;
Float64 kernel; determinism/journaling (invariants 2/3); gates block export
(invariant 4); no hardcoded clinical defaults (invariant 7 — inlay/onlay minimums
live in `clinical-profiles/`); booleans via the manifold wrapper; layer rule;
KERNEL_VERSION discipline (current: 0.15.0); tests-first with analytic golden
fixtures before any real-scan work; NO commit trailers (author Zoltán Dul only);
`scans/` is PHI and never committed; never touch the user's :5198 dev server.

**Fixture reality:** arch-case-01 has crown preps, not cavities — Phase 5 is
synthetic-fixture-driven end to end (the PLAN acceptance says "fixture MOD cavity"
explicitly). A real inlay case is a welcome future addition, tracked like the
retraction-cord crown scan.

## Phase 4 carry-ins (fold into the matching tasks)

- `marginExclusionMm` (feather-band width) → material profile (T1) + wired into the
  live UI `runQc` (T8) — the P4 follow-up.
- e.max profile's non-thickness placeholder fields get real values where inlay/onlay
  IFU data exists (T1); placeholders that remain stay honestly labeled.
- selfIntersection-gate proxy hardening and real library-asset fetch remain OUT of
  scope (tracked for later phases) unless a task naturally lands on them.

---

## Task 1 — Profile params, MOD-cavity fixture, scaffold

1. `clinical-profiles`: add inlay/onlay parameters to the schema + both profiles —
   `inlayMinThicknessMm` (e.max IFU: 1.0 isthmus/occlusal), `onlayMinThicknessMm`
   (1.0), `cuspCoverageMinThicknessMm` (1.5), `marginExclusionMm` (feather band,
   0.2 default — the P4 carry-in); document each value's IFU/source note; version
   bumps + checksums; zirconia gets its documented equivalents (0.5/0.5/0.7 per
   monolithic-zirconia norms, labeled).
2. **Analytic MOD-cavity fixture** (the P5 `shoulderPrepMesh` equivalent, kernel
   test-fixtures): a synthetic posterior tooth (reuse/derive from the library molar
   or a closed-form crown shape) with a machined MOD cavity — closed-form floor
   depth, wall taper, proximal-box widths/heights, and the EXACT cavity-outline
   polyline as a constructed ring (the margin currency). Watertight, deterministic,
   parameterized (isthmus width, box dimensions, taper). Also an ONLAY variant
   knob (reduced cusp) for T7.
3. Pipeline scaffold: `PipelineContext`/stage plumbing accepts `RestorationType`
   'inlay'/'onlay' (shared-types already has the union); type-level guard rails so
   crown-only stages can't silently run on a cavity case.
4. Tests: fixture watertight/manifold/closed-form assertions (outline exactly on the
   constructed ring); profile schema + checksum + i18n-independent loading; property
   tests on fixture parameterization.

**Verify:** full chain green. Commit.

---

## Task 2 — Cavity margin + region analysis (kernel)

1. Validate the P3/P4 margin machinery on cavity outlines: the fixture's cavity
   outline (sharp corners at box line angles) through `marginLoopPolyline` /
   validation / band — document any corner-case handling (chord-cap still binds).
2. `kernel/src/cavity/` region analysis: classify the cavity surface into
   **floor / axial walls / proximal-box walls** relative to the insertion axis
   (analytic tests on the fixture with closed-form expected classification);
   box-region extraction feeds T5's scoped contact adaptation.
3. Insertion-axis suitability for a cavity (reuse the P3 axis/undercut scan on the
   cavity region; a cavity's undercut = wall regions occluded along the axis).

**Verify:** full chain green; classification matches closed-form on the fixture. Commit.

---

## Task 3 — Inlay inner surface: cavity offset + blockout + margin adaptation *(acceptance-critical: margin fit ≤ 10 µm on the cavity outline)*

1. Reuse/extend `innerSurfaceOffset`/`innerSurfaceSolid` for the CAVITY: two-zone
   offset (marginal gap at the outline → cement gap above the spacer line, C1 blend —
   the T3 machinery with the cavity as the prep region), draft-close blockout
   relative to the insertion axis (wall undercuts filled so the inlay seats), and
   the skirt/boundary == the cavity-outline polyline.
2. `marginFitGate` on the cavity outline: **≤ 10 µm** (the same gate, cavity
   currency) — measured + reported on the MOD fixture.
3. Self-consistency: blocked inner surface re-scanned along the axis → zero undercut
   (whole-mesh, valid axis — the T4 lesson).
4. Worker + journaling: one stage op; replay reproduces hashes.

**Verify:** margin fit + zero-undercut measured/reported; full chain green. Commit.

---

## Task 4 — Occlusal patch + G1 boundary blend *(acceptance-critical: dihedral < 5° along the seam — the phase's hardest new geometry)*

1. `kernel`: the occlusal anatomy patch — restore the occlusal surface over the
   cavity (library-molar occlusal region or procedural anatomy), fitted to the
   cavity outline, **blended into the surrounding intact tooth surface with G1
   continuity along the seam**. The blend method is the design crux (candidates:
   boundary-constrained RBF with normal constraints; Hermite/Coons boundary strip;
   normal-field-blended SDF) — brainstorm, document the choice + `@errorBound`.
2. **The G1 measurable**: a kernel measurement of the dihedral angle across the
   seam (patch normal vs surrounding-tooth normal along the boundary, dense
   sampling) → max + distribution; the acceptance gate: **max < 5°**. Analytic
   test: a flat patch in a plane (dihedral 0 exactly) and a spherical cap with
   closed-form seam angle.
3. Deterministic, journaled, worker job; error bound surfaced.
4. Tests: analytic (closed-form dihedral), the MOD fixture (measured seam dihedral
   < 5° REPORTED), determinism, golden.

**Verify:** dihedral measured + < 5° on the fixture; full chain green. Commit.

---

## Task 5 — Proximal box contact adaptation (Class II)

1. Scoped contact adaptation: the T6 RBF morph machinery with control points
   restricted to the **proximal-box wall regions** (T2's classification) — each box
   face adapts to its neighbor at `proximalContactPenetrationMm`; the occlusal
   patch + margin/seam stay FIXED (zero-displacement anchors — the seam's G1 must
   survive adaptation; re-measure dihedral after).
2. Measured box-contact residuals (per box, mesial + distal) reported; clamp
   warnings surfaced (T6 pattern).
3. Deterministic, journaled; worker.

**Verify:** box residuals + seam-dihedral-preserved measured/reported; chain green. Commit.

---

## Task 6 — Inlay shell + QC *(acceptance-critical: MOD inlay passes QC; seating clean)*

1. Shell: occlusal patch + inner cavity surface + seam band → single watertight
   solid (the T7/T12b constructShell/heal machinery adapted to the inlay topology —
   the outer is a patch not a closed tooth; document the stitch).
2. Thickness gate with **inlay minimums** from the profile (isthmus/occlusal —
   `inlayMinThicknessMm`); a deliberately shallow cavity variant → gate BLOCKS.
3. **Seating simulation**: inlay ∩ cavity-die boolean → penetration ≤ interference
   (≈ 0) — measured + reported (the P4 seating gate on the inlay).
4. Full `runCrownQc`-equivalent gate run on the inlay (`runInlayQc` or a
   restoration-type-aware `runRestorationQc`) — all gates pass on the MOD fixture.

**Verify:** all gates pass + seating + thin-blocks measured/reported; chain green. Commit.

---

## Task 7 — Onlay: cusp coverage + onlay minimums

1. Cusp-coverage region selection (kernel): identify cusp regions (library/fixture
   landmarks + geometric cusp detection); a coverage selection extends the
   restoration outline over the selected cusps (the outline UPDATES — margin
   machinery re-runs on the extended outline).
2. Onlay geometry = inlay pipeline on the extended outline (offset/blockout/patch/
   blend all reuse); **thickness rules switch to onlay minimums**
   (`onlayMinThicknessMm`/`cuspCoverageMinThicknessMm` from profile) — the gate
   reads the restoration type.
3. Tests: onlay on the fixture's reduced-cusp variant passes QC with onlay
   minimums; an under-thickness cusp coverage → gate BLOCKS; determinism; golden.

**Verify:** onlay QC + blocks measured/reported; chain green. Commit.

---

## Task 8 — UI: inlay/onlay staged workflow

1. Extend the T10 crown-design UI to restoration-type-aware staged workflow:
   cavity-outline margin trace (the P3 editor on a cavity), inner surface, occlusal
   patch + blend preview (seam dihedral readout), box-contact sliders + heatmaps,
   cusp-coverage selection (onlay), QC panel (inlay/onlay gate set + minimums).
   Same state-machine order enforcement + invalidation cascade + honest-failure
   surfacing (T10 patterns).
2. **P4 carry-in**: wire `marginExclusionMm` (now a profile param, T1) into the live
   UI `runQc` path — closing the P4 follow-up.
3. Coalesced journaling; i18n ×4 (HU terminology consistent); browser-lane
   critical-path test on the MOD fixture; layer rule.

**Verify:** browser-lane green; i18n parity; chain green. Commit.

---

## Task 9 — Server: dual-validation + persistence for inlay/onlay

1. Extend `POST /api/restorations/:id/validate-qc` to the inlay/onlay gate set
   (restoration-type-aware context; bit-identical client/server QcReport on the
   inlay fixture — the T11 proof extended).
2. Persistence round-trip (inlay/onlay `stages` + `qc` via CaseDocument); server-side
   journal replay of the inlay stages reproduces hashes.
3. JSON schemas for anything new.

**Verify:** client/server agreement asserted on inlay; chain green. Commit.

---

## Task 10 — End-to-end acceptance + journal reproducibility *(the phase gate)*

1. Acceptance harness (`test/golden/inlay-acceptance.test.ts`): the COMPLETE inlay
   pipeline on the MOD fixture → **all QC gates pass; margin fit ≤ 10 µm; seam
   dihedral < 5°; seating ≤ interference; thin-cavity variant → thickness BLOCKS;
   full journal reproducibility** (record → replay → bit-identical stage hashes).
   Onlay variant end-to-end likewise.
2. The GENUINELY COUPLED chain (the P4/T12b lesson — no decoupled stand-ins: the
   patch that gets blended is the patch that gets shelled).
3. Runtime reported; env-gate heavy runs.
4. Any unreachable element → BLOCKED with numbers (never weaken).

**Verify:** all acceptance assertions green with measured numbers; reproducibility
proven. Commit.

---

## Task 11 — e2e, docs, phase wrap-up

1. `e2e/phase5.spec.ts`: the inlay workflow end-to-end through the UI on the MOD
   fixture (deterministic waits, store assertions; the T13 lesson: NEVER edit
   committed server/port files — untracked config + isolated bootstrap only).
2. `docs/demos/phase-5.md`: honest acceptance ledger (measured numbers + test
   names; open items incl. no-real-inlay-case tracked-pending); KERNEL_VERSION
   delta; demo script.
3. ADR if warranted (the G1 blend approach is a strong candidate).
4. Full local acceptance chain green (all suites + e2e).

**Verify:** all green; docs complete. Commit.
