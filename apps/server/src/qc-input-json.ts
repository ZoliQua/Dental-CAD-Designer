// apps/server/src/qc-input-json.ts
//
// Shared JSON → kernel reconstruction helpers + the QcReport differ, used by
// BOTH server-side dual-validation surfaces:
//   - POST /api/restorations/:id/validate-qc (app.ts, Phase 4/5/6), and
//   - POST /api/restorations/:id/export (export-route.ts, Phase 7 Task 4).
// Extracted VERBATIM from app.ts (pure move, no behavior change) so the
// export route cannot drift from the validate-qc reconstruction contract.
//
// JSON round-trips a Float64 exactly (ECMAScript shortest-round-trip
// Number↔String), so every reconstruction below is bit-identical to what the
// client serialized — the foundation of the bit-identical dual-validation
// proofs.
import type { FitRegionDescriptor, IndexedMesh, SeamEdge, Vec3 } from '@dqcad/kernel';
import type { FdiTooth, QcGateResult, QcReport } from '@dqcad/shared-types';
import type { BridgeUnitQcInput, ConnectorCrossSection } from '@dqcad/cad-pipeline';

export interface MeshDataInput {
  positions: number[];
  indices: number[];
}

export interface SeamEdgeInput {
  a: number[];
  b: number[];
  segment: string;
}

export interface FitRegionInput {
  axisPointMm: number[];
  axis: number[];
  maxRadialMm: number;
  minAxialMm: number;
  maxAxialMm: number;
}

export interface BridgeUnitInput {
  label: string;
  kind: 'abutment' | 'pontic';
  innerSurfaceMesh: MeshDataInput;
  outerSurfaceMesh: MeshDataInput;
  insertionAxis: number[];
  marginLoop: number[][];
  marginExclusionMm?: number;
  fitRegion?: FitRegionInput;
}

export interface BridgeConnectorInput {
  label: string;
  minAreaMm2: number;
  teeth?: number[];
  targetMm2?: number;
}

export interface QcReportDifference {
  path: string;
  server: unknown;
  client: unknown;
}

/**
 * Thrown when a client-supplied mesh's triangle index set references a vertex
 * that does not exist (index ≥ vertex count, or a positions buffer whose length
 * is not a multiple of 3). The JSON schema pins `indices` to non-negative
 * integers but CANNOT express the cross-field upper bound (an index must be <
 * `positions.length / 3`), so an out-of-range index would otherwise reach the
 * kernel gates as an out-of-bounds typed-array read → `NaN` gate values or an
 * uncaught throw → a 500. Reconstruction refuses first, so the route maps it to
 * a typed 400 (the advisory validate-qc path) / `qc-invalid-input` (export),
 * never a 500 and never a silent `NaN` measurement.
 */
export class MeshIndexOutOfBoundsError extends Error {
  readonly index: number;
  readonly position: number;
  readonly vertexCount: number;
  constructor(index: number, position: number, vertexCount: number) {
    super(
      `mesh triangle index ${index} at indices[${position}] is out of bounds for a mesh with ` +
        `${vertexCount} vertices (valid range 0..${vertexCount - 1})`,
    );
    this.name = 'MeshIndexOutOfBoundsError';
    this.index = index;
    this.position = position;
    this.vertexCount = vertexCount;
  }
}

/** Rebuilds a kernel `IndexedMesh` (Float64 positions, Uint32 indices — the
 * Float64 invariant holds; no Float32 anywhere) from the JSON number arrays.
 * JSON round-trips a Float64 exactly, so this is bit-identical to the mesh the
 * client hashed/measured.
 *
 * BOUNDS-CHECKED (server code-review LOW #5): every triangle index is validated
 * against the reconstructed vertex count BEFORE the mesh reaches any kernel gate
 * — an out-of-range index is a typed `MeshIndexOutOfBoundsError`, not a
 * downstream `NaN`/500. */
export function toIndexedMesh(data: MeshDataInput): IndexedMesh {
  const positions = new Float64Array(data.positions);
  // A positions buffer whose length is not a multiple of 3 has no well-defined
  // vertex count — treat it as malformed (the same typed refusal, reported at
  // the first index).
  const vertexCount = Math.floor(positions.length / 3);
  const wellFormed = positions.length % 3 === 0;
  for (let i = 0; i < data.indices.length; i++) {
    const idx = data.indices[i]!;
    if (!wellFormed || idx >= vertexCount) {
      throw new MeshIndexOutOfBoundsError(idx, i, vertexCount);
    }
  }
  return { positions, indices: Uint32Array.from(data.indices) };
}

export function toVec3(a: readonly number[]): Vec3 {
  const [x, y, z] = a;
  if (x === undefined || y === undefined || z === undefined) {
    // Unreachable — the JSON schema pins these arrays to exactly 3 numbers.
    throw new Error('expected a 3-component vector');
  }
  return [x, y, z];
}

/** Rebuilds the cavity outline / margin polyline (Float64 Vec3 tuples) from the
 * JSON number arrays — bit-identical to the client's (JSON round-trips Float64
 * exactly). */
export function toLoop(points: readonly number[][]): Vec3[] {
  return points.map(toVec3);
}

/** Rebuilds the seam edge set (Task 4/5 `seamEdges`) — the G1-gate currency —
 * from the JSON representation. */
export function toSeamEdges(edges: readonly SeamEdgeInput[]): SeamEdge[] {
  return edges.map((e) => ({ a: toVec3(e.a), b: toVec3(e.b), segment: e.segment }));
}

/** Rebuilds a kernel `FitRegionDescriptor` (the abutment intaglio region — the
 * marginFit gate extracts its patch off the assembled solid with it) from the
 * JSON representation. */
export function toFitRegion(r: FitRegionInput): FitRegionDescriptor {
  return {
    axisPointMm: toVec3(r.axisPointMm),
    axis: toVec3(r.axis),
    maxRadialMm: r.maxRadialMm,
    minAxialMm: r.minAxialMm,
    maxAxialMm: r.maxAxialMm,
  };
}

/** Rebuilds one bridge unit's QC input (per-unit surfaces + margin loop + axis +,
 * for an abutment, the fit-region descriptor) from the JSON representation. */
export function toBridgeUnit(u: BridgeUnitInput): BridgeUnitQcInput {
  return {
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: toIndexedMesh(u.innerSurfaceMesh),
    outerSurfaceMesh: toIndexedMesh(u.outerSurfaceMesh),
    insertionAxis: toVec3(u.insertionAxis),
    marginLoop: toLoop(u.marginLoop),
    marginExclusionMm: u.marginExclusionMm,
    fitRegion: u.fitRegion ? toFitRegion(u.fitRegion) : undefined,
  };
}

/** Rebuilds one measured connector (its kernel-measured min cross-section area +
 * the two teeth it spans + its pre-resolved positional target) from JSON. */
export function toBridgeConnector(c: BridgeConnectorInput): ConnectorCrossSection {
  const teeth = c.teeth;
  return {
    label: c.label,
    minAreaMm2: c.minAreaMm2,
    teeth: teeth && teeth.length === 2 ? [teeth[0] as FdiTooth, teeth[1] as FdiTooth] : undefined,
    targetMm2: c.targetMm2,
  };
}

/** Independent (never client-trusting) diff of the server-computed report
 * against a client-supplied one — every scalar that differs becomes one
 * `{ path, server, client }` diagnostic entry. Exact equality (`!==`), so a
 * single-ULP float divergence surfaces rather than being smoothed over. */
export function diffQcReports(server: QcReport, client: QcReport): QcReportDifference[] {
  const diffs: QcReportDifference[] = [];
  const scalar = (path: string, s: unknown, c: unknown): void => {
    if (s !== c) diffs.push({ path, server: s, client: c });
  };
  scalar('passed', server.passed, client.passed);
  scalar('kernelVersion', server.kernelVersion, client.kernelVersion);
  scalar('profileVersion', server.profileVersion, client.profileVersion);
  scalar('journalHash', server.journalHash, client.journalHash);
  scalar('gates.length', server.gates.length, client.gates.length);
  const n = Math.min(server.gates.length, client.gates.length);
  const fields: readonly (keyof QcGateResult)[] = [
    'gate',
    'passed',
    'acknowledged',
    'value',
    'threshold',
    'unit',
    'message',
  ];
  for (let i = 0; i < n; i++) {
    const s = server.gates[i]!;
    const c = client.gates[i]!;
    for (const f of fields) scalar(`gates[${i}].${f}`, s[f], c[f]);
  }
  return diffs;
}
