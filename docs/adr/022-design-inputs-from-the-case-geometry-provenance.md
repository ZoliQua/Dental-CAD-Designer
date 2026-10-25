# ADR-022 — Design inputs come from the case: typed geometry provenance, fail-closed QC on stand-ins

**Status:** Accepted (2026-10-18; Phase 9 Task 1 implements Decisions 1, 2 and 6; Task 3 implements Decision 3; Task 5 lands Decision 4's ridge-crest fit; Task 4 implements Decision 5 with the library template opt-in until it is fitted to the margin; Task 6 implements Decision 4 — the abutment morph step is not run until the bridge's outer neighbours can be captured — see the Phase 9 plan)
**Date:** 2026-10
**Relates:** ADR-014 (synthetic demo-fixture disclosure — generalized here),
ADR-011 (bridge shared insertion axis), ADR-017 (server-authoritative export
re-validation), ADR-020 (local single-user auth / client-only deploy).

## Context

The MVP (Phases 0–8) proved every restoration pipeline on closed-form
fixtures. Several of those fixture-era stand-ins are still wired into the
**live** design workflows, where they decide QC verdicts for whatever case
the user has open. An inventory (October 2026) found:

| Workflow | Input taken from the case | Synthetic stand-in still in the live path | Gates it feeds | Disclosed? |
|---|---|---|---|---|
| Crown | die / arch scan (`targetNodeId`), margin loop, insertion axis, antagonist (role `antagonist`, optional) | **Proximal neighbours** = world-axis-aligned `boxMesh` at ±X, 0.1 mm gap (`crownDesign.ts` `buildAnatomyInput`); **anatomy** = parametric `builtinLibraryTooth` (cylinder + dome, no occlusal anatomy) | proximal-contact gate (and its export re-validation context); placement MD scale | Anatomy: one muted line. Neighbours: **no** — and doc comments claim contacts are "never fabricated" |
| Inlay / onlay | tooth scan, cavity outline, insertion axis | **Neighbour boxes** from the outline's world-X extent, side chosen by `x < 0` vs world zero (only correct for an origin-centred fixture); **onlay coverage divider** = bbox min-Y with a fixed `[0,-1,0]` normal; procedural occlusal patch | proximal-contact gate; cusp-coverage thickness gate | **No** |
| Bridge | margin loops and target only *gate* the start — they are never read | **The entire geometry**: units, intaglios, dies, fit regions, pontic, connectors, shared axis `[0,0,1]` = the fixed 14-15-16 demo asset | all 11 bridge gates + export context | **Yes** (ADR-014 banner, start note, QC note) |
| Export | — | — | — | Demo-data banner is **unconditional** (no provenance flag exists) |

Two consequences matter for a medical-adjacent product:

1. **A gate can PASS on fabricated geometry without saying so.** The crown
   and inlay proximal-contact verdicts are measured against boxes that are
   not the patient's teeth, and that verdict rides into the server
   re-validation context. This is a silent stand-in — the same failure mode
   ADR-014 was written to prevent for the bridge, but here undisclosed.
2. **Journal entries cannot prove their inputs.** Bridge stage operations are
   journaled with `inputHashes: []` (no scan hash, no margin hash, no source
   identity), which falls short of CLAUDE.md invariant 3.

Meanwhile most of the *real* inputs are already reachable: the arch scans
(roles `upperJaw` / `lowerJaw`), abutment margin loops, the user-set
insertion axis, the `gingiva` role (imported, never consumed), the server
tooth library (`/api/tooth-library`, no client consumer), and every bridge
kernel op as a registered, browser-runnable worker job. Two anonymized real
full-arch cases (`test-fixtures/real-scans/arch-case-01`, `-02`) exist.

## Decision

### 1. Geometry provenance is a typed, journaled property of every QC-relevant input

```ts
type GeometryProvenance =
  | 'case'         // derived from this case's own scans / user decisions
  | 'placeholder'  // a documented stand-in for MISSING case data
  | 'demo-fixture' // a fixed demonstration geometry unrelated to the case (ADR-014)
```

- Every design session records the provenance of each measurement input
  (neighbours, antagonist, coverage region, abutment units, pontic base,
  ridge). It is journaled in the stage op's params, alongside the
  `inputHashes` of the case meshes / margin loops the input came from.
- A test fixture that **is** the case under test (golden tests, synthetic
  acceptance fixtures entered through the real path) has provenance `case`.
  The distinction is "derived from the case" vs "fabricated to fill a gap",
  not "real scan" vs "synthetic file".
- `QcGateResult` gains an **optional** `inputProvenance` field, set only when
  some input is not `case`. Reports whose inputs are all case-derived
  serialize exactly as today, so every existing golden / dual-validation pin
  stays byte-identical (verified in the task that lands the field).

### 2. A gate measured on a non-`case` input can never PASS

A measurement taken against a stand-in is not a measurement of the patient.
Such a gate **fails closed** (`passed: false`, a `non-case-input` message
naming the stand-in), exactly like the existing "measurement failed / no
valid samples" rule in the gates. It can
still be acknowledged (soft gates only — structural gates are unaffected),
and the acknowledgment is journaled and printed in the traceability
document. It is never silently passed and never silently skipped.

Where the case genuinely lacks the data (e.g. a lone `prepDie` scan has no
neighbours), the gate says exactly that ("no neighbour geometry in this
case") rather than inventing boxes.

### 3. Neighbours and antagonist are captured from the case's own scans

- The user picks the mesial / distal neighbour on the arch scan (one click
  each); a kernel op extracts a bounded region around the pick, oriented by
  the margin loop centroid and the insertion axis — never by world axes.
- The opposite-arch scan (`lowerJaw` for an upper restoration and vice
  versa) is offered as the antagonist, applied only after user confirmation
  (journaled, no silent role inference).
- The extraction is an approximation of "the neighbour tooth"; its
  `@errorBound` (what fraction of the true contact surface the region can
  miss) is documented and surfaced in the QC report.

### 4. The bridge gets a real-geometry path; the demo fixture becomes an explicit demo mode

- Abutment units are built per abutment from the case: shared insertion
  axis = `restoration.insertionAxis` (ADR-011), intaglio via the registered
  `bridgeAbutmentSurfaces` job on the target scan, outer anatomy via the
  crown chain (`placeAnatomy` → `morphAnatomy` → `constructShell`).
- The pontic base is shaped against the `gingiva`-role scan, with the ridge
  crest fitted from that scan (new kernel op, PCA crest-cylinder fit, tests
  first against analytic cylinders, `@errorBound` documented).
- Connectors are auto-placed by porting the existing cad-pipeline placement
  into a registered worker job; the profile editor and area gate are
  unchanged (ADR-012).
- The fixed 14-15-16 asset stays available as **demo mode**, entered
  explicitly, still under every ADR-014 disclosure, with provenance
  `demo-fixture` on all its gates (so per Decision 2 its QC can never pass
  for export).
- No existing kernel fixture, serialized asset, or golden pin changes; the
  real path adds new goldens on a new closed-form arch fixture entered
  through the real path.

### 5. Anatomy comes from the tooth library; the placeholder is labelled

- When the server is reachable, the engine fetches the anatomy for the
  restoration's FDI from `/api/tooth-library` (same "engine owns network"
  pattern as persistence). Missing FDI, or client-only mode (ADR-020 static
  deploy), falls back to the parametric placeholder with provenance
  `placeholder`, shown in the panel.
- Anatomy provenance is **disclosed but does not by itself fail a gate**:
  the anatomy is a design proposal, and every gate measures the resulting
  shell (thickness, watertight, …), not the template.
- The starter library gains premolar and molar placeholder generators so a
  posterior bridge pontic has an asset; library provenance (generator vs
  scanned/licensed) is stored per asset.

### 6. The export banner and traceability document follow provenance

The unconditional demo-data banner in the export panel is replaced by one
driven by the selected restoration's gate provenance; the traceability
document lists each gate's input provenance. Once a restoration is fully
`case`-derived, nothing claims it is demo data — and nothing that isn't can
look like a clean pass.

## Consequences

**Positive**
- Closes the undisclosed crown / inlay contact stand-in immediately (Phase 9
  Task 1 needs no new geometry).
- QC verdicts become statements about the patient, or explicitly not.
- Bridge journal entries become replay-verifiable against their inputs.
- Gives the real-scan certification follow-up something to certify.

**Negative / costs**
- Until neighbour capture lands, crown and inlay cases show a failing,
  acknowledgeable contact gate where they previously showed a (fabricated)
  pass. This is intentional and must be explained in the UI and release
  notes.
- `QcGateResult` and the export QC context grow a field; the server
  re-validation must carry it through (and reject a client context that
  claims `case` provenance for an input it cannot trace to the delivered
  case data).
- Neighbour extraction is approximate and needs an error bound and a
  real-scan tracked-pending for certification.

**Not decided here**
- Automatic tooth segmentation (ML or curvature-based) — picking stays
  manual.
- Cavity margin auto-proposal on real cavities and the general cusp
  watershed for onlay coverage — they remain manual, with the current
  divider labelled `placeholder`.
