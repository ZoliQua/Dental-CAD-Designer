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

## [0.1.0] addendum — Fix batch: occlusion detection + boundary epsilon (no version bump)

A follow-up fix batch extended `undercutScan`'s undercut rule from
FACING-ONLY (`normal · d < 0`) to "facing-away OR occluded": a
facing-correct triangle (`normal · d >= 0`) sitting under a genuine,
separate overhang/canopy is now ALSO undercut, with `depthMm` = distance to
the occluder (see `packages/kernel/src/undercut/undercutScan.ts`'s
"Occlusion as an INDEPENDENT undercut detector" doc for the full derivation,
including a documented, deliberate deviation from that task's brief's
literal "cast along `-d`" prose — provably wrong for this module's `d`
convention, see that doc). It also replaced the bare `nd >= 0` facing test
with a principled `UNDERCUT_BOUNDARY_EPSILON` (`1e-12`) band, and excluded
that same band from the new occlusion rule too (a `+d` ray is geometrically
degenerate — tangent to the triangle's own plane — right at `nd ~ 0`,
producing a spurious same-plane-seam hit otherwise; see that constant's doc
and undercutScan.ts's "Near-perpendicular triangles" section).

**This is a real algorithm change, but it did NOT change the pinned
`"undercutScan"` kernel-ops golden entry (added in [0.1.0] below).**
Verified, not assumed: `test/golden/kernel-ops.test.ts` passes unmodified
against the ALREADY-committed golden file, and
`npx tsx scripts/generate-kernel-goldens.ts` (double-run, determinism-
checked) regenerates a BYTE-IDENTICAL `test-fixtures/golden/kernel-ops.json`
— confirmed with a raw `diff` against the pre-fix committed file, not just
"the test suite is green". The reason: the pinned fixture
(`standin-prep-die.stl`, a fairly convex prep-die shape) has ZERO
facing-correct-but-occluded triangles at ANY of several directions tested
(including the pinned `(0.2, -0.4, 0.9)`) — a prep die simply doesn't have
a canopy/overhang feature this specific extension detects; the existing
facing-away undercuts it does have are computed by the UNCHANGED code path
and are therefore bit-identical.
Per this file's own policy above ("a 'small numeric diff'... is a red
flag — investigate, don't regenerate"), the honest, policy-consistent
action for a VERIFIED-unchanged golden output is to NOT bump
`KERNEL_VERSION` — a bump with no corresponding hash diff would be exactly
the kind of unjustified version churn this policy exists to prevent. New
behavioral coverage for the occlusion branch is instead provided by a
dedicated fixture/test (`undercut.test-fixtures.ts`'s `canopyMesh`,
`undercutScan.overhang.test.ts`'s "canopy" describe block — two disjoint
boxes with a genuine air gap, hand-computed exact depth), not by touching
the pinned kernel-ops snapshot. See `.superpowers/sdd/p2-task-9-report.md`'s
"Fix: occlusion detection + boundary epsilon" section for the full
before/after test run and the `diff`-verified no-op golden regeneration.

## [0.1.0] — Phase 2 Task 9: insertion-axis undercut scan

Adds `undercutScan`/`undercutScanBatch`/`undercutScanRange`
(`packages/kernel/src/undercut/`) — no existing op's algorithm or output
changed. The kernel-ops golden file changed only by GAINING one new pinned
entry, `"undercutScan"` (standin-prep-die, one fixed non-axis-aligned
direction `(0.2, -0.4, 0.9)` normalized, `'corners'` sampling — see
`scripts/kernel-ops-lib.ts`'s "14. undercutScan" block). Every pre-existing
op's hash in `test-fixtures/golden/kernel-ops.json` is UNCHANGED by this
bump (verified: `scripts/generate-kernel-goldens.ts`'s regeneration diff
touches only the new `"undercutScan"` array entry, nothing else — see this
task's report for the exact diff).

Note on the golden-version-gate's treatment of an added-vs-changed entry:
this task's own brief assumed the gate has a dedicated "op-added path" that
skips the version-bump requirement for a pure addition. Verified against the
actual gate logic (`scripts/check-golden-version-gate.ts`'s
`checkGoldenVersionGate` — `goldenFilesChanged.length > 0` alone triggers
the bump+changelog requirement, with no special case for "only additions")
and confirmed empirically (`test/golden/kernel-ops.test.ts` fails
immediately with `op "undercutScan" is computed but has no entry in the
committed golden file` the moment the op is added, before any version bump)
— there is NO such exemption. This entry follows the one real, documented
workflow: bump `KERNEL_VERSION`, add this changelog entry, then regenerate
and commit the refreshed golden file, exactly as CLAUDE.md's policy states
for every golden-pinned change, additions included.

## [0.0.0] — Phase 0–2 (initial)

Baseline. Every golden fixture currently committed (`test-fixtures/intake/`,
`test-fixtures/curvature/`, `test-fixtures/offset/`,
`test-fixtures/golden/kernel-ops.json`) was generated against
`KERNEL_VERSION = '0.0.0'`. No prior version to diff against — this is the
starting point the policy above governs from here on.
