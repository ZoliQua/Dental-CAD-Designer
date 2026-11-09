# Phase 12 — The library template fitted on a real margin (M12 "Fitted for real")

Phase 12 implements [ADR-025](../adr/025-continuous-outline-height-and-adaptive-cervical-ring.md).
It works on Phase 11 open items 1 and 6 ([docs/demos/phase-11.md](../demos/phase-11.md)):
the cervical fit refuses real `arch-case-01` tooth 11 over the 50 µm bound.

**Phase acceptance:**
1. **The fit is within the bound on a real margin.** On real tooth 11 (the
   golden real lane and e2e `phase9-crown`), the fitted library incisor
   1.3.0 is placed with a residual ≤ `CERVICAL_FIT_MAX_RESIDUAL_MM`. If a
   measurement refutes this, the honest verdict is asserted and documented.
   The bound is not weakened.
2. **The outline's height is continuous**, and it equals each margin
   point's own height at that point's azimuth. This is proven analytically
   and by property tests, including the notched and tilted cases.
3. **Refinement never changes a fit that already met the bound.** Those
   fits are byte-identical: the open-arch library lanes and the Phase 4
   shoulder lane.
4. **The real crown's later gates report honestly.** Wall and seating fail
   on the unprepared tooth. Any other failing gate is asserted with its
   measured cause.
5. **Golden stability.** Pins move only under kernel 0.39.0 (Task 1) and
   0.40.0 (Task 2). Each change is proven by running the whole golden suite
   with the new code, and every moved pin is named.

## Global constraints (bind every task)

The same as Phase 11: accuracy over speed; a Float64 kernel; determinism
(transcendentals only through `detMath`); journaling; QC gates and bounds
never weakened; clinical values only in `clinical-profiles/` (the fit's
bound is passed in); tests first (analytic and property tests before the
real-scan fixture); EN/HU/DE/ES for every string; **no commit trailers
(author Zoltán Dul only)**; `scans/` is PHI and never committed. A golden
byte-change is an alarm, never a regeneration.

## Task 1 — The continuous outline height *(kernel 0.39.0)*

- `packages/kernel/src/anatomy/cervicalFit.ts`:
  - `emergenceRadius` keeps the horizontal radius. The height becomes the
    margin's height where the ray crosses the margin's projection
    (`marginHeightAt(q, heights, dir)`, linear along the crossed segment,
    with the parameter clamped to [0, 1]).
  - The module doc, `@errorBound` and the ADR-024 cross-reference are
    updated.
- **Tests first** (`cervicalFit.test.ts`):
  - At every margin point's own azimuth, the loop height equals that
    point's height (1e-12). Cases: a scalloped ellipse, the tilted notched
    "plus", and the real trace.
  - Continuity: on the tilted "plus", heights at θ = π/4 ± 1e-15 agree to
    1e-12. This was a 78 µm step under ADR-024.
  - Property (fast-check, random star polygons with random heights): the
    loop height lies between the two heights of the crossed margin segment,
    and adjacent outline samples at a 1e-9 rad azimuth step differ by
    ≤ 1e-6 mm.
  - The existing exactness tests (radius, distance d) are unchanged.
- `KERNEL_VERSION` 0.39.0 and a changelog entry.
- **Golden proof** at 0.38.0 with the new code. Expected: no move where the
  margin is planar (the open-arch lanes, Phase 4 shoulder). The tilted
  kernel tests move by design, and the version-only `*-qc` pins move. Any
  other move is an alarm.

**Landed (2026-11-09, kernel 0.39.0).** As planned. At 0.38.0 with the new
code, **no golden pin moved**: every golden margin is planar. At 0.39.0
only the five `*-qc` pins and the server traceability golden moved, by their
version string. The crossing picks the segment the ray misses least, with
the parameter clamped, so a ray through a vertex is deterministic.

## Task 2 — The adaptive cervical ring *(kernel 0.40.0)*

- `fitCervicalRing`:
  - New inputs: `maxResidualMm` (required when `maxRingRefineLevels > 0`;
    the caller passes the profile bound) and `maxRingRefineLevels`
    (default 3).
  - Before the RBF, split each ring edge whose chord deviates from the
    outline by more than `maxResidualMm` (ADR-025 Decision 2). The split is
    at the template edge midpoint, splitting both adjacent triangles.
    Repeat up to the cap.
  - The result gains `cervicalRing` (the refined ring's indices in the
    output mesh) and `ringRefineLevels` / `ringVertexCount`.
  - `assertValidTopology` holds in tests after each split.
- `packages/kernel-workers/src/jobs/cervicalFit.ts` passes the bound and
  returns the refined ring.
- `apps/client/src/engine/crownDesign.ts`:
  - It passes `CERVICAL_FIT_MAX_RESIDUAL_MM`.
  - Downstream (the morph's `fixedVertexIndices`, the shell's
    `outerCervicalRing`, the export context) it uses the fit's **refined**
    ring, not the asset's.
  - The fit op journals `maxRingRefineLevels`, `ringRefineLevels` and the
    refined `ringVertexCount`.
  - The panel's fit readout adds the ring size (EN/HU/DE/ES).
- **Tests first:**
  - **Shape preservation.** On a loft template, refinement with no fit
    displacement leaves every original vertex bit-identical. Each new vertex
    lies on its edge's midpoint, and the mesh stays watertight and manifold
    with valid topology.
  - **Adaptive.** A smooth circular margin refines nothing (byte-identical
    to `maxRingRefineLevels: 0`). A scalloped margin (a ±0.7 mm height
    scallop, 4 lobes) refines, and the residual drops below the bound.
  - **The cap.** With `maxRingRefineLevels: 0` the residual on the scalloped
    margin exceeds the bound, and the caller's refusal stays.
  - The worker job round-trips the refined ring. The engine test
    (`crownDesign.test.ts`) checks that the morph and the shell receive the
    refined ring.
  - The real trace (kernel test): a 72-vertex loft template fitted to tooth
    11's trace refines and meets 50 µm. The measured figure is recorded.
- `KERNEL_VERSION` 0.40.0 and a changelog entry.
- **Golden proof** at 0.39.0 with the new code. Expected: no move in the
  open-arch library and incisor lanes or the Phase 4 shoulder lanes, whose
  fits met the bound unrefined. The version-only pins move. Any other move
  is an alarm.

**Landed (2026-11-09, kernel 0.40.0).** As planned. At 0.39.0 with the new
code **no golden pin moved**. At 0.40.0 only the five `*-qc` pins and the
server traceability golden moved, by their version string.

Measured:
- The 10-lobe ±0.7 mm scallop goes from 62.1 µm with 72 ring vertices to
  44.9 µm with 88 (one level).
- Tooth 11's trace with a 72-vertex template goes from 75.5 µm to 42.6 µm
  with 77 (five splits).

The engine test was checked against the old ring hand-off: it fails without
the change. The real crown lane (Task 3) is next.

## Task 3 — The real tooth, measured

- **Golden real lane** (`RUN_CROWN_REAL_DIE=1`): the expected source becomes
  `{ origin: 'library', fdi: 11, version: '1.3.0' }`, with the fit residual,
  refine levels and ring size recorded. Then morph, shell and QC run
  through the engine. The verdict is asserted: exactly which gates fail,
  with wall and seating expected.
- **e2e `phase9-crown`:** the anatomy source is the library incisor
  (`data-origin="library"`, the fit readout visible). QC asserts the
  measured failing set.
- If the fitted incisor makes another gate fail on the unprepared tooth
  (self-intersection, for example), assert it and record why. Do not swap
  the template back.

## Task 4 — Phase gate

- Run the whole chain (Vitest, every e2e, lint, typecheck, build, the real
  golden lanes) with exit codes, and get a green CI run.
- Write `docs/demos/phase-12.md`. Update the PLAN.md and README status.
  Close the Phase 11 open items this phase resolves.

## Review focus

1. **A ring edge whose azimuth span contains no loop sample** (a coarse
   margin under a dense ring). The midpoint outline sample alone must
   decide it. Test this in Task 2.
2. **A ring edge spanning the ±π seam.** The azimuth-span membership must
   wrap. Test this in Task 2.
3. **The cap fan at the template's base.** A split ring edge also splits
   its cap triangle. The cap stays watertight, and the shell's ring trim
   discards it anyway. Test this in Task 2.
4. **A margin with repeated points** (the UI resampling). The dedup runs
   before both the height crossing and the refinement. Test this in Tasks 1
   and 2.
5. **An old journal replayed after the upgrade.** A saved fit op at 0.38.0
   replays at its recorded kernel version, and the version gate refuses a
   mismatched replay as before. Check the existing journal-replay golden in
   Task 4.
