# ADR-002: Scene placement and measurements are not journaled `Operation`s

**Status:** Accepted

## Context

CLAUDE.md's hard invariant #3 ("Journal everything") requires: "Every
destructive operation appends an `Operation` (name, params, input/output
hashes) to the case journal. Replaying the journal must reproduce identical
hashes." `Operation` (`packages/shared-types`) carries `inputHashes`/
`outputHashes` specifically because it models a MESH-MUTATING step whose
reproducibility is being asserted.

`engine/caseStore.ts` has several document-mutating methods that do NOT
append an `Operation`:

- `addSceneNode`/`removeSceneNode`/`setSceneNodeVisibility`/
  `setSceneNodeOpacity` — placing a mesh into the scene under a role,
  removing it, or changing its visibility/opacity.
- `addMeasurement` — appending a point-to-point/point-to-surface/angle
  measurement (`ToolManager.ts`) to `document.measurements`.

By contrast, `registerImportedMesh` (import/rescale) and `applyRepair`
(the three repair kinds) both always append an `Operation`.

## Decision

Only operations that MUTATE MESH GEOMETRY (produce a new, hash-distinct
`positions`/`indices` buffer from an existing one) are journaled as
`Operation`s: `import-mesh`, `unit-rescale`, and the three
`repair-*` kinds. Scene placement (`SceneNode` add/remove/visibility/
opacity) and measurements (`Measurement`) are plain `CaseDocument` fields,
mutated directly, with no journal entry.

The dividing line is CLAUDE.md invariant #3's own scope: "destructive
operation" means one whose output hash must be reproducible from an input
hash via a replay — that concept only applies to something that CHANGES
mesh bytes. A `SceneNode` is a reference (`meshId` + transform/visibility/
opacity) to an already-hashed, immutable mesh; changing which meshes are
visible, or where they sit in the scene, never changes any mesh's
`contentHash`. A `Measurement` is a read-only derived value (a distance or
angle computed against already-registered mesh geometry via `ToolManager.ts`
and worker BVH queries) — it has no "output" in the `Operation` sense at
all, and nothing about it is unreproducible: replaying a `Measurement`'s
inputs (the picked points, valid against the same meshes) yields the same
value by construction, since the underlying kernel measurement functions are
already covered by CLAUDE.md invariant #2 (determinism).

## Consequences

- The journal (`CaseDocument.history`) stays a clean, minimal audit trail of
  the geometry that actually changed — exactly what PLAN §6.3's
  journal-replay harness (Task 8, ADR-001) needs to assert hash
  reproducibility against, with no noise from purely presentational or
  read-only state.
- Undo/redo (if added later) for scene placement/measurements would need its
  OWN mechanism (e.g. a separate, non-journaled undo stack over
  `CaseDocument.scene`/`measurements`) — it cannot reuse the `Operation`
  replay machinery, since there is no hash-reproducibility contract to
  replay against for these fields.
- A measurement becomes stale (still displayed, but referencing since-moved
  or since-repaired geometry) only in the sense any read-only derived value
  can go stale — there is no `Operation` to re-run to "fix" it; Phase 1 has
  no re-projection UI for this (documented as a known Phase 1 gap in
  `caseStore.ts`'s `applyRepair` doc: the measurements-cleared count is
  recorded on the repair `Operation` itself instead).
- If a future phase needs scene/measurement history for its own reasons
  (e.g. a "who changed what" audit log, unrelated to hash reproducibility),
  that is a SEPARATE, purpose-built log — not an extension of
  `Operation`/`CaseDocument.history`, which stays scoped to mesh-mutating
  steps per this ADR.

## Amendment (Phase 3): alignment-apply

`engine/caseStore.ts`'s `applyAlignment` (Phase 3 Task 3) journals an
`Operation` named `alignment-apply` for a `SceneNode.transform`-only
change — the alignment tool's user-confirmed ICP result is written onto
`nodeId`'s `transform`, and nothing else about the `SceneNode` or any mesh
changes. By this ADR's own dividing line above ("Only operations that
MUTATE MESH GEOMETRY... are journaled"), a transform write is exactly the
category this ADR puts in the NEVER-journaled bucket alongside
`setSceneNodeOpacity`/`setSceneNodeVisibility` — `alignment-apply` is a
deliberate, bounded EXCEPTION to that rule, not an oversight, recorded here
so the exception is visible next to the rule it carves out of.

**Why the exception is legitimate.** The Decision section's own dividing
line is about REPRODUCIBILITY scope ("a `SceneNode` is a reference... never
changes any mesh's `contentHash`"), which is true and unaffected by this
amendment — `alignment-apply` still produces no `outputHashes` (see
`applyAlignment`'s doc: "there is no `outputHashes[0]` mesh to register").
But `Operation`/`CaseDocument.history` also functions, in practice, as this
app's only CLINICAL AUDIT TRAIL of consequential actions (PLAN.md §2.2's
spirit: a case's history should show what was DONE to it, not just what
mesh bytes resulted) — and unlike opacity or visibility, moving a mesh via
ICP registration is clinically consequential: it changes where a scan sits
relative to every other scan in the case (margin lines, undercut scans,
QC gates, and any later boolean/measurement all read a `SceneNode`'s
CURRENT transform), and it carries real, reportable quality metrics (RMS,
inlier fraction, convergence, the seed/sample-count/overlap-mode-derived
`outlierRejectionFraction` it was run with — see `AlignmentResult`,
`state/alignmentStore.ts`) that a clinician or a later reviewer needs to be
able to see WAS done and HOW WELL it fit, not just infer from the current
transform value. Opacity/visibility carry no such quality signal and have
no clinical consequence — that distinction, not the reproducibility
dividing line, is why `alignment-apply` is journaled while
`setSceneNodeOpacity` is not.

**Why replay coverage is not required.** PLAN.md §6.3's journal-replay
harness (Task 8, ADR-001) asserts hash reproducibility — "same inputs +
params + kernel version ⇒ bit-identical outputs" — over exactly the
mesh-mutating steps this ADR's Decision section scopes `Operation` to.
`alignment-apply` never touches mesh bytes (no mesh is read, repaired, or
re-hashed by it — it reads a mesh only to raycast/sample points FROM it,
already-immutable geometry it never writes back to); its "output" is a
`SceneNode.transform`, a value that is NOT content-addressed and has no
`contentHash` for a replay to reproduce or compare against. Requiring
§6.3-style replay coverage for it would therefore be a category error: there
is no mesh-byte output for a replay to assert bit-identity over, so
"reproducibility" for `alignment-apply` can only ever mean "the recorded
`params` (seed, sample count, overlap-mode preset, pairs) are sufficient to
re-derive the same transform," which is a claim about `icpRegister`'s own
determinism (CLAUDE.md invariant 2, already covered by
`packages/kernel/src/register`'s and `packages/kernel-workers`'s own
determinism tests), not something `alignment-apply`'s journal entry itself
needs its own replay harness to prove.

**Scope of the exception.** This amendment applies ONLY to `alignment-apply`
— it does not reopen the Decision section's general rule, and it does not by
itself justify journaling any other transform-only or presentational
`SceneNode`/`Measurement` change (e.g. `setSceneNodeOpacity`,
`setSceneNodeVisibility`, `addMeasurement` remain un-journaled per the
Decision above). A future case for journaling some OTHER non-mesh-mutating
change should make its own clinical-consequence argument, not cite this
amendment as precedent by analogy.
