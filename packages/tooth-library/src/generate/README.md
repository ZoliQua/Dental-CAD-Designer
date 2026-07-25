# Procedural starter anatomy — provenance & licensing-risk note

PLAN.md §9 flags "no openly-licensed anatomical tooth library available"
as a licensing risk for Phase 4. This directory is the documented
mitigation: **every mesh this package ships is procedurally generated**,
not scanned, sculpted, or derived from any copyrighted/licensed atlas.

- **`incisor.ts`** — one generator shared by FDI 12/11/21/22 (the 4
  upper-incisor real-case fixture Phase 4 needs first). A stack of
  asymmetric elliptical rings (convex buccal, concave-with-cingulum
  lingual) from the cervical margin up to a single incisal-edge apex
  vertex. FDI-specific size differences (central vs lateral incisor) live
  entirely in `toothParams.ts`'s `INCISOR_FDI_PARAMS` table — the
  generator function itself never branches on FDI beyond that lookup.
- **`molar.ts`** — one generator for FDI 16 (upper right first molar, the
  "at least one posterior" requirement). A symmetric elliptical wall
  topped by a concentric-ring occlusal table shaped by 4 Gaussian cusp
  bumps + a central-fossa dip + 2 marginal-ridge bumps.
- Both generators are **pure and deterministic**: every shape parameter is
  a fixed number in `toothParams.ts`, every curve is `Math.cos`/`sin`/
  `exp`/`sqrt` of those numbers — **no `Math.random`, no clock/env
  dependence anywhere**. Calling `generateIncisorAsset(11)` twice produces
  byte-identical `Float64Array`s (see `incisor.test.ts`'s determinism
  test) — the same reproducibility bar the kernel's golden-file tests
  hold every other geometry algorithm to (CLAUDE.md invariant 2).

## This is a PLACEHOLDER, not real anatomy

`toothParams.ts`'s millimeter figures are rough, textbook-average adult
crown dimensions (the general shape/scale of "a central incisor is
roughly this wide and this tall") — good enough to be watertight and
anatomically legible for pipeline development (landmark positions that
mean the right thing, a lingual concavity that's actually concave, 4
cusps that are actually the local maxima of an occlusal table), **not**
clinically precise, patient-specific, or claimed to be. Every starter
asset's `provenance` metadata field says so explicitly, prefixed with
`PLACEHOLDER-ANATOMY:` (`schema.ts`'s `PLACEHOLDER_PROVENANCE_PREFIX`) —
any code path that surfaces asset provenance to a user (a future library
browser UI) should show this string verbatim, not hide it.

**Replacing a placeholder**: swap in a real anatomical library (an openly
licensed one, or technician-authored/scanned) by producing mesh bytes +
metadata satisfying `../README.md`'s format — nothing in the format or the
loader depends on how an asset's mesh was produced. Replacing one FDI's
asset doesn't require regenerating or touching any other.

## YAGNI: why only 5 FDI codes

Per this task's guardrails: not all 32 permanent teeth, just what Phase 4
needs immediately (the 4 upper-incisor real-case fixture) plus one
posterior for "later coverage" test/pipeline exercise. To add another
tooth:

- **Another incisor-shaped or (with new size params) canine-shaped
  tooth**: add an entry to `toothParams.ts`'s `INCISOR_FDI_PARAMS`/a new
  `INCISOR_FDI_CODES`-like table and register it in `assets.ts`. No new
  generator code.
- **Another molar or premolar (4-cusp-family) tooth**: same, via
  `MOLAR_FDI_PARAMS`/`MOLAR_FDI_CODES`. A premolar typically has 2 cusps,
  not 4 — that needs a small generalization of `molar.ts`'s
  `CUSP_ANGLES_RAD` (a 2-entry table instead of 4) rather than a wholesale
  rewrite.
- **A genuinely different crown topology** (unlikely for permanent
  teeth, all of which are cusp-and-ridge variations on incisor/molar
  families): a new generator file, following this directory's pattern —
  pure parametric function, `geometry/ringMesh.ts`'s shared ring/stitch/
  cap primitives, landmarks read back as exact constructed vertices (never
  found by post-hoc search), and a matching entry in `../README.md`'s
  landmark-name table.
