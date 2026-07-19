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

## [0.2.2] — Phase 3 Task 1 housekeeping: kernelVersion/manifoldVersion metadata on the standalone intake/curvature/offset goldens (metadata only, no hash change)

Extends the 0.2.1 precedent (below) — that bump added `kernelVersion`/
`manifoldVersion` to `test-fixtures/golden/kernel-ops.json` only; this one
closes the gap for the THREE other, standalone golden files that never
carried this metadata at all:

1. `test-fixtures/intake/arch-case-01-upperjaw.intake.golden.json` gained a
   `kernelVersion` field (`scripts/generate-intake-golden.ts` now stamps
   `KERNEL_VERSION` into the written snapshot; `test/golden/intake.test.ts`
   gained a well-formedness check for it, mirroring
   `test/golden/kernel-ops.test.ts`'s own). No `manifoldVersion` — plain
   `intake()` never touches manifold-3d.
2. `test-fixtures/curvature/arch-case-01-upperjaw.curvature.golden.json`
   gained a `kernelVersion` field, same treatment
   (`scripts/generate-curvature-golden.ts` / `test/golden/curvature.test.ts`).
   No `manifoldVersion` — `computeCurvature` is pure kernel math.
3. `test-fixtures/offset/standin-prep-die.offset.golden.json` gained BOTH
   `kernelVersion` AND `manifoldVersion` fields (offset's manifold-cleanup
   stage IS WASM-derived) — regenerated via
   `UPDATE_OFFSET_GOLDEN=1 RUN_CLINICAL_GOLDEN=1 npx vitest run --project golden test/golden/offset.test.ts`
   and diffed against the pre-bump file: `stats`, `errorBoundMm`,
   `resultSha256`, `distanceMm`, `pitchMm` are all BYTE-IDENTICAL; only the
   two new metadata fields were added. `test/golden/offset.test.ts` gained
   the same well-formedness checks.

Same "why this needed a `KERNEL_VERSION` bump at all" reasoning as 0.2.1
below: this repo's golden-version gate
(`scripts/check-golden-version-gate.ts`) triggers on ANY diff to a
golden-pinned path, metadata-only or not — a real, if patch-level, bump
through the normal mechanism is simpler and more honest than teaching the
gate a second "metadata-only, exempt" special case. `test-fixtures/golden/
kernel-ops.json` itself was NOT touched by this change (unrelated —
already had this metadata since 0.2.1) and was NOT regenerated.

## [0.2.1] — Fix batch (post-Task-12): pin manifold-3d + record its version in goldens (metadata only, no hash change)

Two related, purely-mechanical changes, ZERO numerical difference in any
kernel-ops golden entry:

1. **`packages/kernel/package.json`: `manifold-3d` dependency pinned to an
   EXACT version, `3.5.1`** (was `^3.5.1`). This repo's booleans/repairs go
   through the `manifold-3d` WASM wrapper
   (`packages/kernel/src/boolean/manifold.ts`) — unlike this kernel's own
   code, a `manifold-3d` upgrade is an external numerics change this repo
   doesn't control, and a caret range meant `npm install` could silently
   pull a newer `manifold-3d` patch/minor release (with its own WASM
   binary, its own numerics) without that being visible anywhere as a
   deliberate, reviewed decision. Pinning exactly makes any future
   `manifold-3d` bump an explicit, single-line diff instead of an ambient
   `npm install` side effect.
2. **`scripts/kernel-ops-lib.ts`'s `KernelOpsSnapshot` gained a
   `manifoldVersion` field** (`getInstalledManifoldVersion()`, reading the
   ACTUALLY INSTALLED `manifold-3d/package.json`'s version at generation/
   test time — not just trusting the pinned string above, so a
   `package.json`/`node_modules` drift is caught as a real mismatch), so
   `test-fixtures/golden/kernel-ops.json` now records WHICH `manifold-3d`
   build produced its committed hashes, alongside `kernelVersion`.
   `test/golden/kernel-ops.test.ts` gained a dedicated assertion that the
   live installed `manifold-3d` version matches the committed golden's
   recorded `manifoldVersion`, with a clear "you're testing against a
   different manifold-3d build than this golden file was generated with"
   message on mismatch — distinct from (and in addition to) the existing
   per-op hash-vs-`kernelVersion` enforcement
   (`test/golden/goldenEnforcement.ts`), since a `manifoldVersion` mismatch
   is diagnosable BEFORE looking at any individual op's hash.

**Why this needed a `KERNEL_VERSION` bump at all** (adding a metadata field
with every hash unchanged still counts, per this repo's golden-version
gate — `scripts/check-golden-version-gate.ts` triggers on ANY diff to
`test-fixtures/golden/kernel-ops.json`, not just a hash diff): the simpler
alternative (teaching the gate script to special-case "only
manifoldVersion/metadata changed, all hashes identical" as exempt) was
considered and rejected — it would add a second, narrower exemption path to
a mechanism whose entire value is "one rule, no exceptions to remember",
for a bump this cheap to do properly. Doing a real, if patch-level, version
bump instead is simpler, more honest (the committed golden file's own
`kernelVersion` field genuinely changed, so recording that fact via the
normal mechanism is just... correct), and exercises the bump+regenerate+
changelog workflow end to end for a third time (after 0.1.0's undercut fix
and 0.2.0's Task 11 repair upgrades), which is itself useful confidence
that the workflow holds up for a "boring" change, not just algorithmic
ones.

Regenerated via `npx tsx scripts/generate-kernel-goldens.ts` and diffed
against the pre-bump file: every op's `hash` and `meta` field is
BYTE-IDENTICAL; only `kernelVersion` (`0.2.0` -> `0.2.1`), the new
`manifoldVersion` field, and the notes array (documenting this bump, see
above) changed.

## [0.2.0] — Phase 2 Task 11: repair upgrades — curvature-continuous hole fill + bowtie split

Two changes, one real golden diff:

1. **`fillSmallHoles` — curvature-continuous hole fill (golden CHANGED).**
   After ear-clip refinement, the patch's new interior (centroid /
   chord-midpoint) vertices are now solved via a discrete thin-plate
   (cotan-weighted graph bi-Laplacian) fairing energy against the
   surrounding mesh's one-ring context, with the boundary ring fixed —
   replacing Phase 1's fixed-lambda Jacobi Laplacian relax as the DEFAULT
   path (that relax survives only as a rare, documented fallback for a
   pathologically non-manifold local neighborhood — see
   `packages/kernel/src/repair/curvatureFill.ts`'s module doc for the exact
   discretization and `packages/kernel/src/repair/fillSmallHoles.ts`'s
   `@approximation` doc). This retires the Phase 1 plan-deviation note
   (`docs/plans/phase-1-import-viewer.md`'s "Deviations (Phase 1)" section).
   **Measured, not assumed**: `fillSmallHoles.test.ts`'s seam-dihedral-angle
   test measures the max angular jump between an untouched outside triangle
   and its adjacent new patch triangle across every seam edge, on an
   icosphere-with-a-hole fixture (subdivision 4 — see that file for why
   subdivision 3's own natural faceting, ~5.75 deg max / ~5.0 deg mean,
   already saturates a naive < 5 deg target) — measured max **2.828 deg**
   against a **< 5 deg** documented threshold (PLAN Phase 5's blend
   language), essentially matching that finer mesh's own natural
   inter-facet faceting (~2.879 deg), i.e. the fill is no longer
   distinguishable from ordinary mesh discretization noise. Volume
   preservation on the same fixture also tightened from Phase 1's 0.5%
   acceptance budget to **0.3%** (still comfortably passing — the solve is
   a quality improvement, not a regression risk). The kernel-ops golden's
   `"repairFillSmallHoles"` entry (small hand-built cube-minus-triangle
   fixture, unchanged params) therefore CHANGED — its output mesh is
   numerically different (better continuity), not merely re-hashed for no
   reason. `FillSmallHolesReport` gained one new field,
   `curvatureFallbackLoopCount` (0 for both the kernel-ops fixture and the
   sphere-with-hole test fixture — the fallback path is exercised only by a
   pathological, out-of-scope neighborhood, not by this repo's fixtures).

2. **`splitNonManifoldVertices` — bowtie-vertex split (golden GAINED one new
   entry, `"repairSplitNonManifoldVertices"`).** New repair op: duplicates a
   bowtie vertex's one-ring fans (every fan but the lowest-triangle-index
   one, which keeps the original vertex id — the same "keep first,
   disconnect the rest" convention `splitNonManifoldEdges` already uses) so
   `buildHalfedge` sees a proper single fan per vertex afterward. No
   existing op's algorithm or output changed by this addition — see
   `packages/kernel/src/repair/splitNonManifoldVertices.ts`'s module doc for
   the fan-partition algorithm and its determinism guarantees.

**Every other kernel-ops golden entry (intake, curvature, geodesicPath,
fitSurfaceSpline, sampleSdfGrid, offsetMesh [+ pre-cleanup soup],
union/subtract/intersect, sectionMesh, repairRemoveComponents,
repairSplitNonManifoldEdges, undercutScan) is BYTE-IDENTICAL across this
bump** — verified via `npx tsx scripts/generate-kernel-goldens.ts`'s
regeneration diff (a scripted before/after JSON comparison, not just "the
test suite is green"), which touched only the two entries described above.

Repair UI: a new "Split bowtie vertices" card appears (`RepairPanel.tsx`)
when `previewSplitNonManifoldVertices` detects at least one bowtie vertex
(a per-card async detection call, deliberately NOT folded into `MeshStats`
— doing so would have rippled into every OTHER golden entry that hashes
`JSON.stringify(stats)`, e.g. `intake`/`offsetMesh`, far outside this
change's scope). The "Fill small holes" card's description string was
updated (all 4 locales) to note the improved (curvature-continuous, not
just smooth) fill quality.

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
