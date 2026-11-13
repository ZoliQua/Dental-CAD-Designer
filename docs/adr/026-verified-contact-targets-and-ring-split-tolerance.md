# ADR-026 — Verified contact targets on real neighbour surface; a ring split tolerance below the fit bound

**Status:** Proposed (2026-11-13)
**Date:** 2026-11
**Relates:** ADR-007 (morph–shell coupling), ADR-022 (case provenance; the
captured neighbour), ADR-025 (the adaptive cervical ring, which Decision 3
refines).

## Context

Phase 12 placed the fitted library incisor on real `arch-case-01` tooth 11.
Two of its findings are kernel defects, not properties of the unprepared
tooth (docs/demos/phase-12.md, open items 1–3).

**1. The contact-target root-find drifts without saying so.** The morph
moves each contact vertex to a target where the neighbour's signed distance
is `−targetPenetration`. The target comes from four Newton steps along one
fixed direction `n₀` (toward the contact vertex's closest neighbour point),
with travel clamped to a bound. On tooth 11 the mesial contact misses its
target by 65 µm and is **not** flagged. A probe of the root-find measured
why:

| step | travel (mm) | signed distance (mm) |
|---|---|---|
| 0 | 0 | +1.0591 |
| 1 | 1.0791 | +0.0069 |
| 2 | 1.1059 | +0.0160 |
| 3 | 1.1420 | +0.0284 |
| final | 1.1904 | +0.0450 (target −0.0200) |

- The closest neighbour point is a **corner** of the captured solid. The
  captured surface ends there, 0.14 mm above the capture's cervical cut, and
  the solid's synthetic closure wall starts. The wall runs along the
  capture's approach direction, about 21° off `n₀`.
- Along `n₀` the signed distance never reaches −0.02 mm: the ray grazes the
  corner and leaves the solid. The root-find has no root on its line.
- Each step stays inside the travel bound, so `clampBound` stays false. The
  gate fails on the residual, but it reports a contact that is "off target"
  instead of one that has no target.

**2. A target can sit on synthetic geometry.** The captured neighbour is a
closed solid. Its first `capturedTriangleCount` triangles are the scan,
copied verbatim. The rest is a synthetic closure (walls and a back cap) that
only makes the solid watertight. A prototype that projects onto the
`−targetPenetration` level set (Decision 1) converges in one step on tooth 11
(`s = −0.020000` mm). But the target's closest triangle is closure triangle
1503 of the mesial capture's 1449 captured triangles. That is a contact
against the window cut, not against tooth 21. Counting it as achieved would
turn a real failure into a false pass.

**3. The fit has 1 µm of headroom.** The real fit measured 49.1 µm (golden)
and 49.5 µm (e2e) against the 50 µm bound. ADR-025 splits ring edges whose
chord deviation exceeds the bound itself, so it stops as soon as the bound is
met. Measured on the real lane with a lower split threshold:

| split threshold | ring vertices | fit residual | self-intersection |
|---|---|---|---|
| 50 µm (the bound; ADR-025) | 72 → 73 | 49.1 µm | none |
| 25 µm (½ bound) | 72 → 91 | 23.8 µm | **20 face pairs** |
| 17.5 µm | 72 → 102 | 17.2 µm | none |

The self-intersection at 25 µm sits in the cervical band, 0.18–0.54 mm from
the margin. It deterministically reproduces open item 2, the e2e
self-intersection whose location was unknown. It is analysed in the Phase 13
plan (Task 3), not tuned around: no threshold is picked because it hides the
self-intersection.

## Decision

### 1. The contact target is verified, and the root-find finishes by projecting onto the level set

- The fixed-direction Newton steps stay exactly as they are. Their target is
  **accepted** only if `|s(T) + t| ≤ CONTACT_TARGET_TOLERANCE_MM` (1e-6 mm,
  a numerical tolerance of the method, not a clinical value).
- Otherwise the root-find takes `CONTACT_PROJECTION_STEPS` (8) fixed
  closest-point projection steps, starting from the Newton target:
  `x ← x − (s(x) + t)·g(x)`. Here `g(x) = sign(s)·(x − cp(x))/|x − cp(x)|`
  is the signed distance's gradient. When `x` lies exactly on the surface,
  the closest face's outward normal is used. For a distance function this
  step is exact within one closest-feature region, so the direction follows
  the surface around corners where a fixed line cannot.
- The projected target is accepted only if it meets the same tolerance
  **and** its travel from the contact vertex is within the existing bound
  (`max(0, g₀) + t + contactMaxExtraTravelMm`).
- If neither target is accepted, the contact is **unreached**:
  `clampBound = true`, and the Newton target is kept, exactly as today's
  clamped case. A target that misses is never reported as merely off target.
- Bit-identical wherever Newton already converges. Every pinned lane does,
  to ≤ 2e-12 mm.

### 2. A contact counts only on real neighbour surface

- `MorphContactInput.realTriangleCount?`: the neighbour's first N triangles
  are real surface, and the rest are synthetic. Absent means all are real,
  as for a full antagonist scan or a placeholder.
- An accepted target whose closest neighbour triangle has an index ≥ N is
  reported as `targetOnSyntheticSurface: true` on the contact result.
- The contact gate **fails closed** on it. The message says the contact
  falls on the capture's synthetic closure, so the capture window excludes
  the neighbour's surface there. A contact on synthetic geometry can never
  pass.
- The engine passes the capture's `capturedTriangleCount`. The flag is
  journaled with the morph op's contact results. The server's contact
  re-validation receives it like the other journaled contact inputs, so dual
  validation stays dual.

### 3. The ring is split to a tolerance below the bound

- `CERVICAL_RING_SPLIT_TOLERANCE_MM` = 0.025 mm (half the bound) is a new
  constant in `clinical-profiles`, next to `CERVICAL_FIT_MAX_RESIDUAL_MM`.
- `CervicalFitInput.ringSplitToleranceMm?` must lie in
  `(0, maxResidualMm]`. ADR-025's split test uses it in place of the bound.
  Absent, the bound is used, so ADR-025's behaviour is unchanged.
- It is journaled with the fit. The bound and its `fitOverBound` refusal are
  unchanged.
- The value is half the bound on principle: the headroom is
  as large as the bound's own margin. It is not chosen to dodge any gate. If
  the fitted crown then fails a gate, the verdict is measured and asserted.

## Consequences

- The real tooth 11's mesial contact is expected to fail **for its real
  reason**. The crown's nearest approach to 21 lies on the capture's
  cervical cut, so the gate names the synthetic closure instead of a 65 µm
  drift. Its clinical root is that the contact vertex is chosen as the
  globally nearest tooth vertex, here a cervical one. A proximal contact
  height band is a profile-level design rule and a candidate for the next
  phase.
- Kernel 0.41.0 (Decisions 1–2) and 0.42.0 (Decision 3). Each is proven at
  the previous version with no pinned lane moving except by design, and
  every moved pin is named in the changelog.
- `QcGateResult` is unchanged. The new failure is reported in the contact
  gate's message.
