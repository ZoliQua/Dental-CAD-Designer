# ADR-013: the Phase 6 gate harness runs closed-form abutment intaglios, not the real SDF stage — a deliberate, disclosed faithfulness reduction

**Status:** Accepted

## Context

Phase 4's and Phase 5's own end-to-end phase-gate harnesses
(`scripts/crown-journal-lib.ts`, `scripts/cavity-journal-lib.ts`) ran the
REAL SDF-based fit-surface construction (marching-cubes offset + blockout +
skirt) through the whole assembled chain — the phase acceptance numbers
(margin fit, seating, etc.) were measured on the actual algorithm a real
case would run. Phase 6 Task 9's job was the same kind of harness for the
bridge: assemble the full coupled chain (axis → abutment surfaces → pontic
→ connectors → framework → assembly → QC), record it as one journal, and
prove record → replay → bit-identical while measuring the PLAN acceptance
table in the assembled result.

Task 2's real abutment fit-surface stage (`runBridgeAbutmentSurfacesStage`)
runs the SDF `buildInnerSurface` op — the same accuracy-critical
marching-cubes pipeline the crown and cavity harnesses exercise. Wiring it
into the Task 9 harness is possible but expensive: `buildInnerSurface`
yields an OPEN fit-surface PATCH (not a closed solid) that would need the
full per-abutment SHELL construction (weld to an outer anatomy surface,
crown-style) before the watertight bridge-assembly union could consume it
— effectively building a second, bridge-specific crown pipeline inside the
harness, whose own determinism and fit-surface quality Task 2's OWN
stage/replay tests (`bridge/abutmentInnerSurface.test.ts`,
`stages/bridgeAbutmentSurfaces.test.ts`) already prove independently
(margin fit 0.000 µm on the real SDF intaglio, replay-identical hashes).

## Decision

The Task 9 phase-gate harness uses **closed-form abutment intaglios** (the
same `closedShellUnit` construction the Task 6 `bridgeAssemblyFixture` is
built from — a watertight capped-cylinder "thimble," analytically exact,
not marching-cubes-derived) rather than re-running the real SDF stage.
Everything ELSE in the chain is genuinely coupled and real: the pontic body
+ base measured by the real Task 3 `shapePonticBase`/`measurePonticRelief`;
the connectors built by the real Task 4 `loftConnectorProfiles` +
`measureConnectorMinArea`; the framework cutback run through the real Task
5 `runBridgeFrameworkStage` (a TRUE geometric cutback, not a threshold
switch — verified: wall 1990 µm → 995 µm, genuinely measured on the
cut-back submesh); the real Task 6 `runBridgeAssemblyStage` union; the real
Task 6/8 `runBridgeQc` 11-gate suite. The SDF fit-surface stage's own
determinism and ≤ 10 µm margin-fit property are treated as ALREADY PROVEN,
in Task 2's own lane, and are not re-proven inside this harness.

This is stated as a **DOUBLE-SCOPED phase-gate verdict**, not softened into
an unqualified "MET": the Task 9 report's own PHASE-GATE VERDICT section
names both caveats explicitly — (1) fixture-driven, no real multi-abutment
bridge scan (the standing, phase-wide tracked-pending), and (2) the chain
runs closed-form abutment intaglios, not the real SDF stage; the SDF
stage's properties are proven separately, in Task 2's lane, not in this
chain. A reviewer explicitly concurred with waiving an in-harness re-proof
of the SDF stage, given Task 2's existing coverage.

## Consequences

- **Positive: the harness stays fast and the coupling that matters most —
  assembly ↔ QC, and every downstream stage's forward feed into the next —
  is genuinely proven, with no stand-in between assembly and QC.** Runtime
  ~0.5 s/chain for BOTH mode chains, full-contour and framework, each
  recording 6 content-addressed ops and replaying bit-identical.
- **Positive: the framework chain is a materially STRONGER proof than the
  Task 6/8 integration tests give it credit for** — it demonstrates a real
  geometric cutback (not merely a threshold switch on unchanged geometry),
  fusing genuinely cut-back units into one watertight solid and measuring
  the mode-switched gate on that real cut-back submesh.
- **Positive: this is a deliberate, reviewed, and NAMED reduction in
  faithfulness relative to the Phase 4/5 precedent**, not an unexamined
  shortcut. Phase 4 and Phase 5's own gates ran their real SDF stage
  end-to-end because doing so was tractable there; Phase 6's bridge case
  specifically is not, for the structural reason given above (an open patch
  vs. a needed closed solid) — and that reason is written down here rather
  than left for a future reader to rediscover.
- **Negative / honest limit — a signer reading "Phase 6 acceptance MET"
  must read BOTH caveats, not just the first.** The assembled-pipeline
  properties (union, mode-switched gates, connector/pontic/margin-fit
  measurement, record→replay reproducibility) are proven IN this chain. The
  SDF abutment fit-surface stage's own determinism and accuracy are proven
  in Task 2's SEPARATE lane, not here. `docs/demos/phase-6.md`'s headline
  states both caveats at the top level for exactly this reason — neither is
  demoted to an "open items" footnote.
- **Follow-up (not required for this ADR, tracked as an open item):** a
  future task wanting a SINGLE fully-real chain (SDF abutments included)
  would need to add a per-abutment shell-weld step to the harness (turning
  the SDF patch into a closed solid the same way a real crown pipeline
  does) before the assembly union could consume it — a bounded, well-
  understood piece of future work, not a structural blocker.
