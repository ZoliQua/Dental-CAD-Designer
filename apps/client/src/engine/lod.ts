// apps/client/src/engine/lod.ts
//
// Render-LOD subsystem (Phase 2 Task 10): meshes above a triangle budget
// get a decimated RENDER copy, built off-thread by the `decimateMesh`
// worker job (packages/kernel-workers/src/jobs/decimate.ts) and attached to
// the mesh's `EngineMeshRecord` via `meshStore.setLod` — same "engine owns,
// state mirrors, ui subscribes" pattern as engine/heatmap.ts, publishing
// build status into state/lodStore.ts.
//
// ## HARD INVARIANT: kernel data of record is NEVER decimated implicitly
//
// The LOD is a separate, derived, render-only copy. The Float64
// `positions`/`indices` master buffers on an `EngineMeshRecord` are never
// replaced, mutated, or transferred by anything in this module (`.slice()`
// copies go into the worker — the masters stay attached and byte-identical;
// lod.test.ts hashes them before/after to prove it). Verified
// consumer-by-consumer (this task's brief's grep requirement — re-verify if
// a new render-copy consumer appears):
//   - `caseStore.getRenderNodes()` is the ONLY reader of any
//     `renderPositions`/`renderIndices` buffer in the whole client (grep
//     confirms) and feeds ONLY SceneManager's display path.
//   - Picking/measuring: SceneManager's Float32 raycast is candidate-finding
//     only; ToolManager.handlePick ALWAYS re-casts via the `raycastMesh`/
//     `measurePointToSurface` worker jobs against `record.positions`/
//     `record.indices` (the Float64 masters — see `ensureBvhBuilt`'s call
//     site in ToolManager.ts). With an LOD render copy active, the
//     candidate ray comes from a click on the LOD surface, but the
//     authoritative Float64 raycast still runs against the FULL-RES mesh —
//     a hit lands exactly on the true surface; a silhouette-edge miss is
//     dropped, the same (documented) way it already is for the Float32
//     full-res render copy (ToolManager.ts's "render-copy rounding" note —
//     an LOD widens that edge band from float-rounding scale to
//     `maxErrorMm` scale, but never changes what a SUCCESSFUL pick means).
//   - Sections (engine/section.ts), heatmaps (engine/heatmap.ts), curvature
//     (engine/curvature.ts), repairs (engine/repair.ts), and export
//     serialization all `.slice()` `record.positions`/`record.indices` —
//     the masters — never a render copy.
//
// ## Journaling
//
// Deliberately NOT journaled: an LOD build mutates no case geometry (the
// data of record is untouched — above) and its output is never persisted or
// exported, so CLAUDE.md invariant 3's "every destructive operation appends
// an Operation" does not apply — the same reasoning `Measurement`s are not
// journaled (see caseStore.addMeasurement's doc).
import { caseStore } from './caseStore';
import { getPool } from './workers';
import {
  lodTargetTriangleCount,
  shouldUseLod,
} from './lodPolicy';
import { useLodStore, type LodBuildStatus } from '../state/lodStore';

// Re-exported so existing consumers/tests have one obvious import site for
// the whole LOD subsystem; the definitions live in the dependency-free
// lodPolicy.ts leaf (see its module doc for why they can't live here).
export {
  RENDER_LOD_TRIANGLE_BUDGET,
  RENDER_LOD_TARGET_FRACTION,
  shouldUseLod,
  lodTargetTriangleCount,
} from './lodPolicy';

class LodEngine {
  /** contentHashes with an LOD build currently in flight — prevents
   * duplicate concurrent jobs for the same mesh. */
  private readonly building = new Set<string>();
  /** Session-lifetime build outcomes, published to state/lodStore.ts. */
  private readonly status = new Map<string, LodBuildStatus>();

  /**
   * Ensures every mesh that the CURRENT mode wants rendered as an LOD has
   * one built (or building). Called from ui/Viewport.tsx whenever the case
   * document or the LOD mode changes — idempotent and cheap when there is
   * nothing to do (every needed LOD already exists/is in flight).
   * Fire-and-forget per mesh: each build publishes its own status; the
   * render-node sync picks the LOD up on the status-driven re-render.
   */
  syncLodBuilds(): void {
    const mode = useLodStore.getState().mode;
    if (mode === 'off') return; // never build eagerly for a mode that won't render them
    for (const node of caseStore.getDocument().scene) {
      const record = caseStore.getMeshRecord(node.meshId);
      if (!record || record.lod) continue;
      const triangleCount = record.indices.length / 3;
      if (!shouldUseLod(mode, triangleCount)) continue;
      if (this.building.has(node.meshId)) continue;
      void this.buildLod(node.meshId);
    }
  }

  private async buildLod(contentHash: string): Promise<void> {
    const record = caseStore.getMeshRecord(contentHash);
    if (!record) return;
    this.building.add(contentHash);
    this.publishStatus(contentHash, 'building');
    try {
      // `.slice()` copies — the transfer below detaches THESE buffers, the
      // Float64 masters stay attached and untouched (the hard invariant;
      // same convention as workers.ts's `ensureBvhBuilt`).
      const positions = record.positions.slice();
      const indices = record.indices.slice();
      const result = await getPool().run(
        'decimateMesh',
        {
          positions,
          indices,
          targetTriangleCount: lodTargetTriangleCount(indices.length / 3),
        },
        { transfer: [positions.buffer, indices.buffer] },
      );
      const attached = caseStore.meshStore.setLod(contentHash, {
        positions: result.positions,
        indices: result.indices,
        maxErrorMm: result.maxErrorMm,
      });
      if (!attached) {
        // Mesh removed while the job ran — drop the stale result (see
        // meshStore.setLod's doc).
        this.status.delete(contentHash);
        this.publish();
        return;
      }
      this.publishStatus(contentHash, 'ready');
    } catch (error) {
      console.error('lodEngine: decimateMesh job failed', error);
      this.publishStatus(contentHash, 'error');
    } finally {
      this.building.delete(contentHash);
    }
  }

  private publishStatus(contentHash: string, status: LodBuildStatus): void {
    this.status.set(contentHash, status);
    this.publish();
  }

  private publish(): void {
    useLodStore.getState().setBuildStatus(Object.fromEntries(this.status));
  }

  /** TEST-ONLY: mirrors heatmapEngine.resetForTests()'s reset-module-
   * singleton convention. */
  resetForTests(): void {
    this.building.clear();
    this.status.clear();
    useLodStore.getState().setBuildStatus({});
    useLodStore.getState().setMode('auto');
  }
}

/** Module-level singleton — same pattern as engine/heatmap.ts's
 * `heatmapEngine`. */
export const lodEngine = new LodEngine();
