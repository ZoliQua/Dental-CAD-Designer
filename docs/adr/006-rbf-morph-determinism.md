# ADR-006: RBF anatomy morph — direct dense solve, not an iterative fit

**Status:** Accepted

## Context

Phase 4 Task 6 needed a way to deform a placed library-tooth outer surface
onto real contact targets (proximal neighbours + antagonist) while keeping
the tooth sealed to the confirmed margin loop — a smooth, control-point
interpolating deformation field, the standard tool for which is a
radial-basis-function (RBF) morph. CLAUDE.md invariant 2 ("Determinism —
same inputs + params + kernel version ⇒ bit-identical outputs... no result
dependent on ... iteration count") rules out the usual way this is done in
general-purpose deformation libraries: an iterative fit (e.g. gradient
descent, or a conjugate-gradient/GMRES solve to a residual tolerance) whose
output depends on how many iterations happened to run before the tolerance
was met — a quantity that can legitimately vary with float rounding order,
starting guess, or solver-library version, none of which this codebase is
willing to let leak into a stored crown's mesh hash.

The morph also needs to run interactively: an initial `runMorph` (BVH
build + contact selection + full solve) followed by a `resolveMorph` on
every contact-strength slider drag, budgeted at < 500 ms (Phase 4 Task 6's
own brief). A method that has to reassemble and re-solve a fresh system on
every slider tick would blow that budget on anything but a tiny control set.

## Decision

1. **Kernel: φ(r) = r (the 3-D biharmonic RBF), not thin-plate/Gaussian/
   multiquadric.** This kernel has no shape parameter — the field is fully
   determined by the control points and their target displacements alone,
   so there is no ε (Gaussian/multiquadric's spread parameter) whose choice
   could silently change, or need re-tuning to reproduce, a result. Paired
   with a degree-1 polynomial term `P(x) = a0 + a1x + a2y + a3z` (the
   standard conditionally-positive-definite pairing for φ(r)=r, with side
   conditions Σwᵢ=0, Σwᵢcᵢ=0), which reproduces any affine displacement
   exactly with zero RBF weight — anchoring a broad region and displacing
   one contact yields a clean, localized bump rather than a global affine
   drift.

2. **A direct, dense solve — Gaussian elimination with partial pivoting,
   ties broken by lowest row index** (`packages/kernel/src/rbf/solve.ts`)
   — not an iterative one. The saddle-point (KKT) system
   `[[A, P],[Pᵀ, 0]]·[w; v] = [d; 0]` (symmetric but indefinite — the zero
   block rules out Cholesky) is factorized once and back-solved three times
   (x/y/z as a multiple-right-hand-side problem sharing one factorization).
   A direct factorization executes a FIXED arithmetic sequence for a given
   input size and pivot pattern — no convergence loop, no residual
   tolerance, no variable iteration count to depend on. The pivot choice
   itself is a pure function of the input values (largest `|A[r][k]|` in
   the column, first-row-index tie-break), so the whole solve — and hence
   the morphed mesh's content hash — is a pure function of the control
   points and displacements. Proven directly: a byte-equality test asserts
   identical Float64 output across repeated solves of the same system.

3. **Plan/solve split for the interactive budget**
   (`anatomy/morph.ts`'s `planAnatomyMorph` / `solveAnatomyMorph`). The
   expensive, strength-independent setup — BVH builds, contact-point
   selection, the fixed-iteration contact-target root-find, anchor-point
   selection (cervical seal band + far-field) — runs once and produces a
   `plan`. `solveAnatomyMorph(plan, strengths)` only scales each contact's
   target displacement by its slider strength, refits the RBF (cheap: the
   control-point SET and count are unchanged by a strength change, only
   the right-hand side `d` differs, so the factorization is re-usable in
   principle even though the current implementation re-factorizes — see
   Consequences), and re-measures. The `morphAnatomy` worker job caches the
   plan so `resolveMorph` re-solves at new strengths without rebuilding the
   BVH — measured 18.0 ms on the real arch-case-01 tooth, comfortably under
   the 500 ms budget (`.superpowers/sdd/p4-task-6-report.md`).

4. **A dense solver, not a sparse/iterative one, is the right trade at this
   problem size.** Control-point counts here are small (tens to a few
   hundred — 211 on the real case: 48 cervical + 160 far-field + 3
   contact), so an `O(N^3)` dense factorization costs low-single-digit
   milliseconds, and the determinism guarantee it buys (no tolerance, no
   preconditioner-dependent convergence) is worth far more than the
   asymptotic complexity a sparse iterative method would improve at this
   scale. This would need revisiting if a future control-point count grows
   into the thousands.

## Consequences

- **Positive:** the morph is bit-reproducible by construction, not by
  discipline — there is no tolerance or iteration-count knob that could
  regress determinism later. Journal replay of a `crown-morph` op needs no
  special-casing (re-running the deterministic kernel op reproduces the
  hash — same precedent as every other Phase 4 stage).
- **Positive:** because 0-strength controls carry a 0 displacement, and the
  RBF interpolates its controls exactly, an all-zero-strength morph
  short-circuits to the exact zero field, so a "no contacts selected"
  morph is provably a no-op (`morphed ≡ placed`, bit-identical) — a useful
  correctness property that falls out of the exact-interpolation kernel
  choice, not something coded separately.
- **Negative / accepted cost:** `resolveMorph`'s current implementation
  re-solves the full dense system on every strength change rather than
  reusing the factorization from `planAnatomyMorph` (the control-point SET
  doesn't change, only the right-hand side does, so in principle the LU
  factors could be cached and only the back-solve re-run) — left as
  straightforward future work if the 18 ms measured re-solve ever becomes
  a bottleneck; not addressed here since it is well inside budget today.
- **Negative / accepted honesty note:** determinism of the SOLVE says
  nothing about clinical accuracy of the RESULT on poor input. The real
  arch-case-01 tooth-11 case's coarse anatomy placement drives one contact
  (`proximalDistal`) into the root-find's travel clamp (a bounded, flagged
  `clampBound`/`contactClampWarning`, never an unbounded/silent failure —
  see `contactMaxExtraTravelMm`), and the resulting margin-seal deviation
  (1637 µm, `.superpowers/sdd/p4-task-6-report.md`) is reported, not
  masked. The solver is proven correct; the real-case numbers are an
  input-quality finding, not a determinism or solver defect — see
  `docs/demos/phase-4.md`'s open items.
