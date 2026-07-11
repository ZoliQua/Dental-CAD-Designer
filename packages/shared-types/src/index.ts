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
   * Float64 content — see apps/client/src/engine/hash.ts's
   * `hashMeshContent`. Identity for journaling/reproducibility; NOT the same
   * value as `fileHash` below (see that field's doc for why the two must
   * stay distinct). */
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

/** A spline lying on a prep mesh surface, defining a restoration's finish line. */
export interface MarginLine {
  /** Indices into the owning mesh's vertex buffer that anchor the spline to the surface. */
  vertexAnchors: readonly number[];
  controlPoints: readonly Vec3[];
  closed: boolean;
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
  marginLines: Partial<Record<FdiTooth, MarginLine>>;
  insertionAxis: Vec3;
  params: RestorationParams;
  /** Content hashes into the mesh store for each completed pipeline stage. */
  stages: {
    innerSurface?: string;
    anatomyPlacement?: string;
    morphState?: string;
    finalMesh?: string;
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
  schemaVersion: 1;
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
