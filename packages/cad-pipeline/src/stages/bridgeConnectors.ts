// packages/cad-pipeline/src/stages/bridgeConnectors.ts
//
// Phase 6 Task 4 — the BRIDGE CONNECTORS stage. A connector is the bar of
// material joining two adjacent bridge units (abutment↔pontic, pontic↔pontic);
// its minimum cross-section area is the fracture-strength gate value. This stage
// AUTO-PLACES one connector solid per adjacent unit pair (`context.unitAdjacency`)
// as a deterministic ruled LOFT between two closed 2D cross-section profiles, and
// MEASURES each connector's fail-safe minimum area (the @dqcad/kernel connector
// op), resolving each connector's positional target (posterior 9 / anterior 7)
// from the units it spans via the documented FDI rule. It PRODUCES the per-
// connector `ConnectorCrossSection` inputs the whole-bridge QC gate (Task 6)
// consumes — this stage does not itself decide block/pass (gates live in the QC
// assembler / caller, the P4/P5 discipline).
//
// ## Auto-placement (documented construction)
//
// Each unit's REPRESENTATIVE point is its mesh centroid; the connector AXIS is
// the segment between the two units' centroids (mesiodistal, from the lower-FDI
// toward the higher), and the two profile planes sit ⟂ that axis, symmetric about
// the inter-centroid MIDPOINT, `spanFraction`·(centroid distance) apart. The
// DEFAULT cross-section is the classic elliptical connector section
// (`makeEllipseConnectorProfile`) with geometric semi-axes (NOT clinical
// defaults — a section SHAPE, not a gap/thickness). A caller may instead supply
// EDITABLE profiles per pair (validated closed/simple/consistently-wound by the
// kernel op) — a journaled design decision.
//
// ## Guard rail (Phase 5 Task 1 pattern)
//
// `assertBridgeContext` at entry — bridge-only stage. Each pair's two unit MESHES
// are supplied in `options.unitMeshes` (the abutment fit-surface bodies from Task
// 2 + the pontic body from Task 3, as they stand this session) — a missing unit
// mesh is this stage's own typed gate.
//
// ## Journaling: ONE multi-unit op (`bridge.connectors`)
//
// A bridge's connectors are placed together as one coupled step (they share the
// arch and the shared insertion axis); like the abutment-surfaces stage (Task 2)
// this emits ONE journaled op whose params carry every connector's frame +
// profiles + measured area + resolved target, and whose outputHashes list every
// connector mesh in pair order. Replay rebuilds all connectors deterministically
// → identical output hashes.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  buildConnectorFrame,
  loftConnectorProfiles,
  measureConnectorMinArea,
  makeEllipseConnectorProfile,
  type IndexedMesh,
  type Vec3,
  type ConnectorProfile2D,
  type MeasureConnectorMinAreaResult,
} from '@dqcad/kernel';
import type { BridgePipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import { assertBridgeContext } from '../pipeline/context.ts';
import {
  connectorPositionalTargetMm2,
  type ConnectorCrossSection,
} from '../gates/connectorCrossSection.ts';

/** Thrown when the bridge context carries no unit adjacency (no connectors). */
export class NoConnectorsError extends Error {
  constructor() {
    super('bridgeConnectors stage: context.unitAdjacency is empty — a bridge needs at least one adjacent unit pair to connect');
    this.name = 'NoConnectorsError';
  }
}

/** Thrown when a unit named in an adjacency pair has no mesh in
 * `options.unitMeshes` — a connector cannot be placed without both unit bodies. */
export class MissingUnitMeshError extends Error {
  readonly tooth: FdiTooth;
  constructor(tooth: FdiTooth) {
    super(`bridgeConnectors stage: no mesh supplied for unit ${tooth} (options.unitMeshes) — both units of a pair are required to place a connector`);
    this.name = 'MissingUnitMeshError';
    this.tooth = tooth;
  }
}

/** Caller-supplied EDITABLE profiles for one connector (both closed 2D polylines
 * in the section plane's (e1,e2) frame; equal vertex counts + consistent
 * winding, validated by the kernel loft). */
export interface EditableConnectorProfiles {
  readonly profileA: ConnectorProfile2D;
  readonly profileB: ConnectorProfile2D;
}

export interface BridgeConnectorsStageOptions {
  /** Each unit's current body mesh, keyed by FDI (abutment fit-surface bodies +
   * pontic body). Every tooth in `context.unitAdjacency` must be present. */
  readonly unitMeshes: Partial<Record<FdiTooth, PipelineMeshHandle>>;
  /** Default elliptical section semi-axis along e1 (buccolingual), mm. Default 2.2. */
  readonly defaultSemiE1Mm?: number;
  /** Default elliptical section semi-axis along e2 (occlusogingival), mm. Default 1.8. */
  readonly defaultSemiE2Mm?: number;
  /** Default profile segment count (both profiles — matched counts). Default 64. */
  readonly profileSegments?: number;
  /** Connector axial length as a fraction of the inter-centroid distance.
   * Default 0.5. */
  readonly spanFraction?: number;
  /** Section stations for the sampled (live-readout) instrument. Default 63. */
  readonly stationCount?: number;
  /** EDITABLE per-pair profile overrides, keyed by `"<a>-<b>"` (the pair as given
   * in `context.unitAdjacency`). A pair without an entry uses the default ellipse. */
  readonly profiles?: ReadonlyMap<string, EditableConnectorProfiles>;
  /** Content-hash function for a produced mesh — injected by the caller. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** One placed + measured connector. */
export interface BridgeConnectorResult {
  readonly teeth: readonly [FdiTooth, FdiTooth];
  readonly label: string;
  readonly mesh: IndexedMesh;
  readonly contentHash: string;
  /** The kernel measurement (gate value + analytic + sampled + tessellation). */
  readonly measurement: MeasureConnectorMinAreaResult;
  /** The measured minimum cross-section area (mm²) — the fail-safe gate value. */
  readonly minAreaMm2: number;
  /** The positional target (mm²) resolved via the FDI rule. */
  readonly targetMm2: number;
  /** Whether this connector alone meets its own target (the gate re-checks). */
  readonly meetsTarget: boolean;
  readonly axis: Vec3;
  readonly spanMm: number;
  readonly profileSource: 'default' | 'editable';
}

export interface BridgeConnectorsStageResult {
  readonly stage: 'connectors';
  readonly connectors: readonly BridgeConnectorResult[];
  /** The gate-ready inputs for the whole-bridge QC connector gate (Task 6). */
  readonly gateConnectors: readonly ConnectorCrossSection[];
  readonly operationName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
}

function centroid(mesh: IndexedMesh): Vec3 {
  const p = mesh.positions;
  const n = p.length / 3;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < p.length; i += 3) {
    sx += p[i]!;
    sy += p[i + 1]!;
    sz += p[i + 2]!;
  }
  return [sx / n, sy / n, sz / n];
}

function pairKey(a: FdiTooth, b: FdiTooth): string {
  return `${a}-${b}`;
}

/**
 * Runs the bridge connectors stage — see this file's doc. Deterministic: same
 * context + options → byte-identical connector meshes + measured areas + hashes.
 *
 * @throws {RestorationTypeMismatchError}/{BridgeContextIncompleteError} via `assertBridgeContext`.
 * @throws {NoConnectorsError} if `context.unitAdjacency` is empty.
 * @throws {MissingUnitMeshError} if a pair's unit has no mesh in `options.unitMeshes`.
 * @throws the kernel connector op's typed errors (degenerate/self-intersecting/
 * count-mismatch/winding-mismatch profiles; degenerate axis/span).
 */
export function runBridgeConnectorsStage(
  context: BridgePipelineContext,
  options: BridgeConnectorsStageOptions,
): BridgeConnectorsStageResult {
  assertBridgeContext(context); // bridge-only stage — guard rail
  const pairs = context.unitAdjacency;
  if (pairs.length === 0) throw new NoConnectorsError();

  const semiE1 = options.defaultSemiE1Mm ?? 2.2;
  const semiE2 = options.defaultSemiE2Mm ?? 1.8;
  const segments = options.profileSegments ?? 64;
  const spanFraction = options.spanFraction ?? 0.5;
  const targets = context.materialProfile.connectorAreaMm2;

  const connectors: BridgeConnectorResult[] = [];
  const gateConnectors: ConnectorCrossSection[] = [];
  const inputHashSet = new Map<FdiTooth, string>();
  const paramPairs: Record<string, unknown>[] = [];

  for (const pair of pairs) {
    const [ta, tb] = pair;
    const handleA = options.unitMeshes[ta];
    const handleB = options.unitMeshes[tb];
    if (!handleA) throw new MissingUnitMeshError(ta);
    if (!handleB) throw new MissingUnitMeshError(tb);
    inputHashSet.set(ta, handleA.contentHash);
    inputHashSet.set(tb, handleB.contentHash);

    const pA = centroid(handleA.mesh);
    const pB = centroid(handleB.mesh);
    const axisVec: Vec3 = [pB[0] - pA[0], pB[1] - pA[1], pB[2] - pA[2]];
    const dist = Math.hypot(axisVec[0], axisVec[1], axisVec[2]);
    const spanMm = dist * spanFraction;
    const axisUnit: Vec3 = [axisVec[0] / dist, axisVec[1] / dist, axisVec[2] / dist];
    const midpoint: Vec3 = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, (pA[2] + pB[2]) / 2];
    const origin: Vec3 = [
      midpoint[0] - (spanMm / 2) * axisUnit[0],
      midpoint[1] - (spanMm / 2) * axisUnit[1],
      midpoint[2] - (spanMm / 2) * axisUnit[2],
    ];
    const frame = buildConnectorFrame(origin, axisVec, spanMm);

    const editable = options.profiles?.get(pairKey(ta, tb));
    const profileSource: 'default' | 'editable' = editable ? 'editable' : 'default';
    const profileA = editable ? editable.profileA : makeEllipseConnectorProfile(semiE1, semiE2, segments);
    const profileB = editable ? editable.profileB : makeEllipseConnectorProfile(semiE1, semiE2, segments);

    const { mesh } = loftConnectorProfiles(profileA, profileB, frame);
    const contentHash = options.hashMesh(mesh);
    const measurement = measureConnectorMinArea(mesh, frame, profileA, profileB, {
      stationCount: options.stationCount ?? 63,
    });
    const minAreaMm2 = measurement.minAreaMm2;
    const targetMm2 = connectorPositionalTargetMm2(ta, tb, targets);
    const label = `${ta}–${tb}`;
    const meetsTarget = minAreaMm2 >= targetMm2;

    connectors.push({
      teeth: [ta, tb],
      label,
      mesh,
      contentHash,
      measurement,
      minAreaMm2,
      targetMm2,
      meetsTarget,
      axis: frame.axis,
      spanMm,
      profileSource,
    });
    gateConnectors.push({ label, minAreaMm2, teeth: [ta, tb], targetMm2 });
    // Journaled per-connector record: `minAreaMm2` (the mesh-sampled, never-over-
    // reporting lower bound — `measurement.sampled.guaranteedLowerBoundMm2`) is the
    // VERDICT DRIVER the gate consumes; `analyticMinAreaMm2` (the exact closed-form
    // ideal-ring minimum) and `stationMarginMm2` are AUDIT fields (validation oracle
    // + the margin subtracted) — see the kernel connector op's @errorBound.
    paramPairs.push({
      teeth: [ta, tb],
      axis: frame.axis,
      spanMm,
      profileSource,
      profileVertexCount: profileA.length,
      minAreaMm2,
      analyticMinAreaMm2: measurement.analytic.minAreaMm2,
      stationMarginMm2: measurement.sampled.stationMarginMm2,
      targetMm2,
    });
  }

  return {
    stage: 'connectors',
    connectors,
    gateConnectors,
    operationName: 'bridge.connectors',
    params: {
      pairs: paramPairs,
      defaultSemiE1Mm: semiE1,
      defaultSemiE2Mm: semiE2,
      profileSegments: segments,
      spanFraction,
      stationCount: options.stationCount ?? 63,
    },
    inputHashes: [...inputHashSet.values()],
    outputHashes: connectors.map((c) => c.contentHash),
  };
}
