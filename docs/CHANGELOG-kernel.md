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

## [0.5.0] — Phase 3 Task 8 tuning: `findRidgeStart` ignores isolated curvature-noise components

Adds `packages/kernel/src/margin/marginRidge.ts`'s
`MARGIN_MIN_RIDGE_COMPONENT_SIZE` (default 20) and a new
`computeQualifyingComponentSizes` helper; `findRidgeStart`'s
"nearest-qualifying-vertex-to-seed" search now requires the candidate's own
`k2`-qualifying connected component (within the LOCATE-step bounded region)
to have at least this many vertices, before it is eligible to be picked as
the seed for the "refine to strongest within that component" step.

**Why:** building Task 8's real-fixture acceptance harness
(`scripts/margin-acceptance.ts`), seeds derived deterministically from a
reference margin's own point centroid (rather than hand-picked precisely ON
a ridge vertex, as Task 4's pinned golden seed is) could land closer to an
ISOLATED single-vertex curvature-noise blip than to the real, hundreds-of-
vertices ridge component a fraction of a millimeter further away. Without
this guard, `findRidgeStart`'s component-refinement step is a no-op on a
size-1 component (the noise vertex is trivially its own strongest vertex),
so the walk starts from a spurious, unrepresentative locus. MEASURED on
arch-case-01 "tooth 21": a reference-centroid seed ~0.78mm from the true
ridge found nearest-qualifying vertex 74246 in an isolated size-1
component, producing `NoClosureError` (closest approach 1.311mm after 468
steps) — where the SAME tooth's finish line, found from the FIX (or from
Task 4's own on-ridge golden seed, unaffected either way) closes cleanly to
261 anchors / 29.7mm, matching Task 4's pinned result exactly.

**Golden impact:** VERIFIED a no-op — `scripts/generate-kernel-goldens.ts`'s
regeneration diff against the previously-committed
`test-fixtures/golden/kernel-ops.json` is EMPTY (byte-identical). Task 4's
pinned `proposeMargin` seed already sits exactly ON its ridge vertex
(nearest-qualifying distance 0.000mm, in the 1211-vertex tooth-21 component,
comfortably above the new 20-vertex floor), so this change is invisible to
every currently-pinned real-fixture and analytic-fixture golden. Bumped
anyway (rather than leaving `KERNEL_VERSION` at 0.4.1) per this repo's
discipline that a real kernel algorithm change goes through the same
bump+changelog workflow regardless of whether it happens to be a no-op for
every currently-pinned case — see `MARGIN_MIN_RIDGE_COMPONENT_SIZE`'s own
TSDoc for the full evidence, and `.superpowers/sdd/p3-task-8-report.md` for
this task's full acceptance-measurement report (including why, even with
this fix, the phase's ≥90%-length/≤100µm acceptance criterion is NOT met on
this real case — a genuine curvature-signal limitation, not a further
tuning target; see that report).

## [0.4.1] — Phase 3 Task 7: dentist hand-traced reference margins committed (acceptance inputs, no kernel change)

- `test-fixtures/margins/arch-case-01/{12,11,21,22}.reference.json`: four
  human-traced reference margin lines (FDI 12, 11, 21, 22, shoulder preps)
  exported from the margin editor by the project owner (a practicing
  dentist) on 2026-07-15. These are Task 8's acceptance ground truth.
- Clinical context recorded by the tracer: this is a REAL case, not an
  idealized specimen — the margin line is partially obscured by collapsed
  gingiva in several regions, and the traces reflect clinical judgment in
  those regions (exactly the realism the acceptance test should measure
  against).
- No kernel algorithm changed; hashes of all kernel-op goldens are
  byte-identical. This bump exists because reference files are
  version-gate-protected acceptance inputs (see
  test-fixtures/margins/README.md).

## [0.4.0] — Phase 3 Task 4: margin ridge detection (proposeMarginLoop)

Adds `packages/kernel/src/margin/` — `proposeMarginLoop(mesh, hm, curvature,
seed, opts)`: the margin auto-proposal core. From a seed roughly inside a
crown prep, locates the nearest curvature-ridge locus (the SIGNED, most-
negative principal curvature `k2` — chosen over `|k2|`/curvedness because it
uniquely, and MEASURABLY on the real arch-case-01 upperjaw fixture,
distinguishes a shoulder margin's CONCAVE crease from an equally sharp but
CONVEX feature elsewhere on the same arch — see marginRidge.ts's module doc
for the full probe-line evidence), then walks it bidirectionally on the
halfedge graph (a bounded k-hop BFS at every step, geodesic-step-regularized
via an EMA-smoothed heading to resist zigzag on noisy real-scan curvature,
preferring the STRONGEST ridge point within the search window over the
nearest — see `findNextStep`'s doc for why, and the measured real-fixture
evidence this design choice is based on) until the walk closes into a loop
(GRAPH-based closure — the two directions' paths literally sharing a
vertex — checked before a distance-based fallback), then simplifies the
walked vertex path into curvature-adaptive `SurfacePoint[]` anchors (angle-
budget marching) ready for `fitSurfaceSpline`, with a per-segment confidence
score (ridge strength vs. local background, normalized).

Two independently-bounded regions, by design (see `MARGIN_SEARCH_RADIUS_MM`/
`MARGIN_WALK_RADIUS_MM`'s docs): a tight one (10mm, from the seed) locates
the ridge; a looser one (30mm, from the ridge start) bounds the walk itself
— the primary defense against the walk crossing to a NEIGHBORING tooth's own
margin (measured as close as ~0.27mm away on the real 4-adjacent-prep
fixture) is ridge CONNECTIVITY (a real gap of non-qualifying, background-
curvature vertices always separates two different teeth's margins at the
`k2 < -3` floor — verified on the real fixture, not merely assumed), not
either radius alone.

Typed errors: `NoRidgeFoundError` (no ridge locus within the bounded search
region — a degenerate/flat seed) and `NoClosureError` (a ridge was found but
the walk never closed into a loop — an open margin is invalid by
definition, per PLAN.md: a prep finish line is always closed).

No existing op's algorithm or output changed — the kernel-ops golden file
changed only by GAINING one new pinned entry, `"proposeMargin"` (same "pure
addition, still needs the bump" precedent as [0.3.0]'s `icpRegister` entry
above), on the real arch-case-01 upperjaw fixture at a fixed seed (default
params) — measured perimeter ~29.7mm, inside the 15-35mm anatomical range
this task's brief cites for an incisor, self-checked at generation time
(`kernel-ops-lib.ts` throws rather than pin an out-of-range loop). Worker
job `proposeMargin` (`kernel-workers/src/jobs/margin.ts`) wires this through
with per-worker halfedge+curvature caches (mirrors jobs/geodesic.ts's/
jobs/curvature.ts's own caches) — measured < 5s (typically ~0.5s) on the
real 250k-triangle fixture, well under this task's brief's budget.

**Known real-data limitation (reported, not swept under the rug):** of the
4 real anterior shoulder preps (FDI 12/11/21/22) on arch-case-01, 3 close
cleanly with DEFAULT parameters (~28-30mm loops); the 4th (one of the two
central-incisor candidates) does not close within the default
`closureToleranceMm` on this specific real, noisy scan region — flagged for
Task 6 (validation)/Task 8 (dentist-hand-traced accuracy benchmarking) to
investigate further with more real fixtures to generalize from. The
analytic acceptance suite (sharp AND filleted shoulder, on a fixture with an
EXACTLY known margin circle) is unaffected and passes with sub-micron
(sharp) / sub-fillet-radius (filleted) measured deviation.

## [0.3.0] — Phase 3 Task 3: rigid registration (coarseAlignFromPointTriples + icpRefine)

Adds `packages/kernel/src/register/` — `coarseAlignFromPointTriples` (closed-form
Kabsch/Horn rigid alignment from exactly 3 point correspondences, via
eigen-decomposition of the 3x3 cross-covariance's `H^T H` rather than a
general SVD routine — see that file's module doc for why this is provably
equivalent to the reflection-corrected Kabsch solution for the N=3 minimal
case) and `icpRefine`/`icpRefineIteration` (point-to-plane ICP, per-triangle
dst normals, seeded deterministic sampling, distance-percentile outlier
rejection, a direct 6x6 dense solve per iteration, exact-Rodrigues delta
composition — see icpRefine.ts's module doc for the full algorithm and its
local-minimum `@errorBound` caveat). No existing op's algorithm or output
changed — the kernel-ops golden file changed only by GAINING one new pinned
entry, `"icpRegister"` (same "pure addition, still needs the bump" precedent
as [0.1.0]'s `undercutScan` entry below — `scripts/check-golden-version-gate.ts`
has no addition-only exemption).

**Real-fixture golden**: arch-case-01 `bite0` (src, 108665 post-intake
triangles — a bite-registration scan) vs. `upperjaw` (dst, 250128 post-intake
triangles), `IDENTITY_MAT4` as the initial transform (verified, not assumed:
both scans' bounding boxes already substantially overlap at identity — they
come from the same acquisition session and share the scanner's own
coordinate frame; a cross-session/cross-modality pair would need
`coarseAlignFromPointTriples` first, which is exercised separately, on
synthetic data with a known ground truth, by
`packages/kernel/src/register/kabsch.analytic.test.ts`).

Measured, not assumed: with this repo's DEFAULT `outlierRejectionFraction`
(0.1, keep the closest 90%), this real pair does NOT converge — RMS
plateaus/drifts around 2.4mm over 30 iterations. Investigated (not papered
over): a bite-registration scan's surface only genuinely CORRESPONDS to the
upper arch at the occlusal CONTACT points (this task's brief: "they overlap
in the tooth surfaces") — most of `bite0`'s own surface (non-contact facets,
and any lower-arch geometry a bite scan also captures) has no real match on
`upperjaw` at all, so the "inlier" 90% is dominated by structurally
non-corresponding points that the linearized solve cannot satisfy
simultaneously with the genuine contact points. Raising
`outlierRejectionFraction` to 0.85 (keep only the closest 15%) — the
parameter pinned in this golden entry — converges cleanly to **RMS 8.3
microns**, `inlierFraction: 0.15`, in 10 iterations. This is reported as a
measured fact about this real fixture, not asserted against a pre-conceived
target; see `scripts/kernel-ops-lib.ts`'s `icpRegister` op entry for the
full derivation and `.superpowers/sdd/p3-task-3-report.md` for the
before/after trace.

Every OTHER kernel-ops golden entry (intake, curvature, geodesicPath,
fitSurfaceSpline, sampleSdfGrid, offsetMesh [+ pre-cleanup soup],
union/subtract/intersect, sectionMesh, every repair op, undercutScan) is
BYTE-IDENTICAL across this bump — verified via `npx tsx
scripts/generate-kernel-goldens.ts`'s regeneration diff, which touched only
the `kernelVersion` field, the `notes` array, and the new `"icpRegister"`
entry.

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
