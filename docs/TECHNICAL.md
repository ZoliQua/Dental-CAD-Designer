# DQ Dental CAD — technical documentation

This document describes how DQ Dental CAD builds and validates restorations:
the geometry kernel, the design pipelines (crown, inlay/onlay, bridge), the
offsets and their error bounds, the QC gates that block export, and the
independent server re-validation. It is written for engineers and dental
technicians who want to evaluate, extend or integrate the software.

The documentation describes **kernel 0.45.0**. Where this document and the
code disagree, the code wins: every module carries its own TSDoc, including
an `@errorBound` on every approximating algorithm. The architectural
decisions live in [`docs/adr/`](adr/), the phase plans in
[`docs/plans/`](plans/), and the measured acceptance evidence per phase in
[`docs/demos/`](demos/).

> **Not a medical device.** This software is not certified under EU MDR
> 2017/745, by the FDA or by any other authority. Its results are
> fixture-proven (see [Validation status](#9-validation-status-what-is-and-is-not-proven)).
> Any clinical or manufacturing use is the responsibility of the user, who
> must validate the output for that use.

## Contents

1. [Architecture](#1-architecture)
2. [Invariants: precision, determinism, journaling](#2-invariants-precision-determinism-journaling)
3. [Clinical parameters and material profiles](#3-clinical-parameters-and-material-profiles)
4. [Offsets and the intaglio (inner surface)](#4-offsets-and-the-intaglio-inner-surface)
5. [The crown pipeline](#5-the-crown-pipeline)
6. [Inlays and onlays](#6-inlays-and-onlays)
7. [Bridges: abutments, pontics, connectors](#7-bridges-abutments-pontics-connectors)
8. [QC gates](#8-qc-gates)
9. [Validation status: what is and is not proven](#9-validation-status-what-is-and-is-not-proven)
10. [Export, server re-validation and traceability](#10-export-server-re-validation-and-traceability)
11. [Testing and reproducing the results](#11-testing-and-reproducing-the-results)
12. [Extending and integrating](#12-extending-and-integrating)

## 1. Architecture

```
React UI shell (panels, i18n, theme)               apps/client/src/ui
        │  zustand snapshots
Engine (imperative TS, Three.js, Float32 copies)   apps/client/src/engine
        │  Comlink RPC, transferable buffers
Worker pool                                        packages/kernel-workers
   ├─ kernel     Float64 geometry core             packages/kernel
   ├─ manifold-3d (WASM) booleans and repair       via packages/kernel/src/boolean
   └─ io         STL/PLY parse and write           packages/io
Restoration stages and QC gates                    packages/cad-pipeline
Material profiles (versioned, checksummed JSON)    packages/clinical-profiles
Tooth library (procedurally generated anatomy)     packages/tooth-library
Traceability document (JSON schema + HTML)         packages/traceability
Node server (Fastify, Prisma, SQLite)              apps/server
```

The layer rule `ui → engine → kernel-workers → kernel` is enforced by lint.
`kernel` and `io` are pure TypeScript with no DOM and no Three.js, so the
same code runs in a browser worker and in Node. The server re-validates
exports with this same kernel (section 10).

The client also runs on its own as a static site ("client-only mode"):
import, viewing, analysis and design work in the browser, but no
manufacturing file is ever released without the server.

## 2. Invariants: precision, determinism, journaling

- **Float64 everywhere in the kernel.** All coordinates, transforms and math
  in `kernel`, `io` and `cad-pipeline` are Float64. `Float32Array` exists
  only in render copies. Prep dies are about 10 mm objects with 50 µm
  features, and chained Float32 operations accumulate visible error.
- **Determinism.** The same inputs, parameters and kernel version give
  bit-identical outputs. There is no unseeded randomness and no wall-clock
  time in computations. Fixed iteration counts and lowest-index tie-breaks
  are used throughout. Transcendental functions (`sin`, `cos`, `atan2`,
  `acos`, `exp`, `pow`) go through `kernel/src/math/detMath.ts`, because the
  platform `Math` functions differ in the last bit between arm64 and x64
  (lint-enforced).
- **Journal.** Every destructive operation appends an `Operation` to the
  case journal: the op name, its parameters, its input and output mesh
  hashes, and the kernel version. Replaying the journal on the source scans
  reproduces identical hashes, and CI checks this.
- **Immutable, content-addressed meshes.** An operation returns a new mesh,
  addressed by its SHA-256 hash. A stored buffer is never mutated.
- **No silent data mutation.** A unit rescale (STL carries no units), a
  mesh repair or a normal flip needs explicit confirmation and a journal
  entry.
- **Golden files.** The output hashes of the pipelines are pinned. They
  change only with a deliberate kernel version bump and an entry in
  [`docs/CHANGELOG-kernel.md`](CHANGELOG-kernel.md) that explains the
  numerical difference.

## 3. Clinical parameters and material profiles

Clinical values live only in `packages/clinical-profiles`; pipeline code
never hardcodes a gap, a thickness or a connector area. A profile is a JSON
file with a schema and a SHA-256 checksum, and it is selected per case. Its
id, version and checksum are journaled and written into the traceability
document.

| Parameter | Standard zirconia 1.4.0 | e.max lithium disilicate 1.3.0 |
|---|---|---|
| Cement gap | 50 µm | 50 µm |
| Marginal gap | 20 µm | 20 µm |
| Spacer start above the margin | 0.8 mm | 0.8 mm |
| Minimum wall, axial | 0.5 mm | 0.8 mm |
| Minimum wall, occlusal | 0.5 mm | 1.0 mm |
| Proximal contact penetration | +20 µm | +20 µm |
| Occlusal contact | 0 µm | 0 µm |
| Connector area, posterior / anterior | 9 / 7 mm² | 9 / 7 mm² |
| Inlay / onlay minimum thickness | 0.5 / 0.5 mm | 1.0 / 1.0 mm |
| Cusp-coverage minimum thickness | 0.7 mm | 1.5 mm |
| Framework minimum thickness | 0.5 mm | 1.0 mm |
| Veneering space (framework mode) | 1.0 mm | 1.0 mm |
| Pontic: hygienic clearance | 2.0 mm | 2.0 mm |
| Pontic: modified ridge-lap relief | 50 µm | 50 µm |
| Pontic: ovate depth | 1.0 mm | 1.0 mm |
| Export maximum chord deviation | 5 µm | 5 µm |

These are documented defaults. They must be checked against the material
manufacturer's instructions for use before clinical work. Other constants in
`constants.ts`:

- the default offset voxel pitch, 20 µm;
- the cervical-fit maximum residual, 50 µm;
- the proximal contact height bands: 60–95 % of the crown height for
  anterior teeth, 45–90 % for posterior teeth (clinical placeholders).

## 4. Offsets and the intaglio (inner surface)

The intaglio is built by `buildInnerSurface` (`kernel/src/offset/`), in one
journaled operation:

1. **Two-zone offset.** The prep surface is offset by the marginal gap near
   the margin and by the cement gap above the spacer start line. The two
   zones are joined by a smoothstep blend. The zone parameter `h` is the
   Euclidean distance to the margin polyline, so `h = 0` holds exactly on
   the margin for any loop shape.
2. **The offset method.** The signed distance field of the prep is sampled
   on a voxel grid (default pitch 20 µm), the offset iso-surface is
   extracted by marching cubes, and the result goes through manifold
   cleanup. The grid covers only the prep region above the margin, but the
   distance queries run against the full mesh.
3. **Undercut blockout** along the insertion axis (a solid draft close).
4. **Skirt to the margin.** The open boundary of the intaglio is the
   confirmed margin polyline (the marginal seal).

**Error bound.** In a zone where the gap is constant, a produced vertex lies
within `pitch / 2` of the true offset surface (10 µm at the default pitch).
Inside the blend the field is `(1 + L)`-Lipschitz, with
`L = 1.5 · (cementGap − marginalGap) / blendWidth`, and the bound is
`(1 + L) / (1 − L) · pitch / 2`. The worst-case (blend) bound is carried in
the result as `errorBoundMm` and reported in the QC report. The pitch is a
journaled parameter.

Independently of the construction, the **margin-fit gate** re-measures the
finished intaglio. It finds the margin boundary loop topologically and
requires its maximum distance to the dense, on-surface margin spline to be
at most 10 µm (section 8).

On an open intraoral scan, `extractPrepDie` first cuts a **closed prep die**
(Phase 10, [ADR-023](adr/023-closed-prep-die-from-an-open-scan-and-cervical-fit.md)).
The kept scan surface is verbatim, and the synthetic closure carries a
measured clearance certificate. The intaglio, the seating gate and the
server re-validation all use this die.

## 5. The crown pipeline

The stages run in a fixed order, and each stage's output is journaled:

1. **Prepared die.** A closed, certified die from the scan (section 4).
2. **Margin line and insertion axis.** The margin line is proposed by
   curvature-ridge detection and completed and edited by hand: control
   points snap geodesically to the surface, and validation rejects open or
   self-intersecting lines. The insertion axis is suggested by minimizing
   the undercut area over the direction hemisphere, and is shown with a live
   undercut heatmap.
3. **Intaglio.** The two-zone offset, blockout and skirt (section 4).
4. **Anatomy placement.** A tooth-library template is placed by FDI number,
   with its cervical ring fitted to the margin's emergence loop. The fit is
   refused above a 50 µm residual, and the built-in template is then used
   with the reason shown. With an antagonist, the crown's height comes from
   the antagonist. Without one, it comes from the captured neighbours'
   occlusal level, lifted only as far as needed to cover the intaglio with
   the occlusal minimum wall. Any lift is reported as insufficient occlusal
   reduction ([ADR-027](adr/027-crown-height-from-the-neighbours-occlusal-level.md)).
5. **Morph.** A deterministic RBF morph brings the proximal contacts to their
   target penetration on the neighbours, and the occlusal contact to the
   antagonist. The cervical ring is held fixed so the marginal seal is
   preserved. Each contact target is verified on the neighbour's real scan
   surface, never on a capture's synthetic closure
   ([ADR-026](adr/026-verified-contact-targets-and-ring-split-tolerance.md)).
6. **Shell.** The outer anatomy and the intaglio are joined at the margin
   band into one watertight solid, with an optional bounded, re-checked
   auto-thicken.
7. **Freeform sculpting.** Add, remove and smooth brushes act on the outer
   surface only. Every stroke is journaled.
8. **QC.** The crown gate set (section 8).

Neighbours and the antagonist are captured from the case's own scans: one
pick per side, inside a capture window oriented by the margin and the
insertion axis. A gate measured on a stand-in input fails closed until it is
acknowledged ([ADR-022](adr/022-design-inputs-from-the-case-geometry-provenance.md)).

## 6. Inlays and onlays

The inlay and onlay pipeline is a cavity-driven variant of the crown
pipeline. The margin traces the cavity outline. The intaglio is the cavity
offset with the insertion-axis blockout. The outer surface is an occlusal
anatomy patch blended into the surrounding tooth surface: a Hermite
cross-sweep ([ADR-008](adr/008-occlusal-patch-hermite-cross-sweep.md)) and
an exact weld of the inlay shell ([ADR-009](adr/009-inlay-shell-exact-weld.md)).

- Class II proximal boxes get their own contact adaptation.
- An onlay adds cusp-coverage regions with their own minimum thickness.
- The **seam dihedral gate** requires G1 continuity along the seam: a
  dihedral angle below 5°.

## 7. Bridges: abutments, pontics, connectors

**Shared insertion axis** ([ADR-011](adr/011-bridge-shared-insertion-axis.md)).
A bridge has one common insertion axis. `assessSharedAxis` reports the
undercut per abutment at that axis, and the axis is acceptable only if
**every** abutment has zero undercut. Each abutment's intaglio is built with
the crown's `buildInnerSurface`, against the shared axis.

**Pontics.** A pontic is a library tooth placed between the abutment units.
Its base is shaped against the edentulous ridge (the gingiva scan) in one of
three clinical styles:

- hygienic, with a 2 mm clearance;
- modified ridge-lap, with a 50 µm relief;
- ovate, with a 1 mm depth.

All three values come from the profile. The ridge crest is fitted from the
gingiva scan by a normal-PCA axis and a least-squares circle fit. The fit's
measured radial residual is reported in the pontic-relief gate.
`measurePonticRelief` then measures the signed distance between the shaped
base and the gingiva mesh over the style's acceptance patch. The **pontic
relief gate** passes only if the worst deviation from the configured relief
is within **±20 µm**.

**Connectors** ([ADR-012](adr/012-connector-mesh-lower-bound-area-gate.md)).
One connector is placed per adjacent unit pair, as a deterministic ruled loft
between two closed 2D cross-section profiles, perpendicular to the line
between the unit centroids. The profiles are editable (validated closed,
simple and consistently wound), and the area readout is live. The gate value
is a **proven lower bound on the minimum cross-section of the real
triangulated solid**, never the ideal analytic minimum:

- The solid is sectioned at dense stations along the connector.
- A second-difference margin, `max |A(k−1) − 2A(k) + A(k+1)| / 8`, bounds
  the deepest waist that could hide between two stations.
- The reported value is the sampled minimum minus that margin.

On an adversarial 45°-twisted connector, the ideal analytic minimum
over-reports the true waist by about 0.2 mm². The lower bound equals the
dense-sampled ground truth. The target is 9 mm² if either spanned tooth is a
premolar or molar (FDI position 4–8), otherwise 7 mm². The stricter target
wins at an anterior–posterior boundary.

**Framework mode** cuts the anatomy back by the veneering space, and it
checks the framework minimum thickness instead of the full-contour wall.

**Whole-bridge QC.**

- The bridge is one watertight solid.
- Wall thickness is checked per unit, and area per connector.
- Margin fit is checked per abutment.
- The pontic relief and the seating gate are included as well.

## 8. QC gates

Gates are pure functions over Float64 buffers. The same code runs in the
client worker and on the server. Thresholds come from the material profile
or are documented QC tolerances. A gate with no valid samples **fails**; it
never passes on a sentinel value.

| Gate | What it measures | Pass condition |
|---|---|---|
| `watertight` | boundary edges of the solid | none |
| `manifold` | edge degree and connected components | every edge shared by exactly two faces, one component |
| `selfIntersection` | BVH-accelerated exact triangle–triangle scan, and manifold-3d acceptance | 0 intersecting non-adjacent face pairs (bound: exact; 1e-9 mm on-plane snap for near-coplanar pairs) |
| `minWallThickness` | inner↔outer closest-surface distance, sampled on both surfaces (a lower bound on the true wall) | sampled minimum **minus the sample spacing** ≥ the profile minimum, axial and occlusal |
| `marginFit` | the intaglio's margin boundary loop vs the dense margin spline | maximum ≤ 10 µm |
| `seating` | the exact boolean intersection volume of the crown and the die (manifold-3d) | ≤ 1·10⁻⁶ mm³ |
| `contact` | proximal and occlusal contact residuals after the morph, verified on the case's scan | within 50 µm of the profile target |
| `connectorCrossSection` | proven lower bound of each connector's minimum area | ≥ 9 / 7 mm² |
| `ponticRelief` | worst deviation from the configured relief | ≤ 20 µm |
| `cuspCoverageThickness` | onlay covered-cusp thickness | ≥ the profile's cusp-coverage minimum |
| `seamDihedral` | inlay/onlay seam continuity | dihedral angle < 5° |

**Gates block export.** The structural gates (`watertight`, `manifold`,
`selfIntersection`) can never be acknowledged. A soft gate can be
acknowledged with a warning. The acknowledgment is journaled and printed in
the report, and a load-bearing acknowledgment must be bounded, localized and
causation-tested ([ADR-010](adr/010-bounded-localized-qc-acknowledgment.md)).

## 9. Validation status: what is and is not proven

**Proven** on synthetic fixtures with closed-form answers:

- Every crown gate passes through the real UI path on the open-arch fixture.
- A 3-unit posterior bridge passes all 11 gates, in every pontic style.
- The connector gate blocks a 5 mm² posterior connector.
- The pontic relief matches its configuration within ±20 µm.
- The inlay passes QC with a G1 seam.
- Basic kernel accuracy:
  - The volume of a boolean of two spheres matches the analytic value
    within 0.1 %.
  - A 50 µm sphere offset at the default pitch has a radial error of at
    most 10 µm.
  - A geodesic on an icosphere matches the great-circle length within
    0.1 %.

**Measured** on two anonymized real intraoral scans (`test-fixtures/real-scans/`):

- The prep die is extracted and certified, and the intaglio is built.
- The library incisor is fitted within 50 µm.
- With the height datum, both proximal contacts land on the neighbours'
  real surface.
- The wall and seating gates fail on that tooth, because it is
  **unprepared**. The failure is reported, not hidden.

**Not yet done:**

- Certification on real prepared-tooth scans: a retraction-cord crown, a
  cavity, a multi-abutment bridge.
- A real edentulous-ridge bridge scan.
- A technician beta.
- Any regulatory conformity assessment.

The open items per phase are listed in `docs/demos/phase-*.md`.

## 10. Export, server re-validation and traceability

**Export.**

- The STL is a deterministic, watertight binary file with outward normals
  verified on its topology. PLY output is optional.
- The Float64 → Float32 narrowing error of the file is measured and
  documented (`io/src/export/narrowing.ts`).

**Server re-validation**
([ADR-017](adr/017-server-authoritative-export-revalidation.md)). The client
result is never trusted:

- The server re-parses the **exact exported bytes**.
- It re-extracts the prep die from the scan.
- It re-runs every QC gate with the Node kernel, against thresholds from
  the server's own profile registry, never from the request.
- It releases the file only on a clean pass. A client/server mismatch is a
  hard failure, and a diagnostic bundle is produced.
- A gate the server cannot recompute from the delivered bytes is disclosed
  as *client-attested*, never presented as a full-authority pass.

**Traceability document.**

- It comes as schema-validated JSON and as PDF-ready HTML in four languages.
- It records:
  - every gate result and parameter;
  - the material profile id, version and checksum;
  - the kernel version;
  - the journal hash.
- The **case archive** is a single file holding the scans, the journal and
  the settings, with an integrity manifest. It is used for support and for
  transfer between labs.

## 11. Testing and reproducing the results

```bash
npm install
npm test                  # every Vitest project: kernel, io, pipeline, server, client
npm run test:golden       # golden-hash regression (Git LFS fixtures: git lfs pull)
npm run test:e2e          # Playwright design flows through the real UI
npm run lint && npm run typecheck
```

- **Kernel tests come first.** Every new algorithm gets property-based tests
  (fast-check) and an analytic case with a closed-form answer before any
  real-scan fixture.
- **Golden hashes** pin the output of every pipeline stage. A changed hash
  without a kernel version bump and changelog entry is a failure.
- **Journal replay** reproduces identical hashes (CI).
- **Parser fuzzing**: `npm run test:fuzz`.
- **Real-scan lanes** are opt-in, with `RUN_CROWN_REAL_DIE=1`.

## 12. Extending and integrating

- **Material profiles.** Add a JSON profile under
  `packages/clinical-profiles/src/profiles/` that follows the schema. The
  checksum is verified at load, and changing a profile is an audited
  operation.
- **Tooth libraries.** The asset format, landmarks and cervical ring are
  described in [`packages/tooth-library/src/README.md`](../packages/tooth-library/src/README.md).
  Each asset declares its provenance and whether it is generated, scanned
  or licensed.
- **Kernel use without the UI.** `@dqcad/kernel`, `@dqcad/io` and
  `@dqcad/cad-pipeline` are pure TypeScript and run in Node or a worker.
  The worker jobs in `packages/kernel-workers` show the call shape of every
  operation.
- **License.** Apache License 2.0 ([LICENSE](../LICENSE), [NOTICE](../NOTICE)).
  You may use, modify and redistribute the code, including in closed and
  commercial products. Keep the license and the NOTICE, mark modified files,
  and credit the author.
