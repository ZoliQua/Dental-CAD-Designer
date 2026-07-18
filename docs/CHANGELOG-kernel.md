# Kernel Changelog

## Policy

`packages/kernel/src/index.ts`'s `KERNEL_VERSION` and every golden-fixture
file under `test-fixtures/{intake,curvature,offset,golden}/` together form
one reproducibility contract (PLAN.md §6: "Deterministic, versioned
operations... Journal reproducibility"; CLAUDE.md: "Golden hashes change
ONLY with a deliberate kernel version bump + changelog entry explaining the
numerical difference. A 'small numeric diff' in golden files is a red
flag — investigate, don't regenerate").

**The rule:**

1. A golden fixture's committed hash may change **only** in the same commit
   that bumps `KERNEL_VERSION`.
2. That commit **must** add an entry below explaining, in terms a reviewer
   can independently judge, *why* the kernel's numerical output changed
   (a bug fix, a new/adjusted algorithm, a precision improvement, ...) —
   not just "regenerated goldens".
3. This policy is machine-enforced by TWO layers, not one — each catches a
   failure mode the other cannot:
   - **Test layer** — `test/golden/kernel-ops.test.ts` (backed by
     `test/golden/goldenEnforcement.ts`'s pure rule + its own
     synthetic-input unit tests) fails the build automatically if a golden
     hash differs from the committed file while `KERNEL_VERSION` is
     unchanged. This catches "kernel behavior changed, developer forgot to
     regenerate the golden file". It does **not** catch a golden file that
     WAS regenerated and committed — a regenerated file always matches
     itself, regardless of whether `KERNEL_VERSION` was bumped or this
     changelog was updated.
   - **CI base-ref gate** — `scripts/check-golden-version-gate.ts`, run as
     its own step in `.github/workflows/ci.yml` (`fetch-depth: 0`, diffs the
     push/PR against a base ref — see that script's module doc for the
     exact push-vs-pull_request ref logic). This is the layer that closes
     the test layer's gap: it fails the build if ANY golden-pinned file
     changed in the diffed range without **both** a `KERNEL_VERSION` bump
     **and** a new changelog entry mentioning the new version — i.e. it
     catches "golden file regenerated (and self-consistent) but the bump +
     changelog discipline was skipped". It applies uniformly to
     `test-fixtures/golden/kernel-ops.json` AND, per the same enumeration in
     that script (`GOLDEN_PATH_PATTERNS`), `test-fixtures/intake/*.golden.json`,
     `test-fixtures/curvature/*.golden.json`, and
     `test-fixtures/offset/*.golden.json` (Tasks 4/3/7's earlier goldens,
     predating the kernel-ops suite) — the same discipline these older
     goldens previously followed "by convention" only is now the same
     automated gate.
   - **What neither layer catches:** a force-push / history rewrite that
     replaces the base ref the CI gate diffs against, or a reviewer
     approving a PR without reading the diff. Both mechanisms above assume
     normal, non-rewritten git history and a range that actually reflects
     what changed — a rewritten history can make the diffed range itself
     dishonest. That residual case stays code-review territory; no
     automated mechanism here can make a rewritten history retroactively
     honest.
4. To regenerate `test-fixtures/golden/kernel-ops.json` after a legitimate,
   changelogged kernel change: `npx tsx scripts/generate-kernel-goldens.ts`
   (it double-runs every op and refuses to write a non-reproducible result —
   see that script's module doc), review the diff, then commit the refreshed
   file together with the `KERNEL_VERSION` bump and this changelog entry.

## [0.0.0] — Phase 0–2 (initial)

Baseline. Every golden fixture currently committed (`test-fixtures/intake/`,
`test-fixtures/curvature/`, `test-fixtures/offset/`,
`test-fixtures/golden/kernel-ops.json`) was generated against
`KERNEL_VERSION = '0.0.0'`. No prior version to diff against — this is the
starting point the policy above governs from here on.
