# ADR-010: bounded + localized + causation-tested QC acknowledgment

**Status:** Accepted

## Context

CLAUDE.md invariant 4 permits a failing QC gate to be "acknowledged with a
warning (journaled, in the report) — never silently bypassed," but does not
define what makes an acknowledgment SAFE to accept versus a rubber stamp
over a real, unbounded defect. Phase 5 Task 7's onlay seating gate produces
exactly this situation: the onlay's shell genuinely, reproducibly measures
a **0.0616 mm³** die-into-wall interference at the bevel↔cavity-wall
junction (a real geometric artifact — marching-cubes' pitch-scale
quantization of the fit-surface intaglio meeting a CONVEX covered-cusp
margin, distinct from the concave cavity floor case that needs no such
care) and this cannot be reduced to the 1×10⁻⁶ mm³ noise floor without a
fillet the fixture's own geometry (a 0.66 mm buccal wall) has no room for.
It must be acknowledged, not gated away — but an initial version of that
acknowledgment was found (review) to be a "blank check": it would have
accepted an interference of ANY size, at ANY location, with no assertion
that the artifact was actually the SAME small, well-understood, cornered
phenomenon it was believed to be.

## Decision

Harden a load-bearing acknowledgment into a **triple, falsifiable claim**,
asserted in the committed acceptance suite (not just a code comment):

1. **BOUNDED.** The intersection mesh's volume is asserted `< ceiling`
   (0.1 mm³ — roughly 50× the measured 0.0616 mm³, a real headroom, not a
   number chosen to just clear the current measurement) **AND `> 0`** — the
   lower bound matters as much as the upper one: if the artifact is ever
   fully eliminated by a future fix, THIS assertion starts failing, forcing
   the acknowledgment's removal rather than letting it sit dormant and
   misleadingly implying an active, unaddressed issue.
2. **LOCALIZED.** ≥ 90% of the intersection mesh's vertices fall inside a
   documented junction band (a bounding region around the specific
   bevel↔wall corner the mechanism predicts), with the intersection
   centroid pinned inside that band, and any vertex OUTSIDE the band
   independently proven to lie exactly on the coverage-crest outline locus
   (a zero-thickness marginal-seal sliver, the SAME phenomenon Phase 4
   already characterized for the crown, not a second unexplained defect). A
   regression that GROWS the interference or SPREADS it into, say, the
   covered-cusp intaglio (a genuinely different, more serious defect) fails
   this assertion, not just the volume bound.
3. **CAUSATION-TESTED.** A dedicated fixture knob
   (`junctionChamferMm` — a single-cut chamfer approximating a fillet at the
   bevel↔wall corner, default 0 so every existing chain stays byte-identical)
   demonstrates the interference SCALES with corner sharpness: increasing
   chamfer radius measurably, monotonically reduces the interference at the
   SAME locus. This is the difference between "we measured a number and it
   happened to be small" and "we understand the mechanism well enough to
   predict how it moves" — the latter is what makes an acknowledgment a
   genuine engineering judgment rather than an observation of convenience.

## Consequences

- **Positive:** this is a genuinely reusable QC-honesty instrument, not a
  one-off test. Whoever picks up the onlay fillet-removal open item
  (`docs/demos/phase-5.md`) inherits a precise, falsifiable definition of
  "done": the chamfer-causation test's own honest finding — a single-cut
  chamfer roughly HALVES the artifact but does not collapse it to the noise
  floor (the fixture's short buccal wall re-sharpens the chamfer's own foot
  against the shoulder corner past a certain radius) — already tells the
  next engineer that a single-cut chamfer is not sufficient and a genuine
  multi-segment fillet (needing fixture surgery to make room) is the real
  next step, rather than re-discovering that from scratch.
- **Positive:** the acknowledgment is provably NOT hiding a different,
  worse defect wearing the same gate name — the "any vertex outside the
  band must be an already-understood margin sliver" check specifically
  guards against exactly that failure mode (a regression introducing an
  unrelated second self-intersection elsewhere in the shell would fail the
  locality assertion, loudly).
- **Negative / accepted cost:** writing this triple (bound + locality +
  causation) is real, non-trivial engineering effort per acknowledgment —
  a dedicated fixture knob, an independent geometric locus proof, and a
  monotonicity sweep. This is NOT proposed as the bar for every trivial
  gate exception (e.g. a one-off `minWallThickness` marginal-band
  exclusion, already handled by the pre-existing `marginExclusionMm`
  disclosure mechanism) — reserved for load-bearing, structural
  acknowledgments where the alternative is either silently weakening a
  gate (never acceptable) or leaving a genuinely-uninvestigated failure
  permanently masked behind a bare `acknowledged: true` flag.
- **Negative / honest limit:** the pattern proves the artifact is bounded
  and understood on THIS fixture, at THESE clinical parameters (inlay gap
  0.02/0.05, onlay gap 0.03/0.08, pitch 0.06 mm — Task 6/7's tuned values).
  It is not a universal proof that any future onlay geometry's seating
  interference stays under the same 0.1 mm³ ceiling — a different covered-
  cusp geometry or coarser marching-cubes pitch could, in principle,
  produce a larger artifact at the same locus, which is exactly why the
  suite re-measures and re-asserts the bound on every run rather than
  treating it as a one-time finding. `docs/demos/phase-5.md`'s own e2e
  section observed a LARGER seating value (0.236 mm³, exceeding this
  ceiling) under the LIVE product UI's different, non-clinically-tuned
  parameters (a coarser fit pitch and the client's zirconia-profile
  defaults) — the SAME structural mechanism at a different magnitude, not
  a new defect, and NOT covered by this ADR's specific 0.1 mm³ number,
  which is scoped to the T7 golden's own fixture/parameter choice.
