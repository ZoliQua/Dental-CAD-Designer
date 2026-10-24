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
- **`molar.ts`** — the first and second molars of every quadrant
  (16/17/26/27/36/37/46/47; Phase 9 Task 4 added all but 16). A symmetric
  elliptical wall topped by a concentric-ring occlusal table shaped by 4
  Gaussian cusp bumps + a central-fossa dip + 2 marginal-ridge bumps (the
  lower molars' fifth cusp is not modelled — placeholder anatomy).
- **`premolar.ts`** (Phase 9 Task 4) — every premolar
  (14/15/24/25/34/35/44/45): the same posterior table (`posterior.ts`,
  extracted from `molar.ts` with FDI 16 kept byte-identical) with two
  cusps, buccal at full height and lingual scaled per tooth.
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

## Coverage: 20 FDI codes (YAGNI beyond that)

Phase 4 shipped the 4 upper incisors (the real-case fixture) plus FDI 16.
Phase 9 Task 4 added every premolar and the first + second molars of every
quadrant, so a posterior bridge pontic and a posterior crown both have a
library asset. Canines, lower incisors and third molars are still absent
(the client falls back to its labelled parametric placeholder for them).
To add another tooth:

- **Another incisor-shaped or (with new size params) canine-shaped
  tooth**: add an entry to `toothParams.ts`'s `INCISOR_FDI_PARAMS`/a new
  `INCISOR_FDI_CODES`-like table and register it in `assets.ts`. No new
  generator code.
- **Another molar or premolar**: an entry in `MOLAR_FDI_PARAMS` /
  `PREMOLAR_FDI_PARAMS` (the generators read their FDI lists from those
  tables). A different cusp set is a `PosteriorCusp[]` for
  `posterior.ts`'s `buildPosteriorCrown`.
- **A genuinely different crown topology** (unlikely for permanent
  teeth, all of which are cusp-and-ridge variations on incisor/molar
  families): a new generator file, following this directory's pattern —
  pure parametric function, `geometry/ringMesh.ts`'s shared ring/stitch/
  cap primitives, landmarks read back as exact constructed vertices (never
  found by post-hoc search), and a matching entry in `../README.md`'s
  landmark-name table.
