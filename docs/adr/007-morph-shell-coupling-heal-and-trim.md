# ADR-007: morph→shell coupling — SDF-remesh heal + robust plane-clip trim

**Status:** Accepted

## Context

The crown shell stage (`constructShell`, Phase 4 Task 7) stitches a
morphed OUTER anatomy mesh to the intaglio (inner surface) at the
confirmed margin, producing the crown's final watertight solid. Task 12's
acceptance harness found that a CLEAN, well-formed RBF-morphed tooth
(watertight, no clamp, ~69 µm margin seal, 20 µm contact residual —
genuinely good input by every existing measure) was REJECTED by
`constructShell` (`NonManifoldInputError`), while the byte-identical
UN-morphed tooth built successfully. This meant the real arch-case-01
tooth-11 shell failure could not be attributed to scan quality alone —
there was a second, independent robustness gap in the morph→shell SEAM
itself, affecting even clean input.

Task 12b root-caused it: the dominant cause was not RBF self-intersection
(the originally-suspected explanation) but the closed-outer TRIM step.
`constructShell`'s original `trimClosedOuterToMargin` discarded triangles
by which side of the finish-line PLANE their centroid fell on, assuming a
clean, single cervical ring sits exactly there. A real (or realistically
morphed) outer's cervical surface does not sit exactly on that plane — RBF
displacement makes non-anchor cervical vertices wiggle sub-margin — so the
plane cut fragmented into ~18 tiny boundary loops instead of one clean
ring, and manifold-3d's stitch correctly rejected the resulting
non-manifold boundary. Confirmed empirically: cutting exactly at the
margin plane produced 18 loops; cutting a hair above it produced exactly
one clean loop that stitches.

## Decision

Two independent, composable fixes, both chosen for **accuracy over speed**
(CLAUDE.md's overriding rule) — a slower, provably-clean remesh/reclip
over a faster lossy repair:

1. **Robust plane-CLIP trim, not a centroid-discard trim**
   (`packages/kernel/src/shell/shell.ts`). Replace "keep/discard whole
   triangles by centroid side" with a proper Sutherland–Hodgman polygon
   clip: triangles straddling the cut plane are SPLIT, with the two new
   split vertices keyed by sorted-vertex-index pairs so a triangle sharing
   an edge with its neighbour produces the IDENTICAL split point (never a
   T-junction) — a genuine 2-manifold cut. The cut plane sits a small,
   documented offset (`marginTrimOffsetMm`, default 0.05 mm) OCCLUSAL to
   the finish line — landing on the clean, non-wiggling axial wall above
   any cervical noise, so the cut always closes to exactly one loop. Only
   the OUTER is cut, above the finish line; the intaglio is stitched to
   its EXACT margin rim unchanged, so margin-fit stays 0.000 µm.
   `@errorBound`: the outer within `marginTrimOffsetMm` of the finish line
   is replaced by a ruled seam band (a ≤ 50 µm marginal collar) bridging
   the trimmed rim down to the exact margin — always above the finish
   line and outward of the fit surface, never perturbing the intaglio.

2. **`healOuterAnatomy` — an SDF re-mesh at the zero level set, NEW op**
   (`packages/kernel/src/shell/healOuterAnatomy.ts`, reuses the existing
   `offsetMesh(mesh, 0, {pitchMm})` marching-cubes offset pipeline). A
   marching-cubes iso-surface is a clean, oriented, watertight 2-manifold
   BY CONSTRUCTION — it cannot carry the RBF morph's folds, self-
   intersections, or degenerate slivers, because it is not the morph's
   triangle soup at all, but a fresh isosurface extraction of the morph's
   IMPLIED solid. This heals a morphed outer "for free" as a side effect
   of re-deriving it from a distance field, rather than attempting to
   detect-and-repair the morph mesh's specific defects directly (which
   would need its own defect taxonomy and would not obviously generalize).
   Heals ONLY the outer; the intaglio is a wholly separate mesh, never
   passed in, so it cannot be touched. `@errorBound = pitchMm/2 + eps_f32`
   (inherited directly from `offsetMesh` at distance 0) — every point of
   the healed outer, including the occlusal/proximal contact loci the
   morph solved for, is within this bound of the morph's own surface, so
   the morph's achieved contacts shift by at most this bound. Surfaced in
   the shell op's journaled params (`healOuterErrorBoundMm`) and in QC
   documentation (`docs/demos/phase-4.md`'s "contact number is PRE-heal"
   disclosure) rather than silently absorbed.

Both fixes are deterministic (the offset pipeline and the plane-clip are
both pure functions of their mesh inputs — no iteration-count or tolerance
loop), and the heal is folded into the pipeline shell stage's single
journaled `shell.construct` op (`options.healOuterPitchMm`), so it
participates in journal replay like any other stage, not as a hidden
side-channel.

### Honest limit (not swept under the rug)

The heal rescues CLEAN or MILDLY-degraded morphs, not arbitrarily-degraded
ones. An extreme through-and-out fold can defeat marching cubes itself
(the offset pipeline throws `NonManifoldInputError` on genuinely
pathological input, same as before). The real arch-case-01 tooth-11
morph — driven by a gingiva-obscured margin into a coarse anatomy
placement and a torn (clamped, ~2.5 mm) distal contact — is exactly this
case: running the FULL coupled heal+trim pipeline against it still
BLOCKS at the shell stage. This is the phase's key finding: the real
case's block is now correctly attributable to SCAN QUALITY (an
arbitrarily-degraded fold beyond what any repair step can rescue), not to
a coupling-robustness gap — the coupling gap this ADR closes is a
DIFFERENT, now-eliminated failure mode. See `docs/demos/phase-4.md`'s
open items for the full real-case disclosure.

## Consequences

- **Positive:** "First crown" (a clean, coupled morph → heal → shell
  lineage building a genuinely watertight crown with a real morphed
  outer, not a synthetic dome standing in for one) is now proven, not
  just designed for — `test/golden/morph-shell-coupling.test.ts`'s
  flipped diagnostic and `test/golden/crown-acceptance.test.ts`'s
  genuinely-coupled standin both demonstrate it, with full journal
  reproducibility including the heal.
- **Positive:** the real tooth-11's tracked-pending status is now
  precisely characterized (input quality only), which is directly useful
  to whoever picks up the retraction-cord/cleanly-segmented-scan work
  next — they are not chasing a coupling bug that no longer exists.
- **Negative / accepted cost:** the heal adds a full marching-cubes
  offset pass (SDF grid build + isosurface extraction) to every shell
  construction that opts into it — measurably heavier than the original
  trim-only path (the coupled standin's shell mesh grew from ~7k to
  ~41k triangles in the diagnostic case, since a fine `pitchMm` marching-
  cubes surface is denser than the RBF-morphed source). Acceptable for
  the crown-design workflow's per-stage worker budget (measured well
  under the workflow's UI-responsiveness needs); would need revisiting if
  a much finer `pitchMm` were ever required for margin-detail fidelity at
  this stage (the crown OUTER, not the intaglio — the intaglio's own
  20 µm clinical pitch default is untouched by this decision).
- **Negative / accepted honesty note:** the heal's `@errorBound` means the
  QC contact gate's reported residual (measured on the pre-heal morph
  output) is not exactly the final post-heal geometry's residual — it
  under-states the true post-heal residual by up to the heal's error
  bound. Both numbers are journaled/surfaced (never only the favorable
  one) — see `docs/demos/phase-4.md`'s "contact number is pre-heal"
  disclosure for the exact numbers and why the true bound is still well
  inside the QC gate's tolerance.
