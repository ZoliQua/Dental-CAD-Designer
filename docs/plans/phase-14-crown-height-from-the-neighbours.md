# Phase 14 — Crown height from the neighbours; the contact in its clinical band (M14 "In the arch")

Phase 14 implements [ADR-027](../adr/027-crown-height-from-the-neighbours-occlusal-level.md).
It starts from Phase 13 open item 1 ([docs/demos/phase-13.md](../demos/phase-13.md)),
the contact location on real tooth 11. Measurement showed the root cause is
upstream of the contact: without an antagonist, the placed crown is about
twice as tall as its neighbours.

**Phase acceptance:**
1. **The crown stands in the arch.** With no antagonist and both neighbours
   captured, the placed crown's highest point is at the neighbours'
   interpolated occlusal level, or at the intaglio floor when the floor is
   higher. This is proven analytically (box neighbours with known peaks),
   by a property test, and on real tooth 11.
2. **A too-tall preparation is named, not hidden.** The shortfall is
   journaled with the placement and shown in the panel. On real tooth 11 it
   is the measured value, about 1.4 mm expected. The die never pierces the
   crown's top.
3. **A truncated or missing datum falls back with its reason**: the uniform
   scale, the reason journaled and shown.
4. **The proximal contact vertex lies in its profile band** (Decision 3).
   Whether the contact reaches real surface on tooth 11 is measured and
   asserted.
5. **The real crown's gates report honestly** in the golden real lane and in
   e2e `phase9-crown`, each failure with its measured cause.
6. **Golden stability.** Pins move only under 0.44.0 and 0.45.0, each proven
   at the previous version with the new code, every moved pin named.

## Global constraints (bind every task)

The same as Phase 13:

- accuracy over speed;
- a Float64 kernel;
- determinism: fixed iteration counts, lowest-index ties, transcendentals
  only through `detMath`;
- journaling;
- QC gates and bounds are never weakened;
- clinical values live only in `clinical-profiles/`;
- tests come first: analytic and property tests before the real-scan
  fixture;
- every string in EN/HU/DE/ES;
- **no commit trailers (author Zoltán Dul only)**;
- `scans/` is PHI and is never committed;
- a golden byte-change is an alarm, never a regeneration;
- e2e runs on `DQCAD_E2E_PORT=5180`.

## Task 1 — The neighbours' occlusal level and the intaglio floor *(kernel 0.44.0)*

- **`packages/kernel/src/anatomy/placement.ts`**:
  - `AnatomyPlacementInput.neighbourOcclusalDatum?: NeighbourOcclusalDatum`:
    - `mesial` and `distal`, each a `NeighbourWindow`
      `{ seedMm: Vec3; radiusMm: number; windowBoundaryBandMm: number; realVertexCount: number }`;
    - `floorHeightMm: number`, the intaglio top above the origin plus the
      occlusal minimum, computed by the caller.
    - Validated as finite, `radiusMm > 0`, `windowBoundaryBandMm ≥ 0`, and
      `realVertexCount` an integer in `[1, vertexCount]`, otherwise a
      `RangeError`.
  - It is used only when the antagonist did not set the height. The solve
    follows ADR-027 Decisions 1–2: the peaks (real vertices, lowest-index
    tie), the truncation test, the interpolated level with its parameter
    clamped, then `heightMm = max(level, floor)` and
    `scaleOG = heightMm / nativeTop`.
  - `AnatomyPlacementMeasurements.occlusoGingivalDatum`:
    `{ source: 'antagonist' | 'neighbours' | 'uniform'; reason?: 'neighbourPeakTruncated' | 'levelNotAbove';`
    `neighbourLevelMm: number | null; floorHeightMm: number | null; occlusalReductionShortfallMm: number }`.
    The shortfall is 0 unless the floor lifted the top.
  - Absent datum: the solve is today's, bit for bit.
- **`packages/kernel-workers/src/jobs/placeAnatomy.ts`**: the payload carries
  the datum, and the result carries `occlusoGingivalDatum`.
- **`apps/client/src/engine/crownDesign.ts`**:
  - Passes the datum when there is no antagonist and both sides are
    `case` captures (`session.captures.mesial` and `.distal`).
    - The window comes from each capture: `seed`, `params.radiusMm`,
      `windowBoundaryBandMm`, and `realVertexCount = positions.length / 6`
      (the closure doubles the vertices, `closeRegion`).
    - `floorHeightMm` = the intaglio's highest point above the margin
      centroid, along the axis, plus `profile.occlusalMinWallThicknessMm`.
  - When a side is not a case capture, the datum is absent and the reason
    is `neighbourNotCaptured`, from the engine.
  - The `crown-anatomy` op journals `occlusoGingivalDatum`.
  - `crownStore` gets an `anatomyHeight` readout, and the panel shows the
    datum source and, when the shortfall is positive, the warning
    `crown-anatomy-occlusal-shortfall`. New i18n keys `crown.heightDatum.*`
    and `crown.occlusalShortfall` in EN/HU/DE/ES.
  - The test hook `getCrownAnatomySummary()` (read-only) serves the e2e.
- **The pipeline twin** (`cad-pipeline/src/stages/anatomyPlacement.ts`) and
  the bridges pass no datum, so they are unchanged (ADR-027 Consequences).
- **Tests first** (`placement.test.ts`):
  - **Analytic.** Box neighbours with peaks at known heights and `u` values,
    with no antagonist:
    - the level equals the closed-form interpolation;
    - the placed mesh's top above the origin along `og` equals the level to
      1e-12;
    - the clamp applies when the origin lies outside the peaks' `u` range.
  - **Floor.** With the floor above the level, the top is at the floor, and
    the shortfall is the floor minus the level, exact.
  - **Truncation.** A peak beyond `radiusMm − band` from its seed gives the
    uniform scale and `neighbourPeakTruncated`.
  - **Closure vertices are ignored.** A vertex after `realVertexCount` that
    is higher than every real one does not move the level.
  - **Antagonist precedence.** With an antagonist, the datum is ignored and
    the source is `antagonist`.
  - **Byte-identity.** An absent datum gives today's frame, bit for bit.
  - **Property** (fast-check, random peaks, seeds and floors): the top is at
    `max(level, floor)` to 1e-9, and the shortfall is ≥ 0 and 0 iff
    `level ≥ floor`.
  - Engine: a `crownDesign.test.ts` case passes the datum from two captures
    and journals it; a placeholder side gives `neighbourNotCaptured`.
- **Golden proof** at 0.43.0 with the new code:
  - Expected moves: the crown-open-arch lanes (built-in, library premolar,
    library incisor), whose neighbours are case captures. Their verdicts
    are measured and asserted. The fixture's die is 0.5 mm taller than its
    neighbours, so a shortfall is expected.
  - Every lane without captures stays byte-identical. That is proven, not
    assumed.
  - Then 0.44.0, a changelog entry, and the re-pins.
- **Decided on measurement, not in advance:** whether the open-arch fixture
  gains a consistent variant (neighbours tall enough for the die) as an
  additional lane. The existing lane keeps its fixture and reports its
  shortfall.

## Task 2 — The proximal contact in its height band *(kernel 0.45.0)*

- **`packages/clinical-profiles/src/constants.ts`**:
  `PROXIMAL_CONTACT_BAND_ANTERIOR = [0.60, 0.95]` and
  `PROXIMAL_CONTACT_BAND_POSTERIOR = [0.45, 0.90]`, each with TSDoc marking
  it a clinical placeholder with its anatomical rationale.
  `proximalContactBand(tooth: FdiTooth)` returns the anterior band for
  x1–x3 and the posterior band otherwise.
- **`packages/kernel/src/anatomy/morph.ts`**:
  - `MorphContactInput.heightBand?`:
    `{ originMm: Vec3; axis: Vec3; heightMm: number; minFraction: number; maxFraction: number }`.
    Validated as `0 ≤ min < max ≤ 1`, `heightMm > 0` and a unit-normalisable
    axis, otherwise a `RangeError`.
  - The contact vertex is chosen among non-fixed vertices whose
    `(p − origin)·axis / heightMm` lies in the band, nearest first, lowest
    index on a tie. An empty band is a `RangeError` (`MorphEmptyContactBandError`).
  - Absent band: bit-identical selection.
- **`kernel-workers` `morphAnatomy`**: per contact, the payload carries
  `heightBand?`.
- **Engine**: the band is passed for proximal contacts only. The origin is
  the margin centroid, the axis the insertion axis, and the height the
  placed crown's top above it along the axis. It is journaled with the
  morph op (`contactHeightBand`).
- **Tests first** (`morph.test.ts`): a column-shaped tooth beside a box
  neighbour whose nearest point is cervical.
  - With the band, the contact vertex lies in the band and is the nearest
    there.
  - Without it, the selection is today's.
  - An empty band throws, and validation errors are covered.
  - **Property:** the chosen vertex's fraction is always inside the band.
- **Golden proof** at 0.44.0 with the new code: the crown-open-arch lanes
  move (named). Lanes without a band are byte-identical. Then 0.45.0.

## Task 3 — Phase gate

- The real lane (`RUN_CROWN_REAL_DIE=1`) and e2e `phase9-crown` assert the
  measured placement, the shortfall, the contact verdict and the failing
  gate set.
- `npm test`, the full e2e (`DQCAD_E2E_PORT=5180`), lint, typecheck, build.
- `docs/demos/phase-14.md`, `PLAN.md`, the README row. ADR-027 becomes
  Accepted with its measured outcomes.
- Push only when the user asks.

**Landed (2026-11-16).**
- **Task 1 (kernel 0.44.0).** The datum and the floor, as planned, with two
  changes made on measurement:
  - The floor covers every intaglio point along the axis, computed by
    downward rays. The planned apex-only floor (the intaglio's top plus the
    minimum) let the die pierce the library crowns.
  - The kernel computes the floor from the intaglio and the profile's
    occlusal minimum, so the datum carries those instead of
    `floorHeightMm`.
  - The engine adds the reason `antagonistNotOverSite`.
  - The e2e reads the journaled datum through the existing
    `getLatestOperation` hook, so no new hook was added.
  - The consistent open-arch lane (3.5 mm prep, 9.0 mm neighbours) was
    added. The existing fixture is kept and reports its lift.
- **Task 2 (kernel 0.45.0).** The band, as planned. The kernel measures the
  height itself, so the band carries only the axis and the fractions.
  - The engine applies the band only when a datum set the crown's height.
    The e2e placement showed why: there the datum falls back, and a band on
    the uniform-height crown drove a bulging, self-intersecting morph
    (ADR-027, "Found during implementation").
- **Outcome.**
  - Real tooth 11 (golden): the contact gate passes. Only the unprepared
    tooth's wall and seating gates fail.
  - Consistent lane: every gate passes.

## Review focus

1. **A neighbour capture whose peak is a window cut** (a tall molar picked
   low). Expected: `neighbourPeakTruncated` and the uniform fallback,
   disclosed. Covered by the truncation test.
2. **Neighbours at very different heights** (a canine beside a lateral).
   Expected: the interpolated level, never above the higher peak or below
   the lower one. The clamp keeps the parameter in [0, 1]. Covered by the
   property test.
3. **A manual rescale after the auto-place.** Expected: the override
   composes on the solved frame as today, and the journaled datum describes
   the auto-solve. Add one engine test.
4. **An old journal without `occlusoGingivalDatum`** on replay. Expected:
   the op replays. The field is absent, and the panel shows no datum line.
5. **A band that excludes every vertex** (a degenerate placed mesh).
   Expected: `MorphEmptyContactBandError`, never a silent global fallback.
