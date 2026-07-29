// apps/client/src/engine/bridgeDesign.ts
//
// Phase 6 Task 7 — the BRIDGE (multi-unit) design workflow CONTROLLER. The bridge
// analogue of engine/cavityDesign.ts: imperative, engine layer, the SOLE
// client-side orchestrator of the bridge pipeline stages in the fixed order
// enforced by engine/bridgeWorkflow.ts. It:
//   1. dispatches the REGISTERED bridge worker jobs — `bridgeConnectors` (the
//      LIVE connector editor: re-loft + measure editable profiles),
//      `bridgeAssembly` (fuse units + connectors into one watertight solid), and
//      `runBridgeQc` (whole-bridge QC) — through the WorkerPool, adding NO new
//      nondeterminism of its own;
//   2. enforces stage order (consults `canRunBridgeStage` before every dispatch,
//      throwing `BridgeStageOrderError` on a premature call);
//   3. content-addresses each stage's output (the `hashMesh` job) and writes the
//      hash into `Restoration.stages` (`bridgeAbutmentSurfaces`/`bridgePontic`/
//      `bridgeConnectors`/`bridgeFramework`/`finalMesh`);
//   4. JOURNALS every completed stage/sub-action as ONE COALESCED `Operation`
//      (previews journal nothing), mirroring engine/cavityDesign.ts;
//   5. publishes an ephemeral UI snapshot to state/bridgeStore.ts after every
//      change (committed hashes/QcReport flow through the case document);
//   6. surfaces a stage FAILURE HONESTLY (an error state; it NEVER writes a stage
//      hash/qc for a stage that failed, so a broken bridge can never masquerade
//      as a completed one — the P4 honest-failure invariant).
//
// ## The abutmentSurfaces / pontic milestones are asset-provided (documented)
//
// The upstream T2 (per-abutment intaglios + shared axis + margin fit) and T3
// (pontic body/base + measured relief) geometry is NOT re-run client-side — its
// real inputs (a prep BVH; an edentulous-ridge scan + library body + canonical
// frame) are not reconstructable in the UI. Instead the controller CAPTURES that
// kernel-built geometry from a `BridgeSessionGeometry` handed to `start()` — the
// SAME "external kernel-built artifact captured, never ported" split the cavity
// `outline` stage uses (the browser lane supplies the serialized fixture asset via
// engine/bridgeGeometry.ts). Committing these milestones content-addresses +
// journals the captured surfaces; the connector editor, assembly and QC are the
// genuinely interactive client stages driven through the real registered jobs.
//
// Layer rule: engine may import kernel-workers / state / shared-types /
// clinical-profiles only (never kernel, cad-pipeline, Three.js). Kernel/pipeline
// payload types are matched STRUCTURALLY here (the worker payload types are
// interfaces, so a plain object with the right fields satisfies WorkerPool.run's
// inferred payload type — the same layer-boundary convention crown/cavityDesign
// document).
import { KERNEL_VERSION, type JobName, type JobPayloadMap, type JobResultMap, type RunJobOptions } from '@dqcad/kernel-workers';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import type { Operation, QcReport, Restoration, Vec3 } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import {
  type BridgeStage,
  canRunBridgeStage,
  bridgeDownstreamInvalidations,
  hasAbutmentMargins,
  nextRunnableBridgeStage,
  bridgeWorkflowGates,
} from './bridgeWorkflow';
import { getPool } from './workers';
import { meshJson, type BridgeExportQcContext } from './exportContext';
import {
  useBridgeStore,
  type BridgeConnectorReadout,
  type BridgeFrameworkMode,
  type BridgeStageGateSnapshot,
  type PonticStyleName,
} from '../state/bridgeStore';
import { useCaseStore } from '../state/caseStore';

/** Re-export the pontic-style union so the panel imports it from one place. */
export type { PonticStyleName };

/** Minimal structural view of a pool that can dispatch a job (`WorkerPool`
 * satisfies it; node-lane tests inject a fake implementing exactly this). */
export interface RunnablePool {
  run<J extends JobName>(jobName: J, payload: JobPayloadMap[J], opts?: RunJobOptions): Promise<JobResultMap[J]>;
}

type Buffers = { positions: Float64Array; indices: Uint32Array };

/** One unit of the captured bridge geometry (a kernel-built T2/T3 artifact). */
export interface BridgeSessionUnit {
  label: string;
  kind: 'abutment' | 'pontic';
  insertionAxis: Vec3;
  marginFitMm: number;
  mesh: Buffers;
  inner: Buffers;
  outer: Buffers;
  marginLoop: readonly Vec3[];
  fitRegion: { axisPointMm: Vec3; axis: Vec3; maxRadialMm: number; minAxialMm: number; maxAxialMm: number } | null;
  die: Buffers | null;
}

/** One connector's captured frame + default profile (the T4 auto-placement). */
export interface BridgeSessionConnector {
  label: string;
  teeth: readonly [number, number];
  originMm: Vec3;
  axisMm: Vec3;
  spanMm: number;
  semiAxisMm: number;
  segments: number;
  profileFlat: readonly number[];
  defaultMinAreaMm2: number;
}

/** The captured bridge geometry `start()` consumes — supplied by the caller (the
 * browser lane's serialized fixture asset via engine/bridgeGeometry.ts; a future
 * real tool builds it from the coupled T2/T3 stages). */
export interface BridgeSessionGeometry {
  sharedAxis: { direction: Vec3; acceptable: boolean; perAbutment: readonly { label: string; marginFitMm: number }[] };
  units: readonly BridgeSessionUnit[];
  connectors: readonly BridgeSessionConnector[];
  ponticReliefByStyle: Record<string, { configuredReliefMm: number; maxAbsDeviationMm: number }>;
}

/** The ±20 µm pontic-relief acceptance tolerance (mm). Mirrors cad-pipeline's
 * `PONTIC_RELIEF_GATE_THRESHOLD_MM` — the PLAN Phase-6 acceptance TOLERANCE (how
 * tightly the built relief must match the configured value), NOT a clinical gap
 * (invariant 7 governs clinical defaults; this is the QC bar). */
const PONTIC_RELIEF_TOLERANCE_MM = 0.02;

/** The FDI positional rule (mirrors cad-pipeline's `connectorPositionalTargetMm2`):
 * a connector is POSTERIOR (the stricter target) iff EITHER unit's FDI position
 * digit is ≥ 4 (premolar/molar), else anterior. */
function connectorTargetMm2(teeth: readonly [number, number]): number {
  const posterior = teeth[0] % 10 >= 4 || teeth[1] % 10 >= 4;
  return posterior
    ? STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.posteriorMm2
    : STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.anteriorMm2;
}

/** A closed elliptical connector profile as flat (u,v) pairs — the client-side
 * regeneration for an EDITED semi-axis (the default uses the asset's byte-exact
 * `makeEllipseConnectorProfile` output). Same equal-angular sampling as the kernel
 * default, so an unedited slider reproduces the fixture connector. Geometry lives
 * in the engine layer (never ui). */
function ellipseProfileFlat(semiAxisMm: number, segments: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    out.push(semiAxisMm * Math.cos(th), semiAxisMm * Math.sin(th));
  }
  return out;
}

/** Runtime narrowing for a journaled pontic style (the journal params are
 * untyped JSON — never trusted structurally). */
function isPonticStyleName(value: string): value is PonticStyleName {
  return value === 'hygienic' || value === 'ridgeLap' || value === 'ovate';
}

/** Runtime narrowing of a `bridge-connectors` op's journaled `connectors`
 * params into typed per-connector decisions. Returns null unless the list is
 * well-formed AND covers EVERY captured connector label exactly once (a
 * partial/mismatched decision must not silently re-attach). */
function parsePersistedConnectors(
  value: unknown,
  geometry: BridgeSessionGeometry,
): { label: string; semiAxisMm: number; minAreaMm2: number; targetMm2: number }[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: { label: string; semiAxisMm: number; minAreaMm2: number; targetMm2: number }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const rec = entry as Record<string, unknown>;
    if (
      typeof rec.label !== 'string' ||
      typeof rec.semiAxisMm !== 'number' ||
      !Number.isFinite(rec.semiAxisMm) ||
      typeof rec.minAreaMm2 !== 'number' ||
      typeof rec.targetMm2 !== 'number'
    ) {
      return null;
    }
    parsed.push({ label: rec.label, semiAxisMm: rec.semiAxisMm, minAreaMm2: rec.minAreaMm2, targetMm2: rec.targetMm2 });
  }
  const labels = new Set(parsed.map((p) => p.label));
  if (labels.size !== parsed.length) return null;
  if (geometry.connectors.length !== parsed.length) return null;
  for (const c of geometry.connectors) if (!labels.has(c.label)) return null;
  return parsed;
}

/** Thrown when a stage method is called before its prerequisite produced its
 * output — the order-enforcement guard. */
export class BridgeStageOrderError extends Error {
  readonly stage: BridgeStage;
  readonly reason: string;
  constructor(stage: BridgeStage, reason: string) {
    super(`bridgeDesign: stage "${stage}" cannot run yet (${reason})`);
    this.name = 'BridgeStageOrderError';
    this.stage = stage;
    this.reason = reason;
  }
}

/** The i18n key the panel translates when a `BridgeSessionRestoreError`
 * surfaces (see state/bridgeStore.ts `errorKey`) — the actionable, localized
 * message replaces the raw error string in the banner. */
export const BRIDGE_SESSION_RESTORE_ERROR_KEY = 'bridge.errorSessionRestore';

/**
 * Thrown when persisted bridge stages exist but the in-memory session state
 * they imply cannot be FAITHFULLY rebuilt from what persistence actually
 * carries (the journaled design decisions + the captured geometry asset) —
 * e.g. a missing/drifted journal op, or a re-computed stage mesh whose content
 * hash no longer reproduces the persisted stage hash. The P7-T1 contract: this
 * must surface VISIBLY (banner + i18n key), never a guess and never a silent
 * no-op; the user re-runs the design stages to re-seal the design.
 */
export class BridgeSessionRestoreError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`bridgeDesign: cannot restore the saved bridge design into this session — ${detail}`);
    this.name = 'BridgeSessionRestoreError';
    this.detail = detail;
  }
}

/** Thrown when a session action is attempted with no active bridge session. */
export class BridgeNoSessionError extends Error {
  constructor() {
    super('bridgeDesign: no active bridge-design session (call start() first)');
    this.name = 'BridgeNoSessionError';
  }
}

/** Thrown when a bridge session is started for a non-bridge restoration type. */
export class NonBridgeRestorationError extends Error {
  readonly type: string;
  constructor(type: string) {
    super(`bridgeDesign: restoration type "${type}" is not a bridge`);
    this.name = 'NonBridgeRestorationError';
    this.type = type;
  }
}

interface CommittedConnector {
  label: string;
  teeth: readonly [number, number];
  semiAxisMm: number;
  minAreaMm2: number;
  targetMm2: number;
  positions: Float64Array;
  indices: Uint32Array;
}

/** The scalar connector design decision as journaled by `commitConnectors`
 * (`bridge-connectors` op params) — what start() recovers from persistence so
 * the connector MESHES can be deterministically re-computed on demand. */
interface PersistedConnectorDecision {
  label: string;
  semiAxisMm: number;
  minAreaMm2: number;
  targetMm2: number;
}

interface Session {
  restorationId: string;
  geometry: BridgeSessionGeometry;
  pontic: { style: PonticStyleName; configuredReliefMm: number; maxAbsDeviationMm: number } | null;
  connectors: CommittedConnector[] | null;
  frameworkMode: BridgeFrameworkMode | null;
  assembled: { positions: Float64Array; indices: Uint32Array; contentHash: string } | null;
  /** The journaled connector decision recovered on start() from persistence
   * (null when absent/unusable) — consumed by `ensureConnectorsMaterialized`. */
  persistedConnectors: PersistedConnectorDecision[] | null;
  /** Whether the persisted `bridgeAbutmentSurfaces` stage hash has been proven
   * to match THIS session's captured abutment inner+outer surfaces — set by
   * `commitAbutmentSurfaces` (it produced the hash from this geometry) or by
   * the reload verification in `ensureSessionMaterialized` (P7-T1 fix round:
   * those surfaces feed the marginFit/seating gates and must never be consumed
   * unverified after a reload). */
  abutmentSurfacesVerified: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Concatenate several indexed meshes into one (offsetting indices) — a
 * deterministic combine for content-addressing a multi-mesh milestone. */
function combineMeshes(meshes: readonly Buffers[]): Buffers {
  let vTotal = 0;
  let iTotal = 0;
  for (const m of meshes) {
    vTotal += m.positions.length;
    iTotal += m.indices.length;
  }
  const positions = new Float64Array(vTotal);
  const indices = new Uint32Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOff);
    const base = vOff / 3;
    for (let i = 0; i < m.indices.length; i++) indices[iOff + i] = m.indices[i]! + base;
    vOff += m.positions.length;
    iOff += m.indices.length;
  }
  return { positions, indices };
}

class BridgeDesignEngine {
  private session: Session | null = null;
  private testPool: RunnablePool | null = null;

  private pool(): RunnablePool {
    return this.testPool ?? getPool();
  }

  /** TEST-ONLY: inject a fake pool so the controller's order/coalescing/
   * stage-hash logic can be unit-tested on the node lane without real workers. */
  __setPoolForTests(pool: RunnablePool | null): void {
    this.testPool = pool;
  }

  private requireSession(): Session {
    if (!this.session) throw new BridgeNoSessionError();
    return this.session;
  }

  private restoration(): Restoration {
    const session = this.requireSession();
    const found = caseStore.getDocument().restorations.find((r) => r.id === session.restorationId);
    if (!found) throw new Error(`bridgeDesign: restoration ${session.restorationId} no longer exists`);
    return found;
  }

  /**
   * Begins a bridge-design session for `restorationId` with the captured bridge
   * geometry. Publishes the initial gate snapshot + shared-axis verdict. Throws
   * if the restoration is missing, not a bridge, has no target scan, or has no
   * confirmed abutment margins.
   */
  start(restorationId: string, geometry: BridgeSessionGeometry): void {
    const restoration = caseStore.getDocument().restorations.find((r) => r.id === restorationId);
    if (!restoration) throw new Error(`bridgeDesign.start: no restoration ${restorationId}`);
    if (restoration.type !== 'bridge') throw new NonBridgeRestorationError(restoration.type);
    if (restoration.targetNodeId === null) throw new BridgeStageOrderError('abutmentSurfaces', 'noTargetScan');
    if (!hasAbutmentMargins(restoration)) throw new BridgeStageOrderError('abutmentSurfaces', 'noAbutmentMargins');
    this.session = {
      restorationId,
      geometry,
      pontic: null,
      connectors: null,
      frameworkMode: null,
      assembled: null,
      persistedConnectors: null,
      abutmentSurfacesVerified: false,
    };
    // P7-T1 (the 19b root fix): a restoration re-opened AFTER a reload carries
    // persisted stage hashes but this fresh session carries none of the state
    // that produced them — recover the journaled scalar DECISIONS now (sync);
    // the stage MESHES are re-computed on demand by the deterministic jobs and
    // VERIFIED against the persisted hashes (`ensureSessionMaterialized`).
    this.restorePersistedDecisions(restoration, this.session);
    caseStore.setSelectedRestorationId(restorationId);
    this.publish({
      restorationId,
      active: true,
      error: null,
      errorStage: null,
      errorKey: null,
      errorDetail: null,
      sharedAxis: {
        acceptable: geometry.sharedAxis.acceptable,
        direction: geometry.sharedAxis.direction,
        perAbutment: geometry.sharedAxis.perAbutment.map((a) => ({ label: a.label, marginFitMm: a.marginFitMm })),
      },
    });
    this.refreshGates();
  }

  clear(): void {
    this.session = null;
    useBridgeStore.getState().reset();
  }

  /** TEST-ONLY: full reset (session + store + injected pool). */
  resetForTests(): void {
    this.session = null;
    this.testPool = null;
    useBridgeStore.getState().reset();
  }

  // ---- publishing -------------------------------------------------------

  private gateSnapshot(): BridgeStageGateSnapshot[] {
    const restoration = this.restoration();
    return bridgeWorkflowGates(restoration).map((g) => ({
      stage: g.stage,
      allowed: g.allowed,
      complete: g.complete,
      reason: g.reason,
    }));
  }

  private publish(partial: Parameters<ReturnType<typeof useBridgeStore.getState>['apply']>[0]): void {
    useBridgeStore.getState().apply(partial);
  }

  private refreshGates(): void {
    if (!this.session) return;
    const restoration = this.restoration();
    this.publish({
      gates: this.gateSnapshot(),
      nextStage: nextRunnableBridgeStage(restoration),
      designGeneration: useBridgeStore.getState().designGeneration + 1,
    });
  }

  private assertRunnable(stage: BridgeStage): void {
    const restoration = this.restoration();
    if (!canRunBridgeStage(stage, restoration)) {
      const gate = bridgeWorkflowGates(restoration).find((g) => g.stage === stage);
      throw new BridgeStageOrderError(stage, gate?.reason ?? 'blocked');
    }
  }

  private async hashMesh(positions: Float64Array, indices: Uint32Array): Promise<string> {
    const { contentHash } = await this.pool().run('hashMesh', { positions, indices });
    return contentHash;
  }

  // ---- session reconstruction from persistence (P7-T1, the 19b root fix) --

  /** The LAST journal op named `opName` for this restoration whose first
   * output hash equals the persisted stage hash — the op that sealed the stage
   * currently on the document (an older re-run of the same stage never
   * matches: the invalidation cascade replaced its hash). */
  private findDecisionOp(opName: string, restorationId: string, stageHash: string): Operation | null {
    const history = caseStore.getDocument().history;
    for (let i = history.length - 1; i >= 0; i--) {
      const op = history[i]!;
      if (op.name === opName && op.params.restorationId === restorationId && op.outputHashes[0] === stageHash) {
        return op;
      }
    }
    return null;
  }

  /**
   * SYNC part of the reload reconstruction: recovers the journaled scalar
   * design DECISIONS (pontic style + relief, framework mode, per-connector
   * semi-axis) from the persisted stages + journal into the fresh session.
   *
   * What is honestly recoverable here, and from where:
   * - `frameworkMode` — parsed from the persisted `bridgeFramework` stage
   *   marker itself (`framework:<mode>`, a deterministic non-mesh marker);
   * - `pontic` — the `bridge-pontic` op's params, CROSS-CHECKED against the
   *   captured per-style relief measurement in the session geometry (a drifted
   *   asset must not silently re-attach to old decisions);
   * - connector scalars — the `bridge-connectors` op's params (label +
   *   semi-axis + measured area + target), which let the connector MESHES be
   *   re-computed deterministically later.
   * Anything unrecoverable stays null; the QC/assembly actions then fail
   * VISIBLY via `BridgeSessionRestoreError` (never a guess, never a no-op).
   */
  private restorePersistedDecisions(restoration: Restoration, session: Session): void {
    const marker = restoration.stages.bridgeFramework;
    if (marker !== undefined) {
      session.frameworkMode =
        marker === 'framework:framework' ? 'framework' : marker === 'framework:fullContour' ? 'fullContour' : null;
    }

    const ponticHash = restoration.stages.bridgePontic;
    if (ponticHash !== undefined) {
      const op = this.findDecisionOp('bridge-pontic', restoration.id, ponticHash);
      const style = typeof op?.params.style === 'string' ? op.params.style : null;
      const captured = style !== null ? session.geometry.ponticReliefByStyle[style] : undefined;
      if (
        op &&
        style !== null &&
        isPonticStyleName(style) &&
        captured !== undefined &&
        op.params.configuredReliefMm === captured.configuredReliefMm &&
        op.params.maxAbsDeviationMm === captured.maxAbsDeviationMm
      ) {
        session.pontic = {
          style,
          configuredReliefMm: captured.configuredReliefMm,
          maxAbsDeviationMm: captured.maxAbsDeviationMm,
        };
      }
    }

    const connectorsHash = restoration.stages.bridgeConnectors;
    if (connectorsHash !== undefined) {
      const op = this.findDecisionOp('bridge-connectors', restoration.id, connectorsHash);
      session.persistedConnectors = op ? parsePersistedConnectors(op.params.connectors, session.geometry) : null;
    }
  }

  /**
   * Re-materializes the committed connector SOLIDS from the persisted design
   * decision: re-runs the SAME deterministic `bridgeConnectors` job the
   * original commit ran (asset profile for an unedited connector, the same
   * equal-angular regeneration for an edited semi-axis) and VERIFIES the
   * combined content hash reproduces the persisted `bridgeConnectors` stage
   * hash. A mismatch means the persisted decision no longer corresponds to
   * the current captured geometry — fail visibly, never adopt a guess.
   * Journals NOTHING (the decision was already journaled by its commit).
   */
  private async ensureConnectorsMaterialized(session: Session, stage: BridgeStage): Promise<void> {
    if (session.connectors) return;
    const restoration = this.restoration();
    const stageHash = restoration.stages.bridgeConnectors;
    if (stageHash === undefined) throw new BridgeStageOrderError(stage, 'connectorsIncomplete');
    const persisted = session.persistedConnectors;
    if (!persisted) {
      throw new BridgeSessionRestoreError(
        'the journaled bridge-connectors decision for the persisted connectors stage was not found (or does not match the captured geometry)',
      );
    }
    const semiAxisByLabel: Record<string, number> = {};
    for (const c of session.geometry.connectors) {
      const decision = persisted.find((p) => p.label === c.label)!;
      if (decision.semiAxisMm !== c.semiAxisMm) semiAxisByLabel[c.label] = decision.semiAxisMm;
    }
    const result = await this.pool().run('bridgeConnectors', this.connectorPayload(semiAxisByLabel), {
      onProgress: (f) => this.publish({ progress: f }),
    });
    const committed: CommittedConnector[] = session.geometry.connectors.map((c, i) => {
      const measured = result.connectors[i]!;
      const decision = persisted.find((p) => p.label === c.label)!;
      return {
        label: c.label,
        teeth: c.teeth,
        semiAxisMm: decision.semiAxisMm,
        minAreaMm2: measured.minAreaMm2,
        targetMm2: connectorTargetMm2(c.teeth),
        positions: measured.positions,
        indices: measured.indices,
      };
    });
    const combined = combineMeshes(committed.map((c) => ({ positions: c.positions, indices: c.indices })));
    const contentHash = await this.hashMesh(combined.positions, combined.indices);
    if (contentHash !== stageHash) {
      throw new BridgeSessionRestoreError(
        're-computed connector geometry does not reproduce the persisted connectors-stage hash (the saved design decision has drifted from the captured geometry)',
      );
    }
    session.connectors = committed;
  }

  /**
   * Re-materializes EVERYTHING `buildQcPayload` needs after a reload: the
   * pontic/framework decisions (recovered sync on start(); their absence when
   * the stage hash exists means persistence is unreconstructable → visible
   * failure), the connector solids, and the assembled solid — the latter two
   * re-computed by the SAME deterministic jobs and verified against the
   * persisted stage hashes. A session sealed in THIS session (no reload) has
   * all fields populated and this is a no-op.
   */
  private async ensureSessionMaterialized(session: Session): Promise<void> {
    const restoration = this.restoration();
    const stages = restoration.stages;
    // P7-T1 fix round (review finding 2): the captured abutment inner/outer
    // surfaces feed the marginFit + seating gates but are NOT covered by the
    // finalMesh verification (that hashes the fused unit `mesh` solids, not
    // the fit/anatomy surfaces). Re-hash EXACTLY what commitAbutmentSurfaces
    // sealed (abutment inner+outer, combined in order) and require it to
    // reproduce the persisted stage hash — once per reloaded session.
    // (The margin loops / fitRegions / dies have NO persisted hash of their
    // own — an inherent persistence limit, documented in the task report.)
    if (stages.bridgeAbutmentSurfaces !== undefined && !session.abutmentSurfacesVerified) {
      const abutments = session.geometry.units.filter((u) => u.kind === 'abutment');
      const combined = combineMeshes(abutments.flatMap((u) => [u.inner, u.outer]));
      const contentHash = await this.hashMesh(combined.positions, combined.indices);
      if (contentHash !== stages.bridgeAbutmentSurfaces) {
        throw new BridgeSessionRestoreError(
          'the captured abutment fit/anatomy surfaces do not reproduce the persisted abutment-surfaces hash (the geometry asset has drifted from the saved design)',
        );
      }
      session.abutmentSurfacesVerified = true;
    }
    if (stages.bridgePontic !== undefined && session.pontic === null) {
      throw new BridgeSessionRestoreError(
        'the journaled bridge-pontic decision for the persisted pontic stage was not found (or no longer matches the captured per-style relief)',
      );
    }
    if (stages.bridgeFramework !== undefined && session.frameworkMode === null) {
      throw new BridgeSessionRestoreError(
        `the persisted framework marker "${stages.bridgeFramework}" does not name a recognizable mode`,
      );
    }
    await this.ensureConnectorsMaterialized(session, 'qc');
    if (session.assembled === null) {
      const finalHash = stages.finalMesh;
      if (finalHash === undefined) throw new BridgeStageOrderError('qc', 'assemblyIncomplete');
      if (!session.connectors) throw new BridgeStageOrderError('qc', 'connectorsIncomplete');
      const solids = [
        ...session.geometry.units.map((u) => ({ positions: u.mesh.positions, indices: u.mesh.indices })),
        ...session.connectors.map((c) => ({ positions: c.positions, indices: c.indices })),
      ];
      const result = await this.pool().run('bridgeAssembly', { solids }, { onProgress: (f) => this.publish({ progress: f }) });
      const contentHash = await this.hashMesh(result.positions, result.indices);
      if (contentHash !== finalHash) {
        throw new BridgeSessionRestoreError(
          're-computed bridge assembly does not reproduce the persisted final-mesh hash (the saved design has drifted from the captured geometry)',
        );
      }
      session.assembled = { positions: result.positions, indices: result.indices, contentHash };
    }
  }

  /** Commits a completed milestone: writes its output hash into `Restoration.
   * stages[field]`, journals ONE coalesced Operation, and applies the INVALIDATION
   * CASCADE (bridgeWorkflow's `bridgeDownstreamInvalidations`) — clearing every
   * downstream stage hash + the `QcReport` this edit invalidated, so a stale
   * "PASSED" report can never survive a re-run of an earlier stage. */
  private commitStage(
    stage: BridgeStage,
    field: keyof Restoration['stages'],
    contentHash: string,
    opName: string,
    params: Record<string, unknown>,
    inputHashes: readonly string[],
  ): void {
    const restoration = this.restoration();
    const invalidation = bridgeDownstreamInvalidations(stage);
    const stages: Restoration['stages'] = { ...restoration.stages, [field]: contentHash };
    for (const invalidField of invalidation.stageFields) delete stages[invalidField];
    const next: Restoration = { ...restoration, stages, qc: invalidation.clearQc ? null : restoration.qc };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: opName,
      params: { restorationId: restoration.id, ...params },
      inputHashes,
      outputHashes: [contentHash],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    caseStore.updateRestoration(next, operation);
    this.invalidateDownstream(invalidation);
  }

  /** Drops the in-memory session geometry + store summaries a commit's cascade
   * just cleared, so nothing renders a stage/QC result that no longer
   * corresponds to the current design. */
  private invalidateDownstream(invalidation: ReturnType<typeof bridgeDownstreamInvalidations>): void {
    const session = this.session;
    const storePatch: Parameters<ReturnType<typeof useBridgeStore.getState>['apply']>[0] = {};
    for (const field of invalidation.stageFields) {
      if (field === 'bridgePontic') {
        if (session) session.pontic = null;
        storePatch.pontic = null;
      } else if (field === 'bridgeConnectors') {
        if (session) {
          session.connectors = null;
          // The persisted decision belongs to the invalidated stage hash — a
          // later re-materialization must never resurrect it.
          session.persistedConnectors = null;
        }
        storePatch.connectors = null;
      } else if (field === 'bridgeFramework') {
        if (session) session.frameworkMode = null;
        storePatch.framework = null;
      } else if (field === 'finalMesh') {
        if (session) session.assembled = null;
        storePatch.assembly = null;
      }
    }
    if (invalidation.clearQc) storePatch.qc = null;
    if (Object.keys(storePatch).length > 0) this.publish(storePatch);
  }

  // ---- stage: abutment surfaces (T2 — captured) -------------------------

  /**
   * Commits the per-abutment fit (inner) + outer anatomy surfaces built on the
   * SHARED insertion axis (the captured T2 artifact). Content-addresses the
   * concatenated abutment surfaces, journals ONE `bridge-abutment-surfaces` op
   * (shared axis + per-abutment margin fit), and publishes the per-abutment fit
   * readouts + shared-axis verdict.
   */
  async commitAbutmentSurfaces(): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('abutmentSurfaces');
    this.publish({ busyStage: 'abutmentSurfaces', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    try {
      const abutments = session.geometry.units.filter((u) => u.kind === 'abutment');
      const combined = combineMeshes(abutments.flatMap((u) => [u.inner, u.outer]));
      const contentHash = await this.hashMesh(combined.positions, combined.indices);
      this.commitStage(
        'abutmentSurfaces',
        'bridgeAbutmentSurfaces',
        contentHash,
        'bridge-abutment-surfaces',
        {
          sharedAxis: session.geometry.sharedAxis.direction,
          sharedAxisAcceptable: session.geometry.sharedAxis.acceptable,
          perAbutmentMarginFitMm: abutments.map((u) => ({ label: u.label, marginFitMm: u.marginFitMm })),
        },
        [],
      );
      // The persisted hash was just produced from THIS session's captured
      // surfaces — no reload re-verification needed until the next start().
      session.abutmentSurfacesVerified = true;
      this.publish({
        busyStage: null,
        progress: 1,
        abutmentSurfaces: { units: abutments.map((u) => ({ label: u.label, marginFitMm: u.marginFitMm })) },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('abutmentSurfaces', error);
      throw error;
    }
  }

  // ---- stage: pontic + gingival interface (T3 — captured) ---------------

  /**
   * Commits the pontic body + gingival-interface base for the chosen STYLE (the
   * captured T3 artifact). The style + configured relief is a journaled DESIGN
   * DECISION; the measured relief deviation (the ±20 µm acceptance evidence) is
   * read from the captured per-style measurement. One `bridge-pontic` op.
   */
  async commitPontic(style: PonticStyleName): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('pontic');
    const relief = session.geometry.ponticReliefByStyle[style];
    if (!relief) throw new BridgeStageOrderError('pontic', `no captured relief for style "${style}"`);
    this.publish({ busyStage: 'pontic', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    try {
      const ponticUnit = session.geometry.units.find((u) => u.kind === 'pontic');
      if (!ponticUnit) throw new BridgeStageOrderError('pontic', 'no pontic unit in captured geometry');
      const contentHash = await this.hashMesh(ponticUnit.mesh.positions, ponticUnit.mesh.indices);
      session.pontic = { style, configuredReliefMm: relief.configuredReliefMm, maxAbsDeviationMm: relief.maxAbsDeviationMm };
      this.commitStage(
        'pontic',
        'bridgePontic',
        contentHash,
        'bridge-pontic',
        { style, configuredReliefMm: relief.configuredReliefMm, maxAbsDeviationMm: relief.maxAbsDeviationMm },
        [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        pontic: {
          style,
          configuredReliefMm: relief.configuredReliefMm,
          maxAbsDeviationMm: relief.maxAbsDeviationMm,
          thresholdMm: PONTIC_RELIEF_TOLERANCE_MM,
          withinTolerance: relief.maxAbsDeviationMm <= PONTIC_RELIEF_TOLERANCE_MM,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('pontic', error);
      throw error;
    }
  }

  // ---- stage: connectors (T4 — the LIVE editor) -------------------------

  /** Build the `bridgeConnectors` payload for the given per-connector semi-axis
   * overrides (default = each connector's captured semi-axis / byte-exact profile). */
  private connectorPayload(semiAxisByLabel: Readonly<Record<string, number>>): JobPayloadMap['bridgeConnectors'] {
    const session = this.requireSession();
    return {
      connectors: session.geometry.connectors.map((c) => {
        const override = semiAxisByLabel[c.label];
        const profileFlat =
          override !== undefined ? ellipseProfileFlat(override, c.segments) : [...c.profileFlat];
        const flat = Float64Array.from(profileFlat);
        return {
          originMm: c.originMm,
          axisMm: c.axisMm,
          spanMm: c.spanMm,
          profileAFlat: flat.slice(),
          profileBFlat: flat.slice(),
        };
      }),
    };
  }

  private connectorReadouts(
    result: JobResultMap['bridgeConnectors'],
    semiAxisByLabel: Readonly<Record<string, number>>,
  ): BridgeConnectorReadout[] {
    const session = this.requireSession();
    return session.geometry.connectors.map((c, i) => {
      const measured = result.connectors[i]!;
      const semiAxisMm = semiAxisByLabel[c.label] ?? c.semiAxisMm;
      const targetMm2 = connectorTargetMm2(c.teeth);
      return {
        label: c.label,
        teeth: c.teeth,
        semiAxisMm,
        minAreaMm2: measured.minAreaMm2,
        targetMm2,
        passed: measured.minAreaMm2 >= targetMm2,
      };
    });
  }

  /**
   * LIVE connector-editor preview: re-lofts + re-measures every connector at the
   * given per-connector semi-axis (the T4 <10 ms measurement) and publishes the
   * per-connector min-area readout + gate status. Journals NOTHING (a preview) —
   * `commitConnectors` seals the design.
   */
  async previewConnectors(semiAxisByLabel: Readonly<Record<string, number>> = {}): Promise<void> {
    this.requireSession();
    this.assertRunnable('connectors');
    this.publish({ busyStage: 'connectors', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    try {
      const result = await this.pool().run('bridgeConnectors', this.connectorPayload(semiAxisByLabel), {
        onProgress: (f) => this.publish({ progress: f }),
      });
      this.publish({
        busyStage: null,
        progress: 1,
        liveConnectors: { connectors: this.connectorReadouts(result, semiAxisByLabel) },
      });
    } catch (error) {
      this.failStage('connectors', error);
      throw error;
    }
  }

  /**
   * Commits the connectors at the given per-connector semi-axis (default = the
   * captured profiles). Runs `bridgeConnectors`, content-addresses the combined
   * connector meshes, journals ONE `bridge-connectors` op (per-connector profile +
   * measured min area + resolved target — a journaled design decision), stores the
   * connector solids for assembly, and publishes the committed per-connector
   * readouts. Applies the invalidation cascade.
   */
  async commitConnectors(semiAxisByLabel: Readonly<Record<string, number>> = {}): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('connectors');
    this.publish({ busyStage: 'connectors', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    try {
      const result = await this.pool().run('bridgeConnectors', this.connectorPayload(semiAxisByLabel), {
        onProgress: (f) => this.publish({ progress: f }),
      });
      const readouts = this.connectorReadouts(result, semiAxisByLabel);
      const committed: CommittedConnector[] = session.geometry.connectors.map((c, i) => {
        const measured = result.connectors[i]!;
        return {
          label: c.label,
          teeth: c.teeth,
          semiAxisMm: semiAxisByLabel[c.label] ?? c.semiAxisMm,
          minAreaMm2: measured.minAreaMm2,
          targetMm2: connectorTargetMm2(c.teeth),
          positions: measured.positions,
          indices: measured.indices,
        };
      });
      session.connectors = committed;
      const combined = combineMeshes(committed.map((c) => ({ positions: c.positions, indices: c.indices })));
      const contentHash = await this.hashMesh(combined.positions, combined.indices);
      this.commitStage(
        'connectors',
        'bridgeConnectors',
        contentHash,
        'bridge-connectors',
        {
          connectors: committed.map((c) => ({ label: c.label, semiAxisMm: c.semiAxisMm, minAreaMm2: c.minAreaMm2, targetMm2: c.targetMm2 })),
        },
        [],
      );
      this.publish({ busyStage: null, progress: 1, connectors: { connectors: readouts }, liveConnectors: { connectors: readouts } });
      this.refreshGates();
    } catch (error) {
      this.failStage('connectors', error);
      throw error;
    }
  }

  // ---- stage: framework mode (T5 — journaled design decision) -----------

  /**
   * Selects framework vs full-contour MODE (a journaled design decision). In
   * framework mode the whole-bridge thickness gate switches to
   * `frameworkMinThicknessMm`, and the veneering space + the non-uniform taper
   * band near the margin are disclosed. The actual outer-anatomy CUTBACK geometry
   * (the `bridgeFramework` job) is exercised in the cad-pipeline/kernel-workers
   * lanes (T5); the client stage records the mode decision (see reviewer notes).
   * One `bridge-framework` op with a deterministic mode marker.
   */
  async selectFramework(mode: BridgeFrameworkMode): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('framework');
    this.publish({ busyStage: 'framework', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    try {
      const veneeringSpaceMm = mode === 'framework' ? STANDARD_ZIRCONIA_PROFILE.veneeringSpaceMm : null;
      const taperBandMm = mode === 'framework' ? STANDARD_ZIRCONIA_PROFILE.marginExclusionMm : null;
      session.frameworkMode = mode;
      // A deterministic marker (a pure function of the mode) — this stage produces
      // no mesh; the marker content-addresses the decision so stages + journal
      // replay are reproducible.
      const marker = `framework:${mode}`;
      this.commitStage('framework', 'bridgeFramework', marker, 'bridge-framework', { mode, veneeringSpaceMm }, []);
      this.publish({ busyStage: null, progress: 1, framework: { mode, veneeringSpaceMm, taperBandMm } });
      this.refreshGates();
    } catch (error) {
      this.failStage('framework', error);
      throw error;
    }
  }

  // ---- stage: assembly --------------------------------------------------

  /**
   * Fuses the bridge units + committed connectors into ONE watertight solid
   * (`bridgeAssembly` → the manifold union). HONEST FAILURE: a disjoint / non-
   * watertight fuse throws (typed) and does NOT write `stages.finalMesh` — the
   * bridge stays unassembled, QC stays blocked. One `bridge-assembly` op.
   */
  async runAssembly(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'assembly', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    // EVERY synchronous validation lives INSIDE the try (P7-T1 defense): a
    // pre-try throw would escape the `failStage` publish and leave the click a
    // silent no-op (the 19b shape — reachable here post-reload, when the gates
    // allow assembly but the session holds no connector solids).
    try {
      this.assertRunnable('assembly');
      await this.ensureConnectorsMaterialized(session, 'assembly');
      if (!session.connectors) throw new BridgeStageOrderError('assembly', 'connectorsIncomplete');
      const solids = [
        ...session.geometry.units.map((u) => ({ positions: u.mesh.positions, indices: u.mesh.indices })),
        ...session.connectors.map((c) => ({ positions: c.positions, indices: c.indices })),
      ];
      const result = await this.pool().run('bridgeAssembly', { solids }, { onProgress: (f) => this.publish({ progress: f }) });
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.assembled = { positions: result.positions, indices: result.indices, contentHash };
      this.commitStage(
        'assembly',
        'finalMesh',
        contentHash,
        'bridge-assembly',
        {
          watertight: result.watertight,
          componentCount: result.componentCount,
          inputCount: result.inputCount,
          volumeMm3: result.volumeMm3,
          triangleCount: result.triangleCount,
        },
        [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        assembly: {
          watertight: result.watertight,
          componentCount: result.componentCount,
          volumeMm3: result.volumeMm3,
          triangleCount: result.triangleCount,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('assembly', error);
      throw error;
    }
  }

  // ---- stage: QC --------------------------------------------------------

  private buildQcPayload(session: Session, acknowledgedGates?: readonly string[]): JobPayloadMap['runBridgeQc'] {
    if (!session.assembled || !session.connectors || !session.pontic) {
      throw new BridgeStageOrderError('qc', 'assemblyIncomplete');
    }
    const document = caseStore.getDocument();
    const profileVersion = document.settings.profileVersion || 'unversioned';
    return {
      assembledPositions: session.assembled.positions,
      assembledIndices: session.assembled.indices,
      units: session.geometry.units.map((u) => ({
        label: u.label,
        kind: u.kind,
        innerPositions: u.inner.positions,
        innerIndices: u.inner.indices,
        outerPositions: u.outer.positions,
        outerIndices: u.outer.indices,
        insertionAxis: u.insertionAxis,
        marginLoopFlat: flattenLoop(u.marginLoop),
        ...(u.fitRegion ? { fitRegion: u.fitRegion } : {}),
      })),
      dies: session.geometry.units
        .filter((u) => u.die)
        .map((u) => ({ positions: u.die!.positions, indices: u.die!.indices })),
      connectors: session.connectors.map((c) => ({ label: c.label, minAreaMm2: c.minAreaMm2, teeth: c.teeth, targetMm2: c.targetMm2 })),
      minWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.restorationParams.minWallThicknessMm,
      occlusalMinWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.occlusalMinWallThicknessMm,
      connectorAreaTargetMm2: STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.posteriorMm2,
      frameworkMode: session.frameworkMode === 'framework',
      frameworkMinThicknessMm: STANDARD_ZIRCONIA_PROFILE.frameworkMinThicknessMm,
      ponticRelief: {
        maxAbsDeviationMm: session.pontic.maxAbsDeviationMm,
        style: session.pontic.style,
        configuredReliefMm: session.pontic.configuredReliefMm,
      },
      kernelVersion: KERNEL_VERSION,
      profileVersion,
      journalHash: session.assembled.contentHash,
      ...(acknowledgedGates ? { acknowledgedGates } : {}),
    };
  }

  /**
   * Runs the whole-bridge QC gate suite on the assembled solid and stores the
   * `QcReport` on the restoration. One coalesced `bridge-qc` op. Requires the
   * assembled solid — an unassembled bridge can never reach QC.
   */
  async runQc(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', progress: 0, error: null, errorStage: null, errorKey: null, errorDetail: null });
    // EVERY synchronous validation lives INSIDE the try (the 19b fix): the
    // pre-try `buildQcPayload` throw was the silent no-op — order errors,
    // session-restore failures and payload validation all surface through the
    // SAME `failStage` path an async job failure uses.
    try {
      this.assertRunnable('qc');
      await this.ensureSessionMaterialized(session);
      const payload = this.buildQcPayload(session);
      const { report } = await this.pool().run('runBridgeQc', payload, { onProgress: (f) => this.publish({ progress: f }) });
      this.commitQc(report, 'bridge-qc', { passed: report.passed, gateCount: report.gates.length });
      this.publish({ busyStage: null, progress: 1, qc: report });
      this.refreshGates();
    } catch (error) {
      this.failStage('qc', error);
      throw error;
    }
  }

  /**
   * Acknowledges a FAILING gate (journaled, never a silent bypass — CLAUDE.md
   * invariant 4). Re-runs QC with the gate added to `acknowledgedGates` so the
   * report's `acknowledged` flag is set by the gate runner itself. One coalesced
   * `bridge-qc-ack` op.
   */
  async acknowledgeGate(gate: string): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', error: null, errorStage: null, errorKey: null, errorDetail: null });
    // Same defense as runQc (the 19b NB named this second call site): the
    // qc-presence check, the session re-materialization and the payload build
    // all surface through `failStage` — no pre-try synchronous escape.
    try {
      const restoration = this.restoration();
      if (restoration.qc === null) throw new BridgeStageOrderError('qc', 'assemblyIncomplete');
      const alreadyAck = restoration.qc.gates.filter((g) => g.acknowledged).map((g) => g.gate);
      const acknowledgedGates = Array.from(new Set([...alreadyAck, gate]));
      await this.ensureSessionMaterialized(session);
      const payload = this.buildQcPayload(session, acknowledgedGates);
      const { report } = await this.pool().run('runBridgeQc', payload);
      this.commitQc(report, 'bridge-qc-ack', { acknowledgedGate: gate, acknowledgedGates });
      this.publish({ busyStage: null, qc: report });
      this.refreshGates();
    } catch (error) {
      this.failStage('qc', error);
      throw error;
    }
  }

  private commitQc(report: QcReport, opName: string, params: Record<string, unknown>): void {
    const restoration = this.restoration();
    const next: Restoration = { ...restoration, qc: report };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: opName,
      params: { restorationId: restoration.id, ...params },
      inputHashes: this.session?.assembled ? [this.session.assembled.contentHash] : [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    caseStore.updateRestoration(next, operation);
  }

  // ---- export access (Phase 7 Task 3) -----------------------------------

  /**
   * The session's FINAL assembled bridge solid for the export flow — same
   * contract as crownDesign.ts's `finalMeshForExport` (null without a live
   * session/assembly; hash verified by the caller before serializing).
   * Post-reload note: `session.assembled` is re-materialized (and
   * hash-verified) by `ensureSessionMaterialized` when QC runs — and the
   * export gate requires a fresh QC anyway — so by the time an export is
   * allowed in a reloaded session, this is populated; until then the export
   * flow refuses with the actionable `finalMeshUnavailable` state, never a
   * silent no-op.
   */
  finalMeshForExport(
    restorationId: string,
  ): { positions: Float64Array; indices: Uint32Array; contentHash: string } | null {
    const session = this.session;
    if (!session || session.restorationId !== restorationId || !session.assembled) return null;
    return {
      positions: session.assembled.positions,
      indices: session.assembled.indices,
      contentHash: session.assembled.contentHash,
    };
  }

  /**
   * The RIDING QC context for the server export re-validation (Phase 7 Task 7)
   * — per-unit inner/outer surfaces + margin loops + fit regions, the dies,
   * the measured connectors, and the pontic-relief measurement this engine's
   * `runQc` fed the worker, so the server recompute over the re-imported
   * assembled solid + this context reproduces the client `QcReport`. `null`
   * under the same no-live-session conditions as `finalMeshForExport`. Every
   * threshold is profile-sourced (invariant 7); the export schema's forbidden
   * free knobs (per-unit `marginExclusionMm`, `ponticRelief.thresholdMm`) are
   * never present.
   */
  exportQcContext(restorationId: string): BridgeExportQcContext | null {
    const session = this.session;
    if (
      !session ||
      session.restorationId !== restorationId ||
      !session.assembled ||
      !session.connectors ||
      !session.pontic
    ) {
      return null;
    }
    return {
      units: session.geometry.units.map((u) => ({
        label: u.label,
        kind: u.kind,
        innerSurfaceMesh: meshJson(u.inner.positions, u.inner.indices),
        outerSurfaceMesh: meshJson(u.outer.positions, u.outer.indices),
        insertionAxis: [...u.insertionAxis],
        marginLoop: u.marginLoop.map((p) => [...p]),
        ...(u.fitRegion
          ? {
              fitRegion: {
                axisPointMm: [...u.fitRegion.axisPointMm],
                axis: [...u.fitRegion.axis],
                maxRadialMm: u.fitRegion.maxRadialMm,
                minAxialMm: u.fitRegion.minAxialMm,
                maxAxialMm: u.fitRegion.maxAxialMm,
              },
            }
          : {}),
      })),
      dieSolids: session.geometry.units
        .filter((u) => u.die)
        .map((u) => meshJson(u.die!.positions, u.die!.indices)),
      connectors: session.connectors.map((c) => ({
        label: c.label,
        minAreaMm2: c.minAreaMm2,
        ...(c.teeth ? { teeth: [...c.teeth] } : {}),
        ...(c.targetMm2 === undefined ? {} : { targetMm2: c.targetMm2 }),
      })),
      minWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.restorationParams.minWallThicknessMm,
      occlusalMinWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.occlusalMinWallThicknessMm,
      connectorAreaTargetMm2: STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.posteriorMm2,
      frameworkMode: session.frameworkMode === 'framework',
      frameworkMinThicknessMm: STANDARD_ZIRCONIA_PROFILE.frameworkMinThicknessMm,
      ponticRelief: {
        maxAbsDeviationMm: session.pontic.maxAbsDeviationMm,
        style: session.pontic.style,
        configuredReliefMm: session.pontic.configuredReliefMm,
      },
    };
  }

  // ---- failure surfacing ------------------------------------------------

  private failStage(stage: BridgeStage, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // A session-restore failure is a KNOWN, user-actionable condition — hand
    // the panel its i18n key (+ the untranslated technical detail) so the
    // actionable message renders localized; every other failure keeps the raw
    // error-string path.
    const restore = error instanceof BridgeSessionRestoreError ? error : null;
    this.publish({
      busyStage: null,
      error: message,
      errorStage: stage,
      errorKey: restore ? BRIDGE_SESSION_RESTORE_ERROR_KEY : null,
      errorDetail: restore ? restore.detail : null,
    });
  }

  clearError(): void {
    this.publish({ error: null, errorStage: null, errorKey: null, errorDetail: null });
  }
}

/** Flatten a closed loop of Vec3 into a Float64Array [x,y,z,...] (engine-layer
 * geometry helper; mirrors crownGeometry's `flattenLoop`). */
function flattenLoop(points: readonly Vec3[]): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i]![0];
    out[i * 3 + 1] = points[i]![1];
    out[i * 3 + 2] = points[i]![2];
  }
  return out;
}

/** The single shared bridge-design controller for the whole client. */
export const bridgeDesignEngine = new BridgeDesignEngine();

/** Re-exports so the panel can subscribe without importing the state modules
 * twice (mirrors crown/cavityDesign.ts's re-export style). */
export { useBridgeStore };
export { useCaseStore };
