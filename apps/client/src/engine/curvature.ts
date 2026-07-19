// apps/client/src/engine/curvature.ts
//
// Imperative owner of the per-vertex curvature overlay (Phase 2 Task 3) —
// same "engine owns, state mirrors, ui subscribes" pattern as
// engine/heatmap.ts (see that file's module doc for the full convention);
// this class is the sole writer of state/curvatureStore.ts.
//
// Scaffolding for Phase 3's margin-ridge detection (which will consume the
// SAME H/K per-vertex arrays this overlay already computes) — kept minimal
// per this task's brief: one mesh, one scalar field (H or K) at a time, no
// filtering/smoothing/ridge-extraction here (YAGNI — Phase 3's job).
import { caseStore } from './caseStore';
import { computeAutoRange, distancesToVertexColors, type ColorRange } from './colormap';
import { ensureBvhBuilt, getPool } from './workers';
import { useCurvatureStore, type CurvatureField, type CurvatureRange } from '../state/curvatureStore';

export interface CurvatureOverlay {
  nodeId: string;
  colors: Float32Array;
}

function summarize(values: Float64Array): { min: number; max: number; mean: number } {
  if (values.length === 0) return { min: 0, max: 0, mean: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / values.length };
}

class CurvatureEngine {
  private nodeId: string | null = null;
  private values: Float64Array | null = null;
  private colors: Float32Array | null = null;
  private manualRange: ColorRange | null = null;
  /** Bumped on every run/clear — see engine/heatmap.ts's identical
   * `generation` doc for why a stale in-flight run must never clobber a
   * newer one. */
  private generation = 0;

  /**
   * Runs `computeCurvature` (packages/kernel-workers' job, wrapping
   * @dqcad/kernel's curvature/ module) against `nodeId`'s CURRENT mesh, then
   * colors it by `field` (H or K) via the SAME colormap path
   * engine/heatmap.ts uses (colormap.ts's functions are generic over "a
   * Float64Array of values", not heatmap-specific, despite their naming).
   * Silently returns (no-op) if the SceneNode/its mesh record is no longer
   * live — mirrors heatmap.ts's `run`'s identical tolerant handling.
   *
   * Boundary-vertex values are 0 by the kernel's documented flag-and-exclude
   * policy (packages/kernel/src/curvature/curvature.ts) — this dev overlay
   * does NOT filter them out (Phase 3's job, once margin/ridge detection
   * needs a real interior-only display policy), so a scan's boundary rim
   * shows up as the colormap's midpoint regardless of its true (unmeasured)
   * curvature.
   *
   * `ensureBvhBuilt` + `affinityKey: contentHash` (same convention as
   * workers.ts's own BVH-cache-affinity doc): the `computeCurvature` job
   * caches its result per-worker, keyed by `contentHash` (jobs/curvature.ts's
   * module doc) — routing this call to the SAME affinity-pinned worker a
   * prior `computeCurvature`/BVH-cache call for this mesh used is what makes
   * a repeat run (e.g. toggling H then back to H) hit that cache instead of
   * recomputing.
   */
  async run(nodeId: string, field: CurvatureField): Promise<void> {
    const document = caseStore.getDocument();
    const node = document.scene.find((n) => n.id === nodeId);
    if (!node) return;
    const record = caseStore.getMeshRecord(node.meshId);
    if (!record) return;

    const myGeneration = ++this.generation;
    this.nodeId = nodeId;
    this.manualRange = null;
    useCurvatureStore.getState().setRun({ nodeId, field });

    try {
      await ensureBvhBuilt(record.contentHash, record.positions, record.indices);
      const result = await getPool().run(
        'computeCurvature',
        { contentHash: record.contentHash },
        {
          affinityKey: record.contentHash,
          onProgress: (fraction) => {
            if (myGeneration === this.generation) {
              useCurvatureStore.getState().setProgress(fraction);
            }
          },
        },
      );
      if (myGeneration !== this.generation) return; // superseded while awaiting

      const values = field === 'H' ? result.H : result.K;
      const range = computeAutoRange(values);
      this.values = values;
      this.colors = distancesToVertexColors(values, range);
      useCurvatureStore.getState().setResult({ stats: summarize(values), range });
    } catch (error) {
      if (myGeneration !== this.generation) return; // superseded — a newer run already owns the UI state
      this.values = null;
      this.colors = null;
      useCurvatureStore.getState().setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Toggles whether the overlay's colors are currently applied in the
   * viewer — independent of re-running the computation. */
  setVisible(visible: boolean): void {
    useCurvatureStore.getState().setVisible(visible);
  }

  /** Overrides the display range — `null` reverts to the auto-computed
   * percentile range. A no-op if no run has completed yet. */
  setRange(range: CurvatureRange | null): void {
    if (!this.values) return;
    this.manualRange = range;
    const effective = range ?? computeAutoRange(this.values);
    this.colors = distancesToVertexColors(this.values, effective);
    useCurvatureStore.getState().setRange(effective, range === null);
  }

  /** Clears the active overlay entirely (e.g. the user picks a different
   * mesh, or the colored mesh is removed from the scene). */
  clear(): void {
    this.generation++;
    this.nodeId = null;
    this.values = null;
    this.colors = null;
    this.manualRange = null;
    useCurvatureStore.getState().clear();
  }

  /** The currently-visible overlay (or `null` if inactive/toggled off) —
   * consumed by ui/Viewport.tsx, merged into `caseStore.getRenderNodes()`'s
   * output the SAME way engine/heatmap.ts's `getActiveOverlay` is (see that
   * file's doc for why this indirection lives in Viewport.tsx rather than
   * engine/caseStore.ts). */
  getActiveOverlay(): CurvatureOverlay | null {
    const visible = useCurvatureStore.getState().visible;
    if (!visible || !this.nodeId || !this.colors) {
      return null;
    }
    return { nodeId: this.nodeId, colors: this.colors };
  }

  /** TEST-ONLY: mirrors engine/heatmap.ts's `resetForTests`. */
  resetForTests(): void {
    this.generation++;
    this.nodeId = null;
    this.values = null;
    this.colors = null;
    this.manualRange = null;
    useCurvatureStore.getState().clear();
  }
}

/** Module-level singleton — same pattern as engine/heatmap.ts's
 * `heatmapEngine`. */
export const curvatureEngine = new CurvatureEngine();
