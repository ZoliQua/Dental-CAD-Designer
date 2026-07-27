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

## [0.24.0] — Phase 6 Task 4: bridge connectors — `bridge/connector.ts` (editable profiles, ruled loft, minimum cross-section area)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.23.0]`.** A brand-new op only; no existing
op's numerical output changed.

Phase 6 Task 4 adds the bridge CONNECTOR op (`bridge/connector.ts`): editable
2D cross-section profiles (validated closed / simple / consistently-wound — the
`margin/validate.ts` precedent in 2D, with typed errors `NonClosedProfileError`
/ `DegenerateProfileError` / `SelfIntersectingProfileError` / `ProfileVertexCountMismatchError`
/ `ProfileWindingMismatchError`); a deterministic watertight ruled LOFT between
two index-paired profiles (`loftConnectorProfiles`, closed via
`orientNormalsConsistently`); and the fracture-strength gate value — the minimum
cross-section area of the connector. The ideal ruled-ring section area
`A(t)=a·t²+b·t+c` is EXACTLY a quadratic in the axial parameter, so its
continuous minimum is CLOSED-FORM (`analyticConnectorMinArea`, no station error);
a secondary mesh-sectioning instrument (`sampleConnectorCrossSectionAreas`, the
live-readout view) sections the real triangulated solid and carries a RIGOROUS
second-difference station margin — `max_k |A_{k−1}−2A_k+A_{k+1}|/8` — so its
`guaranteedLowerBoundMm2` provably never over-reports the actual solid's minimum
(the gate value). Pure Float64; no manifold-3d boundary (the unit+connector union
is Task 6). Regression-pinned by its own closed-form-instrument-validation /
station-margin-falsifiability / loft-watertight / determinism tests in
`bridge/connector.test.ts` (no `kernel-ops.json` pin added — same "brand-new
pure-Float64 op" precedent as `[0.9.0]`–`[0.23.0]`).

The crown/cavity-acceptance QC pins (`test/golden/crown-acceptance.test.ts`,
`test/golden/cavity-acceptance.test.ts`) advance MECHANICALLY: `hashQcReport`
= sha256 over the QcReport JSON, which embeds `kernelVersion`, so the version
string alone shifts the three `*-qc` hashes while EVERY geometry stage pin is
byte-identical to `[0.23.0]` (verified: `npm run test:golden` green, no geometry
pin moved). The gate ordering (`connectorCrossSection` between `seating` and
`contact`) is unchanged, and the single-crown connector gate is still the N/A
PASS path — byte-identical (Task 4 only fills in the never-run-for-a-crown bridge
branch).

## [0.23.0] — Phase 6 Task 3: pontic gingival interface — `bridge/ponticInterface.ts` (`shapePonticBase`, `measurePonticRelief`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.22.0]`.** A brand-new op only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts` and
`test/golden/cavity-acceptance.test.ts` (byte-pinned stage hashes, not
`test-fixtures/` files), all geometry stage pins are verified byte-identical to
0.22.0; only the `crown-standin-qc` / `cavity-inlay-qc` / `cavity-onlay-qc` pins
changed, MECHANICALLY and metadata-only — the `QcReport` embeds `kernelVersion`
(cad-pipeline/gates/report.ts), so `hashQcReport` tracks every version bump even
with every measured value and geometry hash unchanged (the same mechanical churn
documented at 0.16.0-0.22.0; the unchanged geometry pins are the proof the qc
diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/bridge/ponticInterface.ts` — the PONTIC GINGIVAL
INTERFACE. A bridge pontic's base is shaped against the edentulous-ridge
(gingiva) mesh per clinical STYLE at the CONFIGURED relief, with the PLAN
acceptance that the MEASURED pontic-gingiva relation matches the configured value
within ±20 µm per style. Two independent halves (the P5 seam-dihedral lesson: the
instrument is validated before it judges):

- **`shapePonticBase(crest, style, params, footprint, resolution)`** — the
  deterministic CONSTRUCTION. Builds the base as an analytic OFFSET of the ridge
  crest cylinder (`base(x,φ) = crest(x,φ) + t(φ)·n(φ)`, radial signed distance to
  the cylinder is EXACTLY t(φ)) with a per-style target field + an honest patch
  partition: **hygienic** — uniform clearance over the WHOLE base; **modified
  ridge-lap** — relief over the BUCCAL contact patch, lingual RELIEVED region
  reported separately, central transition ramp; **ovate** — −depth penetration
  over the seat patch, outside ramps to emergence. Returns the base surface mesh
  (open patch) + a DENSE, mesh-resolution-independent sample set (each sample
  carrying its geometric patch + intended target) + the `errorBoundMm`.
- **`measurePonticRelief(gingivaMesh, bvh, pseudonormals, samples, crest?)`** —
  the blend-independent MEASUREMENT. Per sample: `signedClosestPoint` to the
  gingiva mesh (sign + outside/clearance, − inside/penetration); buckets by the
  sample's GEOMETRIC patch; reports the PRIMARY (acceptance) patch min/max/mean
  deviation-from-target strictly separate from the relieved/transition/outside
  patches (never diluted). Optional analytic-cylinder cross-check.

Pure Float64, no manifold-3d boundary, no new approximation beyond the surfaced
one-sided inscribed-chord sagitta (`errorBoundMm` = `max R·(1−cos(Δφ/2))` over
the sampled band; the mesh under-approximates the arc so a measured relief reads
`configured + [0, sagitta]`). The construction shapes the pontic BASE only — the
pontic body stays library-shaped (Task 4 connects it; Task 6 assembles the
watertight solid). Regression-pinned by its own tests
(bridge/ponticInterface.test.ts): closed-form instrument validation FIRST, then
per-style ±20 µm (hygienic 0.16 / ridge-lap 0.19 / ovate 0.06 µm measured maxAbs
deviation), relieved/non-patch regions reported separately, falsifiability
(mis-configured 1000 µm / raw-on-ridge 2000 µm ≫ 20), determinism, fc.pre
properties. Same "brand-new op, minor bump, existing goldens byte-identical"
precedent as 0.9.0-0.22.0's pure-Float64 ops; no `kernel-ops.json` pin added.
The pontic stage + worker (cad-pipeline/stages/bridgePontic.ts,
kernel-workers/jobs/bridgePontic.ts) journal the placement + style + configured
relief params; the ±20 µm gate itself is consumed by Task 6's whole-bridge QC.

## [0.22.0] — Phase 6 Task 2: bridge shared insertion axis — `bridge/sharedAxis.ts` (`assessSharedAxis`, `suggestSharedAxis`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.21.0]`.** A brand-new op only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts` and
`test/golden/cavity-acceptance.test.ts` (byte-pinned stage hashes, not
`test-fixtures/` files), all geometry stage pins are verified byte-identical to
0.21.0; only the `crown-standin-qc` / `cavity-inlay-qc` / `cavity-onlay-qc` pins
changed, MECHANICALLY and metadata-only — the `QcReport` embeds `kernelVersion`
(cad-pipeline/gates/report.ts), so `hashQcReport` tracks every version bump even
with every measured value and geometry hash unchanged (the same mechanical churn
documented at 0.16.0-0.21.0; the unchanged geometry pins are the proof the qc
diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/bridge/sharedAxis.ts` — the bridge SHARED insertion
axis (a bridge seats as ONE rigid piece along ONE axis, undercut-acceptable
across BOTH abutment preps):

- **`assessSharedAxis(mesh, bvh, regions, directionUnit, options?)`** — the
  FALSIFIABLE given-axis verdict: the union-of-regions undercut + a per-abutment
  breakdown + a `sharedAxisAcceptable` boolean (`true` iff EVERY abutment has
  zero undercut at that axis). Pure aggregation over the P3 machinery
  (`undercutScanIndices` / `unionRegions` / `regionTriangleAreasMm2` — REUSED
  verbatim, occlusion always queried against the FULL bvh). New over
  `suggestInsertionAxisForRegions` (which only reports at the axis IT chose):
  this assesses an ARBITRARY candidate axis, so the parallel bridge's analytic
  `[0,0,1]` is verified EXACT-ZERO on both preps and a tilted bridge is shown to
  have NO acceptable shared axis (a whole-hemisphere sweep + the suggested axis
  both leave a residual on at least one abutment).
- **`suggestSharedAxis(mesh, bvh, regions, options?)`** — the bridge axis
  suggestion: `suggestInsertionAxisForRegions` (REUSED verbatim) + a uniform
  `assessSharedAxis` readout at the suggested common axis.

Per-abutment fit surfaces are built with the SAME P4 `buildInnerSurface` (a
bridge abutment intaglio IS a crown intaglio) against the SHARED axis — no new
kernel op there; the bridge-specific choice (the shared axis) lives in the stage
(`cad-pipeline/stages/bridgeAbutmentSurfaces.ts`) + worker
(`kernel-workers/jobs/bridgeAbutmentSurfaces.ts`). Pure Float64, no manifold-3d
boundary, no new approximation; regression-pinned by its own analytic exact-zero
/ tilt-residual / determinism tests (bridge/sharedAxis.test.ts) + the
shared-vs-own-axis + self-consistency + margin-fit tests
(bridge/abutmentInnerSurface.test.ts); no `kernel-ops.json` pin added — same
"brand-new op, minor bump, existing goldens byte-identical" precedent as
0.9.0-0.21.0's pure-Float64 ops.

## [0.21.0] — Phase 5 Task 7: onlay cusp coverage — `cavity/cuspCoverage.ts` (`identifyCuspRegions`, `extendOutlineOverCusp`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.20.0]`.** A brand-new op only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts`
(byte-pinned stage hashes, not a `test-fixtures/` file), all FIVE geometry stage
pins are verified byte-identical to 0.20.0; only the `crown-standin-qc` pin
changed, MECHANICALLY and metadata-only — the `QcReport` embeds `kernelVersion`
(cad-pipeline/gates/report.ts), so `hashQcReport` tracks every version bump even
with every measured value and geometry hash unchanged (the same mechanical churn
documented at 0.16.0-0.20.0; the unchanged geometry pins are the proof the qc
diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/cavity/cuspCoverage.ts` (an ONLAY = an inlay on an
extended outline; the extended outline feeds the WHOLE T3–T6 cavity pipeline
UNCHANGED):

- **`identifyCuspRegions(mesh, insertionAxis, options?)`** — geometric cusp
  detection: local along-axis height (`pos·â`) maxima on the OCCLUSAL
  (axis-facing) surface, each grown into a cusp region by a descending flood,
  filtered by a documented prominence. Returns cusps sorted by tip height
  descending. On the MOD onlay fixture: exactly two — the intact LINGUAL cusp
  and the reduced BUCCAL crest (the coverage-margin ridge) — closed-form
  checkable. New error `NoCuspFoundError`.
- **`extendOutlineOverCusp(mesh, baseOutline, insertionAxis, coveredCuspTriangleIndices)`**
  — the outline extension: the extended cavosurface ring is the single BOUNDARY
  LOOP of `cavityRegion ∪ coveredCuspRegion` (the coverage SELECTION unions the
  covered cusp's occlusal surface into the restoration; the shared cavity/cusp
  edges become interior and vanish, splicing the cavity outline and the cusp
  crest into one ring). Deterministic (committed sha256 in cuspCoverage.test.ts);
  reproduces the fixture `onlayOutline` EXACTLY. New error `CoverageBoundaryError`.

Pure Float64, no manifold-3d boundary; same "brand-new op, minor bump, existing
goldens byte-identical" precedent as 0.9.0-0.20.0's pure-Float64 ops
(regression-pinned by its own analytic closed-form / determinism / committed-
sha256 tests in cavity/cuspCoverage.test.ts; no `kernel-ops.json` pin added).

New downstream plumbing (no numerical change to any existing op): the
`cuspCoverageThickness` cad-pipeline gate (the ONLAY covered-cusp REGION-SCOPED
`cuspCoverageMinThicknessMm` min-wall check — samples classified covered-cusp vs
body by a coverage-divider half-space, the wedge band excluded, the sampling
margin subtracted; wired into `runInlayQc` for onlays carrying coverage). The
end-to-end onlay acceptance (`test/golden/onlay-acceptance.test.ts`) is
genuinely coupled (the extend-over-cusp output IS the pipeline outline);
REVIEWER NOTE: it ACKNOWLEDGES the seating gate — the covered-cusp reduction
bevel meets the cavity wall at a SHARP CORNER on the deliberately un-filleted
analytic fixture, and the marching-cubes offset intaglio cuts inside the
gap-radius corner arc there (arc radius ≈ cement gap 0.08 mm, barely above the
0.06 mm cell) → a ~0.06 mm³ die-into-wall interference, journaled + reported,
never weakened. The acknowledgment is SCOPED in the committed suite: the
interference is asserted BOUNDED (< 0.1 mm³) and LOCALIZED at the junction band
(≥90% of intersection vertices; centroid pinned; any buccal off-band vertex must
lie ON the outline-crest marginal-seal locus) so a grown/spread interference — a
real defect — re-fails. Corner-sharpness CAUSATION is measured falsifiably (the
fixture's `junctionChamferMm` single-cut chamfer: sharp 6.165e-2 → c=0.2
3.237e-2 → c=0.4 3.093e-2 mm³, monotone, residual at the same locus); FULL
removal by a true large-radius fillet remains an OPEN GEOMETRY ITEM (untested —
the fixture's 0.66 mm buccal wall leaves no room for a large-radius fillet).

## [0.20.0] — Phase 5 Task 6: inlay/onlay shell — `cavity/inlayShell.ts` (`constructInlayShell`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.19.0]`.** A brand-new op only; no existing
op's algorithm or output changed. `constructInlayShell` is NOT added to
`kernel-ops.json` (like the crown `constructShell`, its output crosses the
manifold-3d Float32 WASM boundary via `cleanupMesh`, so its determinism is
pinned instead by a committed sha256 in `cavity/inlayShell.test.ts`, GUARDED by
the installed manifold-3d version — the same manifoldVersion-guard the
crown-acceptance qc pin uses; a manifold-3d build change is caught there, never
mistaken for a kernel regression). In `test/golden/crown-acceptance.test.ts`
(byte-pinned stage hashes, not a `test-fixtures/` file), all FIVE geometry stage
pins are verified byte-identical to 0.19.0; only the `crown-standin-qc` pin
changed, MECHANICALLY and metadata-only — the `QcReport` embeds `kernelVersion`
(cad-pipeline/gates/report.ts), so `hashQcReport` tracks every version bump even
with every measured value and geometry hash unchanged (the same mechanical churn
documented at 0.16.0-0.19.0; the unchanged geometry pins are the proof the qc
diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/cavity/inlayShell.ts`:

- **`constructInlayShell(fitMesh, patchMesh, hooks?)`** — assembles the inlay/
  onlay SOLID from the Task-3 fit surface (an open cup) and the Task-4/5 occlusal
  patch (an open cap), joined along their SHARED cavity-outline ring. Because
  both surfaces carry that ring as their single open boundary BIT-EXACT (engineered
  across Task 3/4/5), the stitch is a DIRECT DETERMINISTIC WELD (`weldVertices`,
  exact-coordinate dedup), NOT a boolean union — preferred for accuracy: a boolean
  would re-tessellate the margin through the manifold-3d Float32 boundary and
  perturb the ≤10 µm marginal seal, whereas the weld keeps every input vertex at
  its exact Float64 leader position, so the Task-3 margin fit and Task-4 seam
  dihedral survive assembly byte-for-byte. The shared-ring assumption is VERIFIED
  first (each surface exactly one boundary loop; the two loops' bit-exact
  coordinate sets equal) — a perturbed/mismatched ring throws
  `InlayShellRingMismatchError` BEFORE welding (falsifiable). The welded surface
  is consistently oriented, pinned outward, and re-validated + cleaned through the
  manifold-3d wrapper (`cleanupMesh` throws `NonManifoldInputError` on a non-2-
  manifold result); `analyzeMesh` then re-checks watertight + single-component,
  throwing `InlayShellNotWatertightError` otherwise — a non-watertight stitch can
  never masquerade as a shell. Deterministic (same inputs + manifold-3d version →
  byte-identical shell). New errors: `InlayShellOpenBoundaryError`,
  `InlayShellRingMismatchError`, `InlayShellNotWatertightError`.

## [0.19.0] — Phase 5 Task 5: Class II proximal box contact adaptation — `cavity/proximalContact.ts` (`adaptProximalContacts`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.18.0]`.** A brand-new op only; no
existing op's algorithm or output changed (`buildOcclusalPatch` gains the
ADDITIVE `proximalFaces` result field — pure extra output from already-computed
internals; its patch-mesh bytes and committed sha256 pin in
cavity/occlusalPatch.test.ts are unchanged, which that test proves). In
`test/golden/crown-acceptance.test.ts` (byte-pinned stage hashes, not a
`test-fixtures/` file), all FIVE geometry stage pins are verified
byte-identical to 0.18.0; only the `crown-standin-qc` pin changed,
MECHANICALLY and metadata-only — the `QcReport` embeds `kernelVersion`
(cad-pipeline/gates/report.ts), so `hashQcReport` tracks every version bump
even with every measured value and geometry hash unchanged (the same
mechanical churn documented at 0.16.0-0.18.0; the unchanged geometry pins are
the proof the qc diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/cavity/proximalContact.ts`:

- **`adaptProximalContacts(patchMesh, adaptations, options?)`** — the inlay's
  proximal faces (the Task-4 patch's break-through faces) adapt to the
  neighbouring teeth at the profile's target penetration
  (`proximalContactPenetrationMm`, passed in by the stage), one adaptation per
  box (mesial + distal). Mechanism: a dedicated per-box 1-D BUMP displacement
  of the proximal face's occlusal top rim (the patch's proximal cross-section
  column interior) — chosen over a region-scoped RBF because (1) the hard
  invariant is a BYTE-IDENTICAL outline ring and the bump pins by
  construction (the pinned set is never written) where an RBF pins only to
  solver precision; (2) the deformation space is one curve per box; (3) a
  `seamAnchorBandMm` zero-displacement band at both rim ends pins the entire
  seam-boundary-triangle support, so the re-measured seam dihedral is exactly
  the pre-adaptation value (proven, not assumed — the tests re-measure).
  The driven rim vertex's travel is a FIXED-iteration (4) Newton root-find on
  the neighbour's signed distance along a fixed approach direction, clamped
  to ±`maxTravelMm` (1.5 default, documented): an unreachable target clamps
  and reports `clampBound` + an honestly-large MEASURED residual. Achieved
  contact is GENUINE (closest-point of the adapted face vs the neighbour
  mesh, never a prescription re-read); `@errorBound` = max over boxes of
  max(contact residual, face-wide residual), conservative. One documented
  deviation from P4's `refineContactTarget`: the approach direction is
  negated for a pre-penetrating start so the Newton update converges in both
  regimes (P4 assumed an outside start).
- Closed-form residual on the synthetic planar-neighbour case: 0 nm (mesial +
  distal, gaps 0.05-0.4 mm swept) — fp-exact Newton on a planar face; the
  documented general bound is the measured residual itself, carried per box.

New downstream plumbing (no numerical change to any existing op): the
`cavityProximalContact` worker job (kernel-workers; seam-before → adapt →
seam-after, coarse progress + cancellation, byte-identical to direct kernel
calls) and the `runCavityProximalContactStage` cad-pipeline stage (ONE
journaled op `cavityProximalContact.adapt`; FDI neighbours pair to patch faces
geometrically; per-box residuals + seam before/after + clamp warning
journaled; `errorBoundMm` carried).

## [0.18.0] — Phase 5 Task 4: occlusal patch + G1 boundary blend — `cavity/occlusalPatch.ts` (`buildOcclusalPatch`) + `cavity/seamDihedral.ts` (`measureSeamDihedral`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.17.0]`.** Brand-new ops only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts`
(byte-pinned stage hashes, not a `test-fixtures/` file), all FIVE geometry
stage pins are verified byte-identical to 0.17.0; only the `crown-standin-qc`
pin changed, MECHANICALLY and metadata-only — the `QcReport` embeds
`kernelVersion` (cad-pipeline/gates/report.ts), so `hashQcReport` tracks every
version bump even with every measured value and geometry hash unchanged (the
same mechanical churn documented at 0.16.0/0.17.0; the unchanged geometry pins
are the proof the qc diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/cavity/occlusalPatch.ts` + `cavity/seamDihedral.ts`:

- **`buildOcclusalPatch(mesh, cavityOutline, insertionAxis, options?)`** — the
  inlay/onlay OUTER surface: an occlusal anatomy patch over the cavity opening
  whose boundary loop is EXACTLY the dedup'd cavity outline (the same bit-exact
  ring the Task-3 fit surface skirts to, so Task 6 can stitch them into the
  shell), G1-blended into the surrounding intact tooth along the OCCLUSAL SEAM
  segments. **The seam/free partition** is resolved geometrically and matches
  the fixture's closed-form labels: for each outline edge the SURROUNDING
  (non-cavity, from `classifyCavityRegions`) tooth triangle's outward normal is
  projected on the axis — `≥ cos(SEAM_SURROUNDING_MAX_ANGLE_DEG=60°)` ⇒ an
  occlusal SEAM (the cusp inclines, ~0.9 on the fixture); otherwise a proximal
  FREE break-through edge (the cut faces, ~0). **The blend** is a per-station
  cubic-Hermite buccolingual cross-sweep: the two occlusal margin runs give
  paired buccal/lingual station points, and each cross-section is a cubic
  Hermite along the axis whose endpoint positions are the exact outline points
  and whose endpoint TANGENTS equal the surrounding tooth surface tangent
  (recovered from the surrounding facet normal) — so the patch is G1 with the
  tooth AT the seam analytically. The interior dips into a mesiodistally-running
  central groove (a MODEST PROCEDURAL placeholder, like the tooth library, NOT
  patient anatomy — provenance documented honestly). The proximal FREE
  boundaries are the proximal face zipped (monotone arc-length) from the
  occlusal marginal ridge down to the exact outline U — no G1 constraint (there
  is nothing to be continuous with), never in the G1 measurement.
- **`measureSeamDihedral(patchMesh, toothMesh, seamEdges, options?)`** — the
  blend-INDEPENDENT G1 measurable: for each seam edge, the angle between the
  patch boundary triangle's outward normal and the surrounding tooth triangle's
  outward normal across that edge; returns max + mean + per-segment breakdown.
  Validated on CLOSED-FORM inputs (a flat patch meeting a plane → 0° exactly;
  two flat strips at a known wedge β → β exactly; a flat disk cap meeting a
  UV-sphere zone → the colatitude, converging as the mesh refines) BEFORE it
  judges any blend, and FALSIFIABLE (a large angle reads large; the fixture flat
  lid reads ~24.8°). Consumed by cad-pipeline's `seamDihedralGate` (< 5° phase
  acceptance; seam ONLY — free segments never dilute the value; an empty seam
  set FAILS, never a silent pass).

`@errorBound`: SEAM G1 is EXACT in the continuous limit (the Hermite endpoint
tangent equals the sampled surrounding tooth tangent); the only residual in the
MEASURED seam dihedral is discretization O(‖ζ″‖·Δt) with Δt = 1/`crossSegments`
(computed a-priori as `seamDihedralBoundDeg` and measured — ~0.46° on the
default fixture at `crossSegments = 48`, driven → 0 by refinement). A curvature
term enters only for a doubly-curved surrounding surface (0 on the fixture's
ruled cusp inclines). The proximal free boundary adds no seam-fit error and its
rim vertices ARE the outline points (bit-exact).

Pure Float64, deterministic, no manifold-3d boundary. Same "brand-new op, minor
bump, existing goldens byte-identical" precedent as 0.9.0–0.17.0's pure-Float64
ops: **no `kernel-ops.json` pin added** — regression-pinned by their own analytic
closed-form / determinism / committed-sha256 tests in
`cavity/occlusalPatch.test.ts` (partition matches the closed-form labels, patch
boundary == outline bit-exact, MEASURED seam dihedral < 5° on the MOD fixture +
onlay variant, the FALSIFIABLE flat-lid failure, committed result-hash) +
`cavity/seamDihedral.test.ts` (the closed-form measurement validation). A worker
job (`kernel-workers/jobs/cavityOcclusalPatch.ts`, coarse progress + cancel)
mirrors the cavity inner-surface job.

## [0.17.0] — Phase 5 Task 3: inlay/onlay inner (fit) surface — `cavity/innerSurface.ts` (`buildCavityInnerSurface`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.16.0]`.** Brand-new op only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts`
(byte-pinned stage hashes, not a `test-fixtures/` file), all FIVE geometry
stage pins are verified byte-identical to 0.16.0; only the `crown-standin-qc`
pin changed, MECHANICALLY and metadata-only — the `QcReport` embeds
`kernelVersion` (cad-pipeline/gates/report.ts), so `hashQcReport` tracks every
version bump even with every measured value and geometry hash unchanged (the
same mechanical churn documented at 0.16.0; the unchanged geometry pins are the
proof the qc diff is the version string alone, not numerical drift).

Adds `packages/kernel/src/cavity/innerSurface.ts`:

- **`buildCavityInnerSurface(mesh, params, hooks?)`** — the inlay/onlay inner
  (fit) surface: the two-zone cement-gap offset OFF THE CAVITY SURFACE
  (`marginalGapMm` near the outline ≤ `spacerStartMm`, `cementGapMm` above, C1
  smoothstep blend) + a **solid undercut blockout** (draft-close along the
  insertion axis, so re-scanning the result finds ZERO undercut by
  construction) + a **skirt** stitching the fit-surface boundary EXACTLY onto
  the cavity-outline polyline (the ≤10 µm margin-fit acceptance currency). The
  fit surface is the level set `F(x) = signedDistance(x) − gap(h(x)) = 0`, `gap`
  mm OUTSIDE the closed tooth-with-cavity solid on the void side — the SAME
  operation as the crown intaglio (`buildInnerSurface`), restricted to the
  cavity ROI.
- **Heavy reuse of the P4 crown machinery** (imported, not re-implemented):
  `twoZoneGapField` + the FOOTPOINT height field `distanceToClosedPolyline`
  (offset/innerSurfaceOffset.ts) and the axis-frame rotation + footprint mask +
  `skirtToMargin` zipper + `flipOutwardIfNeeded` (offset/innerSurfaceSolid.ts,
  whose shared helpers are now `export`ed for this reuse — a pure `export`
  addition, so every crown output stays byte-identical). The draft-close
  running-minimum direction is VERIFIED identical to the crown's (both withdraw
  along +Z), not assumed — pinned falsifiably (see below).
- **The ONE genuine difference from the crown, extended not forked: the CROP.**
  The crown crops with one horizontal plane just beyond a roughly-planar margin;
  a true MOD cavity outline is highly non-planar and BREAKS THROUGH the proximal
  faces (opening in +Z AND ±X), which a single plane cannot separate. Instead
  this op crops by the SAME footpoint height field the gap uses — a cell whose
  footpoint is within `SKIRT_BAND = maxGap + 3·pitch` of the outline is set to
  the `+Inf` no-data sentinel — cutting a thin, outline-shape-agnostic band
  around the entire 3-D outline at once and leaving a clean single-loop patch
  the skirt spans to the exact outline. Documented in the module doc + the
  reviewer notes.

`@errorBound`: offset MAGNITUDE bound inherited verbatim from the crown op —
flat marginal/cement zones `pitchMm/2 + eps_f32`, blend zone
`(1+Lgap)/(1−Lgap)·pitchMm/2 + eps_f32` (`Lgap = 1.5·(cementGap−marginalGap)/
blendWidth`); the footpoint height-field evaluation eliminates the
grid-vs-footpoint term; the blockout adds a pitch-scaled draft-fill POSITION
error; the skirt adds no margin-fit approximation (its rim vertices ARE the
outline points). Margin-fit + self-consistency residuals are MEASURED and
reported by the tests/gate.

Pure Float64, deterministic, no manifold-3d boundary. Same "brand-new op,
minor bump, existing goldens byte-identical" precedent as 0.9.0–0.16.0's
pure-Float64 ops: **no `kernel-ops.json` pin added** — the op is
regression-pinned by its own analytic tests in
`cavity/innerSurface.analytic.test.ts`: measured offset accuracy in the cement
and marginal zones within the documented bound, **margin fit ≤ 10 µm on the
cavity outline** (default + onlay variant), a committed sha256 result-hash
(determinism), and the FALSIFIABLE self-consistency pair — **whole-mesh ZERO
undercut on the drafted fixture AND the blockout demonstrably filling the
negative-taper variant's undercut** (whose un-blocked offset scans nonzero,
proving the blockout does real work). A worker job
(`kernel-workers/jobs/cavityInnerSurface.ts`, progress + cancel) mirrors the
crown inner-surface job.

## [0.16.0] — Phase 5 Task 2: cavity region analysis — the `cavity/` module (`classifyCavityRegions`, `scanCavityUndercut`)

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.15.0]`.** Brand-new ops only; no existing
op's algorithm or output changed. In `test/golden/crown-acceptance.test.ts`
(byte-pinned stage hashes, not a `test-fixtures/` file), all FIVE geometry
stage pins are verified byte-identical to 0.15.0; only the `crown-standin-qc`
pin changed, MECHANICALLY and metadata-only — the `QcReport` embeds
`kernelVersion` (cad-pipeline/gates/report.ts), so `hashQcReport` tracks every
version bump even with every measured value and geometry hash unchanged. The
unchanged geometry pins are the proof that qc diff is the version string
alone, not numerical drift.

Adds `packages/kernel/src/cavity/regions.ts`:

- **`classifyCavityRegions(mesh, cavityOutline, insertionAxisUnit, options?)`**
  — classifies the cavity surface ENCLOSED by the cavity outline (the margin
  currency: a dense, closed, on-mesh ring, run through the reused
  `marginLoopPolyline` for dedup/closure) into **floor / axial walls /
  proximal-box walls** relative to the insertion axis. Method (that module's
  doc has the full derivation): outline points snapped to mesh vertices
  (bit-exact key lookup, nearest-vertex fallback within `MESH_WELD_EPSILON_MM`);
  the resulting closed EDGE ring separates the closed 2-manifold into exactly
  two components (barrier flood fill); the CAVITY is the side whose
  area-weighted outward-normal sum (reused `regionAreaWeightedNormalSum`)
  opens along the axis. Floor = `normal·axis ≥ cos(floorMaxAngleDeg)`
  (default 45° — a documented ALGORITHM parameter, echoed in the result for
  journaling); proximal boxes = floor components stepping down ≥
  `floorStepMinMm` (default 0.5 mm) from the reference (highest) floor level
  with a well-defined axis-perpendicular proximal direction; box walls = the
  wall half-space at/beyond each box's pulpal step along that direction.
  Every region is returned in the `AxisRegion` currency (triangle-index
  subsets, sorted — Phase 5 Task 5 consumes the box regions directly).
- **`scanCavityUndercut(mesh, bvh, cavityRegion, axisUnit, options?)`** — the
  P3 `undercutScanIndices` primitive scoped to the cavity region (a cavity's
  undercut = its wall subset facing-away/occluded along the axis), plus the
  sorted mesh-triangle-id list of undercut triangles.

Pure Float64, deterministic, no manifold-3d boundary. Same "brand-new op,
minor bump, existing goldens byte-identical" precedent as 0.9.0–0.15.0's
pure-Float64 ops: **no `kernel-ops.json` pin added** — the op is
regression-pinned by its own closed-form analytic tests (per-region triangle
counts + zero misclassified triangles against the MOD-cavity fixture's
constructed answer, across property-varied parameters) and a committed
sha256 result-hash test in `cavity/regions.test.ts`. The undercut scan is
pinned BOTH ways (falsifiable zero: exactly 0 undercut triangles on the
drafted fixture AND exactly the 20m drafted-wall triangles detected on the
negative-taper variant). No worker job: measured sub-millisecond on the
fixture (see `.superpowers/sdd/p5-task-2-report.md`) — far under the >~10 ms
worker threshold; re-measure when a pipeline stage runs it on a large real
scan.

## [0.15.0] — Phase 4 Task 12b: morph→shell coupling robustness — `shell/healOuterAnatomy.ts` (`healOuterAnatomy`) + `shell/shell.ts` `constructShell` robust trim

**No `kernel-ops.json` / `*.golden.json` fixture hash changed — every pinned
fixture hash is byte-identical to `[0.14.0]`.** The DELIBERATE golden change is
the byte-pinned crown-acceptance STAGE hashes in
`test/golden/crown-acceptance.test.ts` (not a `test-fixtures/` file): the standin
now feeds the MORPHED outer through the heal into the shell — the genuine coupled
`die→inner→place→morph→HEAL→shell→sculpt→qc` lineage — so the anatomyPlacement,
morphing, shell, freeform and qc stage hashes all shifted (only innerSurface, the
same die/intaglio, is byte-identical). That change is guarded by the test's own
`EXPECTED_KERNEL_VERSION` (bumped here to `0.15.0`) + the manifold-3d-version
guard.

**Why this task:** Task 12's diagnostic proved a CLEAN, well-formed RBF-morphed
closed tooth was REJECTED by `constructShell` even though the byte-identical
un-morphed tooth built — a morph→shell coupling robustness gap independent of
scan quality, so NO input (clean or real) built a crown through the genuine
coupled path. 12b closes it.

- **NEW op — `healOuterAnatomy(outerMesh, { pitchMm })`** — a deterministic HEAL
  of the morphed OUTER anatomy between morph (T6) and shell (T7). It SDF-re-meshes
  the closed morphed outer at the zero level set (the exact `offset/offsetMesh.ts`
  pipeline at `distanceMm = 0`): a marching-cubes iso surface is ALWAYS a clean,
  oriented, watertight 2-manifold with no self-intersections and no degenerate
  triangles, so the RBF morph's folds/slivers (invisible to halfedge
  watertightness) are healed BY CONSTRUCTION. Heals only the OUTER; the intaglio
  (the ≤10 µm fit surface) is a separate mesh, never passed here, stitched to its
  EXACT margin as before. `@errorBound = pitchMm/2 + eps_f32` (inherited from
  `offsetMesh` at distance 0): every point of the healed outer — including the
  occlusal/proximal CONTACT loci — is within this of the morph's surface, so the
  morph's achieved contacts shift by at most this bound (surfaced to QC). Pure
  reuse of the offset pipeline ⇒ deterministic (same mesh + pitch + manifold-3d
  version ⇒ byte-identical); regression-pinned by `shell/healOuterAnatomy.test.ts`
  (a self-intersecting folded sphere → clean valid solid; determinism; fidelity),
  no `kernel-ops.json` pin (same additive-op precedent as 0.9.0–0.14.0).
  HONEST LIMIT: an EXTREME through-and-out fold can defeat the marching-cubes
  reconstruction itself (NonManifoldInputError) — the heal rescues clean/mild
  morphs, not arbitrarily-degraded ones (see the real tooth-11 outcome below).

- **CHANGED op — `constructShell`'s CLOSED-outer trim** (`trimClosedOuterToMargin`):
  replaced the fragile centroid-DISCARD (which assumed a clean cervical ring at
  the finish-line plane) with a robust plane-CLIP (Sutherland–Hodgman, splitting
  crossed triangles with sorted-vertex-index-keyed shared split vertices → a
  2-manifold cut, never a T-junction) at a plane a small `marginTrimOffsetMm`
  (new optional param, default `DEFAULT_MARGIN_TRIM_OFFSET_MM = 0.05 mm`) OCCLUSAL
  to the finish line. This was the DOMINANT proximate cause of the coupling gap:
  a real morphed outer's cervical surface WIGGLES across the exact margin plane
  (non-anchor cervical vertices move sub-margin), so a cut AT the finish line
  fragments into many boundary loops → a non-manifold stitch; a cut a hair above
  lands on the clean axial wall → exactly one cervical rim → a watertight stitch.
  Only the OUTER is cut, ABOVE the finish line; the intaglio's ≤10 µm marginal
  seal is untouched (measured: the confirmed margin points stay on the shell
  surface to ≤10 µm — 0.000 µm on the standin). `@errorBound`: the outer shape
  within `marginTrimOffsetMm` of the finish line is replaced by the ruled seam
  band (a marginal collar ≤ 50 µm tall) — above the finish line, outward of the
  intaglio, never perturbing the fit surface.
  **The `kernel-ops.json` `constructShell` golden is BYTE-IDENTICAL**: its fixture
  passes an already-OPEN dome, which skips the trim entirely — only the
  closed-outer path changed.

Result: the flipped diagnostic (`test/golden/morph-shell-coupling.test.ts`) — a
clean morph now BUILDS a watertight, single-component crown through
morph→heal→shell with margin-fit 0.000 µm — and the genuinely-coupled standin
acceptance (all gates pass on the morph-derived shell) prove the coupled
end-to-end crown on clean input. The REAL arch-case-01 tooth-11 STILL blocks
(coupled morph→heal→shell → NonManifoldInputError), now attributable to SCAN
QUALITY (a degraded ~1.64 mm-seal / clamped ~2.47 mm-contact morph beyond
healing), not the coupling — the same tracked-pending pattern as Phase 3.

## [0.14.0] — Phase 4 Task 8: freeform sculpting brushes — `sculpt/sculpt.ts` (`applySculptStroke` / `applySculptGesture` / `computeShellLock`)

**No golden hash changed — every existing `kernel-ops.json`/`*.golden.json`
hash is byte-identical to `[0.13.0]`.** One new kernel module, `sculpt/sculpt.ts`,
adding deterministic add/remove/smooth sculpting brushes for the crown shell
(Task 7), with the FIT SURFACE (inner intaglio + margin + margin-band seam)
LOCKED by default so Task 4's ≤10 µm marginal fit survives sculpting. The ops are
pure Float64 (no manifold-3d boundary), so — like 0.9.0–0.12.0's additive ops —
they add NO `kernel-ops.json` pin; they are regression-pinned by their own
determinism / committed-hash / analytic tests (`sculpt/sculpt.test.ts`). The
minor bump follows the standing "brand-new op ⇒ minor bump + changelog"
discipline even though no pinned hash moved.

- **`applySculptStroke`** — applies ONE stroke `{center, radiusMm, strength,
  brush}` to a mesh, displacing only NON-locked (outer) vertices. The RADIAL
  FALLOFF is the C1-smooth bump `falloff(t) = (1 − t²)²` for `t = d/radius ∈
  [0,1]` (value 1/slope 0 at the centre, value 0/slope 0 at the rim — no crease).
  With `n_v` the pre-stroke area-weighted UNIT vertex normal (snapshotted ONCE,
  so all displacements in a stroke are computed from the same state and are
  order-independent): **add** displaces `+n_v·strength·falloff`, **remove**
  `−n_v·strength·falloff`, **smooth** moves each vertex toward its one-ring
  centroid by `L_v·clamp01(strength)·falloff` (`L_v` = umbrella/Laplacian from
  the pre-stroke snapshot — REDUCES local curvature, Taubin λ-step). `strength`
  is the peak displacement (mm) at the centre for add/remove, a peak blend
  fraction [0,1] for smooth.
- **Fold guard / safe-displacement bound** — a brush only displaces existing
  vertices (no re-triangulation), so the shell's TOPOLOGICAL watertightness
  (manifold-edge / boundary-edge / component structure) is preserved BY
  CONSTRUCTION and re-validated with `analyzeMesh`. The tractable geometric
  failure — a triangle incident to a moved vertex folding to a sliver / flipping
  — is guarded: over the affected triangles, the largest global scale `s ∈ (0,1]`
  at which every affected triangle keeps ≥ `minAreaFraction` (default 0.1) of its
  original area projected on its original normal is found by deterministic
  bisection; the stroke is applied at that `s` (`s = 1` unclamped, `s < 1`
  reported as clamped). This guards LOCAL folds exactly; it does NOT prove the
  absence of a GLOBAL self-intersection between two distant moving patches (out
  of reach of a bounded local-normal displacement on a smooth shell — surfaced
  honestly, not claimed away). Displacement along the vertex normal on a convex
  surface only inflates (safe); the guard binds on tangential (smooth) and
  through-surface (strong remove) motion.
- **`computeShellLock`** — identifies the LOCKED fit surface on the ACTUAL shell
  (robust to the manifold-3d cleanup that reorders the shell's vertices, so the
  `constructShell` triangle-range breakdown is unusable post-cleanup): base lock
  = every shell vertex within `lockInnerEpsilonMm` (default 20 µm — far below the
  0.5 mm min wall, far above the < ~1 µm Float32 cleanup round-trip) of the inner
  intaglio surface (the whole intaglio incl. its exact margin rim); plus an
  optional margin-polyline band; then `seamRingGrowth` (default 2) topological
  one-ring growth steps — the outer cervical rim is stitched DIRECTLY to the
  inner margin rim by the seam, so growth reaches it, guaranteeing every seam
  triangle has all-locked corners and the seam ribbon never moves. Result: the
  ≤10 µm margin fit is preserved because the inner/margin/seam vertices are
  byte-identical before/after any stroke (proven in the tests: margin fit stays
  0.00 µm after a stroke centred on the margin).
- **`applySculptGesture`** — the coalesced, journaled, replayable unit: applies
  an ordered stroke sequence, each to the previous result, with the SAME lock
  frozen throughout (vertex topology is constant so the mask stays valid), and
  re-validates watertight ONCE at the end. Same `(mesh, strokes, locked,
  options)` ⇒ byte-identical mesh, so replaying the journaled strokes reproduces
  the sculpt bit-for-bit (CLAUDE.md invariant 2). Overlapping strokes apply in
  journaled order (order-dependent, deterministically). Measured < 3 ms/stroke on
  a ~3.3 k-vertex shell (< 50 ms interactive budget). Consumed by
  `cad-pipeline`'s freeform stage (`stages/sculpt.ts`, journaled as
  `freeform.sculpt`) and the `applySculptStroke` worker job.

## [0.13.0] — Phase 4 Task 7: shell construction — `shell/shell.ts` (`constructShell` + `measureWallThickness` + `autoThickenOuter`)

**One NEW golden pin added (`constructShell`); every OTHER existing golden hash
is byte-identical to `[0.12.0]`** (verified via the regeneration diff — only the
new `constructShell` entry was added to `test-fixtures/golden/kernel-ops.json`,
op count 20 → 21). One new kernel module, `shell/shell.ts`:

- **`constructShell`** — joins the morphed OUTER anatomy (Task 6) and the
  intaglio INNER surface (Task 4) into a SINGLE WATERTIGHT crown shell. The
  Task-6 morphed tooth is a CLOSED watertight solid (it inherits the placed
  library tooth's topology), so `constructShell` first TRIMS it to an open-
  cervical dome at the margin (`trimClosedOuterToMargin`: discard triangles on
  the apical side of the margin-centroid plane ⟂ the insertion axis) — this is
  the pipeline connection (closed morphed tooth → watertight shell, unblocking
  Task 12). Only the OUTER is cut; the inner intaglio is stitched to its EXACT
  margin rim, so the ≤10 µm marginal seal is preserved untouched (measured: the
  confirmed margin lies 0.00 µm from the resulting shell). A pre-opened dome
  (one cervical rim already) skips the trim. Both surfaces then share the
  crown's finish-line edge: the outer dome open at its CERVICAL rim, the inner
  cup open at the MARGIN rim (== the confirmed margin polyline). The
  two rims are bridged by a **margin-band seam** — a ruled annulus stitched with
  the same deterministic azimuth-fraction zipper `offset/innerSurfaceSolid.ts`'s
  skirt uses (strictly monotone, robust to a jagged marching-cubes rim),
  generalizing `margin/band.ts`'s `marginLoopMesh` (a loop↔its-own-offset ribbon)
  to bridge the two DISTINCT rims a real crown has. The stitched closed 2-manifold
  is then passed through the **manifold-3d wrapper** (`boolean/manifold.ts`'s
  `cleanupMesh`), which validates the oriented-2-manifold invariant + collapses
  degenerate slivers, and the result is re-validated watertight + single-component
  (`analyzeMesh`), throwing `ShellNotWatertightError` otherwise — a non-watertight
  stitch can never masquerade as a shell.
- **`measureWallThickness`** — minimum wall thickness as the inner↔outer closest-
  surface distance. Every triangle of BOTH surfaces is GRID-SAMPLED at ≤
  `maxSampleSpacingMm` (default 0.1 mm — not just at vertices), so a thin spot
  BETWEEN vertices cannot be missed; the min is over both directions. Two error
  sources handled separately: the straight-line distance is a lower bound on the
  through-material thickness (that dimension over-reports thinness), and the
  discrete-sampling gap (the DANGEROUS direction) is bounded by the sample
  spacing and reported as `sampleSpacingMm`, which `minWallThicknessGate`
  SUBTRACTS from the measured minimum before comparing to the threshold — so a
  wall that could be thinner than the threshold within sampling error FAILS.
  Occlusal vs axial classification via the insertion axis.
- **`autoThickenOuter`** — user-invoked, bounded, deterministic outward
  displacement of OUTER vertices whose local wall is below the profile minimum
  (directly away from the nearest inner point; total displacement capped at
  `maxDisplacementMm`), with a small overshoot + fixed convergence passes to clear
  the discretization gap. Never thins anything; reports clamped (bound-limited)
  vertices rather than silently over-ballooning.

**Why `constructShell` IS a `kernel-ops.json` pin (unlike 0.9.0–0.12.0's
additive-only ops):** its output crosses the manifold-3d WASM boundary
(`cleanupMesh`), so its hash depends on the manifold-3d BUILD — exactly the
`union`/`subtract`/`intersect` situation. Pinning it in the manifoldVersion-
guarded `kernel-ops.json` snapshot means a manifold-3d upgrade that changes the
shell hash surfaces AS a manifold-version diff (caught by
`test/golden/kernel-ops.test.ts`'s dedicated version-match assertion), not a
spurious kernel regression. The two pure-Float64 ops (`measureWallThickness`,
`autoThickenOuter`) are regression-pinned by their own analytic + determinism
tests (`shell/shell.test.ts`), not a `kernel-ops.json` entry.

## [0.12.0] — Phase 4 Task 6: adaptation/morphing — `rbf/` (deterministic dense solver + RBF interpolant) + `anatomy/morph.ts` (contact-driven RBF morph)

**NEW ops, no existing golden hash changed.** Every committed golden
(`test-fixtures/golden/kernel-ops.json`, intake/curvature/offset/margins) is
byte-identical to `[0.11.0]` — this bump is purely additive. Two new kernel
modules:

- **`rbf/solve.ts`** — `solveDense`, a dense Float64 linear solver via Gaussian
  elimination with **partial pivoting and a deterministic tie-break** (largest
  |pivot| in the column, lowest row index on an exact tie — the same
  `>`-strict discipline as `bvh/closestPoint.ts`). A DIRECT factorization has a
  fixed arithmetic sequence with no convergence/tolerance loop, so the same
  input yields byte-identical output — the journal-reproducibility bar Task 6
  exists to hit (CLAUDE.md invariant 2). No prior linear-algebra solver existed
  in the kernel.
- **`rbf/rbf.ts`** — `fitRbf`/`evaluateRbf`/`applyRbfDisplacement`, a vector-
  valued RBF displacement interpolant: kernel **φ(r) = r** (the 3-D biharmonic
  polyharmonic spline — parameter-free, so nothing to tune could silently
  change the result) plus a **degree-1 polynomial term** (affine reproduction +
  conditional positive-definiteness). The (N+4)×(N+4) symmetric saddle system
  is solved by `solveDense`, three RHS (x/y/z) against one factorization.
- **`anatomy/morph.ts`** — `planAnatomyMorph`/`solveAnatomyMorph`/`morphAnatomy`,
  the adaptation/morphing stage: deform the placed library tooth (Task 5) so it
  makes correct **proximal** contacts (penetration = `proximalContactPenetration-
  Mm`) and an **antagonist** contact (`occlusalContactMm`) — targets from the
  profile, never hardcoded — while pinning the cervical seal band as fixed
  zero-displacement anchors so Task 4's ≤10 µm marginal seal survives. Contact
  targets are driven to penetration by a FIXED-count root-find (no tolerance
  loop) against the other surface's signed-distance field; far-field anchors
  localize the deformation and make the control set unisolvent. The plan/solve
  split gives an interactive (< 500 ms) slider re-solve. The morph carries a
  MEASURED contact-residual `@errorBound` (achieved vs target penetration).

**No `kernel-ops.json` pin added.** As with 0.9.0–0.11.0, the new ops are
regression-pinned by their own analytic + determinism + committed-hash tests
(`rbf/solve.test.ts`, `rbf/rbf.test.ts`, `anatomy/morph.test.ts`) plus the
synthetic morph golden (`test/golden/anatomy-morph.test.ts`, a pinned
placed-mesh→morphed-mesh sha256 + byte determinism), not by a `kernel-ops.json`
entry. Every existing golden hash is unchanged — this bump follows the same
brand-new-op / minor-bump / existing-goldens-byte-identical precedent as
`[0.11.0]`.

## [0.11.0] — Phase 4 Task 5: anatomy placement — `anatomy/placement.ts` (deterministic transform solve + manual-override API)

**NEW op, no existing golden hash changed.** Every committed golden
(`test-fixtures/golden/kernel-ops.json`, intake/curvature/offset/margins) is
byte-identical to `[0.10.0]` — this bump is purely additive. `anatomy/placement.ts`
adds NO entry to `kernel-ops.json`: it is pure transform math (it reuses the
already-pinned `register/` primitives — `coarseAlignFromPointTriples`,
`multiplyMat4`, `composeRigid`, `applyMat4ToPoint` — and the already-pinned
`margin/band.ts` `computeMarginLoopFrame`), and is regression-pinned by its own
analytic + determinism (byte-identical transform/placed-mesh hash) tests
(`packages/kernel/src/anatomy/placement.test.ts`) rather than a golden-file
snapshot. Verified by a full `npm run test:golden` run against this bump.

### What the new op is

`solveAnatomyPlacement(input)` + `buildPlacementTransform(frame, canonical)` +
`placeMesh(mesh, transform)` place a library tooth into a case with a single
deterministic, closed-form transform solve — no iterative-tolerance
nondeterminism, no randomness/clock:

1. **Target frame from case geometry.** Occluso-gingival axis = the insertion
   axis (re-oriented toward the antagonist when present so a sign-flipped axis
   cannot place the tooth upside-down); mesial-distal axis = the mesial→distal
   neighbour-centroid line orthogonalised against it; bucco-lingual =
   `og × md` (right-handed, matching the canonical frame's `MD×BL=OG`
   convention, so buccal orientation is forced once M-D and O-G are correct).
   Origin = the confirmed margin loop's centroid (the cervical seat).
2. **Anisotropic scale.** `scaleMesialDistal` fills the proximal gap between
   the neighbours (centroid-separation fallback for crowded scans);
   `scaleOcclusoGingival` fills margin→nearest-antagonist-over-the-site
   (antagonist-absent fallback: reuse the M-D factor → undistorted uniform
   scale); `scaleBuccoLingual` reuses the M-D factor (no B-L case datum).
3. **Transform.** `M = R_target · diag(scale) · R_canonicalᵀ` — the rigid
   canonical→target rotation is recovered by the existing
   `coarseAlignFromPointTriples` (Kabsch) fed the two frames' axis-tip triples,
   the anisotropic scale composed about the origin via `multiplyMat4`. Applied
   to a COPY of the immutable library mesh (positive determinant → winding
   preserved).

Manual-override helpers (`translatePlacement`/`rotatePlacement`/
`rescalePlacement`/`solveLandmarkHandleTranslation`) return a new
`PlacementFrame` for deterministic position/rotation/scale + anatomical-handle
edits; a landmark handle re-solves to a pure origin translation that lands the
dragged landmark exactly on target.

`@errorBound` EXACT (Float64, ~1e-13 for the Kabsch frame rotation; every other
step direct arithmetic). Placement is a deterministic initial-pose heuristic,
not an approximation of a continuous quantity, so its `RestorationStageResult`
carries a `null` errorBound.

## [0.10.0] — Phase 4 Task 4: crown inner surface completed — `offset/innerSurfaceSolid.ts`'s `buildInnerSurface` (solid undercut blockout + skirt-to-margin)

**NEW op, no existing golden hash changed.** Every entry in
`test-fixtures/golden/kernel-ops.json` (and every other committed golden —
intake/curvature/offset/margins) is byte-identical to `[0.9.0]` — this bump is
purely additive: it adds one new op file (`offset/innerSurfaceSolid.ts`) and
does not touch any pinned kernel-op's inputs or code path. Verified by a full
`npm run test:golden` run against this bump.

### What the new op is

`buildInnerSurface(mesh, params)` completes the crown intaglio Task 3
(`innerSurfaceOffsetRoi`) started. It produces the FINISHED fit surface — an
open patch whose single boundary loop is exactly the confirmed margin — with
two new construction stages on top of Task 3's two-zone offset:

1. **Solid undercut blockout (draft-close).** In a frame rotated so the
   insertion axis is `+Z`, the cement-gap field `F(x) = signedDistance(x) −
   gap(h(x))` is DENSELY sampled (not banded — a draft-fill wall leaves the
   thin offset band, so the running-minimum needs a correctly-signed field
   everywhere in the ROI; accuracy over speed) and draft-closed by a per-column
   running minimum `G[z] = min(F[z], G[z+1])`. The resulting `{G = 0}` surface
   is downward-closed along the axis, hence undercut-free BY CONSTRUCTION: a
   short proof (`G(x−s·d) ≤ G(x)`) shows the cavity is closed under stepping
   toward the margin, so its upper boundary is single-valued along every axis
   column (no overhang, no self-occlusion, `normal·axis ≥ 0` everywhere). The
   self-consistency test re-scans the WHOLE finished intaglio (patch + skirt +
   occlusion) with `undercutScan`: on any CLINICALLY VALID (in-taper) insertion
   axis — the die's `+Z` and an ~11.5° in-taper tilt — the ENTIRE mesh has ZERO
   undercut (measured), and the die genuinely has undercut before blockout (a
   control asserts that). This closes the P3 composite-interaction gap: the
   morphological field operation handles occlusion the display-only
   `blockoutPreview` could not. On an axis EXCEEDING the die taper (~15° — an
   UNSEATABLE axis, on which the confirmed margin itself cannot draw) the
   offset/blockout PATCH is STILL undercut-free (0 patch facing, 0 patch
   occlusion — measured); the only residual there is the marginal-seal SKIRT
   near the margin (NOT occlusal-cap self-occlusion — measured 0).

2. **Skirt-to-margin (the ≤10 µm marginal seal).** The blocked patch's open
   boundary loop is stitched onto the dense margin `resampledPoints` (CHORD-CAP,
   never anchor chords) by a deterministic index-fraction zipper; the skirt's
   bottom rim vertices ARE the margin points, so the finished boundary loop ==
   the margin polyline (measured margin fit ~0, `<<` the 10 µm gate). Winding is
   made consistent + outward by `orientNormalsConsistently` + a reference-triangle
   flip.

`@errorBound`: the offset magnitude keeps Task 3's chord bound; the blockout
adds a `pitchMm/2` position error on draft-fill walls; the skirt adds NO margin
error (boundary vertices are the margin points). Margin-fit and self-consistency
residuals are MEASURED (not bounded a priori) — see
`offset/innerSurfaceSolid.analytic.test.ts` and `cad-pipeline`'s
`gates/marginFit.ts`.

### Why no `kernel-ops.json` pin

Same precedent as `[0.8.0]`/`[0.9.0]`: the op is regression-pinned by its own
analytic determinism (byte-identical double-run hash) + acceptance tests, which
also assert margin fit ≤ 10 µm and zero facing/draft residual. Adding it to the
shared `kernel-ops.json` snapshot is deferred (its runtime is dominated by the
dense SDF field; the compact-die always-on run is already its regression pin).

## [0.9.0] — Phase 4 Task 3: crown inner surface — `offset/innerSurfaceOffset.ts`'s `innerSurfaceOffsetRoi` (two-zone cement-gap offset + C1 blend)

**NEW op, no existing golden hash changed.** Every entry in
`test-fixtures/golden/kernel-ops.json` (and every other committed golden —
intake/curvature/offset/margins) is byte-identical to `[0.8.0]` — verified
by a full `npm run test:golden` run against this bump. This is a genuinely
new piece of kernel surface, not a behavior change to anything existing.

**`offset/innerSurfaceOffset.ts`'s `innerSurfaceOffsetRoi`** — the crown
INNER-SURFACE (intaglio / cement-gap) geometry, PLAN.md §4 Phase 4 stage 1's
opening step. A spatially-VARYING outward offset of the prep with two zones
and a C1-smooth blend, extracted by the same SDF -> marching cubes machinery
`offsetMesh`/`offsetMeshRoi` use, restricted to the prep ROI:

- **Formulation.** Instead of a constant-iso offset, it extracts the level
  set `F(x) = signedDistance(x) - gap(h(x)) = 0`, where `gap(h)` is a C1
  ramp from `marginalGapMm` (near margin) to `cementGapMm` (above the spacer
  line) via a smoothstep across `blendWidthMm` centred on `spacerStartMm`. It
  builds the grid `G = signedDistance - gap(h)` and runs marching cubes at
  iso = 0 — the blend is built into the ramp, no MC-side special-casing.
- **Height field `h(x)` — the design decision.** `h` = EUCLIDEAN distance to
  the margin loop polyline, evaluated at the grid point's FOOTPOINT on the
  prep (`signedClosestPoint`'s `.point`, already computed for the SDF value —
  so it is free), NOT at the off-surface grid point (option C, documented
  against the geodesic and plane-projection alternatives in the module doc).
  Chosen because it is 0 EXACTLY on the margin for any loop shape (so the
  marginal band genuinely hugs the margin — closing the plane-proxy's
  non-planar degradation), it equals along-surface distance EXACTLY on a ruled
  axial wall (clean analytic golden on the cone die), it is a LOWER bound on
  true geodesic arc length in general (spacer line never lands lower than
  nominal — the clinically safe direction), and it needs no off-surface field
  extension. Evaluating at the footpoint makes `gap` a property of the surface
  location (constant along the normal through it), which REMOVES the
  grid-vs-footpoint displacement term (up to `|signedDistance| <= cementGapMm`,
  ~7.5µm of blend-zone gap error at the standard gaps) rather than merely
  bounding it.
- **`@errorBound`.** Offset chord bound is `pitchMm/2` in the flat
  (marginal/cement) zones and `(1+Lgap)/(1-Lgap) * pitchMm/2` inside the
  blend (`Lgap = 1.5*(cementGapMm-marginalGapMm)/blendWidthMm`); the result
  carries BOTH (`flatZoneErrorBoundMm` and the worst-case `errorBoundMm`),
  plus the reused Float32/mu-clamp term. Because `h` is evaluated at the
  footpoint, there is NO grid-vs-footpoint gap-displacement term; the only
  residual height-field effect is the intrinsic Euclidean-vs-geodesic
  arc-vs-chord under-estimate, a blend-POSITION bound (0 on the analytic cone
  die), reported separately.
- **Output.** An OPEN, welded patch (no manifold cleanup — `offsetMeshRoi`'s
  documented shape); a later Phase 4 stage skirts/stitches it into the closed
  shell.

MEASURED on the analytic shoulder-prep die (compact variant, clinical pitch
0.02mm): marginal-zone offset max deviation 3.28µm and cement-zone 0.82µm
(both against the tight `pitchMm/2 = 10µm` flat-zone bound; targets 20/50µm),
blend monotonic with max drop 0.37µm across the spacer line, margin boundary
reaching to within ~29µm of the margin — see
`packages/kernel/src/offset/innerSurfaceOffset.analytic.test.ts` for the full
reported numerals and `.superpowers/sdd/p4-task-3-report.md`.

**No `kernel-ops.json` pin added** — same decision as `[0.8.0]`'s
`offsetMeshRoi`/`margin/band.ts`: the op is regression-pinned by its own
analytic determinism (double-run byte-identical hash) and zone/blend
accuracy tests, which run every `npm test`; a `kernel-ops` snapshot would add
a heavy die-scale SDF/MC run to the golden lane for no coverage the analytic
test doesn't already give. The worker job (`innerSurfaceOffset`,
`kernel-workers/src/jobs/innerSurface.ts`) is pinned byte-identical to a
direct kernel call by `innerSurfaceJob.test.ts`.

## [0.8.0] — Phase 4 Task 1: cad-pipeline scaffold carry-ins — `offsetMeshRoi` (die-offset ROI-band perf fix) + `margin/band.ts` (margin-band primitive)

**NEW ops, no existing golden hash changed.** Every entry in
`test-fixtures/golden/kernel-ops.json` (and every other committed golden —
intake/curvature/offset/margins) is byte-identical to `[0.7.1]` — verified
by a full `npm run test:golden` run before this bump. This bump is for two
genuinely NEW pieces of kernel surface, not a behavior change to anything
existing:

1. **`offset/offsetMesh.ts`'s `offsetMeshRoi`** — the die-offset ROI-band
   perf fix (Phase 3 carry-in). Restricts the SDF grid's DOMAIN (bbox) to a
   caller-supplied ROI instead of the input mesh's own full bbox — every
   other stage (BVH, pseudonormals, the watertight gate) still runs over the
   FULL, unrestricted mesh, so every sampled SDF value is the exact correct
   value at its own world coordinate, and accuracy is preserved regardless of
   grid alignment (proven by construction — `computeSdfGridSlice`'s per-point
   value depends only on `mesh`/`bvh`/`pseudonormals`/the point's own world
   coordinates, never the grid's overall extent). Note this is an
   accuracy-per-sampled-point guarantee, not a cell-for-cell identity
   guarantee: the ROI grid's lattice coincides with the full-bbox grid's
   lattice only when the ROI bbox's min corner differs from the full bbox's
   min corner by an exact integer multiple of `pitchMm` on every axis — see
   `offsetMeshRoi`'s module doc for the full argument and
   `offsetMeshRoi.test.ts` for the byte-identity (aligned-lattice case) +
   interior-accuracy tests). MEASURED on
   `standin-prep-die.stl` at the clinical default pitch (0.02mm): the
   existing full-bbox `offsetMesh` golden's own die case took **117.9s**
   (reproducing P2 Task 7's original 117-126s measurement); the SAME offset
   restricted to a shoulder-collar ROI (`z in [-0.1, 0.7]`, full XY) took
   **6.1s** — a 19.3x speedup, comfortably under this task's <10s target
   (`test/golden/offset.test.ts`'s `RUN_OFFSET_ROI_PERF=1`-gated test).
   Result is deliberately an OPEN (uncleaned) patch, not a solid — documented
   in the function's own doc.
2. **`margin/band.ts`** — the margin-band primitive: `marginLoopPolyline`
   (dense on-surface loop, CHORD-CAP guarded — never derives geometry from
   anchor chords), `computeMarginLoopFrame` (Newell's-method plane
   normal/centroid/orthonormal tangent basis), `marginLoopMesh` (the loop as
   a thin open ribbon for future boolean stitching). Analytic-tested on a
   circular margin (`band.test.ts`) — exact centroid/normal/radius, and a
   halfedge-topology validity check on the ribbon mesh.

**Golden pinning deferred, honestly**: neither op has a `kernel-ops.json`
entry yet (unlike prior "NEW op" bumps — icpRegister/proposeMargin/
suggestAxis/blockoutPreview each gained one). Both are Phase 4 Task 1
SCAFFOLD primitives with no pipeline stage consuming them yet — pinning a
golden now would fix an interface shape (ROI bbox choice, ribbon
`halfThicknessMm` default) before Task 3/4 actually wires them into a real
stage with real fixtures. Each is instead covered by dedicated
analytic/property/determinism unit tests in this same commit; a golden pin
is the natural next step once a real stage consumes them.

## [0.7.1] — Final-review fix batch 2 (Important 13): drop non-reproducible `elapsedMs` from the `suggestAxis` golden meta

No kernel algorithm or output changed — every op's `hash` in
`test-fixtures/golden/kernel-ops.json` is byte-identical to `[0.7.0]`. The
ONLY change is that the `suggestAxis` entry's `meta` object no longer
carries `elapsedMs` (wall-clock timing of that op's real-fixture run,
`scripts/kernel-ops-lib.ts`'s "18. suggestAxis" block). `elapsedMs` was
never an input to that entry's `hash` (see the op's own `sha256Of(...)`
call — it hashes `best`/`rankedCount`/`poleUsed`/`coarseCount`/
`refineCount` only), so removing it changes NOTHING about what this golden
verifies; it only removes wall-clock noise from the COMMITTED file itself,
which previously made `npx tsx scripts/generate-kernel-goldens.ts` produce a
different `kernel-ops.json` on every single run (a fresh timing number, every
time) even with zero real kernel change — exactly the "small numeric diff
in golden files" CLAUDE.md's policy warns against investigating-not-
regenerating over, except this one was guaranteed to fire on every
regeneration, not a real signal. The measured timing itself is still
enforced (the existing <8s CI-safe bound check in `kernel-ops-lib.ts` is
unchanged) and still printed to the console during generation for a human
to read — only its presence in the diffed, committed golden file is
removed. This is a genuine golden-file CHANGE (the JSON file's bytes
differ), so it goes through the same bump+changelog discipline as any other
golden change, per this policy's own point 2 — a "more honest" file is
still a changed file the version-gate must see, not an exemption.

## [0.7.0] — Phase 3 Task 10: undercut blockout preview (`blockout/` module, "virtual wax")

**NEW op.** Adds `packages/kernel/src/blockout/` — `blockoutPreview(mesh, bvh,
region, directionUnit, thresholdMm, options?)`: a DISPLAY-ONLY preview of
where/how much material would need to be blocked out (wax-filled) to
eliminate undercut along a candidate insertion axis, for the insertion-axis
tool (Phase 3 Task 9) to show DURING axis selection. **Scope boundary,
repeated because it matters**: this is a preview PATCH mesh, never a
watertight solid, never unioned with the prep, never fed back into any other
kernel geometry op (branded `BlockoutPreviewMesh`, mirroring `decimate.ts`'s
`RenderOnlyMesh`) — the REAL blockout construction, unioned into the
inner-surface stage, is PLAN.md §5 Phase 4's job.

**Construction** (two granularities of `undercut/undercutScan.ts`'s
existing `depthMm` machinery, deliberately): (1) triangle SELECTION —
`undercutScanIndices` over `region.triangleIndices`, keeping triangles where
`undercut[t] === 1 AND depthMm[t] > thresholdMm`; (2) per-VERTEX
DISPLACEMENT — for every unique vertex of a selected triangle, a FRESH,
independent depth sample from that vertex's own position
(`sampleDepthAlongAxis`, undercut/undercutScan.ts's `depthFromSample` made
public), displacing it to `original + axis * depth` — the point where the
`+axis` ray first exits the solid, i.e. the visibility horizon "from above".
Output triangle winding is REVERSED relative to the source triangles — a
MEASURED necessity (not cosmetic): a smoothly-varying displacement field
does not itself flip a triangle's facing sense, but the physical role of the
surface flips (it now bounds the newly added WAX, not the original cavity)
— see blockoutPreview.ts's "Winding is REVERSED" doc for the measured
before/after numbers on the tilted-cylinder fixture.

**`@errorBound`**: two independent, documented approximation sources — (1)
selection error, inherited verbatim from `undercutScanIndices`'s own
sampling-policy bound; (2) NEW "displacement incoherence" — independent
per-vertex rays give no global smoothness guarantee, unbounded in the worst
case (see blockoutPreview.ts's doc, and the honest measured canopy-fixture
residual below). No fixed numeric bound is claimed, same character as
`undercutScan.ts`'s own sampling-policy doc.

**Measured self-consistency** (this task's report has the full numbers):
re-scanning the PREVIEW mesh (fresh BVH) along the SAME axis —
- Tilted-cylinder analytic fixture (a=90deg): displaced vertex positions
  match the derived closed-form horizon point to `~1.3e-15` mm.
- Cone-frustum "prep-die" fixture, tilts 15/20/25/30/45deg beyond its own
  ~9.46deg zero-undercut cone: **MEASURED EXACT ZERO** residual undercut at
  every tilt tested (a single connected solid).
- Canopy fixture (three DISCONNECTED undercut regions sharing one (x,y)
  footprint, an adversarial multi-region stress case, not a realistic prep
  shape): displacement pulls the three regions into mutual vertical
  alignment, creating NEW inter-region occlusion within the combined
  preview — **MEASURED 4 of 6 selected triangles residually undercut**
  (`maxDepthMm = 1`, exactly the canopy's own thickness) — a genuine,
  documented limitation, not a hidden failure.

**Golden impact**: ONE new pinned entry, `blockoutPreview` (arch-case-01
upperjaw, SAME ROI as the `suggestAxis` entry — tooth 11's reference margin,
radiusMm=2 — direction = the WORST-ranked candidate `suggestAxis` itself
evaluated, deliberately, so this real-fixture golden exercises a genuine
non-empty preview rather than the near-zero-undercut result the BEST
candidate would give; `thresholdMm = DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM`
= 0). Every other op entry is UNCHANGED (verified — `sampleDepthAlongAxis`
is new, `depthFromSample`'s existing behavior and every other undercutScan
function is untouched). Note: the pinned direction is intentionally a
WORST-CASE, non-clinically-representative axis (chosen to guarantee a
non-empty golden) — its `maxDisplacementMm` (~20.6mm) is not a realistic
clinical blockout depth, see this task's report.

**Also adds** `packages/clinical-profiles/src/constants.ts`'s
`DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM` (aliases
`STANDARD_ZIRCONIA_PROFILE.undercutBlockoutThresholdMm`, PLAN.md §3's "0 µm"
row — the profile field itself already existed, unwired, since Phase 3 Task
2).

## [0.6.0] addendum — Fix batch: HONESTY correction to the default-budget accuracy claim + `AXIS_SEARCH_PRESETS` (no version bump)

**Correction.** [0.6.0]'s original "Measured accuracy" prose (below) did not
itself repeat the false claim, but `.superpowers/sdd/p3-task-9-report.md`'s
"Analytic accuracies" section did: it stated `best.scoreMm3 = 0` ("zero
undercut achieved") on the cone-frustum and bridge analytic fixtures under
the DEFAULT 24+8 search budget. **That was false.** A reviewer reproduced
the real numbers and they have been re-verified directly here: at the
default `interactive` budget, the frustum fixture's best candidate has
**`scoreMm3 ≈ 28.82 mm³`** (4.7% of the ROI still undercut, `maxDepthMm ≈
8.11mm`) at **9.58°** angular error — a genuine, non-zero residual, not
zero. The bridge fixture is the same story (`scoreMm3 ≈ 25.8 mm³` per
abutment). The algorithm itself is NOT broken: at a higher search budget
(`refineCount: 200`, `refineCapAngleRad: 0.3` — now exposed as
`AXIS_SEARCH_PRESETS.precise`, see `suggestInsertionAxis.ts`), the SAME
fixtures converge to `scoreMm3 = 0` exactly at 9.20° (inside the fixture's
own ~9.46° zero-undercut cone). The default `interactive` budget is a
deliberate, documented interactivity/precision trade (tuned for <2s on the
real arch-case-01 upperjaw ROI) — the live µm-depth undercut heatmap plus
manual angle-slider adjustment is the designed clinical accuracy backstop,
not a missing feature this correction reveals.

**Golden impact: NONE.** No default parameter changed — `AXIS_SEARCH_PRESETS`
is a purely additive new export (`{ interactive: {24, 8}, precise: {refineCount:
200, refineCapAngleRad: 0.3} }`); `suggestInsertionAxis`'s own default options
are untouched. `test-fixtures/golden/kernel-ops.json`'s `suggestAxis` entry
(computed with default options) is verified byte-identical. Per this file's
own policy ("a bump with no corresponding hash diff would be exactly the
kind of unjustified version churn this policy exists to prevent" — see the
[0.1.0] addendum below for the same reasoning applied previously), no
`KERNEL_VERSION` bump.

**New test coverage**: `suggestInsertionAxis.analytic.test.ts` gained (a) a
documented residual-score upper bound on the existing default-budget frustum
and bridge tests (so a regression pushing the default search meaningfully
off-optimum now fails there, not just on angle), and (b) new HIGH-BUDGET
variant tests (frustum + bridge) asserting `scoreMm3 === 0` at the `precise`
preset — proving the search genuinely converges to the analytic optimum, not
just "gets close on angle". See
`.superpowers/sdd/p3-task-9-report.md`'s corrected "Analytic accuracies"
section for the full numbers.

## [0.6.0] — Phase 3 Task 9: insertion-axis auto-suggestion (`axis/` module)

**NEW op.** Adds `packages/kernel/src/axis/` — insertion-axis auto-
suggestion for the restoration workflow:

- `roi.ts`: `extractMarginRegion`/`marginRegionVertexBall` — the ROI (region
  of interest) around a margin loop, via a MULTI-SOURCE Dijkstra ball over
  the mesh's vertex adjacency graph (graph distance, a documented
  conservative upper bound on true geodesic distance — same method/
  rationale as `margin/marginRidge.ts`'s `boundedVertexRegion`, generalized
  to many seed points in one shared expansion). `unionRegions` (bridges: the
  common-axis search region is the union of every abutment's own ROI).
  `AXIS_DEFAULT_ROI_RADIUS_MM` (2mm) — measured to keep a full suggestion
  sweep under ~2s on the real arch-case-01 upperjaw (see below).
- `hemisphere.ts`: `fibonacciHemisphereDirections`/`fibonacciCapDirections`
  — deterministic, unseeded-random-free Fibonacci/golden-angle equal-area
  direction sampling (a full hemisphere for the coarse sweep, a small polar
  cap for the fine refinement sweep).
- `suggestInsertionAxis.ts`: `suggestInsertionAxis`/
  `suggestInsertionAxisForRegions` — deterministic coarse->fine search over
  the ROI, scored by a depth-weighted undercut-area objective
  (`undercutScanIndices`/`undercutScanBatchIndices`, see below, restricted
  to the ROI's own triangles). `deriveHemispherePole` seeds the search
  around the ROI's own area-weighted outward normal. Documented,
  tie-break-tested determinism (ties resolve to the pole-nearest, earliest-
  generated candidate — verified analytically on a sphere patch, "no
  undercut anywhere" case). Bridges: one COMMON axis over the union region +
  a per-abutment undercut report at that axis (`suggestInsertionAxisForRegions`).

**NEW primitives in `undercut/undercutScan.ts`**: `undercutScanIndices`/
`undercutScanBatchIndices` — the SAME per-triangle facing+occlusion rule as
`undercutScan`/`undercutScanBatch` (refactored into a shared private
`scanTriangle` helper; existing `undercutScan`/`undercutScanBatch`/
`undercutScanRange` behavior is UNCHANGED — verified: their own golden entry
and full test suite are byte-identical), but evaluated ONLY for an explicit,
arbitrary triangle-index SUBSET rather than the whole mesh. **Why this was
necessary, not just an optimization:** an earlier draft of `axis/` restricted
only the SCORING to the ROI and ran `undercutScanBatch` over the FULL mesh
for every candidate direction, reasoning (from an extrapolation) that a
~50-direction whole-mesh sweep would cost ~0.5-1s on the real 250k-triangle
arch-case-01 upperjaw. MEASURED reality: a 48-direction whole-mesh sweep
actually took ~45 SECONDS — `undercutScan`'s occlusion rule means almost
every strictly-facing triangle also gets a real BVH raycast, so whole-mesh
cost is `O(mesh triangleCount)` per direction, not "mostly cheap, raycasts
only for the interesting few". Restricting the SCAN itself (not just the
objective) to the ROI's triangles — while every raycast still queries the
FULL BVH, so occlusion by geometry outside the ROI is still detected
correctly — brought the real-fixture suggestion timing down to ~1.6-1.7s
in-process (~1.9s in-worker, incl. postMessage/transfer overhead), meeting
this task's <2s interactivity target. See `axis/suggestInsertionAxis.ts`'s
"Why the ROI restricts the SCAN's triangle set" doc for the full account.

**Golden impact:** every existing `kernel-ops.json` entry is UNCHANGED
(verified — the `undercutScanIndices` refactor is behavior-preserving for
the pre-existing functions, and no other op touches `axis/`). ONE new
pinned entry, `suggestAxis` (arch-case-01 upperjaw, ROI extracted from tooth
11's committed hand-traced reference margin at `roiRadiusMm=2`, default
`suggestInsertionAxis` params — a fixed margin -> fixed suggestion, with a
generation-time <8s CI-contention-safe runtime self-check; the real <2s
interactivity target is measured/reported separately, in isolation).

**Measured accuracy** (this task's report has the full numbers): a
synthetic tapered-frustum fixture (analytic construction axis `[0,0,1]`)
recovers the true axis within ~9.6 degrees (coarse+refine defaults: 24 + 8 =
32 directions); a sphere-patch region with no undercut at any sampled
direction ties at score 0 everywhere, resolving deterministically to the
region's own derived pole (tested directly, not just asserted).

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
