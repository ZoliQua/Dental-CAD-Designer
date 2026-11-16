# Phase 14 — Crown height from the neighbours; the contact in its clinical band (M14 "In the arch"): demo script + acceptance evidence

Phase 14 ([ADR-027](../adr/027-crown-height-from-the-neighbours-occlusal-level.md),
[plan](../plans/phase-14-crown-height-from-the-neighbours.md)) started from
Phase 13 open item 1 ([phase-13.md](phase-13.md)): the contact location on
real tooth 11. Measurement showed the cause was upstream of the contact.
Without an antagonist, the placed crown had no height datum and stood about
twice as tall as its neighbours.

- **The crown stands in the arch** (kernel 0.44.0).
  - With no antagonist and both neighbours captured, the crown's top is
    placed at the neighbours' occlusal level, interpolated at the site.
  - It is lifted until it covers the intaglio with the occlusal minimum
    wall along the axis. The lift is reported as insufficient occlusal
    reduction.
- **The proximal contact lies in its clinical band** (kernel 0.45.0): the
  incisal third for anterior teeth, the occlusal and middle thirds'
  junction for posterior teeth. The band applies whenever a datum set the
  height.

## Scope, stated plainly

The real tooth is still **unprepared**. Covering it lifts the crown 4.40 mm
above its neighbours, and the wall and seating gates fail whatever the
template. The contact gate now **passes** on the real crown (golden): both
contacts are verified on 21's and 12's real surface. No gate, bound or
tolerance was weakened.

## Measured: why the contact was cervical (real tooth 11, kernel 0.43.0)

| quantity | value |
|---|---|
| natural tooth 11 on the scan (unprepared): incisal edge above its margin | 5.64 mm |
| teeth 21 / 12 on the scan: highest point above their own margin | 5.70 / 5.62 mm |
| the placed library incisor's top above the margin | **11.68 mm** |
| distance from that top to the nearest scan surface | 6.05 mm |
| the captured neighbours' real surface, as a fraction of the crown's height | 0.00–0.29 (21), 0.00–0.47 (12) |

A contact band alone could not have fixed it. In the incisal third of that
crown, 21 was 2–5 mm away.

## The six phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | The crown stands in the arch | **Met** | Analytic: box neighbours with known peaks put the top at the closed-form level (1e-12), with the clamp outside the peaks. A pyramid library shows the floor covers an off-apex intaglio point (top 7.0, where an apex-only floor gives 3.5). A property test: top = max(level, floor), shortfall = max(0, floor − level). Consistent open-arch lane: top at the level (7.48 mm, floor 6.33 mm, no lift). Real tooth 11: level 4.54 mm, crown top 8.93 mm (11.68 mm before) |
| 2 | A too-tall preparation is named | **Met** | Journaled `occlusoGingivalDatum.occlusalReductionShortfallMm` and the panel warning `crown-anatomy-occlusal-shortfall`. Real tooth 11: 4.40 mm. Open-arch fixture: built-in 1.07, premolar 4.48, incisor 7.13 mm. No lane self-intersects |
| 3 | A truncated or missing datum falls back with its reason | **Met** | Kernel tests (`neighbourPeakTruncated`, `levelNotAbove`). The engine adds `neighbourNotCaptured` and `antagonistNotOverSite`. e2e `phase9-crown`: a neighbour peak within its capture ball's border band falls back to `neighbourPeakTruncated`, shown in the panel |
| 4 | The proximal contact lies in its band | **Met** | Analytic: on a cylinder beside an equidistant face, the band moves the contact from z = 0.5 to 3.0. Band [0, 1] is bit-identical. An empty band throws, and a property test keeps the vertex in the band. Real tooth 11: both contacts in [0.60, 0.95], verified on real surface (0.0 µm) |
| 5 | The real crown's gates report honestly | **Met** | Golden real lane: wall and seating fail (the unprepared tooth), contact passes. e2e: the datum falls back (truncated peak), so no band applies, and the Phase 13 verdict holds (wall, seating, contact with distal unreached). Every failure is visible and acknowledgeable |
| 6 | Golden stability | **Met** | 0.44.0 was proven at 0.43.0 with the new code: only the open-arch lanes moved (placement, morph, final mesh). 0.45.0 was proven at 0.44.0: only the open-arch lanes' morph and final mesh moved. Every other pin advanced by its version string only |

## Found during the phase

**An apex-only floor is not enough.** Lifting the crown's top to the
intaglio's top plus the minimum wall let the die pierce the premolar's
central fossa and the incisor's incisal third (687 and 1159
self-intersecting pairs). The floor must cover every intaglio point along
the axis. The O-G scale is linear, so one downward ray per intaglio point
gives the exact minimum.

**The synthetic fixture's die is taller than its neighbours.** The open-arch
die stands 5.5 mm above its margin, the neighbours 4.98 mm. Until 0.43.0 the
premolar lane passed every gate with its crown 10 mm above them. It now
reports a 4.48 mm lift, and its occlusal wall fails by about 10 µm on one
slope: the floor holds along the axis, not normal to the surface. The
fixture is kept. A consistent lane (3.5 mm prep, 9.0 mm neighbours) was
added beside it, and every gate passes there.

**A contact band needs an anchored height.** In the e2e placement the
neighbour datum falls back, and the crown keeps its uniform, too-tall
height. There the band put the mesial contact vertex millimetres from 21,
and the morph's bulge self-intersected. So the band applies only when a
datum set the height.

## e2e (this phase)

| Spec | What changed | Result |
|---|---|---|
| `e2e/phase9-crown.spec.ts` | The height datum falls back as `neighbourPeakTruncated`, shown in the panel, with no shortfall warning. No contact band is journaled. QC: contact, wall and seating fail, as in Phase 13 | 4 / 4 ✓ |
| `e2e/phase10.spec.ts` | It now uses the golden's consistent arch (3.5 mm prep, 9.0 mm neighbours). On the default fixture the premolar's occlusal wall now fails by about 10 µm (asserted in the golden). Every gate passes, and the export is released | 6 / 6 ✓ |

## Full local acceptance chain

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 377 files / 4002 passed, 26 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 70 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 (9.0 min) |
| `RUN_CROWN_REAL_DIE=1` golden real lanes (`crown-open-arch-acceptance`) | 7 passed: the four synthetic lanes, the open-scan check and the two real lanes (die certified; library incisor fitted at 23.8 µm, height datum 4.54 → 8.93 mm, contacts on real surface, QC verdict asserted) |
| `npm run lint` | 0 errors (2 pre-existing warnings) — exit 0 |
| `npm run typecheck` / `npm run build` | clean — exit 0 / exit 0 |

## Open items & tracked pendings

1. **The e2e neighbour peak is truncated.** In the e2e placement one
   neighbour's highest captured point lies within its capture ball's border
   band. A capture window anchored on the neighbour's top (a pick there, or
   a taller ball) would let the datum apply. That is a capture-window
   change, deliberately not made here.
2. **How far may a contact be morphed?** Nothing limits the gap the morph
   closes. A contact several millimetres away should be flagged, not
   bulged. A clinical maximum contact travel is the candidate.
3. **The floor is axial, not normal.** On a slope the normal wall under the
   floor is thinner than the minimum (the open-arch premolar: 489 µm). An
   autothicken pass after the placement is the existing lever.
4. **Bridges keep the uniform height.** Pontic placement does not use the
   neighbour datum yet.
5. Carried over: an incisor-shaped preparation fixture, a real
   prepared-tooth scan, the intermittent Vitest worker death on CI, a
   by-version tooth-library route, and the Phase 9 items.

## Demo script — the library incisor on the real scan

1. Open real `arch-case-01` and put a crown on 11. Prepare the die and the
   intaglio, and capture 21 and 12.
2. **Auto-place.**
   - With both neighbours' peaks inside their capture windows, the panel
     shows "Height datum: the neighbours' occlusal level". It also warns of
     insufficient occlusal reduction: about 4.4 mm on this unprepared tooth.
   - With a peak at a window border, it shows why the library proportions
     were kept.
3. **Morph.** With a datum, each proximal contact lies in the incisal third
   and lands on the neighbour's real surface.
4. **Shell, QC.** Wall and seating fail on the unprepared tooth. The contact
   gate passes when the datum applied. Every failure is acknowledgeable.
