# Phase 12 — The library template fitted on a real margin (M12 "Fitted for real"): demo script + acceptance evidence

Phase 12 ([ADR-025](../adr/025-continuous-outline-height-and-adaptive-cervical-ring.md),
[plan](../plans/phase-12-continuous-outline-and-adaptive-ring.md)) resolves
Phase 11 open items 1, 4 and 6 ([phase-11.md](phase-11.md)):

- **The emergence outline's height is continuous** (kernel 0.39.0). It is
  the margin's height at the same azimuth, so it no longer steps in filled
  concavities. At every margin point's azimuth it is that point's own height.
- **The cervical fit refines the template's ring where it must** (kernel
  0.40.0). It splits ring edges whose chords cannot follow the outline within
  the bound, at the template edge midpoint, so the template's shape is
  unchanged. A fit that already met the bound is byte-identical.
- **The fitted library incisor is placed on the real scan.** On real
  `arch-case-01` tooth 11 the library incisor 1.3.0 now fits within 50 µm.
  Before Phase 11 the fit refused the margin; in Phase 11 it was over the
  bound.
- **The `phase3` drag flake, root-caused** from a CI trace: a 30 s test
  budget on software WebGL. A second, unrelated property-test flake was
  replaced by a provable bound.

## Scope, stated plainly

The tooth is **unprepared**, so its wall and seating gates fail whatever the
template. With the fitted library incisor two more gates fail, and both are
measured:

- **The mesial contact**, 65 µm off target. The miss belongs to the morph's
  target root-find on the rough captured patch of 21.
- **Self-intersection**, in the e2e's placement only. Its location is open
  (open item 2).

Both fits sit **within about 1 µm of the bound**: 49.1 µm in the golden and
49.5 µm in the e2e. A small change in placement can flip either one to
`fitOverBound`. The tests assert the measured values. No gate or bound was
weakened.

## The five phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | The fit is within the bound on a real margin: on real tooth 11 the fitted library incisor 1.3.0 is placed with residual ≤ 50 µm | **Met (narrowly)** | Golden real lane (`RUN_CROWN_REAL_DIE=1`, engine): `library` 1.3.0, residual **49.1 µm**, ring 72 → 73 (one split), moved ≤ 1.41 mm. e2e `phase9-crown`: `library`, **49.5 µm**, ring unrefined. Kernel test on the trace with a 72-vertex template: 75.5 → 42.6 µm (72 → 77) |
| 2 | The outline height is continuous and equals each margin point's own height at its azimuth | **Met** | Own heights to 1e-12 (tilted notch, scalloped ellipse); 720 azimuths against an independent crossing; the notch bisector continuous (a 78 µm step under ADR-024); a property test (bounds, continuity at 1e-9 rad) |
| 3 | Refinement never changes a fit that already met the bound | **Met** | A smooth margin refines nothing (byte-identical to the fit without a bound). Golden proofs at 0.38.0 and 0.39.0 with the new code: **no pin moved**, including the open-arch library and incisor lanes and the Phase 4 shoulder lanes |
| 4 | The real crown's later gates report honestly | **Met (honest verdict)** | Golden: wall (562 µm axial), seating and contact fail. e2e: the same plus self-intersection. Every failure is visible and acknowledgeable, and nothing is stood in |
| 5 | Golden stability: pins move only under 0.39.0 and 0.40.0, each proven | **Met** | Both bumps were proven at the previous version with no pin moving. At each bump only the five `*-qc` pins and the server traceability golden moved, by their version string |

## Found during the phase

**Most of the real-margin residual was the outline's height, not the ring.**
A probe on tooth 11 (72-vertex ring at uniform azimuths) measured 117 µm with
the nearest-point height and 73 µm with the radial height. With the adaptive
ring, the engine's fit lands at 49 µm.

**The mesial contact on the real tooth misses by 65 µm.** The morph moves
the contact vertex exactly to its target, because the RBF interpolates its
controls. So the miss belongs to the target root-find, which takes a fixed
number of steps along a fixed direction on the rough captured patch of 21.
With the built-in template the root-find converged at a different contact
vertex. The distal contact converges (0.0 µm).

**The `phase3` drag flake: a test budget, measured.** In the trace of CI run
42550791378 (ubuntu-26.04, where the flake now reproduced on both attempts),
every input event on the full-arch canvas waits about 1–1.4 s for its frame,
because WebGL is software-rendered on the runner. Ten wheel steps took 13 s,
the 8-step move 6.7 s, and the default 30 s timeout expired during mouse-up.
The drag never missed. The test now has an explicit 120 s budget (it takes
about 16 s locally), and the next CI run passed it.

**A property-test bound that was never a bound.** The ridge-crest test
asserted max residual ≤ 3a. CI found a random input over it by 2.5·10⁻¹⁶,
because a least-squares fit does not bound the max residual by a multiple of
the noise. It now asserts the triangle-inequality bound at every vertex, and
the counterexample is kept.

**The CI's GitHub runner image moved from ubuntu-24.04 to ubuntu-26.04**
between the last green Phase 10 run and the Phase 11 push. The first Phase
11 CI runs then failed with a Vitest worker dying mid-run
(`ERR_IPC_CHANNEL_CLOSED`) in the unit step. Probe branches showed:

| code | unit command | result |
|---|---|---|
| Phase 10 (`cc35232`) | `npm test` | ✓ |
| Phase 10 | `--project '!golden'` | ✓ (9:24) |
| Phase 11 Tasks 1–3 | `npm test` | ✓ ✓ |
| Phase 11 Tasks 1–3 | `--project '!golden'` | ✗ (the ridge-crest flake, no crash) |
| Phase 11 HEAD | `--project '!golden'` | ✗ crash ✗ crash |
| Phase 12 + diagnostics | `--project '!golden'` | ✓ ✓ (run 42938869591, both attempts) |

No commit deterministically causes the crash. The unit step now samples the
runner's memory (vmstat) and prints the kernel's OOM-killer lines when it
fails, so the next occurrence names its cause (open item 4).

## e2e (this phase)

| Spec | What changed | Result |
|---|---|---|
| `e2e/phase9-crown.spec.ts` | the fitted library incisor is placed (fit readout visible); QC asserts the measured failing set: contact, wall, seating, self-intersection | 4 / 4 ✓ |
| `e2e/phase3.spec.ts` | the drag has an explicit, measured 120 s budget | 10 / 10 ✓ (and green in CI) |

## Full local acceptance chain

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 373 files / 3949 passed, 26 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 70 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 (13.4 min) |
| `RUN_CROWN_REAL_DIE=1` golden real lanes | 2 passed — die certified; library incisor fitted at 49.1 µm; QC verdict asserted |
| `npm run lint` | 0 errors (2 pre-existing warnings) — exit 0 |
| `npm run typecheck` / `npm run build` | clean — exit 0 / exit 0 |

CI (run 42938869591, the Phase 12 code with the diagnostics, two attempts):
green both times. With the golden suite running once (Phase 11 Task 5) the
unit step takes 7:30 and 5:38 (it was 14:01 in the last Phase 10 run), the
golden step 7:35 and 5:28 (it was 7:00), and the whole job 35:04 and 25:00
(it was 41:22).

## Open items & tracked pendings

1. **The fit sits about 1 µm under the bound on the real tooth.** It is
   honest, but fragile. A margin trace or a placement a hair different
   gives `fitOverBound`. The next lever is a ring split threshold below the
   bound, for example half of it, which would leave headroom without
   weakening the bound.
2. **Self-intersection in the e2e's placement** of the fitted incisor on
   the unprepared tooth (the ring moved up to 1.74 mm). The golden's
   placement (1.41 mm) does not self-intersect. Its location needs a test
   hook that exposes the gate's report.
3. **The morph's contact root-find on rough captured patches.** It takes a
   fixed number of steps along a fixed direction and missed the mesial
   contact by 65 µm here.
4. **The intermittent Vitest worker death** on the ubuntu-26.04 runner. The
   diagnostics are in place.
5. Carried over: an incisor-shaped preparation fixture, a real
   prepared-tooth scan, a by-version tooth-library route, and the Phase 9
   items (a real bridge scan, inlay/onlay scans, segmentation, …).

## Demo script — the library incisor on the real scan

1. Open real `arch-case-01` and put a crown on 11 (as `e2e/phase9-crown`
   does). Confirm the margin and the suggested axis. Prepare the die and
   the intaglio, and capture 21 and 12 from the scan.
2. **Auto-place.** The panel names the library incisor (FDI 11, asset
   1.3.0) and shows the fit readout: the residual under the 50 µm bound, the
   emergence offset, and the ring size with any vertices added.
3. Morph, shell, QC. The tooth is unprepared, so the wall and seating gates
   fail. The contact (and in this placement self-intersection) fail too,
   each visible and acknowledgeable.
