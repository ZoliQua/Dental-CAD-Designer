# Phase 13 — Verified contacts and fit headroom on the real crown (M13 "Honest contacts"): demo script + acceptance evidence

Phase 13 ([ADR-026](../adr/026-verified-contact-targets-and-ring-split-tolerance.md),
[plan](../plans/phase-13-verified-contacts-and-fit-headroom.md)) resolves
Phase 12 open items 1–3 ([phase-12.md](phase-12.md)):

- **Every contact target is verified or flagged** (kernel 0.41.0).
  - The morph's root-find finishes by projecting onto the level set, so a
    contact misses only with a flag.
  - A contact that only a capture's synthetic closure provides fails the
    gate as such.
- **The fit has headroom** (kernel 0.42.0). The ring is split to 25 µm,
  half the bound, so real tooth 11 fits at 23.8 µm (golden) and 24.9 µm
  (e2e), where it was 49.1 and 49.5.
- **The real crown's self-intersection is located and fixed** (kernel
  0.43.0). The shell's margin seam paired its rims by index. It now pairs
  them by azimuth.

## Scope, stated plainly

The tooth is still **unprepared**, so its wall and seating gates fail
whatever the template. The contact gate also fails on real tooth 11, now
for a stated reason in each placement:

- **Golden real lane:** the mesial contact's verified target lies only on
  the capture's synthetic closure. The crown's nearest approach to 21 is at
  the capture's cervical cut, 0.14 mm above it.
- **e2e:** the mesial contact reaches its target on 21's real surface. The
  distal contact has no verified target and is flagged unreached (120 µm).

Self-intersection now passes in both placements. No gate, bound or
tolerance was weakened. The new split tolerance lies under the unchanged
bound.

## The six phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | No contact misses silently | **Met** | Analytic: on a 90° edge entered at 20°, Newton alone stops > 0.1 µm off and the projection reaches 1e-9. A 30° wedge has no root on the fixed line: the old code drifted unflagged, the new code flags it. A contact vertex lying on the surface up to rounding: the old Newton never moved, the new code reaches s = −t. A property test over random boxes: accepted ⇒ \|s + t\| ≤ 1e-6 within the travel bound. Real tooth 11: flagged on synthetic surface (golden) and unreached (e2e distal) |
| 2 | Converged contacts are byte-identical | **Met, with two measured exceptions** | Proven at 0.40.0 with the new code: every pinned lane is identical except the P4 standin crown chain. Its contacts had not converged: 6.584 µm unflagged before, 0.000 µm now. The coupling diagnostic's mesial contact sat on the surface and stayed 20 µm off. Both are named in the changelog |
| 3 | The fit has headroom | **Met** | Real tooth 11: 23.8 µm (golden, ring 72 → 91) and 24.9 µm (e2e, 72 → 85), both ≤ 25 µm. The real trace with a 72-vertex template: 42.6 → 24.8 µm. The scallop: 44.9 → 20.4 µm |
| 4 | The self-intersection is located and resolved | **Met (a kernel defect, fixed)** | Each of the 20 pairs was classified by distance. Each was an intaglio triangle (0 µm from it) crossing a seam triangle (145–195 µm off the intaglio, 470–550 µm off the outer surface). The seam zipper paired the rims by index. The result was non-monotone in ring size (73: 0 pairs, 91: 20, 102: 0). Fixed by azimuth pairing: a property test bounds every seam triangle's azimuth span, and real tooth 11 has 0 pairs in the golden and the e2e |
| 5 | The real crown's gates report honestly | **Met** | Golden: wall, seating and contact fail (synthetic surface, asserted by message). e2e: wall, seating and contact fail (distal unreached, asserted through a new read-only test hook). Every failure is visible and acknowledgeable |
| 6 | Golden stability | **Met** | 0.41.0, 0.42.0 and 0.43.0 were each proven at the previous version with the new code. 0.42.0 moved no geometry pin. 0.41.0 moved the P4 standin chain. 0.43.0 moved every crown shell and the real bridge's assembled mesh, and nothing upstream of the shell. Every moved pin is named |

## Found during the phase

**The mesial contact's 65 µm was a root-find with no root.** The contact
vertex's closest point on 21's capture is a corner of the captured solid,
where the captured surface meets the closure wall. The wall runs along the
capture's approach direction, 21° off the root-find's fixed line. Along that
line the signed distance never reaches −20 µm. The four Newton steps drifted
to +45 µm, inside the clamp, so nothing was flagged.

**A level-set target can sit on synthetic geometry.** Projected onto the
−20 µm level set, the mesial target converged in one step, but beside the
closure wall: it was a contact with the window's cut. A contact counts only
when real surface provides its penetration. A target equidistant from a real
face and a synthetic one counts as real, so the test has no tie-break.

**A contact vertex on the neighbour surface never moved.** When the contact
vertex lies on the neighbour's surface, its closest-point direction is
1e-15 mm of rounding noise, here tangent to the face. Newton then cannot
move. Below 1 pm the projection uses the closest face's normal instead.

**The fit's headroom exposed a shell defect, it did not cause one.** The
seam zipper's index pairing skewed whenever a rim was sampled non-uniformly.
The e2e placement had already self-intersected in Phase 12 with an
unrefined ring, because a fitted ring's vertices sit at their own azimuths.

**The planned gate-message attribution was not built.** The shell passes
through manifold-3d's cleanup, which reorders triangles and quantizes
positions to Float32, so triangle ranges do not survive into the gated
mesh. The locus was attributed geometrically instead (ADR-026, "Found during
implementation").

## e2e (this phase)

| Spec | What changed | Result |
|---|---|---|
| `e2e/phase9-crown.spec.ts` | the fit is ≤ 25 µm and the split tolerance is journaled. Contacts: mesial on target on real surface, distal flagged unreached, no synthetic-surface warning. QC: contact, wall and seating fail. Self-intersection passes | 4 / 4 ✓ |

## Full local acceptance chain

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 375 files / 3974 passed, 26 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 70 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 (9.7 min) |
| `RUN_CROWN_REAL_DIE=1` golden real lanes | 6 passed: die certified; library incisor fitted at 23.8 µm; no self-intersection; QC verdict asserted |
| `npm run lint` | 0 errors (2 pre-existing warnings) — exit 0 |
| `npm run typecheck` / `npm run build` | clean — exit 0 / exit 0 |

## Open items & tracked pendings

1. **The contact location on real tooth 11.** The morph picks the globally
   nearest tooth vertex as the contact vertex. Here that is a cervical
   vertex, and the capture's cervical cut excludes 21 below it. A proximal
   contact height band (a profile-level rule, clinical) is the candidate
   fix. A wider capture window is the other lever.
2. **The e2e distal contact is unreached.** Its location and cause are
   measured (flagged), not yet analysed.
3. **The intermittent Vitest worker death** on the ubuntu-26.04 runner.
   Diagnostics are in place, and CI was green on the Phase 12 push.
4. Carried over: an incisor-shaped preparation fixture, a real
   prepared-tooth scan, a by-version tooth-library route, and the Phase 9
   items.

## Demo script — the library incisor on the real scan

1. Open real `arch-case-01` and put a crown on 11 (as `e2e/phase9-crown`
   does). Prepare the die and the intaglio, and capture 21 and 12.
2. **Auto-place.** The panel shows the fit readout: about 25 µm against the
   50 µm bound, with the ring vertices added.
3. **Morph.** Each contact is either on target or flagged. A contact on the
   capture's synthetic closure is named in the panel.
4. **Shell, QC.** Wall and seating fail on the unprepared tooth, and the
   contact gate fails for its stated reason. Self-intersection passes. Every
   failure is acknowledgeable.
