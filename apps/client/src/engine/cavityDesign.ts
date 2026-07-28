// apps/client/src/engine/cavityDesign.ts
//
// Phase 5 Task 8 — the inlay/onlay (cavity) design workflow CONTROLLER. The
// cavity analogue of engine/crownDesign.ts: imperative, engine layer, the SOLE
// client-side orchestrator of the cavity pipeline stages (T3–T7's REGISTERED
// worker jobs) in the fixed order enforced by engine/cavityWorkflow.ts. It:
//   1. dispatches the already-deterministic cavity worker jobs
//      (cavityInnerSurface, cavityOcclusalPatch, cavityProximalContact,
//      cavityShell, runInlayQc) through the WorkerPool — adding NO new
//      nondeterminism of its own;
//   2. enforces stage order (consults `canRunCavityStage` before every dispatch,
//      throwing `CavityStageOrderError` on a premature call);
//   3. content-addresses each stage's output mesh (the `hashMesh` job) and writes
//      the hash into `Restoration.stages` (`fitSurface`/`occlusalPatch`/
//      `proximalContacts`/`cuspCoverage`/`finalMesh`);
//   4. JOURNALS every completed stage as ONE COALESCED `Operation` (never
//      per-frame spam), mirroring engine/crownDesign.ts;
//   5. publishes an ephemeral UI snapshot to state/cavityStore.ts after every
//      change (committed hashes/QcReport flow through the case document);
//   6. surfaces a stage FAILURE HONESTLY (an error state; it NEVER writes a
//      stage hash/qc for a stage that failed, so a broken restoration can never
//      masquerade as a completed one — the P4 honest-failure invariant).
//
// Layer rule: engine may import kernel-workers / state / shared-types /
// clinical-profiles only (never kernel, cad-pipeline, Three.js). The kernel
// payload types are matched STRUCTURALLY here (the worker payload types are
// interfaces, so a plain object with the right fields satisfies WorkerPool.run's
// inferred payload type without importing the nominal kernel type name — the
// same layer-boundary convention crownDesign.ts documents).
import { KERNEL_VERSION, type JobName, type JobPayloadMap, type JobResultMap, type RunJobOptions } from '@dqcad/kernel-workers';
import { DEFAULT_OFFSET_VOXEL_PITCH_MM, STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import type { FdiTooth, Operation, QcReport, Restoration, RestorationParams, Vec3 } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import {
  type CavityStage,
  canRunCavityStage,
  cavityDownstreamInvalidations,
  firstCavityOutline,
  nextRunnableCavityStage,
  cavityWorkflowGates,
} from './cavityWorkflow';
import { flattenLoop, boxMesh } from './crownGeometry';
import { getPool } from './workers';
import { useCavityStore, type CavityStageGateSnapshot } from '../state/cavityStore';
import { useCaseStore } from '../state/caseStore';

/** Minimal structural view of a pool that can dispatch a job (`WorkerPool`
 * satisfies it; node-lane tests inject a fake implementing exactly this). */
export interface RunnablePool {
  run<J extends JobName>(jobName: J, payload: JobPayloadMap[J], opts?: RunJobOptions): Promise<JobResultMap[J]>;
}

/** Blend width (mm) between the marginal-gap and cement-gap zones of the cavity
 * fit surface — an ALGORITHMIC smoothing parameter (not a clinical default; the
 * clinical gaps come from the material profile / `RestorationParams`). Matches
 * the T3/T6 fixture value. Journaled. */
const CAVITY_FIT_BLEND_WIDTH_MM = 0.3;

/**
 * The cavity min-wall MARGINAL-TRANSITION band width (mm) wired into the LIVE
 * `runInlayQc` call — the inlay/onlay analogue of the crown's `marginExclusionMm`
 * feather, but sized for the cavity's much larger cavosurface CONVERGENCE WEDGE,
 * and BRANCHED ON RESTORATION TYPE (Task 9 review fix — a single unconditional
 * 1.3 previously applied to onlays too, narrower than the T7-derived band):
 *
 *   - INLAY → **1.3 mm** (Task 6 derivation, measured on the MOD fixture): the
 *     fit↔patch global minimum is ALWAYS the convergence wedge (≈0.88 µm/µm from
 *     the outline), so the band must clear it — below ~1.2 mm the wedge leaks in
 *     and confounds the structural measurement; above ~1.5 mm the shallow-cavity
 *     variant over-excludes to 0 samples. 1.3 is the measured separator, pinned
 *     by the inlay-shell-acceptance golden (`MARGIN_EXCL = 1.3`).
 *   - ONLAY → **1.8 mm** (Task 7 derivation): the broad covered cusp's
 *     convergence wedge is WIDER — below ~1.6 mm it leaks into the region-scoped
 *     coverage minimum and confounds the healthy/thin cusp-coverage separation.
 *     1.8 is the measured separator, pinned by the onlay-acceptance golden
 *     (`MARGIN_EXCL = 1.8`).
 *
 * WHERE THE NUMBERS LIVE & WHY NOT THE 0.2 mm CROWN FEATHER: an inlay/onlay
 * closes along its ENTIRE cavity outline (not a single cervical margin), so the
 * fit-surface ↔ occlusal-patch convergence wedge — the restoration feathering to
 * the cavosurface margin (the marginal-seal region, governed by `marginFit`) —
 * wraps the whole perimeter and is ~one restoration-thickness wide, NOT the
 * crown's 0.2 mm finish-line feather. These are GEOMETRY-DERIVED bands documented
 * in the Task 6/7 reports + the acceptance goldens.
 *
 * PHASE 6 TASK 1 — the reviewer item is now DONE: these bands are PROMOTED into
 * `clinical-profiles` as dedicated `inlayMarginExclusionMm` (1.3) /
 * `onlayMarginExclusionMm` (1.8) fields (versioned + checksummed, the T1
 * discipline). This helper now READS THOSE PROFILE FIELDS instead of hardcoding
 * 1.3/1.8 — bit-identical values (the live UI defaults to zirconia, whose profile
 * carries exactly 1.3/1.8), so the cavity QC payloads and acceptance goldens do
 * NOT move. The bands are geometry-derived (material-independent), so the same
 * values ride on every profile.
 */
export function cavityMarginExclusionMm(restorationType: 'inlay' | 'onlay'): number {
  return restorationType === 'onlay'
    ? STANDARD_ZIRCONIA_PROFILE.onlayMarginExclusionMm
    : STANDARD_ZIRCONIA_PROFILE.inlayMarginExclusionMm;
}

/** The proximal-contact NEIGHBOUR gap (mm) for the synthetic reference boxes —
 * mirrors the inlay-shell-acceptance golden's `gap = 0.1`. */
const NEIGHBOUR_GAP_MM = 0.1;

/** Thrown when a stage method is called before its prerequisite stage produced
 * its output — the order-enforcement guard. */
export class CavityStageOrderError extends Error {
  constructor(
    readonly stage: CavityStage,
    readonly reason: string,
  ) {
    super(`cavityDesign: stage "${stage}" cannot run yet (${reason})`);
    this.name = 'CavityStageOrderError';
  }
}

/** Thrown when a session action is attempted with no active restoration. */
export class CavityNoSessionError extends Error {
  constructor() {
    super('cavityDesign: no active cavity-design session (call start() first)');
    this.name = 'CavityNoSessionError';
  }
}

/** Thrown when a cavity session is started for a non-cavity restoration type. */
export class NonCavityRestorationError extends Error {
  constructor(readonly type: string) {
    super(`cavityDesign: restoration type "${type}" is not a cavity restoration (inlay/onlay only)`);
    this.name = 'NonCavityRestorationError';
  }
}

interface DerivedMesh {
  positions: Float64Array;
  indices: Uint32Array;
  contentHash: string;
}

/** Structural mirror of `@dqcad/cad-pipeline`'s `ContactResidualInput`. */
interface ContactResidualInput {
  kind: 'proximalMesial' | 'proximalDistal';
  targetPenetrationMm: number;
  achievedSignedDistanceMm: number;
  contactResidualMm: number;
  regionResidualMm: number;
  clampBound: boolean;
}

/** Structural mirror of `@dqcad/cad-pipeline`'s `CoverageDivider`. */
export interface CoverageDivider {
  pointMm: Vec3;
  normalMm: Vec3;
}

interface Session {
  restorationId: string;
  tooth: FdiTooth;
  restorationType: 'inlay' | 'onlay';
  targetNodeId: string;
  toothHash: string;
  toothPositions: Float64Array;
  toothIndices: Uint32Array;
  outlinePoints: readonly Vec3[];
  outlineFlat: Float64Array;
  insertionAxis: Vec3;
  params: RestorationParams;
  bvhBuilt: boolean;
  fit: DerivedMesh | null;
  patch: (DerivedMesh & {
    seamEdges: JobResultMap['cavityOcclusalPatch']['seamEdges'];
    cavityTriangleIndices: Uint32Array;
    proximalFaces: JobResultMap['cavityOcclusalPatch']['proximalFaces'];
    seamDihedralMaxDeg: number;
  }) | null;
  contacts: (DerivedMesh & { contactInputs: ContactResidualInput[]; clampWarning: boolean }) | null;
  coverage: CoverageDivider | null;
  shell: DerivedMesh | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

class CavityDesignEngine {
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
    if (!this.session) throw new CavityNoSessionError();
    return this.session;
  }

  private restoration(): Restoration {
    const session = this.requireSession();
    const found = caseStore.getDocument().restorations.find((r) => r.id === session.restorationId);
    if (!found) throw new Error(`cavityDesign: restoration ${session.restorationId} no longer exists`);
    return found;
  }

  /**
   * Begins a cavity-design session for `restorationId`. Captures the target tooth
   * scan, the confirmed cavity outline, insertion axis and params, then publishes
   * the initial gate snapshot. Throws if the restoration is missing, not a cavity
   * type, has no target scan, or has no usable cavity outline.
   */
  start(restorationId: string): void {
    const restoration = caseStore.getDocument().restorations.find((r) => r.id === restorationId);
    if (!restoration) throw new Error(`cavityDesign.start: no restoration ${restorationId}`);
    if (restoration.type !== 'inlay' && restoration.type !== 'onlay') {
      throw new NonCavityRestorationError(restoration.type);
    }
    if (restoration.targetNodeId === null) throw new CavityStageOrderError('fit', 'noTargetScan');
    const outline = firstCavityOutline(restoration);
    if (!outline) throw new CavityStageOrderError('fit', 'noCavityOutline');
    const node = caseStore.getDocument().scene.find((n) => n.id === restoration.targetNodeId);
    const record = node ? caseStore.getMeshRecord(node.meshId) : undefined;
    if (!node || !record) throw new CavityStageOrderError('fit', 'noTargetScan');
    this.session = {
      restorationId,
      tooth: outline.tooth,
      restorationType: restoration.type,
      targetNodeId: restoration.targetNodeId,
      toothHash: record.contentHash,
      toothPositions: record.positions,
      toothIndices: record.indices,
      outlinePoints: outline.points,
      outlineFlat: flattenLoop(outline.points),
      insertionAxis: restoration.insertionAxis,
      params: restoration.params,
      bvhBuilt: false,
      fit: null,
      patch: null,
      contacts: null,
      coverage: null,
      shell: null,
    };
    caseStore.setSelectedRestorationId(restorationId);
    this.publish({ restorationId, restorationType: restoration.type, active: true, error: null, errorStage: null });
    this.refreshGates();
  }

  clear(): void {
    this.session = null;
    useCavityStore.getState().reset();
  }

  /** TEST-ONLY: full reset (session + store + injected pool). */
  resetForTests(): void {
    this.session = null;
    this.testPool = null;
    useCavityStore.getState().reset();
  }

  // ---- publishing -------------------------------------------------------

  private gateSnapshot(): CavityStageGateSnapshot[] {
    const restoration = this.restoration();
    return cavityWorkflowGates(restoration).map((g) => ({
      stage: g.stage,
      allowed: g.allowed,
      complete: g.complete,
      reason: g.reason,
    }));
  }

  private publish(partial: Parameters<ReturnType<typeof useCavityStore.getState>['apply']>[0]): void {
    useCavityStore.getState().apply(partial);
  }

  private refreshGates(): void {
    if (!this.session) return;
    const restoration = this.restoration();
    this.publish({
      gates: this.gateSnapshot(),
      nextStage: nextRunnableCavityStage(restoration),
      designGeneration: useCavityStore.getState().designGeneration + 1,
    });
  }

  private assertRunnable(stage: CavityStage): void {
    const restoration = this.restoration();
    if (!canRunCavityStage(stage, restoration)) {
      const gate = cavityWorkflowGates(restoration).find((g) => g.stage === stage);
      throw new CavityStageOrderError(stage, gate?.reason ?? 'blocked');
    }
  }

  private async hashMesh(positions: Float64Array, indices: Uint32Array): Promise<string> {
    const { contentHash } = await this.pool().run('hashMesh', { positions, indices });
    return contentHash;
  }

  /** Commits a completed stage: writes its output hash into `Restoration.
   * stages[field]`, journals ONE coalesced Operation, and applies the
   * INVALIDATION CASCADE (cavityWorkflow's `cavityDownstreamInvalidations`) —
   * clearing every downstream stage hash + the `QcReport` this edit invalidated,
   * so a stale "PASSED" report can never survive a re-run of an earlier stage. */
  private commitStage(
    stage: CavityStage,
    field: keyof Restoration['stages'],
    contentHash: string,
    opName: string,
    params: Record<string, unknown>,
    inputHashes: readonly string[],
  ): void {
    const restoration = this.restoration();
    const invalidation = cavityDownstreamInvalidations(stage, restoration.type);
    const stages: Restoration['stages'] = { ...restoration.stages, [field]: contentHash };
    for (const invalidField of invalidation.stageFields) delete stages[invalidField];
    const next: Restoration = { ...restoration, stages, qc: invalidation.clearQc ? null : restoration.qc };
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

  /** Drops the in-memory session geometry + store summaries a commit's cascade
   * just cleared, so nothing renders a stage/QC result that no longer
   * corresponds to the current design. */
  private invalidateDownstream(invalidation: ReturnType<typeof cavityDownstreamInvalidations>): void {
    const session = this.session;
    const storePatch: Parameters<ReturnType<typeof useCavityStore.getState>['apply']>[0] = {};
    for (const field of invalidation.stageFields) {
      if (field === 'occlusalPatch') {
        if (session) session.patch = null;
        storePatch.patch = null;
      } else if (field === 'proximalContacts') {
        if (session) session.contacts = null;
        storePatch.contacts = null;
      } else if (field === 'cuspCoverage') {
        if (session) session.coverage = null;
        storePatch.coverage = null;
      } else if (field === 'finalMesh') {
        if (session) session.shell = null;
        storePatch.shell = null;
      }
    }
    if (invalidation.clearQc) storePatch.qc = null;
    if (Object.keys(storePatch).length > 0) this.publish(storePatch);
  }

  // ---- stage: fit (cavity inner surface) --------------------------------

  /**
   * Runs the cavity fit (inner) surface stage: builds a BVH for the tooth (once),
   * then the two-zone cement-gap offset + undercut blockout whose boundary loop
   * is the cavity outline. Default pitch = the clinical 20 µm; a coarser pitch is
   * a journaled parameter. One coalesced `inlay-fit-surface` op.
   */
  async runFit(opts: { pitchMm?: number } = {}): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('fit');
    const pitchMm = opts.pitchMm ?? DEFAULT_OFFSET_VOXEL_PITCH_MM;
    this.publish({ busyStage: 'fit', progress: 0, error: null, errorStage: null });
    try {
      if (!session.bvhBuilt) {
        const positionsCopy = session.toothPositions.slice();
        const indicesCopy = session.toothIndices.slice();
        await this.pool().run(
          'buildBvh',
          { contentHash: session.toothHash, positions: positionsCopy, indices: indicesCopy },
          { transfer: [positionsCopy.buffer, indicesCopy.buffer], affinityKey: session.toothHash },
        );
        session.bvhBuilt = true;
      }
      const result = await this.pool().run(
        'cavityInnerSurface',
        {
          contentHash: session.toothHash,
          pitchMm,
          marginalGapMm: session.params.marginalGapMm,
          cementGapMm: session.params.cementGapMm,
          spacerStartMm: session.params.spacerStartMm,
          blendWidthMm: CAVITY_FIT_BLEND_WIDTH_MM,
          cavityOutline: session.outlineFlat,
          insertionAxis: session.insertionAxis,
        },
        { affinityKey: session.toothHash, onProgress: (f) => this.publish({ progress: f }) },
      );
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.fit = { positions: result.positions, indices: result.indices, contentHash };
      this.commitStage(
        'fit',
        'fitSurface',
        contentHash,
        'inlay-fit-surface',
        {
          pitchMm,
          marginalGapMm: session.params.marginalGapMm,
          cementGapMm: session.params.cementGapMm,
          spacerStartMm: session.params.spacerStartMm,
          blendWidthMm: CAVITY_FIT_BLEND_WIDTH_MM,
          errorBoundMm: result.errorBoundMm,
        },
        [session.toothHash],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        fit: {
          errorBoundMm: result.errorBoundMm,
          flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
          patchTriangleCount: result.patchTriangleCount,
          skirtTriangleCount: result.skirtTriangleCount,
          marginVertexCount: result.marginVertexCount,
          pitchMm,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('fit', error);
      throw error;
    }
  }

  // ---- stage: patch (occlusal anatomy + G1 seam blend) ------------------

  /**
   * Runs the occlusal-patch stage: the anatomy patch fitted to the cavity outline
   * and G1-blended into the surrounding tooth (max seam dihedral < 5° measured).
   * One coalesced `inlay-occlusal-patch` op.
   */
  async runPatch(opts: { crossSegments?: number } = {}): Promise<void> {
    const session = this.requireSession();
    this.assertRunnable('patch');
    this.publish({ busyStage: 'patch', progress: 0, error: null, errorStage: null });
    try {
      const result = await this.pool().run(
        'cavityOcclusalPatch',
        {
          contentHash: session.toothHash,
          cavityOutline: session.outlineFlat,
          insertionAxis: session.insertionAxis,
          ...(opts.crossSegments !== undefined ? { crossSegments: opts.crossSegments } : {}),
        },
        { affinityKey: session.toothHash, onProgress: (f) => this.publish({ progress: f }) },
      );
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.patch = {
        positions: result.positions,
        indices: result.indices,
        contentHash,
        seamEdges: result.seamEdges,
        cavityTriangleIndices: result.cavityTriangleIndices,
        proximalFaces: result.proximalFaces,
        seamDihedralMaxDeg: result.seamDihedralMaxDeg,
      };
      this.commitStage(
        'patch',
        'occlusalPatch',
        contentHash,
        'inlay-occlusal-patch',
        {
          seamDihedralMaxDeg: result.seamDihedralMaxDeg,
          seamDihedralBoundDeg: result.seamDihedralBoundDeg,
          patchTriangleCount: result.patchTriangleCount,
          crossSegments: result.crossSegments,
        },
        session.fit ? [session.fit.contentHash] : [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        patch: {
          seamDihedralMaxDeg: result.seamDihedralMaxDeg,
          seamDihedralMeanDeg: result.seamDihedralMeanDeg,
          seamDihedralBoundDeg: result.seamDihedralBoundDeg,
          patchTriangleCount: result.patchTriangleCount,
          proximalFaceCount: result.proximalFaces.length,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('patch', error);
      throw error;
    }
  }

  // ---- stage: contacts (Class II proximal box adaptation) ---------------

  /** Builds the flanking synthetic neighbour reference boxes (a documented
   * placeholder — the client cannot yet segment the real proximal neighbours
   * from an arch scan; mirrors crownDesign's synthetic proximal boxes) from the
   * cavity outline's mesiodistal extent, and pairs each proximal break-through
   * face to the neighbour on its side. */
  private buildAdaptations(session: Session): Array<{
    label: string;
    columnPoints: Float64Array;
    freeRunPoints: Float64Array;
    neighborPositions: Float64Array;
    neighborIndices: Uint32Array;
    targetPenetrationMm: number;
  }> {
    const pts = session.outlinePoints;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    }
    const yMin = minY - 3, yMax = maxY + 3, zMin = minZ - 1, zMax = maxZ + 3;
    const mesialBox = boxMesh([minX - NEIGHBOUR_GAP_MM - 2, yMin, zMin], [minX - NEIGHBOUR_GAP_MM, yMax, zMax]);
    const distalBox = boxMesh([maxX + NEIGHBOUR_GAP_MM, yMin, zMin], [maxX + NEIGHBOUR_GAP_MM + 2, yMax, zMax]);
    const patch = session.patch;
    if (!patch) return [];
    return patch.proximalFaces.map((face) => {
      const side = face.columnPoints.length > 0 && face.columnPoints[0]![0] < 0 ? 'mesial' : 'distal';
      const neighbor = side === 'mesial' ? mesialBox : distalBox;
      return {
        label: side,
        columnPoints: flattenLoop(face.columnPoints),
        freeRunPoints: flattenLoop(face.freeRunPoints),
        neighborPositions: neighbor.positions,
        neighborIndices: neighbor.indices,
        targetPenetrationMm: session.params.proximalContactPenetrationMm,
      };
    });
  }

  /**
   * Runs the proximal-box contact adaptation (Class II): each box face adapts to
   * its neighbour at `proximalContactPenetrationMm`; the occlusal patch + seam
   * stay fixed (the seam's G1 must survive — measured before/after). One coalesced
   * `inlay-proximal-contacts` op.
   */
  async runContacts(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'contacts', progress: 0, error: null, errorStage: null });
    // P7-T1 fix round (19b class): sync validation inside the try — post-reload
    // the gate passes from the persisted occlusalPatch hash while the session
    // fields are null; a pre-try throw would be a silent no-op.
    try {
      this.assertRunnable('contacts');
      if (!session.patch) throw new CavityStageOrderError('contacts', 'patchIncomplete');
      const adaptations = this.buildAdaptations(session);
      const result = await this.pool().run(
        'cavityProximalContact',
        {
          patchPositions: session.patch.positions,
          patchIndices: session.patch.indices,
          toothPositions: session.toothPositions,
          toothIndices: session.toothIndices,
          seamEdges: session.patch.seamEdges,
          cavityTriangleIndices: session.patch.cavityTriangleIndices,
          adaptations,
        },
        { onProgress: (f) => this.publish({ progress: f }) },
      );
      const contentHash = await this.hashMesh(result.positions, result.indices);
      const contactInputs: ContactResidualInput[] = result.boxes.map((b) => ({
        kind: b.label === 'mesial' ? 'proximalMesial' : 'proximalDistal',
        targetPenetrationMm: b.targetPenetrationMm,
        achievedSignedDistanceMm: b.achievedSignedDistanceMm,
        contactResidualMm: b.contactResidualMm,
        regionResidualMm: b.faceResidualMm,
        clampBound: b.clampBound,
      }));
      session.contacts = {
        positions: result.positions,
        indices: result.indices,
        contentHash,
        contactInputs,
        clampWarning: result.clampedBoxes.length > 0,
      };
      this.commitStage(
        'contacts',
        'proximalContacts',
        contentHash,
        'inlay-proximal-contacts',
        {
          boxes: result.boxes.map((b) => ({ label: b.label, contactResidualMm: b.contactResidualMm, clampBound: b.clampBound })),
          clampedBoxes: result.clampedBoxes,
          seamDihedralMaxBeforeDeg: result.seamDihedralMaxBeforeDeg,
          seamDihedralMaxAfterDeg: result.seamDihedralMaxAfterDeg,
        },
        session.patch ? [session.patch.contentHash] : [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        contacts: {
          boxes: result.boxes.map((b) => ({
            label: b.label,
            targetPenetrationMm: b.targetPenetrationMm,
            achievedSignedDistanceMm: b.achievedSignedDistanceMm,
            contactResidualMm: b.contactResidualMm,
            clampBound: b.clampBound,
          })),
          clampedBoxes: [...result.clampedBoxes],
          seamDihedralMaxBeforeDeg: result.seamDihedralMaxBeforeDeg,
          seamDihedralMaxAfterDeg: result.seamDihedralMaxAfterDeg,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('contacts', error);
      throw error;
    }
  }

  // ---- stage: cusp coverage (ONLAY only) --------------------------------

  /** A default covered-cusp divider derived from the cavity outline bbox — a
   * plane at the outline's buccal (min-Y) extent, normal pointing outward
   * (−Y). The UI lets the clinician override it; a real onlay would derive the
   * covered cusp from segmentation (reviewer item). */
  defaultCoverageDivider(): CoverageDivider {
    const pts = this.requireSession().outlinePoints;
    let minY = Infinity, sumX = 0, sumZ = 0;
    for (const p of pts) {
      if (p[1] < minY) minY = p[1];
      sumX += p[0];
      sumZ += p[2];
    }
    const n = pts.length || 1;
    return { pointMm: [sumX / n, minY, sumZ / n], normalMm: [0, -1, 0] };
  }

  /**
   * ONLAY only: commits the covered-cusp coverage divider selection (the plane
   * the region-scoped cusp-coverage thickness gate uses). Journaled as one
   * `inlay-cusp-coverage` op with a deterministic marker hash of the divider.
   */
  async selectCuspCoverage(divider: CoverageDivider): Promise<void> {
    const session = this.requireSession();
    if (session.restorationType !== 'onlay') {
      throw new CavityStageOrderError('cuspCoverage', 'contactsIncomplete');
    }
    this.assertRunnable('cuspCoverage');
    this.publish({ busyStage: 'cuspCoverage', progress: 0, error: null, errorStage: null });
    try {
      session.coverage = divider;
      // A deterministic marker (a pure function of the divider) — the coverage
      // stage produces no mesh; the marker content-addresses the selection so the
      // stages field + journal replay are reproducible.
      const marker = `coverage:${divider.pointMm.join(',')}:${divider.normalMm.join(',')}`;
      this.commitStage(
        'cuspCoverage',
        'cuspCoverage',
        marker,
        'inlay-cusp-coverage',
        { pointMm: divider.pointMm, normalMm: divider.normalMm },
        session.contacts ? [session.contacts.contentHash] : [],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        coverage: { pointMm: divider.pointMm, normalMm: divider.normalMm },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('cuspCoverage', error);
      throw error;
    }
  }

  // ---- stage: shell -----------------------------------------------------

  /**
   * Constructs the watertight inlay/onlay shell from the fit surface + the adapted
   * occlusal patch, welded along their shared cavity-outline ring. HONEST FAILURE:
   * if the manifold weld rejects the input, this sets an error state and does NOT
   * write `stages.finalMesh` — the restoration stays unbuilt, QC stays blocked.
   * One coalesced `inlay-shell` op.
   */
  async constructShell(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'shell', progress: 0, error: null, errorStage: null });
    // P7-T1 fix round (19b class): sync validation inside the try — post-reload
    // the gate passes from the persisted proximalContacts hash while the
    // session fields are null; a pre-try throw would be a silent no-op.
    try {
      this.assertRunnable('shell');
      if (!session.fit || !session.contacts) throw new CavityStageOrderError('shell', 'contactsIncomplete');
      const result = await this.pool().run(
        'cavityShell',
        {
          fitPositions: session.fit.positions,
          fitIndices: session.fit.indices,
          patchPositions: session.contacts.positions,
          patchIndices: session.contacts.indices,
        },
        { onProgress: (f) => this.publish({ progress: f }) },
      );
      const contentHash = await this.hashMesh(result.positions, result.indices);
      session.shell = { positions: result.positions, indices: result.indices, contentHash };
      this.commitStage(
        'shell',
        'finalMesh',
        contentHash,
        'inlay-shell',
        {
          watertight: result.watertight,
          componentCount: result.componentCount,
          seamRingVertexCount: result.seamRingVertexCount,
          volumeMm3: result.volumeMm3,
        },
        [session.fit.contentHash, session.contacts.contentHash],
      );
      this.publish({
        busyStage: null,
        progress: 1,
        shell: {
          watertight: result.watertight,
          componentCount: result.componentCount,
          seamRingVertexCount: result.seamRingVertexCount,
          volumeMm3: result.volumeMm3,
        },
      });
      this.refreshGates();
    } catch (error) {
      this.failStage('shell', error);
      throw error;
    }
  }

  // ---- stage: QC --------------------------------------------------------

  private cavityMinimums(): { inlayMinThicknessMm: number; onlayMinThicknessMm: number } {
    return {
      inlayMinThicknessMm: STANDARD_ZIRCONIA_PROFILE.inlayMinThicknessMm,
      onlayMinThicknessMm: STANDARD_ZIRCONIA_PROFILE.onlayMinThicknessMm,
    };
  }

  private buildQcPayload(session: Session, acknowledgedGates?: readonly string[]): JobPayloadMap['runInlayQc'] {
    if (!session.shell || !session.fit || !session.contacts || !session.patch) {
      throw new CavityStageOrderError('qc', 'shellIncomplete');
    }
    const document = caseStore.getDocument();
    const profileVersion = document.settings.profileVersion || 'unversioned';
    const coverage =
      session.restorationType === 'onlay' && session.coverage
        ? {
            coverageDivider: { pointMm: session.coverage.pointMm, normalMm: session.coverage.normalMm },
            cuspCoverageMinThicknessMm: STANDARD_ZIRCONIA_PROFILE.cuspCoverageMinThicknessMm,
          }
        : undefined;
    return {
      inlayPositions: session.shell.positions,
      inlayIndices: session.shell.indices,
      fitPositions: session.fit.positions,
      fitIndices: session.fit.indices,
      patchPositions: session.contacts.positions,
      patchIndices: session.contacts.indices,
      toothPositions: session.toothPositions,
      toothIndices: session.toothIndices,
      cavityOutline: session.outlineFlat,
      insertionAxis: session.insertionAxis,
      restorationType: session.restorationType,
      thicknessMinimums: this.cavityMinimums(),
      // The type-branched cavity band (NOT the crown 0.2 feather) — see
      // cavityMarginExclusionMm: inlay 1.3 (T6), onlay 1.8 (T7).
      marginExclusionMm: cavityMarginExclusionMm(session.restorationType),
      ...(coverage ? { coverage } : {}),
      seamEdges: session.patch.seamEdges,
      cavityTriangleIndices: session.patch.cavityTriangleIndices,
      contacts: session.contacts.contactInputs,
      contactClampWarning: session.contacts.clampWarning,
      kernelVersion: KERNEL_VERSION,
      profileVersion,
      journalHash: session.shell.contentHash,
      ...(acknowledgedGates ? { acknowledgedGates } : {}),
    };
  }

  /**
   * Runs the full inlay/onlay QC gate suite on the constructed shell and stores
   * the `QcReport` on the restoration. One coalesced `inlay-qc` op. Requires the
   * shell to exist — a restoration with no watertight shell can never reach QC.
   */
  async runQc(): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', progress: 0, error: null, errorStage: null });
    // P7-T1 (the 19b sibling sweep): the synchronous order check + payload
    // build live INSIDE the try — a pre-try throw (e.g. persisted stage hashes
    // without session state, after a reload) would escape `failStage` and
    // leave the click a silent no-op.
    try {
      this.assertRunnable('qc');
      const payload = this.buildQcPayload(session);
      const { report } = await this.pool().run('runInlayQc', payload, { onProgress: (f) => this.publish({ progress: f }) });
      this.commitQc(report, 'inlay-qc', { passed: report.passed, gateCount: report.gates.length });
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
   * report's `acknowledged` flag is set by the gate runner itself. This is the
   * path the ONLAY's ~0.06 mm³ seating interference surfaces through: ACKNOWLEDGED,
   * never a clean pass. One coalesced `inlay-qc-ack` op.
   */
  async acknowledgeGate(gate: string): Promise<void> {
    const session = this.requireSession();
    this.publish({ busyStage: 'qc', error: null, errorStage: null });
    // Same defense as runQc (P7-T1): no pre-try synchronous escape.
    try {
      const restoration = this.restoration();
      if (restoration.qc === null) throw new CavityStageOrderError('qc', 'shellIncomplete');
      const alreadyAck = restoration.qc.gates.filter((g) => g.acknowledged).map((g) => g.gate);
      const acknowledgedGates = Array.from(new Set([...alreadyAck, gate]));
      const payload = this.buildQcPayload(session, acknowledgedGates);
      const { report } = await this.pool().run('runInlayQc', payload);
      this.commitQc(report, 'inlay-qc-ack', { acknowledgedGate: gate, acknowledgedGates });
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

  // ---- failure surfacing + UI-only toggles ------------------------------

  private failStage(stage: CavityStage, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.publish({ busyStage: null, error: message, errorStage: stage });
  }

  clearError(): void {
    this.publish({ error: null, errorStage: null });
  }

  setFitGhostVisible(visible: boolean): void {
    this.publish({ fitGhostVisible: visible, designGeneration: useCavityStore.getState().designGeneration + 1 });
  }
}

/** The single shared cavity-design controller for the whole client. */
export const cavityDesignEngine = new CavityDesignEngine();

/** Re-exports so the panel can subscribe without importing the state modules
 * twice (mirrors crownDesign.ts's re-export style). */
export { useCavityStore };
export { useCaseStore };
