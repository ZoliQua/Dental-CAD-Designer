// apps/client/src/engine/alignment.ts
//
// Alignment tool orchestration (Phase 3 Task 3): pick 3 point pairs
// alternating between two selected meshes (reusing ToolManager.ts's
// full-res multi-mesh candidate-safety pattern — see `handlePick`'s doc),
// run coarse+ICP registration (@dqcad/kernel's register/ module, via the
// kernel-workers `icpRegister` job), preview the candidate transform as a
// ghosted overlay (SceneManager.setAlignmentPreview — NEVER touches the
// canonical SceneNode until the user explicitly confirms), and, on
// confirm, commit the transform through caseStore.applyAlignment (journaled
// as `alignment-apply`).
//
// Same "engine owns, state mirrors, ui subscribes" pattern as
// engine/ToolManager.ts / engine/heatmap.ts: this class is the sole writer
// of state/alignmentStore.ts.
//
// ## Scope limit (documented, not silently mishandled)
//
// Point-pair picks are resolved against each mesh's Float64 MASTER geometry
// (via the `raycastMesh` worker job, same as ToolManager.ts) — which is
// only meaningful while the mesh's CURRENT `SceneNode.transform` is
// identity (the master buffers are never re-baked by a transform; only
// where a node is DRAWN moves — see engine/sceneTransform.ts's module doc).
// `startPicking` therefore refuses (surfaces a translated error, does not
// silently mis-pick) to start a picking session for a src node whose
// CURRENT transform is already non-identity — re-aligning an
// already-aligned mesh a second time is out of this task's scope (YAGNI;
// the common single-alignment-pass workflow this task targets never hits
// this path).
import type { Operation, SceneNode, Vec3 } from '@dqcad/shared-types';
import { KERNEL_VERSION, type CoarsePointPair, type IcpRegisterResult, type RaycastMeshResult } from '@dqcad/kernel-workers';
import { useAlignmentStore, type AlignmentOverlapMode, type AlignmentResult } from '../state/alignmentStore';
import { caseStore } from './caseStore';
import type { EngineMeshRecord } from './meshStore';
import { renderFrameTransform } from './sceneTransform';
import { getActiveSceneManager } from './viewerController';
import { ensureBvhBuilt, getPool } from './workers';

/** Re-exported so ui/AlignmentPanel.tsx (and tests) can import the overlap-
 * mode type from this module alongside `alignmentEngine`, without also
 * needing a separate import from `state/alignmentStore.ts` just for the
 * type. */
export type { AlignmentOverlapMode };

export const ALIGNMENT_SAMPLE_COUNT = 2000;
export const ALIGNMENT_MAX_ITERATIONS = 60;

/**
 * Overlap-mode presets for `icpRefine`/`icpRegister`'s
 * `outlierRejectionFraction` (packages/kernel/src/register/icpRefine.ts's
 * `DEFAULT_OUTLIER_REJECTION_FRACTION` doc) — an ICP CORRESPONDENCE-
 * REJECTION tuning knob, not a clinical parameter, so these live here
 * (engine layer) rather than in `clinical-profiles/` (CLAUDE.md: "Clinical
 * defaults live in clinical-profiles/ only" scopes GAPS/THICKNESSES/
 * CONNECTOR AREAS drawn from a per-MATERIAL profile; this is neither — it
 * is a property of how much of TWO SCANS' surfaces genuinely correspond to
 * each other, chosen per alignment SESSION by which pair of scans is being
 * registered, with no material/tooth/restoration-type dimension at all).
 *
 * Two named presets, not a free-form slider, because the tuned value that
 * makes this repo's flagship real-fixture pair converge (0.85 —
 * scripts/kernel-ops-lib.ts's `icpRegister` golden entry: arch-case-01
 * bite0 vs. upperjaw) was previously reachable ONLY from that golden
 * script: `run()` below never set `outlierRejectionFraction` in the
 * `icpRegister` job payload at all, so every UI-driven alignment silently
 * used `icpRefine`'s library default (0.10) — which does NOT converge on a
 * partial-overlap pair like bite-vs-upperjaw (measured, per the golden
 * script's own inline comment: plateaus/drifts around 2.4mm RMS and never
 * converges, because the 90%-kept "inlier" budget is dominated by points
 * that have no genuine correspondence on the other scan at all). See
 * `state/alignmentStore.ts`'s `DEFAULT_ALIGNMENT_OVERLAP_MODE` doc for why
 * the tool defaults to the partial-overlap preset.
 */
export const OVERLAP_MODE_FULL_OUTLIER_REJECTION_FRACTION = 0.1;
export const OVERLAP_MODE_PARTIAL_OUTLIER_REJECTION_FRACTION = 0.85;

/** Maps an `AlignmentOverlapMode` to the `outlierRejectionFraction` `run()`
 * passes into the `icpRegister` job — see this module's preset-constants
 * doc above. */
export function overlapModeOutlierRejectionFraction(mode: AlignmentOverlapMode): number {
  return mode === 'full' ? OVERLAP_MODE_FULL_OUTLIER_REJECTION_FRACTION : OVERLAP_MODE_PARTIAL_OUTLIER_REJECTION_FRACTION;
}

/** Same request shape as ToolManager.ts's `MeasurePickRequest` — reused
 * verbatim so ui/Viewport.tsx can route a SceneManager `onMeasurePick`
 * event to EITHER `toolManager.handlePick` or `alignmentEngine.handlePick`
 * depending on which tool is currently active, without SceneManager needing
 * to know or care which. */
export interface AlignPickRequest {
  candidateNodeIds: readonly string[];
  rayOrigin: Vec3;
  rayDirection: Vec3;
}

const IDENTITY_TRANSFORM_16: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function isIdentityTransform(transform: readonly number[]): boolean {
  return transform.every((v, i) => v === IDENTITY_TRANSFORM_16[i]);
}

class AlignmentEngine {
  private pendingSrc: Vec3 | null = null;
  private pairs: { src: Vec3; dst: Vec3 }[] = [];

  /**
   * Begins a picking session for `srcNodeId` (to be moved) onto
   * `dstNodeId` (fixed target). Throws (does not silently start a
   * mis-picking session) if either node doesn't exist, or if `srcNodeId`'s
   * CURRENT transform is already non-identity — see this module's top-doc
   * "Scope limit".
   */
  startPicking(srcNodeId: string, dstNodeId: string): void {
    const scene = caseStore.getDocument().scene;
    const srcNode = scene.find((n) => n.id === srcNodeId);
    const dstNode = scene.find((n) => n.id === dstNodeId);
    if (!srcNode || !dstNode) {
      throw new Error('alignmentEngine.startPicking: srcNodeId/dstNodeId must reference live SceneNodes');
    }
    if (srcNodeId === dstNodeId) {
      throw new Error('alignmentEngine.startPicking: srcNodeId and dstNodeId must be different meshes');
    }
    if (!isIdentityTransform(srcNode.transform)) {
      throw new Error(
        'alignmentEngine.startPicking: the source mesh already has a non-identity transform — re-aligning an already-aligned mesh is not supported this phase',
      );
    }
    this.pendingSrc = null;
    this.pairs = [];
    useAlignmentStore.getState().startPicking(srcNodeId, dstNodeId);
  }

  /**
   * Sets the overlap-mode preset (`AlignmentOverlapMode`) that the NEXT
   * `run()` will use — see this module's `OVERLAP_MODE_*` constants and
   * `state/alignmentStore.ts`'s `DEFAULT_ALIGNMENT_OVERLAP_MODE` doc.
   * Callable at any phase (it only affects a SUBSEQUENT `run()`; there is
   * no invalid-state hazard in setting it early or mid-session) —
   * ui/AlignmentPanel.tsx only renders the selector while `phase ===
   * 'idle'`, purely to keep the choice visually grouped with the other
   * session-setup fields (mesh pickers).
   */
  setOverlapMode(mode: AlignmentOverlapMode): void {
    useAlignmentStore.getState().setOverlapMode(mode);
  }

  /** Aborts the in-progress session (any phase) without applying anything —
   * clears any active ghost preview too. */
  cancel(): void {
    this.pendingSrc = null;
    this.pairs = [];
    getActiveSceneManager()?.setAlignmentPreview(null);
    useAlignmentStore.getState().reset();
  }

  /**
   * Handles one alignment-mode click — see this module's top-of-file doc
   * for the candidate-safety re-cast (mirrors ToolManager.handlePick
   * exactly, constrained to only ACCEPT a hit on the currently-expected
   * mesh; a click landing on the wrong mesh, or missing entirely, is
   * silently ignored — same "the user just tries again" UX as
   * ToolManager.handlePick's own miss case).
   */
  async handlePick(request: AlignPickRequest): Promise<void> {
    const store = useAlignmentStore.getState();
    if (store.phase !== 'pickingPairs' || !store.srcNodeId || !store.dstNodeId) {
      return;
    }
    if (request.candidateNodeIds.length === 0) {
      return;
    }
    const expectedNodeId = this.pendingSrc === null ? store.srcNodeId : store.dstNodeId;

    const scene = caseStore.getDocument().scene;
    const candidates = request.candidateNodeIds
      .map((nodeId) => {
        const sceneNode = scene.find((n) => n.id === nodeId);
        const record = sceneNode ? caseStore.getMeshRecord(sceneNode.meshId) : undefined;
        return sceneNode && record ? { node: sceneNode, record } : null;
      })
      .filter((c): c is { node: SceneNode; record: EngineMeshRecord } => c !== null);
    if (candidates.length === 0) {
      return;
    }

    await Promise.all(
      candidates.map((c) => ensureBvhBuilt(c.node.meshId, c.record.positions, c.record.indices)),
    );
    const results = await Promise.all(
      candidates.map(async (c) => ({
        candidate: c,
        hit: await getPool().run(
          'raycastMesh',
          { contentHash: c.node.meshId, origin: request.rayOrigin, direction: request.rayDirection },
          { affinityKey: c.node.meshId },
        ),
      })),
    );
    let best: { candidate: { node: SceneNode; record: EngineMeshRecord }; hit: Extract<RaycastMeshResult, { hit: true }> } | null = null;
    for (const result of results) {
      if (!result.hit.hit) continue;
      if (!best || result.hit.distance < best.hit.distance) {
        best = { candidate: result.candidate, hit: result.hit };
      }
    }
    if (!best || best.candidate.node.id !== expectedNodeId) {
      return; // wrong mesh (or a miss) — ignored, matching this expected side's requirement
    }

    if (this.pendingSrc === null) {
      this.pendingSrc = best.hit.point;
    } else {
      this.pairs.push({ src: this.pendingSrc, dst: best.hit.point });
      this.pendingSrc = null;
    }
    useAlignmentStore.getState().recordPick(this.pairs.length, this.pendingSrc === null ? 'src' : 'dst');
  }

  /**
   * Runs coarse (from the 3 picked pairs) + ICP refinement via the
   * `icpRegister` worker job, with progress reporting, and shows the
   * resulting transform as a ghost preview — does NOT touch the canonical
   * SceneNode (see `confirm()` for that). No-op if fewer than 3 pairs have
   * been picked.
   */
  async run(): Promise<void> {
    const store = useAlignmentStore.getState();
    if (store.phase !== 'ready' || !store.srcNodeId || !store.dstNodeId || this.pairs.length !== 3) {
      return;
    }
    const scene = caseStore.getDocument().scene;
    const srcNode = scene.find((n) => n.id === store.srcNodeId);
    const dstNode = scene.find((n) => n.id === store.dstNodeId);
    const srcRecord = srcNode ? caseStore.getMeshRecord(srcNode.meshId) : undefined;
    const dstRecord = dstNode ? caseStore.getMeshRecord(dstNode.meshId) : undefined;
    if (!srcNode || !dstNode || !srcRecord || !dstRecord) {
      useAlignmentStore.getState().setError('alignmentEngine.run: source/target mesh is no longer in the scene');
      return;
    }

    useAlignmentStore.getState().setRunning();
    try {
      // `icpRegister` needs BOTH src's and dst's BVH cached on the SAME
      // worker (jobs/register.ts's module doc: "requireCachedBvh" for
      // both). `ensureBvhBuilt`'s normal per-mesh affinity (`affinityKey:
      // contentHash`) gives each mesh its OWN independently-routed worker —
      // correct for a single-mesh job (measurement/heatmap), but not
      // sufficient here: picking (`handlePick` above) may already have
      // built src's and dst's BVHs on TWO DIFFERENT workers (each raycast
      // candidate is routed independently, by design — see `handlePick`'s
      // doc). So this deliberately bypasses `ensureBvhBuilt`'s per-mesh
      // memo and issues two SEQUENTIAL `buildBvh` calls, BOTH pinned to
      // `dstNode.meshId`'s affinity key — sequential (not `Promise.all`) is
      // load-bearing: the pool only remembers an affinityKey's target
      // worker once the first call using it actually resolves, so a
      // concurrent pair could race to two different workers. A harmless,
      // occasionally-redundant rebuild (this "Run" click is a rare,
      // user-initiated action, not a hot loop) in exchange for a
      // provably-correct same-worker guarantee.
      const dstPositionsCopy = dstRecord.positions.slice();
      const dstIndicesCopy = dstRecord.indices.slice();
      await getPool().run(
        'buildBvh',
        { contentHash: dstNode.meshId, positions: dstPositionsCopy, indices: dstIndicesCopy },
        { affinityKey: dstNode.meshId, transfer: [dstPositionsCopy.buffer, dstIndicesCopy.buffer] },
      );
      const srcPositionsCopy = srcRecord.positions.slice();
      const srcIndicesCopy = srcRecord.indices.slice();
      await getPool().run(
        'buildBvh',
        { contentHash: srcNode.meshId, positions: srcPositionsCopy, indices: srcIndicesCopy },
        { affinityKey: dstNode.meshId, transfer: [srcPositionsCopy.buffer, srcIndicesCopy.buffer] },
      );

      // Journaled, not (only) internal: the seed is a real input to
      // icpRegister's deterministic sampling (CLAUDE.md invariant 2) —
      // chosen here from real entropy (same "crypto.randomUUID() for a
      // fresh id" precedent this codebase already uses elsewhere), then
      // captured verbatim in the result/journal so this exact run
      // reproduces given the same recorded inputs.
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
      const coarsePairs: CoarsePointPair[] = this.pairs.map((p) => ({ src: p.src, dst: p.dst }));

      // IMPORTANT (fix batch): previously this payload never set
      // `outlierRejectionFraction` at all, so the job silently fell back to
      // `icpRefine`'s library DEFAULT_OUTLIER_REJECTION_FRACTION (0.10) —
      // unreachable-from-the-UI territory that does NOT converge on a
      // partial-overlap pair (this module's `OVERLAP_MODE_*` doc). The
      // fraction now always flows from the store's currently-selected
      // `overlapMode` preset (`setOverlapMode`/ui/AlignmentPanel.tsx),
      // captured here so it can be echoed into `AlignmentResult` and
      // journaled verbatim on `confirm()` below.
      const overlapMode = store.overlapMode;
      const outlierRejectionFraction = overlapModeOutlierRejectionFraction(overlapMode);

      const result: IcpRegisterResult = await getPool().run(
        'icpRegister',
        {
          srcContentHash: srcNode.meshId,
          dstContentHash: dstNode.meshId,
          coarsePairs,
          sampleCount: ALIGNMENT_SAMPLE_COUNT,
          seed,
          maxIterations: ALIGNMENT_MAX_ITERATIONS,
          outlierRejectionFraction,
        },
        {
          affinityKey: dstNode.meshId,
          onProgress: (fraction) => useAlignmentStore.getState().setProgress(fraction),
        },
      );

      const alignmentResult: AlignmentResult = {
        transform: result.transform,
        rmsMm: result.rmsMm,
        inlierFraction: result.inlierFraction,
        iterations: result.iterations,
        converged: result.converged,
        seed,
        sampleCount: ALIGNMENT_SAMPLE_COUNT,
        overlapMode,
        outlierRejectionFraction,
      };
      useAlignmentStore.getState().setResult(alignmentResult);

      const worldOffset = caseStore.getRenderWorldOffset();
      getActiveSceneManager()?.setAlignmentPreview({
        nodeId: store.srcNodeId,
        transform: renderFrameTransform(result.transform, worldOffset),
      });
    } catch (error) {
      useAlignmentStore.getState().setError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Explicit user confirmation (Task 3 brief: "No silent apply") — writes
   * the previewed transform onto `srcNodeId`'s `SceneNode.transform` via
   * caseStore.applyAlignment (journaled as `alignment-apply`), clears the
   * ghost preview, and resets to idle. No-op if there is no result to
   * confirm.
   *
   * Journaling a transform-only `SceneNode` change is a deliberate, bounded
   * exception to docs/adr/002-scene-ops-not-journaled.md's general rule —
   * see that ADR's "Amendment (Phase 3): alignment-apply" section (and
   * caseStore.ts's `applyAlignment` doc) for why.
   */
  confirm(): void {
    const store = useAlignmentStore.getState();
    if (store.phase !== 'preview' || !store.result || !store.srcNodeId || !store.dstNodeId) {
      return;
    }
    const { result, srcNodeId, dstNodeId } = store;
    const scene = caseStore.getDocument().scene;
    const srcMeshId = scene.find((n) => n.id === srcNodeId)?.meshId;
    const dstMeshId = scene.find((n) => n.id === dstNodeId)?.meshId;
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'alignment-apply',
      params: {
        transform: result.transform,
        rmsMm: result.rmsMm,
        inlierFraction: result.inlierFraction,
        iterations: result.iterations,
        converged: result.converged,
        seed: result.seed,
        sampleCount: result.sampleCount,
        // Fix batch: journal WHICH overlap-mode preset produced
        // `outlierRejectionFraction` (not just the resolved fraction) so a
        // replay/audit can see the operator's actual choice — see this
        // module's `OVERLAP_MODE_*` doc.
        overlapMode: result.overlapMode,
        outlierRejectionFraction: result.outlierRejectionFraction,
      },
      inputHashes: [srcMeshId, dstMeshId].filter((hash): hash is string => hash !== undefined),
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date().toISOString(),
    };
    caseStore.applyAlignment(srcNodeId, result.transform, operation);
    getActiveSceneManager()?.setAlignmentPreview(null);
    this.pendingSrc = null;
    this.pairs = [];
    useAlignmentStore.getState().reset();
  }

  /** TEST-ONLY: mirrors caseStore.resetForTests()'s reset-module-singleton
   * convention. */
  resetForTests(): void {
    this.pendingSrc = null;
    this.pairs = [];
    useAlignmentStore.getState().reset();
  }
}

/** Module-level singleton — same pattern as engine/ToolManager.ts's
 * `toolManager` / engine/heatmap.ts's `heatmapEngine`. */
export const alignmentEngine = new AlignmentEngine();
