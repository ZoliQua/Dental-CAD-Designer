// apps/server/src/bridge-qc-fixture.testutil.ts
//
// Shared bridge-QC test fixture for Phase 6 Task 8's server tests — the bridge
// analogue of `inlay-qc-fixture.testutil.ts`. Builds a GENUINE 3-unit posterior
// bridge via the SAME public kernel + cad-pipeline pipeline the client's bridge
// worker jobs use (the analytic closed-form `bridgeAssemblyFixture` → the
// journaled `runBridgeAssemblyStage` fuse → `runBridgeQc`), so the QcReport the
// server recomputes is the same one the client's `runBridgeQc` produces.
//
// The chain is GENUINELY COUPLED (the P4/T12b lesson): the assembled solid QC
// measures IS the one the journaled assembly stage produced (built ONCE and
// reused for the QC input, persistence, and replay). The connectors carry their
// REAL kernel-measured minimum cross-section area (the T4 gate value) + their own
// positional target resolved from the two units they span.
//
// The analytic 3-unit bridge fixture comes from the kernel via its dedicated
// `@dqcad/kernel/bridge-fixtures` subpath export (test-only, resolved through the
// package map like `@dqcad/kernel/cavity-fixtures` — NOT a relative `../../packages`
// path, which would violate this project's `rootDir: src`). NOT a `.test.ts` —
// imported by the dual-validation + persistence suites, never run as a suite itself.
import {
  KERNEL_VERSION,
  type IndexedMesh,
  type Vec3,
  type FitRegionDescriptor,
} from '@dqcad/kernel';
import { bridgeAssemblyFixture, type BridgeAssemblyFixtureOptions } from '@dqcad/kernel/bridge-fixtures';
import type { FdiTooth, QcReport } from '@dqcad/shared-types';
import {
  connectorPositionalTargetMm2,
  runBridgeAssemblyStage,
  type BridgeAssemblyStageResult,
  type BridgePipelineContext,
  type BridgeUnitQcInput,
  type ConnectorCrossSection,
  type PipelineMeshHandle,
  type RunBridgeQcInput,
} from '@dqcad/cad-pipeline';
import { hashMesh } from './journal-replay.js';
import { PROFILE } from './crown-qc-fixture.testutil.js';

// The 3-unit posterior bridge — teeth 14 (abutment) · 15 (pontic) · 16 (abutment).
export const BRIDGE_TEETH: readonly FdiTooth[] = [14, 15, 16] as FdiTooth[];
export const BRIDGE_PONTICS: readonly FdiTooth[] = [15] as FdiTooth[];
export const BRIDGE_ADJACENCY: readonly (readonly [FdiTooth, FdiTooth])[] = [
  [14, 15],
  [15, 16],
] as [FdiTooth, FdiTooth][];
export const AXIS: Vec3 = [0, 0, 1];

/** The profile's positional connector targets (zirconia bridge default — the
 * live-UI default; matches the crown-qc PROFILE's `connectorAreaMm2`). */
const CONNECTOR_TARGETS = { posteriorMm2: PROFILE.connectorAreaMm2.posteriorMm2, anteriorMm2: PROFILE.connectorAreaMm2.anteriorMm2 };

/** A representative measured pontic-relief scalar (µm-scale, well under the
 * ±20 µm gate). The pontic-relief measurement is a Task-3 concern proven in the
 * bridge-acceptance golden; here the *scalar* rides WITH the request (a
 * geometry-scoped parameter — the server uses the exact value the client used,
 * and the bit-identical dual-validation proof catches any divergence), so the
 * whole QC report stays byte-identical regardless of how the scalar was measured.
 * The T7 `runBridgeQc` worker-job test uses the same fixed-scalar approach. */
const PONTIC_RELIEF = { maxAbsDeviationMm: 0.0002, style: 'hygienic', configuredReliefMm: PROFILE.ponticHygienicClearanceMm };

function handle(mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash: hashMesh(mesh), mesh };
}

/** A bridge `BridgePipelineContext` for the assembly stage (restoration type
 * bridge — `runBridgeAssemblyStage` asserts it via `assertBridgeContext`). The
 * stage reads only the type + the supplied handles; the remaining bridge-only
 * fields are structurally required but unused by the fuse. */
function bridgeContext(): BridgePipelineContext {
  return {
    restorationId: 'bridge-under-test',
    restorationType: 'bridge',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle({ positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }),
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    ponticSites: [...BRIDGE_PONTICS],
    gingivaMesh: null,
    unitAdjacency: [...BRIDGE_ADJACENCY],
    stages: {},
  };
}

/** Everything a Task-8 server test needs for one built bridge: the QC input, the
 * journaled assembly stage (for replay + persistence), the fused solid, the input
 * handles, and the bridge context. */
export interface BuiltBridgeRestoration {
  readonly qcInput: RunBridgeQcInput;
  readonly assemblyStage: BridgeAssemblyStageResult;
  readonly assembledSolid: IndexedMesh;
  readonly context: BridgePipelineContext;
  readonly unitHandles: readonly PipelineMeshHandle[];
  readonly connectorHandles: readonly PipelineMeshHandle[];
}

export interface BuildBridgeOptions {
  /** Fixture knobs (the falsifiable blocks live here — e.g.
   * `connectorSemiAxisMm: 1.2633` for the ~5 mm² connector, or
   * `thinPonticInnerRadiusMm: 2.6` for the thin-unit thickness block). */
  readonly fixture?: BridgeAssemblyFixtureOptions;
  /** Framework mode — every unit judged against the single framework minimum. */
  readonly frameworkMode?: boolean;
  /** Gate names to acknowledge (the acknowledgment must round-trip byte-for-byte). */
  readonly acknowledgedGates?: readonly string[];
  /** `journalHash` stamped on the report — kept stable per built variant. */
  readonly journalHash?: string;
}

/**
 * Builds a genuine 3-unit posterior bridge + its `runBridgeQc` input. The
 * assembled solid is produced ONCE via the journaled `runBridgeAssemblyStage` and
 * reused for the QC input — the coupled chain (the solid QC measures IS the one
 * the assembly stage sealed, whose hash the persistence + replay tests check).
 */
export async function buildBridge(options: BuildBridgeOptions = {}): Promise<BuiltBridgeRestoration> {
  const fx = bridgeAssemblyFixture(options.fixture);

  const context = bridgeContext();
  const unitHandles = fx.units.map((u) => handle(u.mesh));
  const connectorHandles = fx.connectors.map((c) => handle(c.mesh));
  const assemblyStage = await runBridgeAssemblyStage(context, {
    unitMeshes: unitHandles,
    connectorMeshes: connectorHandles,
    hashMesh,
  });
  const assembledSolid = assemblyStage.assembledSolid;

  const units: BridgeUnitQcInput[] = fx.units.map((u) => ({
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: u.innerSurfaceMesh,
    outerSurfaceMesh: u.outerSurfaceMesh,
    insertionAxis: u.insertionAxis,
    marginLoop: u.marginLoop,
    fitRegion: u.kind === 'abutment' ? u.fitRegion : undefined,
  }));
  const dieSolids = fx.units.filter((u) => u.die).map((u) => u.die!);
  const connectors: ConnectorCrossSection[] = fx.connectors.map((c) => {
    const teeth: [FdiTooth, FdiTooth] = [c.teeth[0] as FdiTooth, c.teeth[1] as FdiTooth];
    return {
      label: c.label,
      minAreaMm2: c.minAreaMm2,
      teeth,
      targetMm2: connectorPositionalTargetMm2(teeth[0], teeth[1], CONNECTOR_TARGETS),
    };
  });

  const qcInput: RunBridgeQcInput = {
    assembledSolid,
    units,
    dieSolids,
    connectors,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: CONNECTOR_TARGETS.posteriorMm2,
    frameworkMode: options.frameworkMode,
    frameworkMinThicknessMm: PROFILE.frameworkMinThicknessMm,
    ponticRelief: { ...PONTIC_RELIEF },
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: options.journalHash ?? 'bridge-dual-validation',
    acknowledgedGates: options.acknowledgedGates,
  };

  return { qcInput, assemblyStage, assembledSolid, context, unitHandles, connectorHandles };
}

// --- serialization: RunBridgeQcInput → the POST .../validate-qc JSON body ---

function meshBody(m: IndexedMesh): { positions: number[]; indices: number[] } {
  return { positions: Array.from(m.positions), indices: Array.from(m.indices) };
}

function fitRegionBody(r: FitRegionDescriptor): Record<string, unknown> {
  return {
    axisPointMm: [...r.axisPointMm],
    axis: [...r.axis],
    maxRadialMm: r.maxRadialMm,
    minAxialMm: r.minAxialMm,
    maxAxialMm: r.maxAxialMm,
  };
}

function unitBody(u: BridgeUnitQcInput): Record<string, unknown> {
  return {
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: meshBody(u.innerSurfaceMesh),
    outerSurfaceMesh: meshBody(u.outerSurfaceMesh),
    insertionAxis: [...u.insertionAxis],
    marginLoop: u.marginLoop.map((p) => [...p]),
    ...(u.marginExclusionMm !== undefined ? { marginExclusionMm: u.marginExclusionMm } : {}),
    ...(u.fitRegion ? { fitRegion: fitRegionBody(u.fitRegion) } : {}),
  };
}

function connectorBody(c: ConnectorCrossSection): Record<string, unknown> {
  return {
    label: c.label,
    minAreaMm2: c.minAreaMm2,
    ...(c.teeth ? { teeth: [c.teeth[0], c.teeth[1]] } : {}),
    ...(c.targetMm2 !== undefined ? { targetMm2: c.targetMm2 } : {}),
  };
}

/** Serializes a `RunBridgeQcInput` into the extended validate-qc JSON body.
 * `Array.from` on the Float64/Uint32 arrays yields plain numbers that JSON
 * round-trips exactly (shortest-round-trip Number↔String), so the server
 * reconstructs bit-identical inputs. */
export function toValidateBridgeQcBody(
  input: RunBridgeQcInput,
  extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
): Record<string, unknown> {
  const ack = extra?.acknowledgedGates ?? input.acknowledgedGates;
  const acknowledgedGates = ack ? [...ack] : undefined;
  return {
    restorationType: 'bridge',
    assembledSolid: meshBody(input.assembledSolid),
    units: input.units.map(unitBody),
    dieSolids: input.dieSolids.map(meshBody),
    connectors: input.connectors.map(connectorBody),
    minWallThicknessMm: input.minWallThicknessMm,
    occlusalMinWallThicknessMm: input.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: input.connectorAreaTargetMm2,
    ...(input.frameworkMode !== undefined ? { frameworkMode: input.frameworkMode } : {}),
    ...(input.frameworkMinThicknessMm !== undefined ? { frameworkMinThicknessMm: input.frameworkMinThicknessMm } : {}),
    ponticRelief: {
      maxAbsDeviationMm: input.ponticRelief.maxAbsDeviationMm,
      style: input.ponticRelief.style,
      configuredReliefMm: input.ponticRelief.configuredReliefMm,
      ...(input.ponticRelief.thresholdMm !== undefined ? { thresholdMm: input.ponticRelief.thresholdMm } : {}),
    },
    ...(input.marginFitThresholdMm !== undefined ? { marginFitThresholdMm: input.marginFitThresholdMm } : {}),
    ...(input.seatingInterferenceVolumeToleranceMm3 !== undefined
      ? { seatingInterferenceVolumeToleranceMm3: input.seatingInterferenceVolumeToleranceMm3 }
      : {}),
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    ...(acknowledgedGates ? { acknowledgedGates } : {}),
    ...(extra?.clientReport ? { clientReport: extra.clientReport } : {}),
  };
}
