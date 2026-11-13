# Phase 13 — Verified contacts and fit headroom on the real crown (M13 "Honest contacts")

Phase 13 implements [ADR-026](../adr/026-verified-contact-targets-and-ring-split-tolerance.md).
It works on Phase 12 open items 1–3 ([docs/demos/phase-12.md](../demos/phase-12.md)):

- the real fit sits about 1 µm under the bound;
- the e2e self-intersection's location is unknown;
- the mesial contact misses its target by 65 µm without being flagged.

**Phase acceptance:**
1. **No contact misses silently.** A contact target is either verified to
   1e-6 mm on real neighbour surface, or reported as unreached
   (`clampBound`) or as on synthetic surface. Both of those fail the contact
   gate. This is proven analytically (a corner case where the fixed line
   misses), by property tests, and on real tooth 11.
2. **Converged contacts are byte-identical.** Every pinned lane's morph and
   crown hashes are unchanged under kernel 0.41.0, proven at 0.40.0 with the
   new code.
3. **The fit has headroom.** With the split tolerance at half the bound,
   real tooth 11's fit residual is ≤ 25 µm (golden and e2e), measured. If a
   measurement refutes this, the honest value is asserted. The bound is not
   weakened.
4. **The self-intersection is located and resolved.** The first locus is
   attributed to a shell part (outer, inner or seam) and to a cause, and then
   either fixed with a regression test or asserted as a measured consequence
   of the unprepared tooth, with evidence.
5. **The real crown's gates report honestly**, each with its measured cause,
   in the golden real lane and in e2e `phase9-crown`.
6. **Golden stability.** Pins move only under 0.41.0 and 0.42.0, each
   proven, with every moved pin named.

## Global constraints (bind every task)

The same as Phase 12:

- accuracy over speed;
- a Float64 kernel;
- determinism: fixed iteration counts, never a tolerance loop, and
  transcendentals only through `detMath`;
- journaling;
- QC gates and bounds are never weakened;
- clinical values live only in `clinical-profiles/`;
- tests come first: analytic and property tests before the real-scan
  fixture;
- every string in EN/HU/DE/ES;
- **no commit trailers (author Zoltán Dul only)**;
- `scans/` is PHI and is never committed;
- a golden byte-change is an alarm, never a regeneration;
- e2e runs on `DQCAD_E2E_PORT=5180`, because port 5173 belongs to another
  project.

## Task 1 — Verified contact targets on real surface *(kernel 0.41.0)*

- **`packages/kernel/src/anatomy/morph.ts`**:
  - Exported constants: `CONTACT_TARGET_TOLERANCE_MM = 1e-6` and
    `CONTACT_PROJECTION_STEPS = 8`, each with TSDoc stating that they are
    numerical, not clinical.
  - `refineContactTarget`:
    - It keeps the Newton loop unchanged, then verifies the result.
    - If verification fails, it runs the fixed projection steps of ADR-026
      Decision 1 and verifies again (the tolerance and the travel bound).
    - If that also fails, it returns the Newton target with
      `clampBound: true`.
    - It returns `{ target, clampBound, targetTriangle }`, where
      `targetTriangle` is the closest neighbour triangle of the accepted
      target.
  - `MorphContactInput.realTriangleCount?: number`:
    - Validated as an integer in `[1, triangleCount]`, otherwise a
      `RangeError`.
    - `ContactPlan` and `MorphContactResult` gain
      `targetOnSyntheticSurface: boolean`: true when the target was accepted
      and `targetTriangle ≥ realTriangleCount`.
  - The module doc and `@errorBound` are updated. The bound is unchanged in
    definition, and a target can no longer miss without a flag.
- **`packages/kernel-workers/src/jobs/morphAnatomy.ts`**: the payload carries
  `realTriangleCount?` per contact, and the result carries
  `targetOnSyntheticSurface` per contact.
- **`packages/cad-pipeline/src/gates/contact.ts`**:
  - `ContactResidualInput.targetOnSyntheticSurface?: boolean`. An absent flag
    means false, so old journals read as before.
  - A flagged contact fails closed. Its message names the kind and the
    synthetic closure.
  - `stages/morphing.ts` threads the flag through.
- **`apps/client/src/engine/crownDesign.ts`**:
  - `buildMorphContacts` passes `realTriangleCount` from the session's
    captures (`capturedTriangleCount`), and nothing for a placeholder.
  - The flag rides in the morph op's journaled contact results, in
    `morphContacts`, and in `exportContext.ts` to the server.
  - `apps/server/src/schemas.ts` accepts the optional boolean.
  - `crownStore.ts` carries it, and the panel's contact readout shows it
    (new i18n key `crownContactOnSynthetic`, EN/HU/DE/ES).
- **Tests first** (`morph.test.ts`):
  - **Analytic corner.** The neighbour is a closed box whose first N
    triangles are its −x face (real) and whose remaining faces are
    synthetic. The contact vertex sits diagonally off the box's edge, so `n₀`
    points at the edge.
    - The fixed-direction Newton alone misses. Assert this through the old
      behaviour, with `CONTACT_PROJECTION_STEPS` set to 0 via an internal
      test seam.
    - The projected target reaches `s = −t` to 1e-9 and is accepted.
  - **Synthetic flag.** In the same box, a target landing nearest a
    synthetic face gives `targetOnSyntheticSurface: true`. Making every
    triangle real gives false.
  - **Unreached.** On a neighbour thinner than `t`, the target is unreachable
    and `clampBound` is true. It never reads as merely off target.
  - **Property** (fast-check, random sphere and box neighbours at random
    gaps): every accepted target satisfies `|s + t| ≤ 1e-6`, and travel is
    within the bound.
  - **Byte-identity.** A converged case (sphere neighbour) returns the same
    target bits as the Newton loop alone.
  - The `contact.test.ts` gate fails closed on the flag, with the message. A
    `crownDesign.test.ts` case passes `realTriangleCount` from a capture.
- **Golden proof** at 0.40.0 with the new code:
  - Expected: no pinned lane moves. Every pinned contact converges in
    Newton.
  - Then `KERNEL_VERSION` becomes 0.41.0, with a changelog entry, and the
    five `*-qc` pins and the server traceability golden are re-pinned by
    their version string.
- **Real lane** (`RUN_CROWN_REAL_DIE=1`) and e2e `phase9-crown`: assert the
  measured contact verdict. The expectation is that the mesial contact
  fails, flagged on synthetic surface.

## Task 2 — The ring split tolerance *(kernel 0.42.0)*

- `packages/clinical-profiles/src/constants.ts`:
  `CERVICAL_RING_SPLIT_TOLERANCE_MM = 0.025`, with a TSDoc rationale (half
  the bound: headroom as large as the bound's margin, ADR-026 Decision 3).
- `packages/kernel/src/anatomy/cervicalFit.ts`:
  - `CervicalFitInput.ringSplitToleranceMm?`. It requires `maxResidualMm`
    and must be in `(0, maxResidualMm]`, otherwise a `RangeError`.
  - `ringEdgesOverBound` uses it, and the result echoes it.
- `kernel-workers` cervical-fit job: the payload and the result carry it.
- The engine passes the constant, and the fit op journals it.
- **Tests first** (`cervicalFit.test.ts`):
  - Absent tolerance: byte-identical to ADR-025.
  - Tolerance equal to the bound: byte-identical.
  - On the real trace with the 72-vertex template: half the bound gives a
    residual ≤ 25 µm, and the refined count is asserted.
  - Validation errors.
  - A property: the residual is non-increasing as the tolerance falls, over
    a fixed grid of tolerances.
- **Golden proof** at 0.41.0 with the new code:
  - Expected: the open-arch library lanes move only if their rings now split
    (each move named).
  - Then 0.42.0, a changelog entry, and the re-pins.
- Real lane and e2e: assert the measured residual (≤ 25 µm expected) and
  the measured gate set.

## Task 3 — The self-intersection, located and resolved

- **`packages/cad-pipeline/src/gates/selfIntersection.ts`**: when the gate
  fails and the caller supplies the shell's part ranges (`outer`, `inner`,
  `seam` triangle counts, from the shell stage's output order: outer, then
  inner, then seam), the message names each first-locus triangle's part.
  - A passing gate's message is unchanged, so no pinned report moves.
  - The engine and `exportContext.ts` pass the ranges, and the server
    computes them the same way from the journaled shell op.
- **Root cause.** Reproduce on the real lane: Task 2's tolerance gives 20
  pairs, the first at 0.18–0.54 mm from the margin. Measure:
  - the parts of every intersecting pair;
  - the local wall thickness there, against the minimum-wall gate's
    excluded margin samples;
  - whether the die penetrates at the same place (seating gate).
- **Outcome**, one of the two, decided by the measurement:
  - (a) **A kernel defect** (for example in the shell's seam or trim): fix
    it with a regression fixture, including a synthetic analytic case.
    Version bump only if bytes move.
  - (b) **The unprepared tooth's consequence** (the outer surface crosses an
    intaglio that follows an unprepared, bulging tooth, where seating
    already fails): assert the measured verdict in the golden and the e2e,
    with the parts and the distances in the test's comment.
- Tests:
  - `selfIntersection.test.ts`: the part attribution on a synthetic
    two-part shell.
  - The real-lane assertion.

## Task 4 — Phase gate

- `npm test`, the full e2e (`DQCAD_E2E_PORT=5180`), the real lanes, lint,
  typecheck and build.
- `docs/demos/phase-13.md` (acceptance table, measurements, open items);
  `PLAN.md`; the README phase row. ADR-026 becomes Accepted with its
  measured outcomes.
- Push only when the user asks.

## Review focus

1. **A neighbour whose captured surface is a thin sliver.** The level set at
   `−t` may not exist near the contact vertex. Expected: unreached and
   flagged, never a false accept.
2. **A projection step that crosses the medial axis.** The gradient flips
   between steps. Expected: the final verification rejects a non-converged
   target. The fixed step count keeps it deterministic.
3. **An old journal with no `targetOnSyntheticSurface`** on replay or export.
   Expected: the flag is read as false, and the server schema accepts both.
4. **A tolerance equal to the bound or absent.** Expected: byte-identical to
   ADR-025 (tested).
5. **A self-intersection gate given no part ranges** (the inlay and bridge
   callers). Expected: today's message, unchanged.
