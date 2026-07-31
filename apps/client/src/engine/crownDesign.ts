// apps/client/src/engine/crownDesign.ts
//
// Phase 4 Task 10 — the crown-design workflow CONTROLLER. Imperative, engine
// layer, the SOLE client-side orchestrator of the six pipeline stages
// (T3–T9's worker jobs) in the fixed order enforced by engine/crownWorkflow.ts.
// It:
//   1. dispatches the already-deterministic worker jobs (innerSurface,
//      placeAnatomy, morphAnatomy/resolveMorph, constructShell,
//      applySculptStroke, runQc) through the WorkerPool — adding NO new
//      nondeterminism of its own;
//   2. enforces stage order (consults `canRunStage` before every dispatch,
//      throwing `CrownStageOrderError` on a premature call);
//   3. content-addresses each stage's output mesh (the `hashMesh` job) and
//      writes the hash into `Restoration.stages` (`finalMesh` etc.);
//   4. JOURNALS every completed stage + sub-action as ONE COALESCED
//      `Operation` (transform commit / slider commit / brush stroke /
//      auto-thicken / gate-ack are each a single op — never per-mousemove or
//      per-frame spam), mirroring engine/marginEditor.ts's per-gesture commit
//      seam;
//   5. publishes an ephemeral UI snapshot to state/crownStore.ts after every
//      change (the committed hashes/QcReport flow to the UI through the case
//      document / state/caseStore.ts);
//   6. surfaces a stage FAILURE HONESTLY (the shell throwing
//      `NonManifoldInputError` on a distorted real morph — the Task 9 finding
//      on the real arch-case-01 tooth-11) as an error state; it NEVER writes a
//      `finalMesh`/`qc` for a stage that failed, so a broken crown can never
//      masquerade as a completed one.
//
// Layer rule: engine may import kernel-workers / state / shared-types /
// clinical-profiles only (never kernel, cad-pipeline, tooth-library, Three.js).
// The kernel enums the payloads use (`MorphContactKind`, `SculptBrushType`,
// `CanonicalFrameAxes`, `ContactResidualInput`) are matched STRUCTURALLY here
// — the worker payload types are interfaces, so a plain object with the right
// fields satisfies `WorkerPool.run`'s inferred payload type without importing
// the nominal type name (the same layer-boundary convention axisStore/
// marginStore document for their duplicated summary shapes).
import {
  KERNEL_VERSION,
  type JobName,
  type JobPayloadMap,
  type JobResultMap,
  type RunJobOptions,
} from '@dqcad/kernel-workers';
import { DEFAULT_OFFSET_VOXEL_PITCH_MM, STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import type { FdiTooth, Operation, QcReport, Restoration, RestorationParams, Vec3 } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { resolveProfileVersion } from './materialProfile';
import {
  type CrownStage,
  canRunStage,
  downstreamInvalidations,
  firstMarginLoop,
  nextRunnableStage,
  workflowGates,
} from './crownWorkflow';
import { boxMesh, builtinLibraryTooth, flattenLoop, type BuiltinLibraryTooth, type IndexedBuffers } from './crownGeometry';
import { loopJson, meshJson, type CrownExportQcContext } from './exportContext';
import type { RenderNode } from './renderNode';
import { getPool } from './workers';
import { colorForValue, computeAutoRange, distancesToVertexColors } from './colormap';
import { useCrownStore, type CrownStageGateSnapshot, type MorphStrengthsUi } from '../state/crownStore';
import { useCaseStore } from '../state/caseStore';

/** Minimal structural view of a pool that can dispatch a job — `WorkerPool`
 * satisfies it; node-lane tests inject a fake implementing exactly this. */
export interface RunnablePool {
  run<J extends JobName>(jobName: J, payload: JobPayloadMap[J], opts?: RunJobOptions): Promise<JobResultMap[J]>;
}

/** Blend width (mm) between the marginal-gap zone and the cement-gap zone of
 * the inner surface — an ALGORITHMIC smoothing parameter (not a clinical
 * default; the clinical gaps themselves come from the material profile /
 * `RestorationParams`). Matches the Task 4/7 fixture value. Journaled. */
const INNER_SURFACE_BLEND_WIDTH_MM = 0.3;

/** Thrown when a stage method is called before its prerequisite stage has
 * produced its output — the order-enforcement guard. `reason` is the pure
 * state machine's `CrownPrerequisiteCode`. */
export class CrownStageOrderError extends Error {
  constructor(
    readonly stage: CrownStage,
    readonly reason: string,
  ) {
    super(`crownDesign: stage "${stage}" cannot run yet (${reason})`);
    this.name = 'CrownStageOrderError';
  }
}

/** Thrown when a session action is attempted with no active restoration. */
export class CrownNoSessionError extends Error {
  constructor() {
    super('crownDesign: no active crown-design session (call start() first)');
    this.name = 'CrownNoSessionError';
  }
}

interface DerivedMesh {
  positions: Float64Array;
  indices: Uint32Array;
  contentHash: string;
}

/** Structural mirror of `@dqcad/kernel`'s `MorphContactKind`. */
type MorphContactKind = 'proximalMesial' | 'proximalDistal' | 'antagonist';

/** Structural mirror of `@dqcad/kernel`'s `SculptBrushType`. */
export type SculptBrushType = 'add' | 'remove' | 'smooth';

/** Structural mirror of `@dqcad/cad-pipeline`'s `ContactResidualInput` — the
 * runQc contact input; built from a morph result's per-contact readouts. */
interface ContactResidualInput {
  kind: MorphContactKind;
  targetPenetrationMm: number;
  achievedSignedDistanceMm: number;
  contactResidualMm: number;
  regionResidualMm: number;
  clampBound: boolean;
}

/** Anatomy-placement geometry the anatomy stage consumes — a built-in library
 * tooth (engine/crownGeometry.ts) plus OPTIONAL real neighbour/antagonist
 * scan geometry (a contact is created only for geometry that actually
 * exists — never fabricated). */
export interface AnatomyPlacementInput {
  library: BuiltinLibraryTooth;
  mesialNeighbor?: IndexedBuffers;
  distalNeighbor?: IndexedBuffers;
  antagonist?: IndexedBuffers;
  /** Manual gizmo override (position/scale/landmark) — present on a manual
   * transform commit, absent on the initial auto-place. */
  manualOverride?: {
    translationMm?: Vec3;
    scale?: { md?: number; bl?: number; og?: number };
  };
}

interface Session {
  restorationId: string;
  tooth: FdiTooth;
  targetNodeId: string;
  dieHash: string;
  diePositions: Float64Array;
  dieIndices: Uint32Array;
  marginPoints: readonly Vec3[];
  marginLoopFlat: Float64Array;
  insertionAxis: Vec3;
  params: RestorationParams;
  bvhBuilt: boolean;
  anatomyInput: AnatomyPlacementInput | null;
  inner: DerivedMesh | null;
  placed: DerivedMesh | null;
  morphOuter: DerivedMesh | null;
  morphPlanId: string | null;
  morphContacts: readonly ContactResidualInput[];
  morphHeatmap: Float64Array | null;
  shell: DerivedMesh | null;
  shellThicknessHeatmap: Float64Array | null;
  /** The shell stage's journaled morph→shell heal @errorBound (mm), captured
   * from the `constructShell` worker result when the outer was healed; `null`
   * when no heal ran. Threaded into the contact QC input (`healErrorBoundMm`)
   * so the contact gate SUMS it onto every contact residual — the same
   * journaled param the server export re-validation receives, keeping the
   * client-attested contact verdict in agreement. */
  shellHealErrorBoundMm: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

class CrownDesignEngine {
  private session: Session | null = null;
  private testPool: RunnablePool | null = null;

  private pool(): RunnablePool {
    return this.testPool ?? getPool();
  }

  /** TEST-ONLY: inject a fake pool so the controller's order/coalescing/
   * stage-hash logic can be unit-tested on the node lane without real
   * workers (mirrors workers.ts's `resetBvhCacheForTests` test-hook style). */
  __setPoolForTests(pool: RunnablePool | null): void {
    this.testPool = pool;
  }

  private requireSession(): Session {
    if (!this.session) throw new CrownNoSessionError();
    return this.session;
  }

  private restoration(): Restoration {
    const session = this.requireSession();
    const found = caseStore.getDocument().restorations.find((r) => r.id === session.restorationId);
    if (!found) {
      throw new Error(`crownDesign: restoration ${session.restorationId} no longer exists`);
    }
    return found;
  }

  /**
   * Begins a crown-design session for `restorationId`. Captures the target
   * die scan (from the mesh store), the confirmed margin loop, insertion
   * axis and params, then publishes the initial gate snapshot. Throws if the
   * restoration is missing, has no target scan, or has no usable margin loop
   * (the two external prerequisites the state machine reports).
   */
  start(restorationId: string): void {
    const restoration = caseStore.getDocument().restorations.find((r) => r.id === restorationId);
    if (!restoration) {
      throw new Error(`crownDesign.start: no restoration ${restorationId}`);
    }
    if (restoration.targetNodeId === null) {
      throw new CrownStageOrderError('innerSurface', 'noTargetScan');
    }
    const loop = firstMarginLoop(restoration);
    if (!loop) {
      throw new CrownStageOrderError('innerSurface', 'noMarginLine');
    }
    const node = caseStore.getDocument().scene.find((n) => n.id === restoration.targetNodeId);
    const record = node ? caseStore.getMeshRecord(node.meshId) : undefined;
    if (!node || !record) {
      throw new CrownStageOrderError('innerSurface', 'noTargetScan');
    }
    this.session = {
      restorationId,
      tooth: loop.tooth,
      targetNodeId: restoration.targetNodeId,
      dieHash: record.contentHash,
      diePositions: record.positions,
      dieIndices: record.indices,
      marginPoints: loop.points,
      marginLoopFlat: flattenLoop(loop.points),
      insertionAxis: restoration.insertionAxis,
      params: restoration.params,
      bvhBuilt: false,
      anatomyInput: null,
      inner: null,
      placed: null,
      morphOuter: null,
      morphPlanId: null,
      morphContacts: [],
      morphHeatmap: null,
      shell: null,
      shellThicknessHeatmap: null,
      shellHealErrorBoundMm: null,
    };
    caseStore.setSelectedRestorationId(restorationId);
    this.publish({ restorationId, active: true, error: null, errorStage: null });
    // Publish the initial gate snapshot so the UI enables/blocks each stage
    // from the first render (without this every stage button stays disabled).
    this.refreshGates();
  }

  clear(): void {
    this.session = null;
    useCrownStore.getState().reset();
  }

  /** TEST-ONLY: full reset (session + store + injected pool). */
  resetForTests(): void {
    this.session = null;
    this.testPool = null;
    useCrownStore.getState().reset();
  }

  // ---- publishing -------------------------------------------------------

  private gateSnapshot(): CrownStageGateSnapshot[] {
    const restoration = this.restoration();
    return workflowGates(restoration).map((g) => ({
      stage: g.stage,
      allowed: g.allowed,
      complete: g.complete,
      reason: g.reason,
    }));
  }

  private publish(partial: Parameters<ReturnType<typeof useCrownStore.getState>['apply']>[0]): void {
    useCrownStore.getState().apply(partial);
  }

  /** Recomputes and publishes the gate snapshot + next-stage suggestion +
   * design-mesh generation bump. Called after every committed stage. */
  private refreshGates(): void {
    if (!this.session) return;
    const restoration = this.restoration();
    this.publish({
      gates: this.gateSnapshot(),
      nextStage: nextRunnableStage(restoration),
      designGeneration: useCrownStore.getState().designGeneration + 1,
    });
  }

  private assertRunnable(stage: CrownStage): void {
    const restoration = this.restoration();
    if (!canRunStage(stage, restoration)) {
      const gate = workflowGates(restoration).find((g) => g.stage === stage);
      throw new CrownStageOrderError(stage, gate?.reason ?? 'blocked');
    }
  }

  private async hashMesh(positions: Float64Array, indices: Uint32Array): Promise<string> {
    const { contentHash } = await this.pool().run('hashMesh', { positions, indices });
    return contentHash;
  }

  /** Commits a completed stage: writes its output hash into `Restoration.
   * stages[field]`, journals ONE coalesced Operation, and applies the
   * INVALIDATION CASCADE (engine/crownWorkflow.ts's `downstreamInvalidations`)
   * — clearing every downstream stage hash + the `QcReport` that this edit
   * invalidated, so a stale "PASSED" report (or an orphaned finalMesh hash)
   * can never survive a re-run of an earlier stage. Also drops the now-invalid
   * in-memory session geometry + store summaries. */
  private commitStage(
    stage: CrownStage,
    field: keyof Restoration['stages'],
    contentHash: string,
    opName: string,
    params: Record<string, unknown>,
    inputHashes: readonly string[],
  ): void {
    const restoration = this.restoration();
    const invalidation = downstreamInvalidations(stage);
    const stages: Restoration['stages'] = { ...restoration.stages, [field]: contentHash };
    for (const invalidField of invalidation.stageFields) {
      delete stages[invalidField];
    }
    const next: Restoration = {
      ...restoration,
      stages,
      qc: invalidation.clearQc ? null : restoration.qc,
    };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: opName,
      params: { restorationId: restoration.id, tooth: this.requireSession().tooth, ...params },
      inputHashes,
      outputHashes: [contentHash],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    caseStore.updateRestoration(next, operation);
    this.invalidateDownstream(invalidation);
  }

  /** Drops the in-memory session geometry + store summaries that a commit's
   * `downstreamInvalidations` just cleared from the document — so
   * `getDesignRenderNodes`, the gate snapshot, and the panel never render a
   * shell/morph/QC result that no longer corresponds to the current design. */
  private invalidateDownstream(invalidation: ReturnType<typeof downstreamInvalidations>): void {
    const session = this.session;
    const storePatch: Parameters<ReturnType<typeof useCrownStore.getState>['apply']>[0] = {};
    for (const field of invalidation.stageFields) {
      if (field === 'anatomyPlacement') {
        if (session) session.placed = null;
        storePatch.anatomy = null;
      } else if (field === 'morphState') {
        if (session) {
          session.morphOuter = null;
          session.morphPlanId = null;
          session.morphContacts = [];
          session.morphHeatmap = null;
        }
        storePatch.morph = null;
      } else if (field === 'finalMesh') {
        if (session) {
          session.shell = null;
          session.shellThicknessHeatmap = null;
        }
        storePatch.shell = null;
        storePatch.sculpt = null;
      }
    }
    if (invalidation.clearQc) {
      storePatch.qc = null;
    }
    if (Object.keys(storePatch).length > 0) {
      this.publish(storePatch);
    }
  }

  // ---- stage 1: inner surface ------------------------------------------

  /**
   * Runs the inner-surface (intaglio) stage: builds a BVH for the die (once),
   * then the cement-gap offset surface. Default pitch = the clinical 20 µm
   * (`DEFAULT_OFFSET_VOXEL_PITCH_MM`); a coarser pitch may be passed (it is a
   * journaled parameter — CLAUDE.md). One coalesced `crown-inner-surface` op.
   */
  async runInnerSurface(opts: { pitchMm?: number } = {}): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('innerSurface');
    const pitchMm = opts.pitchMm ?? DEFAULT_OFFSET_VOXEL_PITCH_MM;
    this.publish({ busyStage: 'innerSurface', progress: 0, error: null, errorStage: null });
    try {
      if (!session.bvhBuilt) {
        const positionsCopy = session.diePositions.slice();
        const indicesCopy = session.dieIndices.slice();
        await this.pool().run(
          'buildBvh',
          { contentHash: session.dieHash, positions: positionsCopy, indices: indicesCopy },
          { transfer: [positionsCopy.buffer, indicesCopy.buffer], affinityKey: session.dieHash },
        );
        session.bvhBuilt = true;
      }
      const result = await this.pool().run(
        'innerSurface',
        {
          contentHash: session.dieHash,
          pitchMm,
          marginalGapMm: session.params.marginalGapMm,
          cementGapMm: session.params.cementGapMm,
          spacerStartMm: session.params.spacerStartMm,
          blendWidthMm: INNER_SURFACE_BLEND_WIDTH_MM,
          marginLoop: session.marginLoopFlat,
          insertionAxis: session.insertionAxis,
        },
        { affinityKey: session.dieHash, onProgress: (f) => this.publish({ progress: f }) },
      );
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.inner = { positions: result.positions, indices: result.indices, contentHash };
      this.commitStage(
        'innerSurface',
        'innerSurface',
        contentHash,
        'crown-inner-surface',
        {
          pitchMm,
          marginalGapMm: session.params.marginalGapMm,
          cementGapMm: session.params.cementGapMm,
          spacerStartMm: session.params.spacerStartMm,
          blendWidthMm: INNER_SURFACE_BLEND_WIDTH_MM,
          errorBoundMm: result.errorBoundMm,
        },
        [session.dieHash],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        inner: {
          errorBoundMm: result.errorBoundMm,
          patchTriangleCount: result.patchTriangleCount,
          marginVertexCount: result.marginVertexCount,
          pitchMm,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('innerSurface', error);
      throw error;
    }
  }

  // ---- stage 2: anatomy placement --------------------------------------

  /**
   * Assembles the anatomy-placement input from the session's margin geometry
   * (a built-in parametric library tooth sized to the margin — see
   * crownGeometry.ts's HONEST SCOPE NOTE) plus the antagonist scan present in
   * the scene (role `antagonist`), if any. All geometry math lives in the
   * engine (crownGeometry.ts); the UI only calls `placeAnatomyAuto` /
   * `commitAnatomyTransform`.
   */
  private buildAnatomyInput(manualOverride?: AnatomyPlacementInput['manualOverride']): AnatomyPlacementInput {
    const session = this.requireSession();
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of session.marginPoints) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const n = session.marginPoints.length;
    cx /= n;
    cy /= n;
    cz /= n;
    let marginR = 0;
    for (const p of session.marginPoints) {
      marginR += Math.hypot(p[0] - cx, p[1] - cy);
    }
    marginR /= n;
    let dieMaxZ = cz;
    for (let i = 2; i < session.diePositions.length; i += 3) {
      if (session.diePositions[i]! > dieMaxZ) dieMaxZ = session.diePositions[i]!;
    }
    const heightMm = Math.max((dieMaxZ - cz) * 1.3 + 0.5, marginR * 2);
    const library = builtinLibraryTooth(marginR, cz, heightMm, session.params.minWallThicknessMm * 2);
    // HONEST SCOPE NOTE: the client cannot yet identify the real mesial/distal
    // neighbour teeth from an arch scan (Phase 5+ segmentation), and the
    // placement solve requires non-empty neighbour references. Until then,
    // auto-place uses synthetic proximal reference boxes flanking the margin
    // in ±MD at a small gap — a documented placeholder, called out as a
    // reviewer-attention item, not hidden.
    const gap = 0.1;
    const width = marginR;
    const yMin = -marginR;
    const yMax = marginR;
    const mesialNeighbor = boxMesh([cx - marginR - gap - width, yMin, cz], [cx - marginR - gap, yMax, dieMaxZ]);
    const distalNeighbor = boxMesh([cx + marginR + gap, yMin, cz], [cx + marginR + gap + width, yMax, dieMaxZ]);
    const antNode = caseStore.getDocument().scene.find((node) => node.role === 'antagonist');
    const antRecord = antNode ? caseStore.getMeshRecord(antNode.meshId) : undefined;
    const antagonist = antRecord ? { positions: antRecord.positions, indices: antRecord.indices } : undefined;
    return { library, mesialNeighbor, distalNeighbor, antagonist, manualOverride };
  }

  /** Auto-places the built-in library tooth (no manual override). */
  async placeAnatomyAuto(): Promise<void> {
    await this.placeAnatomy(this.buildAnatomyInput());
  }

  /** Commits a manual gizmo transform (one coalesced op — the whole drag is
   * one gesture). */
  async commitAnatomyTransform(override: NonNullable<AnatomyPlacementInput['manualOverride']>): Promise<void> {
    await this.placeAnatomy(this.buildAnatomyInput(override));
  }

  /**
   * Places the anatomy library tooth (auto, or with a manual gizmo override).
   * Re-callable: a manual transform commit re-runs the placement with the new
   * override and journals ONE coalesced `crown-anatomy` op (the whole gizmo
   * drag is one gesture — never per-frame).
   */
  async placeAnatomy(input: AnatomyPlacementInput): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('anatomy');
    session.anatomyInput = input;
    const manual = input.manualOverride !== undefined;
    this.publish({ busyStage: 'anatomy', progress: 0, error: null, errorStage: null });
    try {
      const result = await this.pool().run('placeAnatomy', {
        canonicalFrame: input.library.canonicalFrame,
        libraryPositions: input.library.positions,
        libraryIndices: input.library.indices,
        marginLoop: session.marginLoopFlat,
        insertionAxis: session.insertionAxis,
        mesialNeighborPositions: input.mesialNeighbor?.positions ?? new Float64Array(0),
        distalNeighborPositions: input.distalNeighbor?.positions ?? new Float64Array(0),
        antagonistPositions: input.antagonist?.positions ?? null,
        landmarks: input.library.landmarks,
        manualOverride: input.manualOverride,
      });
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.placed = { positions: result.positions, indices: result.indices, contentHash };
      // Placing anew invalidates any downstream morph/shell preview.
      session.morphOuter = null;
      session.morphPlanId = null;
      session.shell = null;
      this.commitStage(
        'anatomy',
        'anatomyPlacement',
        contentHash,
        'crown-anatomy',
        {
          manual,
          scaleMesialDistal: result.scaleMesialDistal,
          scaleBuccoLingual: result.scaleBuccoLingual,
          scaleOcclusoGingival: result.scaleOcclusoGingival,
          usedProximalGap: result.usedProximalGap,
          antagonistUsed: result.antagonistUsed,
          override: input.manualOverride ?? null,
        },
        session.inner ? [session.inner.contentHash] : [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        anatomy: {
          scaleMesialDistal: result.scaleMesialDistal,
          scaleBuccoLingual: result.scaleBuccoLingual,
          scaleOcclusoGingival: result.scaleOcclusoGingival,
          usedProximalGap: result.usedProximalGap,
          antagonistUsed: result.antagonistUsed,
          manual,
        },
        morph: null,
        shell: null,
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('anatomy', error);
      throw error;
    }
  }

  // ---- stage 3: morph ---------------------------------------------------

  private buildMorphContacts(session: Session, input: AnatomyPlacementInput): Array<{
    kind: MorphContactKind;
    positions: Float64Array;
    indices: Uint32Array;
    targetPenetrationMm: number;
  }> {
    const contacts: Array<{ kind: MorphContactKind; positions: Float64Array; indices: Uint32Array; targetPenetrationMm: number }> = [];
    if (input.mesialNeighbor) {
      contacts.push({
        kind: 'proximalMesial',
        positions: input.mesialNeighbor.positions,
        indices: input.mesialNeighbor.indices,
        targetPenetrationMm: session.params.proximalContactPenetrationMm,
      });
    }
    if (input.distalNeighbor) {
      contacts.push({
        kind: 'proximalDistal',
        positions: input.distalNeighbor.positions,
        indices: input.distalNeighbor.indices,
        targetPenetrationMm: session.params.proximalContactPenetrationMm,
      });
    }
    if (input.antagonist) {
      contacts.push({
        kind: 'antagonist',
        positions: input.antagonist.positions,
        indices: input.antagonist.indices,
        targetPenetrationMm: session.params.occlusalContactMm,
      });
    }
    return contacts;
  }

  /**
   * Runs the initial adaptation/morph on the placed tooth. Contacts are built
   * ONLY from real neighbour/antagonist scan geometry present in the anatomy
   * input (never fabricated); with none, the morph just seals the tooth to
   * the margin. Caches the RBF plan under a deterministic `planId` so
   * `resolveMorph` can re-solve at new strengths in < 500 ms (T6). One
   * coalesced `crown-morph` op.
   */
  async runMorph(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'morph', progress: 0, error: null, errorStage: null });
    // P7-T1 fix round (19b class): sync validation inside the try — post-reload
    // the gate passes from the persisted anatomyPlacement hash while the
    // session fields are null; a pre-try throw would be a silent no-op.
    try {
      this.assertRunnable('morph');
      if (!session.placed || !session.anatomyInput) {
        throw new CrownStageOrderError('morph', 'anatomyIncomplete');
      }
      const planId = `${session.restorationId}:${session.placed.contentHash}`;
      const contacts = this.buildMorphContacts(session, session.anatomyInput);
      const strengths = useCrownStore.getState().strengths;
      const result = await this.pool().run(
        'morphAnatomy',
        {
          planId,
          placedPositions: session.placed.positions,
          placedIndices: session.placed.indices,
          marginLoop: session.marginLoopFlat,
          contacts,
          strengths,
          computeHeatmaps: true,
        },
        { affinityKey: planId },
      );
      session.morphPlanId = planId;
      // The initial morph COMPLETES the morph stage (writes stages.morphState
      // -> unblocks shell). Later slider commits re-write it (coalesced).
      await this.applyMorphResult(session, result, strengths, true);
      this.refreshGates();
    } catch (error) {
      this.failStage('morph', error);
      throw error;
    }
  }

  private async applyMorphResult(
    session: Session,
    result: JobResultMap['morphAnatomy'],
    strengths: MorphStrengthsUi,
    journal: boolean,
  ): Promise<void> {
    const contentHash = await this.hashMesh(result.positions, result.indices);
    session.morphOuter = { positions: result.positions, indices: result.indices, contentHash };
    session.shell = null;
    session.morphContacts = result.contacts.map((c) => ({
      kind: c.kind as MorphContactKind,
      targetPenetrationMm: c.targetPenetrationMm,
      achievedSignedDistanceMm: c.achievedSignedDistanceMm,
      contactResidualMm: c.contactResidualMm,
      regionResidualMm: c.regionResidualMm,
      clampBound: c.clampBound,
    }));
    session.morphHeatmap = result.heatmaps && result.heatmaps.length > 0 ? result.heatmaps[0]!.distances : null;
    if (journal) {
      this.commitStage(
        'morph',
        'morphState',
        contentHash,
        'crown-morph',
        {
          strengths,
          maxContactResidualMm: result.maxContactResidualMm,
          marginSealMaxDeviationMm: result.marginSealMaxDeviationMm,
          clampedContacts: result.clampedContacts,
        },
        session.placed ? [session.placed.contentHash] : [],
      );
    }
    this.publish({
      busyStage: null,
      morphBusy: false,
      progress: 1,
      shell: null,
      morph: {
        maxContactResidualMm: result.maxContactResidualMm,
        marginSealMaxDeviationMm: result.marginSealMaxDeviationMm,
        contacts: result.contacts.map((c) => ({
          kind: c.kind as MorphContactKind,
          strength: c.strength,
          targetPenetrationMm: c.targetPenetrationMm,
          achievedSignedDistanceMm: c.achievedSignedDistanceMm,
          contactResidualMm: c.contactResidualMm,
          clampBound: c.clampBound,
        })),
        clampedContacts: result.clampedContacts.map((k) => k as MorphContactKind),
      },
    });
  }

  /** Sets a contact-strength slider value (UI state only — no journal, no
   * re-solve). The commit (`commitMorphStrengths`) does the re-solve+journal. */
  setStrength(kind: keyof MorphStrengthsUi, value: number): void {
    const strengths = { ...useCrownStore.getState().strengths, [kind]: value };
    this.publish({ strengths });
  }

  /**
   * LIVE contact-strength re-solve (slider drag): re-runs the cached RBF plan
   * at the current strengths via `resolveMorph`. Does NOT journal (it is the
   * interactive preview — journaling happens on the explicit commit). The
   * morph plan must already be cached (`runMorph` ran first).
   */
  async previewMorphStrengths(strengths: MorphStrengthsUi): Promise<void> {
    const session = this.requireSession();
    this.publish({ strengths, morphBusy: true });
    // Fire-and-forget on every slider move (CrownDesignPanel), so a worker
    // rejection here is swallowed by the UI's `run()` wrapper. Without this
    // try/catch a reject would leave `morphBusy` stuck true forever (the
    // "updating…" indicator sticks on) and hide the error. `failStage` clears
    // `morphBusy` AND surfaces the error, matching `commitMorphStrengths`.
    try {
      if (!session.morphPlanId) {
        throw new CrownStageOrderError('morph', 'anatomyIncomplete');
      }
      const result = await this.pool().run(
        'resolveMorph',
        { planId: session.morphPlanId, strengths, computeHeatmaps: true },
        { affinityKey: session.morphPlanId },
      );
      await this.applyMorphResult(session, result, strengths, false);
    } catch (error) {
      this.failStage('morph', error);
      throw error;
    }
  }

  /**
   * COMMITS the current contact strengths: re-solves at the given strengths
   * and journals ONE coalesced `crown-morph` op (the whole slider gesture ->
   * one op, mirroring the margin-editor drag commit). This is what writes
   * `stages.morphState`.
   */
  async commitMorphStrengths(strengths: MorphStrengthsUi): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('morph');
    if (!session.morphPlanId) {
      throw new CrownStageOrderError('morph', 'anatomyIncomplete');
    }
    this.publish({ strengths, busyStage: 'morph', error: null, errorStage: null });
    try {
      const result = await this.pool().run(
        'resolveMorph',
        { planId: session.morphPlanId, strengths, computeHeatmaps: true },
        { affinityKey: session.morphPlanId },
      );
      await this.applyMorphResult(session, result, strengths, true);
      this.refreshGates();
    } catch (error) {
      this.failStage('morph', error);
      throw error;
    }
  }

  // ---- stage 4: shell ---------------------------------------------------

  /**
   * Constructs the watertight crown shell from the morphed outer + the inner
   * surface. HONEST FAILURE: if the manifold stitch rejects the input (the
   * `NonManifoldInputError`/`ShellNotWatertightError` the real distorted
   * tooth-11 morph triggers — T9), this sets an error state and does NOT
   * write `stages.finalMesh` — the crown stays unbuilt, QC stays blocked, and
   * the failure is visible in the UI. One coalesced `crown-shell` op on
   * success (auto-thicken is a param on that same op).
   */
  async constructShell(opts: { autoThicken?: boolean } = {}): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'shell', progress: 0, error: null, errorStage: null });
    // P7-T1 fix round (19b class): sync validation inside the try — post-reload
    // the gate passes from the persisted morphState hash while the session
    // fields are null; a pre-try throw would be a silent no-op.
    try {
      this.assertRunnable('shell');
      if (!session.morphOuter || !session.inner) {
        throw new CrownStageOrderError('shell', 'morphIncomplete');
      }
      const autoThicken = opts.autoThicken ?? false;
      const result = await this.pool().run('constructShell', {
        outerPositions: session.morphOuter.positions,
        outerIndices: session.morphOuter.indices,
        innerPositions: session.inner.positions,
        innerIndices: session.inner.indices,
        insertionAxis: session.insertionAxis,
        marginLoop: session.marginLoopFlat,
        autoThicken,
        autoThickenMinThicknessMm: autoThicken ? session.params.minWallThicknessMm : undefined,
        autoThickenMaxDisplacementMm: autoThicken ? session.params.minWallThicknessMm : undefined,
      });
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.shell = { positions: result.positions, indices: result.indices, contentHash };
      session.shellThicknessHeatmap = result.thicknessHeatmap;
      // The morph→shell heal @errorBound (mm) when the outer was healed —
      // captured here, journaled on the shell op, and SUMMED onto every contact
      // residual by the contact gate (runQc + the export re-validation both
      // receive it, so the client-attested contact verdict stays in agreement).
      // `undefined` on the no-heal path ⇒ 0 ⇒ byte-identical contact residuals.
      session.shellHealErrorBoundMm = result.healOuterErrorBoundMm ?? null;
      this.commitStage(
        'shell',
        'finalMesh',
        contentHash,
        'crown-shell',
        {
          autoThicken,
          watertight: result.watertight,
          minWallThicknessMm: result.minWallThicknessMm,
          volumeMm3: result.volumeMm3,
          autoThickenApplied: result.autoThickenApplied,
          autoThickenMaxAppliedMm: result.autoThickenMaxAppliedMm,
          ...(result.healOuterErrorBoundMm !== undefined
            ? { healOuterErrorBoundMm: result.healOuterErrorBoundMm }
            : {}),
        },
        [session.morphOuter.contentHash, session.inner.contentHash],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        shell: {
          watertight: result.watertight,
          minWallThicknessMm: result.minWallThicknessMm,
          minOcclusalWallThicknessMm: result.minOcclusalWallThicknessMm,
          minAxialWallThicknessMm: result.minAxialWallThicknessMm,
          volumeMm3: result.volumeMm3,
          autoThickenApplied: result.autoThickenApplied,
          autoThickenMaxAppliedMm: result.autoThickenMaxAppliedMm,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('shell', error);
      throw error;
    }
  }

  // ---- stage 5: freeform sculpt ----------------------------------------

  /**
   * Applies ONE freeform sculpt stroke to the shell's OUTER surface (the
   * intaglio fit surface stays locked unless `unlockFitSurface`). Each stroke
   * is one gesture -> ONE coalesced `crown-sculpt` op, and re-writes
   * `stages.finalMesh`. Requires the shell to exist.
   */
  async applySculptStroke(stroke: { center: Vec3; radiusMm: number; strength: number; brush: SculptBrushType }): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'freeform', progress: 0, error: null, errorStage: null });
    // P7-T1 fix round (19b class): the sync order check + session-shape check
    // live INSIDE the try — post-reload the freeform gate passes from the
    // persisted stages.finalMesh hash while `session.shell`/`session.inner` are
    // null; a pre-try throw would escape `failStage` and leave the sculpt click
    // a fully silent no-op (button enabled, nothing happens). Matches the
    // runQc/runMorph/constructShell siblings.
    try {
      this.assertRunnable('freeform');
      if (!session.shell || !session.inner) {
        throw new CrownStageOrderError('freeform', 'shellIncomplete');
      }
      const unlock = !useCrownStore.getState().outerLock;
      const result = await this.pool().run('applySculptStroke', {
        shellPositions: session.shell.positions,
        shellIndices: session.shell.indices,
        innerPositions: session.inner.positions,
        innerIndices: session.inner.indices,
        strokes: [stroke],
        marginLoop: session.marginLoopFlat,
        unlockFitSurface: unlock,
      });
      const priorShellHash = session.shell.contentHash;
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.shell = { positions: result.positions, indices: result.indices, contentHash };
      this.commitStage(
        'freeform',
        'finalMesh',
        contentHash,
        'crown-sculpt',
        {
          brush: stroke.brush,
          radiusMm: stroke.radiusMm,
          strength: stroke.strength,
          center: stroke.center,
          unlockFitSurface: unlock,
          movedVertexCount: result.movedVertexCount,
          peakDisplacementMm: result.peakDisplacementMm,
        },
        [priorShellHash],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        sculpt: {
          movedVertexCount: result.movedVertexCount,
          peakDisplacementMm: result.peakDisplacementMm,
          lockedVertexCount: result.lockedVertexCount,
          sculptableVertexCount: result.sculptableVertexCount,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('freeform', error);
      throw error;
    }
  }

  // ---- stage 6: QC ------------------------------------------------------

  /**
   * Runs the full QC gate suite on the constructed shell and stores the
   * `QcReport` on the restoration (`Restoration.qc`). One coalesced
   * `crown-qc` op. Requires the shell to exist — a crown with no watertight
   * shell can never reach QC (order enforcement), so a failed shell can never
   * produce a passing report.
   */
  async runQc(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', progress: 0, error: null, errorStage: null });
    // P7-T1 (the 19b sibling sweep): the synchronous order check + session-
    // shape check live INSIDE the try — a pre-try throw (e.g. persisted stage
    // hashes without session state, after a reload) would escape `failStage`
    // and leave the click a silent no-op.
    try {
      this.assertRunnable('qc');
      if (!session.shell || !session.inner || !session.morphOuter) {
        throw new CrownStageOrderError('qc', 'shellIncomplete');
      }
      const document = caseStore.getDocument();
      const profileVersion = resolveProfileVersion(document);
      const { report } = await this.pool().run('runQc', {
        crownPositions: session.shell.positions,
        crownIndices: session.shell.indices,
        innerPositions: session.inner.positions,
        innerIndices: session.inner.indices,
        outerPositions: session.morphOuter.positions,
        outerIndices: session.morphOuter.indices,
        diePositions: session.diePositions,
        dieIndices: session.dieIndices,
        marginLoop: session.marginLoopFlat,
        insertionAxis: session.insertionAxis,
        minWallThicknessMm: session.params.minWallThicknessMm,
        occlusalMinWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.occlusalMinWallThicknessMm,
        connectorAreaTargetMm2: STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.anteriorMm2,
        // P4 carry-in (closing docs/demos/phase-4.md's open item): the finish-line
        // feather band is excluded from the min-wall gate so it measures the wall
        // bulk, not the marginal feather (governed by marginFit). Sourced from the
        // material profile — the crown's 0.2 mm finish-line feather (invariant 7,
        // never hardcoded in pipeline code); the cavity path uses its own, larger
        // cavosurface-convergence band (see engine/cavityDesign.ts).
        marginExclusionMm: STANDARD_ZIRCONIA_PROFILE.marginExclusionMm,
        contacts: session.morphContacts,
        contactClampWarning: session.morphContacts.some((c) => c.clampBound),
        // The journaled morph→shell heal @errorBound — SUMMED onto each contact
        // residual so the gate is honest; the export re-validation gets the same
        // value. `null` (no heal) ⇒ undefined ⇒ 0 ⇒ pre-heal-identical.
        healErrorBoundMm: session.shellHealErrorBoundMm ?? undefined,
        kernelVersion: KERNEL_VERSION,
        profileVersion,
        journalHash: session.shell.contentHash,
      });
      this.commitQc(report, 'crown-qc', { passed: report.passed, gateCount: report.gates.length });
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
   * report's `acknowledged` flag is set by the gate runner itself (not
   * hand-patched). One coalesced `crown-qc-ack` op.
   */
  async acknowledgeGate(gate: string): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', error: null, errorStage: null });
    // Same defense as runQc (P7-T1): no pre-try synchronous escape.
    try {
      const restoration = this.restoration();
      if (restoration.qc === null || !session.shell || !session.inner || !session.morphOuter) {
        throw new CrownStageOrderError('qc', 'shellIncomplete');
      }
      const alreadyAck = restoration.qc.gates.filter((g) => g.acknowledged).map((g) => g.gate);
      const acknowledgedGates = Array.from(new Set([...alreadyAck, gate]));
      const document = caseStore.getDocument();
      const profileVersion = resolveProfileVersion(document);
      const { report } = await this.pool().run('runQc', {
        crownPositions: session.shell.positions,
        crownIndices: session.shell.indices,
        innerPositions: session.inner.positions,
        innerIndices: session.inner.indices,
        outerPositions: session.morphOuter.positions,
        outerIndices: session.morphOuter.indices,
        diePositions: session.diePositions,
        dieIndices: session.dieIndices,
        marginLoop: session.marginLoopFlat,
        insertionAxis: session.insertionAxis,
        minWallThicknessMm: session.params.minWallThicknessMm,
        occlusalMinWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.occlusalMinWallThicknessMm,
        connectorAreaTargetMm2: STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.anteriorMm2,
        // P4 carry-in (closing docs/demos/phase-4.md's open item): the finish-line
        // feather band is excluded from the min-wall gate so it measures the wall
        // bulk, not the marginal feather (governed by marginFit). Sourced from the
        // material profile — the crown's 0.2 mm finish-line feather (invariant 7,
        // never hardcoded in pipeline code); the cavity path uses its own, larger
        // cavosurface-convergence band (see engine/cavityDesign.ts).
        marginExclusionMm: STANDARD_ZIRCONIA_PROFILE.marginExclusionMm,
        contacts: session.morphContacts,
        contactClampWarning: session.morphContacts.some((c) => c.clampBound),
        // Same journaled heal @errorBound as runQc — re-supplied on the ack
        // re-run so the acknowledged report's contact residual is unchanged.
        healErrorBoundMm: session.shellHealErrorBoundMm ?? undefined,
        kernelVersion: KERNEL_VERSION,
        profileVersion,
        journalHash: session.shell.contentHash,
        acknowledgedGates,
      });
      this.commitQc(report, 'crown-qc-ack', { acknowledgedGate: gate, acknowledgedGates });
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
      params: { restorationId: restoration.id, tooth: this.requireSession().tooth, ...params },
      inputHashes: this.session?.shell ? [this.session.shell.contentHash] : [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    caseStore.updateRestoration(next, operation);
  }

  // ---- export access (Phase 7 Task 3) -----------------------------------

  /**
   * The session's FINAL restoration solid (the shell that wrote
   * `stages.finalMesh`) for the export flow — `null` when no session is
   * active for `restorationId` or the shell has not been built in THIS
   * session (e.g. right after a reload). The caller
   * (engine/exportFlow.ts) verifies `contentHash` against the document's
   * `stages.finalMesh` before serializing — a mismatch is refused, never
   * exported. Read-only access to the live session buffers (the export job
   * copies them before transfer).
   */
  finalMeshForExport(
    restorationId: string,
  ): { positions: Float64Array; indices: Uint32Array; contentHash: string } | null {
    const session = this.session;
    if (!session || session.restorationId !== restorationId || !session.shell) return null;
    return {
      positions: session.shell.positions,
      indices: session.shell.indices,
      contentHash: session.shell.contentHash,
    };
  }

  /**
   * The RIDING QC context for the server export re-validation (Phase 7 Task 7)
   * — the design-time surfaces + measured inputs the delivered bytes can't
   * reconstruct, built from the SAME live-session buffers + profile constants
   * this engine's `runQc` fed the worker (parity: the server recompute over the
   * re-imported solid + this context reproduces the client `QcReport`). `null`
   * under the same no-live-session conditions as `finalMeshForExport`. Every
   * threshold is profile-sourced (invariant 7) and matches the server-resolved
   * authority; the export schema's forbidden free knobs are never present.
   */
  exportQcContext(restorationId: string): CrownExportQcContext | null {
    const session = this.session;
    if (
      !session ||
      session.restorationId !== restorationId ||
      !session.inner ||
      !session.morphOuter ||
      !session.shell
    ) {
      return null;
    }
    return {
      innerSurfaceMesh: meshJson(session.inner.positions, session.inner.indices),
      outerSurfaceMesh: meshJson(session.morphOuter.positions, session.morphOuter.indices),
      dieSolid: meshJson(session.diePositions, session.dieIndices),
      marginResampledPoints: loopJson(session.marginLoopFlat),
      insertionAxis: [...session.insertionAxis],
      minWallThicknessMm: session.params.minWallThicknessMm,
      occlusalMinWallThicknessMm: STANDARD_ZIRCONIA_PROFILE.occlusalMinWallThicknessMm,
      connectorAreaTargetMm2: STANDARD_ZIRCONIA_PROFILE.connectorAreaMm2.anteriorMm2,
      contacts: [...session.morphContacts],
      contactClampWarning: session.morphContacts.some((c) => c.clampBound),
      marginExclusionMm: STANDARD_ZIRCONIA_PROFILE.marginExclusionMm,
      // The journaled heal @errorBound rides with the export request (a
      // journaled PARAM, not a re-measurement) so the server's independent
      // contact gate SUMS the exact same value — the client-attested contact
      // residual matches field-for-field. Omitted (no heal) ⇒ 0 both sides.
      ...(session.shellHealErrorBoundMm !== null
        ? { healErrorBoundMm: session.shellHealErrorBoundMm }
        : {}),
    };
  }

  // ---- failure surfacing ------------------------------------------------

  private failStage(stage: CrownStage, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.publish({ busyStage: null, morphBusy: false, error: message, errorStage: stage });
  }

  clearError(): void {
    this.publish({ error: null, errorStage: null });
  }

  // ---- overlay-visibility toggles (UI-only, no journal) -----------------

  setInnerGhostVisible(visible: boolean): void {
    this.publish({ innerGhostVisible: visible, designGeneration: useCrownStore.getState().designGeneration + 1 });
  }

  setContactHeatmapVisible(visible: boolean): void {
    this.publish({ contactHeatmapVisible: visible, designGeneration: useCrownStore.getState().designGeneration + 1 });
  }

  setThicknessHeatmapVisible(visible: boolean): void {
    this.publish({ thicknessHeatmapVisible: visible, designGeneration: useCrownStore.getState().designGeneration + 1 });
  }

  setBrush(brush: SculptBrushType): void {
    this.publish({ brush });
  }

  setBrushRadius(radiusMm: number): void {
    this.publish({ brushRadiusMm: radiusMm });
  }

  setBrushStrength(strength: number): void {
    this.publish({ brushStrength: strength });
  }

  setOuterLock(locked: boolean): void {
    this.publish({ outerLock: locked });
  }

  // ---- render-node projection (design mesh + overlays) ------------------

  /**
   * The design mesh(es) to render in the viewport, as Float32 render copies
   * re-centred at the case bbox centroid (the SAME frame the scans render in
   * — CLAUDE.md; the only Float32 in the engine). Returns the most-advanced
   * design surface (shell > morphed outer > placed > inner), optionally with
   * a ghosted inner-surface overlay, and with per-vertex heatmap colours
   * applied when the matching overlay toggle is on. Consumed by
   * ui/Viewport.tsx, concatenated with the scan render nodes.
   */
  getDesignRenderNodes(): RenderNode[] {
    if (!this.session) return [];
    const store = useCrownStore.getState();
    const offset = caseStore.getRenderWorldOffset();
    const nodes: RenderNode[] = [];
    const session = this.session;

    const main = session.shell ?? session.morphOuter ?? session.placed ?? session.inner;
    if (main) {
      const colors = this.designColors(main.positions.length / 3);
      nodes.push({
        id: `crown-design-${session.restorationId}`,
        positions: toRenderPositions(main.positions, offset),
        indices: main.indices,
        visible: true,
        opacity: 1,
        role: 'prepDie',
        colors,
        transform: IDENTITY_RENDER_TRANSFORM,
      });
    }
    if (store.innerGhostVisible && session.inner && main !== session.inner) {
      nodes.push({
        id: `crown-inner-ghost-${session.restorationId}`,
        positions: toRenderPositions(session.inner.positions, offset),
        indices: session.inner.indices,
        visible: true,
        opacity: 0.3,
        role: 'prepDie',
        transform: IDENTITY_RENDER_TRANSFORM,
      });
    }
    return nodes;
  }

  /** Per-vertex heatmap colours for the current main design surface, or
   * `undefined` when no overlay is active/available. Thickness (shell) wins
   * over contact (morph) when both are toggled+available, mirroring
   * Viewport's documented axis>curvature>heatmap precedence. */
  private designColors(vertexCount: number): Float32Array | undefined {
    if (!this.session) return undefined;
    const store = useCrownStore.getState();
    const session = this.session;
    if (store.thicknessHeatmapVisible && session.shell && session.shellThicknessHeatmap) {
      const distances = session.shellThicknessHeatmap;
      if (distances.length === vertexCount) {
        const range = computeAutoRange(distances);
        return distancesToVertexColors(distances, range);
      }
    }
    if (
      store.contactHeatmapVisible &&
      session.morphOuter &&
      session.shell === null &&
      session.morphHeatmap &&
      session.morphHeatmap.length === vertexCount
    ) {
      const range = computeAutoRange(session.morphHeatmap);
      return distancesToVertexColors(session.morphHeatmap, range);
    }
    // Reference `colorForValue` so an unused-import lint never trips while the
    // richer per-gate overlays are still Phase 5 work.
    void colorForValue;
    return undefined;
  }
}

const IDENTITY_RENDER_TRANSFORM: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function toRenderPositions(positions: Float64Array, offset: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! - offset[0];
    out[i + 1] = positions[i + 1]! - offset[1];
    out[i + 2] = positions[i + 2]! - offset[2];
  }
  return out;
}

/** The single shared crown-design controller for the whole client (mirrors
 * engine/axis.ts's `axisEngine` singleton). */
export const crownDesignEngine = new CrownDesignEngine();

/** Re-export so the panel can subscribe without importing the state module
 * twice (mirrors other panels' import style). */
export { useCrownStore };

/** Bind the case-document store hook here so `useCaseStore` stays reachable
 * for tests that assert against the published snapshot. */
export { useCaseStore };
