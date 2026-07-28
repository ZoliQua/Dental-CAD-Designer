// packages/shared-types — the canonical CaseDocument data model (PLAN.md §2.2).
// Type declarations only: no runtime logic, no clinical defaults, no I/O.
// Units are millimeters (mm) unless a field name says otherwise.

// ---------------------------------------------------------------------------
// FDI tooth numbering
// ---------------------------------------------------------------------------

/** Quadrant digit of an FDI tooth number (1 = upper right … 4 = lower right). */
type FdiQuadrant = 1 | 2 | 3 | 4;

/** Tooth-in-quadrant digit of an FDI tooth number (1 = central incisor … 8 = third molar). */
type FdiPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** String form produced by crossing quadrant × position, e.g. "11", "48". */
type FdiToothLiteral = `${FdiQuadrant}${FdiPosition}`;

/** Parses a numeric-literal string type back into its numeric literal type. */
type ToNumber<S extends string> = S extends `${infer N extends number}` ? N : never;

/**
 * Valid FDI tooth numbers: 11–18, 21–28, 31–38, 41–48.
 * Built from a template-literal cross product of quadrant × position so the
 * literal union stays in sync with the FDI definition instead of being typed out by hand.
 */
export type FdiTooth = ToNumber<FdiToothLiteral>;

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** A 3D vector or point, in mm. Immutable tuple. */
export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Mesh & scene
// ---------------------------------------------------------------------------

export type MeshRole = 'upperJaw' | 'lowerJaw' | 'prepDie' | 'antagonist' | 'situ' | 'gingiva';

/** An immutable, content-addressed source mesh (a scan). */
export interface MeshAsset {
  id: string;
  /** SHA-256 (or equivalent) of the mesh's PROCESSED (post-intake, welded)
   * Float64 content — computed worker-side by kernel-workers'
   * `intakeMesh`/`hashMesh` jobs (see packages/kernel-workers/src/hash.ts's
   * `hashMeshContent`). Identity for journaling/reproducibility; NOT the
   * same value as `fileHash` below (see that field's doc for why the two
   * must stay distinct). */
  contentHash: string;
  name: string;
  unit: 'mm';
  triangleCount: number;
  /**
   * SHA-256 of the binary-STL FILE BYTES this mesh was last persisted as on
   * the server (`POST /api/meshes`'s content-addressed store — see
   * docs/plans/phase-1-import-viewer.md Task 11). Deliberately a SEPARATE
   * hash from `contentHash`: `contentHash` is computed over the exact
   * Float64 positions/indices buffers in memory, while binary STL only
   * stores float32 coordinates (packages/io's `writeStlBinary` — an
   * inherent, documented lossy boundary of the file format), so re-parsing
   * the persisted file never reproduces the identical Float64 bytes
   * `contentHash` was derived from. Keeping both means: `contentHash` stays
   * the stable in-session/journal identity (and is what a loaded
   * `SceneNode.meshId` and `MeshStore` record key on — never recomputed
   * after a load), while `fileHash` is purely "where is this mesh's byte
   * payload on the server" (`GET /api/meshes/:fileHash`). Optional/absent
   * for a `MeshAsset` that has never been saved to the server yet (created
   * this session, only present in `meshStore`/in-memory).
   */
  fileHash?: string;
}

/** Placement of a MeshAsset in the scene. */
export interface SceneNode {
  id: string;
  meshId: string;
  role: MeshRole;
  /** 4x4 matrix, 16 numbers, column-major. */
  transform: readonly number[];
  visible: boolean;
  opacity: number;
}

// ---------------------------------------------------------------------------
// Margin line
// ---------------------------------------------------------------------------

/**
 * A control point anchoring a `MarginLine` spline to a mesh surface — the
 * SAME "triangle + barycentric" currency `@dqcad/kernel`'s `SurfacePoint`
 * uses (packages/kernel/src/geodesic/types.ts), duplicated here as a plain,
 * serializable, kernel-independent shape (shared-types has no dependency on
 * `@dqcad/kernel` — this package is "type declarations only", see this
 * file's top doc) so a `CaseDocument` can carry it directly.
 *
 * `triangleIndex`/`barycentric` are meaningful ONLY relative to whatever
 * mesh the OWNING `Restoration` currently targets for this tooth — that
 * association is established by context (the restoration's assigned prepDie
 * scan, Phase 3 Task 2's wizard), not carried inline on the anchor itself;
 * `position` is the float-precision echo of the same point (never expected
 * to disagree with re-evaluating `triangleIndex`/`barycentric` against the
 * correct mesh — see marginLine.ts's `toMarginLine`/`fromMarginLine`, the
 * kernel-side adapter that produces/consumes this shape).
 *
 * schemaVersion 2 (Phase 3 Task 1) — replaces schemaVersion 1's lossy
 * `vertexAnchors: readonly number[]` (nearest-VERTEX hint only, no triangle/
 * barycentric — see this package's CHANGELOG-adjacent migration notes in
 * apps/client/src/engine/caseDocumentMigration.ts for the v1 -> v2 load-time
 * migration and its documented, explicit limitation for legacy documents).
 */
export interface MarginAnchor {
  /** Float64 mm world-space position — exact, always trustworthy regardless
   * of whether `triangleIndex`/`barycentric` have been resolved against a
   * real mesh (see this interface's doc and the v1->v2 migration's doc for
   * the one documented case where they haven't: a migrated legacy anchor). */
  position: Vec3;
  triangleIndex: number;
  /** Producer-guaranteed: sums to ~1, each component in [0, 1] (mirrors
   * kernel/src/geodesic/types.ts's `SurfacePoint.barycentric` doc). */
  barycentric: readonly [number, number, number];
}

/** A spline lying on a prep mesh surface, defining a restoration's finish line. */
export interface MarginLine {
  /** Ordered control points anchoring the spline to the surface — see
   * `MarginAnchor`'s doc. */
  anchors: readonly MarginAnchor[];
  closed: boolean;
  /** Optional densely-resampled points along the fitted spline (e.g. for
   * display or export), Float64 mm world-space — NOT authoritative (
   * `anchors` is); absent until something actually resamples the spline
   * (Phase 3's surface-spline fitting, packages/kernel/src/spline/). */
  resampledPoints?: readonly Vec3[];
}

/**
 * Phase 3 Task 7 — the on-disk shape of a hand-traced reference margin
 * fixture (`test-fixtures/margins/<caseId>/<tooth>.reference.json`),
 * produced by `apps/client/src/engine/marginEditor.ts`'s dev-only
 * `exportReferenceMargin()` and consumed by `test/golden/
 * margin-references.test.ts`'s reference-quality checks (and, later, Task
 * 8's acceptance harness). See `test-fixtures/margins/README.md` for the
 * full workflow/schema doc.
 *
 * Declared here (not local to `apps/client`) so both the client engine
 * (which produces it) and root-level `test/golden/` scripts (which consume
 * it) can import the SAME type without a cross-layer dependency — the same
 * "file-format shape belongs in shared-types" precedent as `MarginLine`
 * itself.
 *
 * ALLOW-LISTED FIELDS ONLY (CLAUDE.md "no silent data mutation" / no-PHI
 * export requirement): every field is either a mesh-relative geometric
 * quantity, a content-hash reference (never a filename or any
 * patient-identifying string), or build/provenance metadata. A test that
 * asserts `Object.keys(parsed)` against exactly this field set IS this
 * fixture's no-PHI check — nothing else may ever be added here without a
 * matching audit of that assertion.
 */
export interface MarginReferenceExport {
  tooth: FdiTooth;
  /** Same currency as `MarginLine.anchors` — see `MarginAnchor`'s doc. */
  anchors: readonly MarginAnchor[];
  /** A confirmed margin is always closed (Task 6's validation gate blocks
   * confirm on an open loop — see `MarginHardFailureKind`'s 'open' case,
   * apps/client/src/state/marginStore.ts) — carried explicitly anyway
   * (rather than assumed `true`) so a consumer can reconstruct a
   * self-describing `MarginLineLike` from this file alone, with no implicit
   * assumption baked into the reader. */
  closed: boolean;
  /** Same currency as `MarginLine.resampledPoints`, but REQUIRED here (never
   * absent) — a reference exported from a confirmed margin always has a
   * real committed `resampledPoints` array (see `MarginLine.resampledPoints`'s
   * own doc for when it's legitimately absent on the LIVE editing shape;
   * that case never reaches a confirm-and-export). */
  resampledPoints: readonly Vec3[];
  /** The target mesh's `MeshAsset.contentHash` this margin was traced
   * against — ties the reference to a specific, immutable, anonymized
   * fixture mesh (never a filename or scan identifier). */
  meshContentHash: string;
  /** Always `'human-reference'` — distinguishes this file, by construction,
   * from any machine-generated (`proposeMargin`) golden fixture; a fixed
   * literal rather than a boolean so a future export path (if one is ever
   * added) can extend the union without an ambiguous `false`. */
  traced: 'human-reference';
  /** `apps/client`'s own build/version tag at export time (see
   * `apps/client/src/appVersion.ts`) — independent of `kernelVersion`
   * below: a client UI/wiring change bumps this, not that. */
  appVersion: string;
  /** `@dqcad/kernel`'s `KERNEL_VERSION` at export time — the same value
   * every journaled `Operation.kernelVersion` records. */
  kernelVersion: string;
  /** ISO-8601 UTC timestamp of the export action itself — provenance only,
   * never treated as clinically meaningful (no acquisition date is stored
   * anywhere in this file — see this interface's doc). */
  exportedAt: string;
}

// ---------------------------------------------------------------------------
// Restoration
// ---------------------------------------------------------------------------

export type RestorationType = 'crown' | 'inlay' | 'onlay' | 'bridge';

/** Clinical design parameters for a restoration, in mm. Values are sourced from a material profile. */
export interface RestorationParams {
  cementGapMm: number;
  marginalGapMm: number;
  spacerStartMm: number;
  minWallThicknessMm: number;
  proximalContactPenetrationMm: number;
  occlusalContactMm: number;
}

export interface Restoration {
  id: string;
  type: RestorationType;
  /** Bridges list all abutments and pontics. */
  teeth: readonly FdiTooth[];
  /**
   * Bridge-only: the subset of `teeth` that are pontics (no prep — suspended
   * between abutments, never gets a `marginLines` entry). Every tooth in
   * `teeth` NOT listed here is an abutment (prepped, load-bearing). Always
   * `[]` for `crown`/`inlay`/`onlay` (single/few-tooth types with no pontic
   * concept — Phase 3 Task 2's wizard never lets the user mark one for those
   * types). See CLAUDE.md's domain vocabulary ("pontic", "abutment") and
   * docs/plans/phase-3-margin-axis.md Task 2's brief ("multi-select for
   * bridge: abutments + pontics marked distinctly").
   */
  pontics: readonly FdiTooth[];
  /**
   * The `SceneNode.id` (role `prepDie`/`upperJaw`/`lowerJaw`) this
   * restoration's margin lines/insertion axis are resolved against — `null`
   * until the wizard's "assign target scan" step (Phase 3 Task 2) sets it.
   * This is the "context" `MarginAnchor`'s doc refers to ("meaningful ONLY
   * relative to whatever mesh the OWNING Restoration currently targets for
   * this tooth"). Same naming convention as
   * apps/client/src/state/heatmapStore.ts's `targetNodeId`.
   */
  targetNodeId: string | null;
  marginLines: Partial<Record<FdiTooth, MarginLine>>;
  insertionAxis: Vec3;
  params: RestorationParams;
  /** Content hashes into the mesh store for each completed pipeline stage.
   * The first four are the CROWN pipeline stages (Phase 4); the cavity fields
   * (`fitSurface`/`occlusalPatch`/`proximalContacts`/`cuspCoverage`) are the
   * inlay/onlay pipeline stages (Phase 5). `finalMesh` is SHARED — it is the
   * final watertight restoration solid for both families (the crown shell and
   * the inlay/onlay shell), so the stale-QC guard (`qc.journalHash` vs
   * `finalMesh`) works uniformly across restoration types. Every field is
   * optional: a given restoration only ever populates its own family's fields. */
  stages: {
    innerSurface?: string;
    anatomyPlacement?: string;
    morphState?: string;
    finalMesh?: string;
    /** Inlay/onlay cavity FIT (inner) surface — `cavityInnerSurface` output. */
    fitSurface?: string;
    /** Inlay/onlay occlusal anatomy patch — `cavityOcclusalPatch` output. */
    occlusalPatch?: string;
    /** Inlay/onlay adapted proximal-box contacts — `cavityProximalContact` output. */
    proximalContacts?: string;
    /** Onlay covered-cusp coverage selection marker (the coverage divider) —
     * onlay only; feeds the region-scoped cusp-coverage thickness gate in QC. */
    cuspCoverage?: string;
    /** Bridge per-abutment fit (inner/outer) surfaces milestone (Phase 6 Task
     * 7) — the shared-axis abutment intaglios + outer anatomy (`bridgeAbutmentSurfaces`
     * job output). Bridge only. */
    bridgeAbutmentSurfaces?: string;
    /** Bridge pontic body + gingival-interface base milestone (`bridgePontic`
     * job output; the style + configured relief is a journaled design decision).
     * Bridge only. */
    bridgePontic?: string;
    /** Bridge connectors milestone — the per-adjacent-pair connector lofts
     * (`bridgeConnectors` job output; editable cross-section profiles are a
     * journaled design decision). Bridge only. */
    bridgeConnectors?: string;
    /** Bridge framework-mode selection marker (fullContour vs framework — a
     * journaled design decision that switches the whole-bridge thickness gate to
     * `frameworkMinThicknessMm`). Bridge only. */
    bridgeFramework?: string;
  };
  qc: QcReport | null;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** `pointToPoint`/`pointToSurface` store 2 `points` and a mm `value`;
 * `angle` stores 3 `points` (vertex is `points[1]`) and a degree `value`. */
export type MeasurementKind = 'pointToPoint' | 'pointToSurface' | 'angle';

/** A single picked (or, for point-to-surface's second point, derived — the
 * nearest point on the target surface) point anchoring a `Measurement`. */
export interface MeasurementPoint {
  /** The SceneNode the point lies on — lets an overlay re-render after that
   * node's visibility/opacity changes, and is a future extension point for
   * re-deriving a measurement after its underlying mesh moves (Task 6+
   * alignment tools; out of this task's scope — see PLAN.md). */
  nodeId: string;
  /** World-space Float64 mm coordinates (same frame as the owning mesh's
   * `IndexedMesh.positions` — Phase 1 SceneNode transforms are always
   * identity, see `SceneNode.transform`'s doc, so "world" and "mesh-local"
   * coincide for now). */
  position: Vec3;
}

export interface Measurement {
  id: string;
  kind: MeasurementKind;
  points: readonly MeasurementPoint[];
  /** Millimeters for `pointToPoint`/`pointToSurface`; degrees for `angle`. */
  value: number;
  /** ISO 8601 timestamp — display/ordering only, never fed into computations. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** An append-only journal entry for a destructive operation; replaying the journal must
 * reproduce identical output hashes (the reproducibility invariant, PLAN.md §6). */
export interface Operation {
  id: string;
  name: string;
  params: Readonly<Record<string, unknown>>;
  inputHashes: readonly string[];
  outputHashes: readonly string[];
  kernelVersion: string;
  /** ISO 8601 timestamp. Recorded for audit display only — never fed into computations. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// QC
// ---------------------------------------------------------------------------

export interface QcGateResult {
  gate: string;
  passed: boolean;
  /** True if a failing gate was explicitly acknowledged by the user (never silently bypassed). */
  acknowledged: boolean;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  message: string;
}

export interface QcReport {
  gates: readonly QcGateResult[];
  passed: boolean;
  kernelVersion: string;
  profileVersion: string;
  /** Hash of the journal state the report was computed against. */
  journalHash: string;
}

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

export interface CaseSettings {
  materialProfileId: string;
  profileVersion: string;
}

export interface CaseDocument {
  id: string;
  /** 2 (Phase 3 Task 1): `MarginLine` moved from lossy `vertexAnchors:
   * number[]` to `anchors: MarginAnchor[]` (triangle + barycentric + exact
   * position — see `MarginAnchor`'s doc). A schemaVersion-1 document loaded
   * from the server is migrated client-side BEFORE it is ever represented
   * as a `CaseDocument` — see apps/client/src/engine/
   * caseDocumentMigration.ts's module doc for the full migration contract
   * and its documented legacy-anchor limitation. The server's PUT schema
   * (apps/server/src/schemas.ts) accepts ONLY `2` — migration is exclusively
   * a client-side, load-time concern, never a server responsibility. */
  schemaVersion: 2;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** Optional link to an external record (e.g. DentalQuoter). */
  patientRef?: string;
  meshes: readonly MeshAsset[];
  scene: readonly SceneNode[];
  restorations: readonly Restoration[];
  /** Point-to-point / point-to-surface / angle measurements (Task 7) —
   * ephemeral user annotations, not journaled as `Operation`s (they don't
   * mutate any mesh geometry — CLAUDE.md invariant 5 concerns geometry
   * mutation, not measurement bookkeeping). */
  measurements: readonly Measurement[];
  history: readonly Operation[];
  settings: CaseSettings;
}
