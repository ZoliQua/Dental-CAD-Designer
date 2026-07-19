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
