# ADR-014: an un-missable, repeated, mismatch-aware disclosure banner for a demo-fixture-backed UI panel

**Status:** Accepted

## Context

Phase 6's client has no real multi-abutment bridge-geometry capture
pipeline yet — the abutment fit surfaces and pontic base are kernel-built
artifacts whose real inputs (a prep BVH; an edentulous-ridge scan + library
body) are not reconstructable in the browser. `ui/BridgeDesignPanel.tsx`
therefore runs EVERY bridge session on a single fixed synthetic
demonstration fixture (`buildBridgeFixture()`, teeth 14-15-16), regardless
of which case or which teeth the dentist actually selected — the same
"external kernel-built artifact captured, never ported" pattern the cavity
`outline` stage already uses, but here backing the ENTIRE workflow rather
than one stage.

Task 7's initial version shipped this with ZERO on-screen disclosure — the
panel silently substituted the fixed fixture's geometry for whatever case
was open. In a medical-adjacent product this is not a cosmetic gap: a
dentist could read a per-case-looking QC pass/fail table, margin-fit
readout, or connector area as a genuine measurement of THEIR case, when it
is illustrative output for an unrelated demonstration geometry. Review
correctly flagged this CRITICAL before merge.

## Decision

A three-part disclosure pattern, all present simultaneously, not a single
banner treated as sufficient on its own:

1. **Un-missable, on every stage.** A `role="alert"`
   `data-testid="bridge-synthetic-notice"` banner renders above EVERY stage
   of the active workflow (not just an initial toast that could be dismissed
   or scrolled past) — visible for the entire session, every time.
2. **Repeated at the highest-stakes moment.** The SAME disclosure repeats
   inside the QC RESULTS specifically (`bridge-qc-synthetic-note`,
   independently `role="alert"`) — the exact place a dentist is most likely
   to be scanning for a pass/fail verdict and least likely to be re-reading
   banner text from three stages earlier. A picker-view note
   (`bridge-synthetic-start-note`) additionally discloses BEFORE start is
   even clicked.
3. **Mismatch-aware, not just present.** When the selected case's actual
   teeth differ from the fixture's (14-15-16), the banner surfaces the
   MISMATCH explicitly and concretely (e.g. "Selected case: 24-25-26 ·
   demonstration fixture: 14-15-16 — these do NOT match"),
   `data-testid="bridge-synthetic-mismatch"` — not merely a generic "this is
   a demo" notice that leaves the dentist to notice the tooth numbers don't
   line up themselves.

**Explicit guard decision, documented in the panel's own top doc:** the
panel ALLOWS starting a session on a mismatch, with the loud disclosure,
rather than refusing outright. The alternative (block start on any
mismatch) would make the panel unusable for the only geometry that
currently exists, for every real case — refusing is not actually safer if
the practical effect is "the feature cannot be used at all, so nobody
benefits from the disclosure discipline." The always-on banner plus the
explicit mismatch line are judged to make it "impossible to mistake the
demo for clinical results" without disabling the phase's only working
demonstration path.

The e2e phase-gate spec (`e2e/phase6.spec.ts`, this task) exists partly to
PROVE this disclosure actually ships through the real product UI — not just
a component test — asserting the banner's presence, `role="alert"`, and key
phrases, both on first render and again after a save/reload round trip, and
the QC-results repeat.

## Consequences

- **Positive: closes a genuine patient-safety-adjacent gap** — a fabricated
  demonstration readout can no longer plausibly be mistaken for a per-case
  result, at any point in the workflow a dentist might be looking.
- **Positive: a reusable go-forward pattern for the NEXT demo-fixture-backed
  panel.** Any future feature that must ship ahead of its real data pipeline
  (a common phase-boundary situation in this codebase — Phase 6's own pontic
  crest descriptor and connector auto-placement axis carry similar
  provenance notes) has a concrete, three-part template to follow: present
  everywhere the feature is used, repeated at the verdict, and specific
  about what does not match, rather than inventing a bespoke disclosure
  each time.
- **Positive: falsifiable in the same spirit as ADR-010's QC
  acknowledgments.** The teeth-mismatch line is not a static string — it is
  computed from the actual selected case vs. the actual fixture constant, so
  a future change to either would cause the assertion to genuinely fail
  rather than silently pass on stale copy.
- **Negative / accepted cost:** the banner is unavoidably repetitive across
  a single session (three render sites) — a deliberate trade of a small
  amount of visual noise against the much larger risk of a dentist landing
  on the QC table (the highest-stakes screen) having scrolled past or never
  seen the initial disclosure.
- **Negative / honest limit:** this pattern discloses that the CURRENT
  session's readouts are synthetic; it does not, by itself, prevent a
  screenshot or exported artifact taken from this panel from being
  misread later, out of context, by someone who never saw the live banner.
  Export-time provenance stamping (carrying a "synthetic demonstration
  fixture" marker into any saved/exported artifact derived from this panel)
  is not implemented and is a natural extension once real bridge capture
  exists to contrast it against.
