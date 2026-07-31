// apps/client/src/engine/exportContext.ts
//
// Phase 7 Task 7 — the CLIENT-side `qcContext` currency for the server export
// endpoint (`POST /api/restorations/:id/export`, body `{ request, qcContext }`).
//
// `qcContext` is the RIDING geometry context the server re-validation needs but
// CANNOT recover from the delivered mill bytes: the design-time inner/outer/fit
// surfaces, dies, margin/outline polylines, seam edges, measured contacts, etc.
// It is EXACTLY the matching validate-qc branch MINUS the restoration solid
// (the server re-imports that from `request.bytesBase64` — the one place the
// bytes are authoritative), MINUS the request-level metadata the route derives
// from the verified `request`, and MINUS the free tolerance knobs the export
// schema forbids (`schemas.ts` EXPORT_CONTEXT_FORBIDDEN_KNOBS — the F1 fix
// round: an unbounded knob could silently loosen a release gate).
//
// Parity is the whole point: each design engine builds its context from the
// SAME live-session buffers its worker QC ran on, so the server's independent
// recompute over the re-imported solid + this riding context reproduces the
// client `QcReport` field-for-field (any delta is the honest 409 mismatch, not
// a context drift). This module is the SINGLE definition of the mapping shape;
// the three engines fill it, `engine/handoff.ts` ships it.
//
// Pure, leaf — no engine/store/worker imports (so the engines and the handoff
// controller can both depend on it with no cycle). Layer rule: engine may NOT
// import cad-pipeline (boundaries), so the measured-contact shape is declared
// structurally here — it is bit-identical to cad-pipeline's `ContactResidualInput`
// (the design engines' `morphContacts` / `contactInputs` flow into it by
// structural typing) and travels as plain JSON in the request.

/** One measured proximal/antagonist contact — the JSON currency of the QC
 * `contacts` input (structurally the cad-pipeline `ContactResidualInput`). */
export interface ExportContactJson {
  readonly kind: string;
  readonly targetPenetrationMm: number;
  readonly achievedSignedDistanceMm: number;
  readonly contactResidualMm: number;
  readonly regionResidualMm: number;
  readonly clampBound: boolean;
}

/** A mesh as the server's `MeshDataInput` (JSON number arrays; JSON round-trips
 * a Float64 exactly, so this is bit-identical to the client's f64 buffers —
 * the foundation of the dual-validation parity proof). */
export interface MeshDataJson {
  positions: number[];
  indices: number[];
}

export interface SeamEdgeJson {
  a: number[];
  b: number[];
  segment: string;
}

export interface FitRegionJson {
  axisPointMm: number[];
  axis: number[];
  maxRadialMm: number;
  minAxialMm: number;
  maxAxialMm: number;
}

export interface CrownExportQcContext {
  innerSurfaceMesh: MeshDataJson;
  outerSurfaceMesh: MeshDataJson;
  dieSolid: MeshDataJson;
  marginResampledPoints: number[][];
  insertionAxis: number[];
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  contacts: ExportContactJson[];
  contactClampWarning: boolean;
  marginExclusionMm?: number;
  /** The shell stage's journaled morph→shell heal @errorBound (mm), riding with
   * the request so the server's contact gate SUMS the same value the client did
   * (a journaled PARAM, never a server re-measurement — invariant 6). Omitted
   * when the outer was not healed ⇒ 0 both sides ⇒ byte-identical report. */
  healErrorBoundMm?: number;
}

export interface InlayExportQcContext {
  fitSurfaceMesh: MeshDataJson;
  patchMesh: MeshDataJson;
  toothWithCavitySolid: MeshDataJson;
  cavityOutlineResampledPoints: number[][];
  insertionAxis: number[];
  thicknessMinimums: { inlayMinThicknessMm: number; onlayMinThicknessMm: number };
  marginExclusionMm: number;
  coverage?: {
    coverageDivider: { pointMm: number[]; normalMm: number[] };
    cuspCoverageMinThicknessMm: number;
  };
  seamEdges: SeamEdgeJson[];
  cavityTriangleIndices: number[];
  contacts: ExportContactJson[];
  contactClampWarning: boolean;
}

export interface BridgeUnitJson {
  label: string;
  kind: 'abutment' | 'pontic';
  innerSurfaceMesh: MeshDataJson;
  outerSurfaceMesh: MeshDataJson;
  insertionAxis: number[];
  marginLoop: number[][];
  fitRegion?: FitRegionJson;
}

export interface BridgeConnectorJson {
  label: string;
  minAreaMm2: number;
  teeth?: number[];
  targetMm2?: number;
}

export interface BridgeExportQcContext {
  units: BridgeUnitJson[];
  dieSolids: MeshDataJson[];
  connectors: BridgeConnectorJson[];
  minWallThicknessMm: number;
  occlusalMinWallThicknessMm: number;
  connectorAreaTargetMm2: number;
  frameworkMode?: boolean;
  frameworkMinThicknessMm?: number;
  ponticRelief: { maxAbsDeviationMm: number; style: string; configuredReliefMm: number };
}

export type ExportQcContext = CrownExportQcContext | InlayExportQcContext | BridgeExportQcContext;

// --- converters (typed-array → JSON, flat → point list) --------------------

/** A mesh's Float64/Uint32 buffers as JSON number arrays. */
export function meshJson(positions: Float64Array, indices: Uint32Array): MeshDataJson {
  return { positions: Array.from(positions), indices: Array.from(indices) };
}

/** A flat `[x0,y0,z0,x1,y1,z1,…]` Float64 loop as `[[x,y,z],…]` — the exact
 * point set the client QC consumed (the kernel gate rebuilds the same Vec3[]
 * from either representation). Throws on a non-multiple-of-3 length (a
 * corrupt loop must fail loudly, never silently drop a coordinate). */
export function loopJson(flat: Float64Array): number[][] {
  if (flat.length % 3 !== 0) {
    throw new Error(`exportContext: loop length ${flat.length} is not a multiple of 3`);
  }
  const out: number[][] = [];
  for (let i = 0; i < flat.length; i += 3) {
    out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  }
  return out;
}

/** A Uint32 index array as a plain number array. */
export function indicesJson(indices: Uint32Array): number[] {
  return Array.from(indices);
}
