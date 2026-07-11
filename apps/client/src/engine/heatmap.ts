// apps/client/src/engine/heatmap.ts
//
// Imperative owner of the surface-distance heatmap (Task 9) — same "engine
// owns, state mirrors, ui subscribes" pattern as engine/ToolManager.ts /
// engine/caseStore.ts: this class is the sole writer of
// state/heatmapStore.ts, publishing a fresh snapshot after every state
// change; ui/SurfaceDistancePanel.tsx only ever reads that store and calls
// back into this module's exported methods.
//
// ## Why this runs on the SAME size:1 measurement pool as point/surface picks
//
// The kernel-workers `distanceHeatmap` job (packages/kernel-workers/src/
// jobs.ts) takes only the TARGET mesh's `contentHash` — it queries against
// whatever BVH is already cached under that hash on the worker it runs on
// (see jobs.ts's "Per-worker BVH cache" doc). `WorkerPool.run()` has no
// per-job worker affinity, so a `buildBvh` call and a later `distanceHeatmap`
// call for the same contentHash are only guaranteed to reuse the SAME
// worker's cache on a pool that never has more than one worker — this is
// exactly why engine/workers.ts's `getMeasurementWorkerPool()` (a dedicated
// `size: 1` pool, already used by ToolManager.ts's point/surface picks) is
// reused here too, rather than spinning up a separate pool: `run()` below
// always calls `ensureBvhBuilt` (which itself already skips a redundant
// `buildBvh` round trip once a mesh's hash has been built THIS session — see
// workers.ts's `builtBvhHashes` memo) immediately before the `distanceHeatmap`
// call on that same pool, so the job always hits a warm cache.
import { caseStore } from './caseStore';
import { computeAutoRange, distancesToVertexColors, type ColorRange } from './colormap';
import { ensureBvhBuilt, getMeasurementWorkerPool } from './workers';
import { useHeatmapStore, type HeatmapRange } from '../state/heatmapStore';

/** What ui/Viewport.tsx merges into `caseStore.getRenderNodes()`'s output
 * before handing render nodes to SceneManager — see `getActiveOverlay`'s
 * doc for why this indirection (rather than caseStore.ts importing this
 * module directly) exists. */
export interface HeatmapOverlay {
  /** The SOURCE SceneNode id (the mesh whose vertices were queried — see
   * this module's `run`) — the mesh that actually gets colored. */
  nodeId: string;
  colors: Float32Array;
}

class HeatmapEngine {
  private sourceNodeId: string | null = null;
  private distances: Float64Array | null = null;
  private colors: Float32Array | null = null;
  private manualRange: ColorRange | null = null;
  /** Bumped on every run/clear so a stale, still-in-flight `run()` call
   * (e.g. the user started a second run, or a repair/removal invalidated
   * the first before it settled) never overwrites state a NEWER call
   * already replaced — same "ignore a stale async result" pattern
   * engine/repair.ts's preview debouncing uses. */
  private generation = 0;

  /**
   * Runs the heatmap: mesh A (`sourceNodeId`)'s vertices, queried against
   * mesh B (`targetNodeId`)'s surface via the kernel BVH. Silently returns
   * (no-op) if either SceneNode/its mesh record is no longer live — mirrors
   * ToolManager.ts's `handlePick`'s tolerant handling of a stale id.
   */
  async run(sourceNodeId: string, targetNodeId: string, signed: boolean): Promise<void> {
    const document = caseStore.getDocument();
    const sourceNode = document.scene.find((node) => node.id === sourceNodeId);
    const targetNode = document.scene.find((node) => node.id === targetNodeId);
    if (!sourceNode || !targetNode) {
      return;
    }
    const sourceRecord = caseStore.getMeshRecord(sourceNode.meshId);
    const targetRecord = caseStore.getMeshRecord(targetNode.meshId);
    if (!sourceRecord || !targetRecord) {
      return;
    }

    const myGeneration = ++this.generation;
    this.sourceNodeId = sourceNodeId;
    this.manualRange = null;
    useHeatmapStore.getState().setRun({ sourceNodeId, targetNodeId, signed });

    try {
      await ensureBvhBuilt(targetNode.meshId, targetRecord.positions, targetRecord.indices);
      if (myGeneration !== this.generation) return; // superseded while awaiting

      const points = sourceRecord.positions.slice();
      const result = await getMeasurementWorkerPool().run(
        'distanceHeatmap',
        { contentHash: targetNode.meshId, points, signed },
        {
          transfer: [points.buffer],
          onProgress: (fraction) => {
            if (myGeneration === this.generation) {
              useHeatmapStore.getState().setProgress(fraction);
            }
          },
        },
      );
      if (myGeneration !== this.generation) return; // superseded while awaiting

      const range = computeAutoRange(result.distances);
      this.distances = result.distances;
      this.colors = distancesToVertexColors(result.distances, range);
      useHeatmapStore.getState().setResult({
        stats: { min: result.min, max: result.max, mean: result.mean, rms: result.rms },
        range,
      });
    } catch (error) {
      if (myGeneration !== this.generation) return; // superseded — a newer run already owns the UI state
      this.distances = null;
      this.colors = null;
      useHeatmapStore.getState().setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Toggles whether the heatmap's colors are currently applied in the
   * viewer — independent of re-running the computation (Task 9's brief:
   * "heatmap togglable per mesh pair"). */
  setVisible(visible: boolean): void {
    useHeatmapStore.getState().setVisible(visible);
  }

  /**
   * Overrides the display range (µm legend controls — ui/SurfaceDistancePanel.tsx).
   * Passing `null` reverts to the auto-computed percentile range. A no-op if
   * no run has completed yet (nothing to recolor).
   */
  setRange(range: HeatmapRange | null): void {
    if (!this.distances) {
      return;
    }
    this.manualRange = range;
    const effective = range ?? computeAutoRange(this.distances);
    this.colors = distancesToVertexColors(this.distances, effective);
    useHeatmapStore.getState().setRange(effective, range === null);
  }

  /** Clears the active heatmap entirely (e.g. the user picks a new mesh
   * pair, or either mesh is removed from the scene). */
  clear(): void {
    this.generation++;
    this.sourceNodeId = null;
    this.distances = null;
    this.colors = null;
    this.manualRange = null;
    useHeatmapStore.getState().clear();
  }

  /**
   * The currently-visible overlay (or `null` if no heatmap is active/toggled
   * off) — consumed by ui/Viewport.tsx, which merges this into
   * `caseStore.getRenderNodes()`'s output before syncing SceneManager (see
   * this module's top-of-file doc: kept out of engine/caseStore.ts itself to
   * avoid a caseStore.ts <-> heatmap.ts import cycle, since this module
   * already depends on caseStore.ts to resolve scene nodes/mesh records in
   * `run()`).
   */
  getActiveOverlay(): HeatmapOverlay | null {
    const visible = useHeatmapStore.getState().visible;
    if (!visible || !this.sourceNodeId || !this.colors) {
      return null;
    }
    return { nodeId: this.sourceNodeId, colors: this.colors };
  }

  /** TEST-ONLY: mirrors caseStore.resetForTests()'s reset-module-singleton
   * convention. */
  resetForTests(): void {
    this.generation++;
    this.sourceNodeId = null;
    this.distances = null;
    this.colors = null;
    this.manualRange = null;
    useHeatmapStore.getState().clear();
  }
}

/** Module-level singleton — same pattern as engine/ToolManager.ts's
 * `toolManager` / engine/caseStore.ts's `caseStore`. */
export const heatmapEngine = new HeatmapEngine();
