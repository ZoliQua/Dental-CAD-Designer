// apps/client/src/engine/ToolManager.ts
//
// Measurement tool state machine: point-to-point (2 picks), point-to-surface
// (1 pick on surface A + 1 pick selecting target surface B), angle (3
// picks, vertex = the SECOND pick). Owns NO Three.js/DOM state itself (that
// stays in engine/SceneManager.ts, per this file's boundary — SceneManager
// only ever hands this module a candidate mesh id + a world-space ray; see
// `MeasurePickRequest`'s doc) — this is the imperative, non-React
// counterpart to state/toolStore.ts (which it publishes into after every
// state change, same "engine owns, state mirrors, ui subscribes" pattern as
// engine/caseStore.ts).
//
// ## Why the authoritative pick point (AND mesh) always comes from a worker job
//
// This task's brief's critical correctness point: a measurement pick point
// MUST be the Float64 world-space intersection against the mesh's real
// (post-intake, welded) geometry — never the Three.js/Float32 render-copy
// raycast SceneManager uses for on-screen candidate selection. SceneManager
// tells this module WHAT ray a click fired (`MeasurePickRequest.rayOrigin`/
// `rayDirection`, in world-space mm, converted from the render-copy's
// re-centered frame by re-adding `meshStore`'s world offset — see
// SceneManager.ts's `pickAtClientPosition`) and WHICH meshes are even
// visible/plausible (`candidateNodeIds`) — but, since Phase 2 Task 10's LOD
// fix batch, NOT which one of them the ray actually hits: in a multi-mesh
// scene an LOD's decimated silhouette can differ enough from its true
// Float64 surface that trusting a single Three.js-nearest "candidate" could
// silently resolve a measurement against the WRONG mesh (see
// `MeasurePickCandidate`'s doc in SceneManager.ts). `handlePick` below
// therefore re-casts the SAME ray against EVERY candidate's Float64 master
// via the `raycastMesh` worker job (packages/kernel-workers) and keeps only
// the globally nearest TRUE intersection — both the mesh identity AND the
// point stored in a `Measurement` are always exact, never a Float32-rounded
// or LOD-silhouette-driven approximation.
import type { Measurement, MeasurementKind, MeasurementPoint, SceneNode, Vec3 } from '@dqcad/shared-types';
import type { RaycastMeshResult } from '@dqcad/kernel-workers';
import { useToolStore } from '../state/toolStore';
import { caseStore } from './caseStore';
import type { EngineMeshRecord } from './meshStore';
import { ensureBvhBuilt, getMeasurementWorkerPool } from './workers';

/** How many surface points each measurement kind needs before it's complete
 * — see this module's top-of-file doc for what each pick means per kind.
 * Exported so ui/MeasureToolbar.tsx can render an accurate "pick N of M"
 * instructional hint without duplicating this table. */
export const REQUIRED_POINT_COUNT: Record<MeasurementKind, number> = {
  pointToPoint: 2,
  pointToSurface: 2,
  angle: 3,
};

/** What SceneManager hands `handlePick` for one measurement-mode click —
 * see this module's top-of-file doc for why this is a RAY + a candidate
 * SET, not a resolved point/mesh: SceneManager's render pass never supplies
 * the final point, and (since the LOD pick-safety fix) it no longer even
 * tries to resolve which candidate mesh the ray "really" hits — that
 * decision requires the Float64 masters, which only `handlePick` (via the
 * `raycastMesh` worker job) touches. */
export interface MeasurePickRequest {
  /** Every currently visible SceneNode id — see SceneManager.ts's
   * `MeasurePickCandidate.candidateNodeIds` doc. `handlePick` re-casts
   * against every one of these and keeps only the globally nearest TRUE
   * hit. */
  candidateNodeIds: readonly string[];
  /** World-space (Float64 mm, NOT the render-copy's re-centered frame) ray
   * origin/direction. */
  rayOrigin: Vec3;
  rayDirection: Vec3;
}

function distanceMm(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Angle (degrees, in [0, 180]) at `vertex` between rays toward `a` and `c`.
 * Returns `NaN` if either ray is degenerate (a/c coincides with the vertex —
 * e.g. the user picked the same point twice) rather than throwing:
 * formatMm-adjacent display code (ui/MeasurementPanel.tsx) already has to
 * handle non-finite values (see formatMm.ts's NaN/Infinity placeholder), so
 * reusing that path here is simpler than inventing a separate error state
 * for one degenerate geometric case. */
function angleDegrees(a: Vec3, vertex: Vec3, c: Vec3): number {
  const v1: Vec3 = [a[0] - vertex[0], a[1] - vertex[1], a[2] - vertex[2]];
  const v2: Vec3 = [c[0] - vertex[0], c[1] - vertex[1], c[2] - vertex[2]];
  const len1 = Math.hypot(v1[0], v1[1], v1[2]);
  const len2 = Math.hypot(v2[0], v2[1], v2[2]);
  if (len1 === 0 || len2 === 0) {
    return NaN;
  }
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const cos = Math.min(1, Math.max(-1, dot / (len1 * len2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

class ToolManagerEngine {
  private pending: MeasurementPoint[] = [];

  /** Begins a new measurement of `kind` — discards any in-progress (not yet
   * completed) picks from a previously active tool. */
  startTool(kind: MeasurementKind): void {
    this.pending = [];
    const store = useToolStore.getState();
    store.setActiveTool(kind);
    store.setPendingPointCount(0);
    store.setError(null);
  }

  /** Aborts the in-progress measurement (if any) without recording
   * anything — returns to "no tool active" (ordinary click-to-select mode). */
  cancelTool(): void {
    this.pending = [];
    const store = useToolStore.getState();
    store.setActiveTool(null);
    store.setPendingPointCount(0);
    store.setBusy(false);
    store.setError(null);
  }

  /**
   * Handles one measurement-mode click — see `MeasurePickRequest`'s doc.
   * Ignored (not an error) if no tool is active or a previous pick's worker
   * round trip hasn't settled yet (`useToolStore`'s `busy` flag) — a rapid
   * double-click during the async gap simply drops the second click rather
   * than racing two in-flight picks against the same in-progress
   * measurement.
   */
  async handlePick(request: MeasurePickRequest): Promise<void> {
    const store = useToolStore.getState();
    const kind = store.activeTool;
    if (!kind || store.busy) {
      return;
    }

    if (request.candidateNodeIds.length === 0) {
      return; // SceneManager had no visible mesh to offer as a candidate.
    }
    const scene = caseStore.getDocument().scene;
    const candidates = request.candidateNodeIds
      .map((nodeId) => {
        const sceneNode = scene.find((n) => n.id === nodeId);
        const record = sceneNode ? caseStore.getMeshRecord(sceneNode.meshId) : undefined;
        return sceneNode && record ? { node: sceneNode, record } : null;
      })
      .filter((c): c is { node: SceneNode; record: EngineMeshRecord } => c !== null);
    if (candidates.length === 0) {
      return; // Stale pick — every candidate node/mesh was removed between the click and this call.
    }

    useToolStore.getState().setBusy(true);
    try {
      // Authoritative candidate-mesh resolution (LOD pick-safety fix — see
      // `MeasurePickRequest`'s and SceneManager.ts's `MeasurePickCandidate`'s
      // docs): cast the SAME ray against EVERY candidate's Float64 master,
      // and keep only the globally NEAREST true intersection. A wrong/extra
      // candidate is harmless by construction — its own true raycast either
      // misses outright or lands farther away than the real target's hit.
      await Promise.all(
        candidates.map((c) => ensureBvhBuilt(c.node.meshId, c.record.positions, c.record.indices)),
      );
      const results = await Promise.all(
        candidates.map(async (c) => ({
          candidate: c,
          hit: await getMeasurementWorkerPool().run('raycastMesh', {
            contentHash: c.node.meshId,
            origin: request.rayOrigin,
            direction: request.rayDirection,
          }),
        })),
      );
      let best: {
        candidate: { node: SceneNode; record: EngineMeshRecord };
        hit: Extract<RaycastMeshResult, { hit: true }>;
      } | null = null;
      for (const result of results) {
        if (!result.hit.hit) continue;
        if (!best || result.hit.distance < best.hit.distance) {
          best = { candidate: result.candidate, hit: result.hit };
        }
      }
      if (!best) {
        // No candidate's TRUE surface was actually hit by this ray — can
        // happen right at a silhouette edge (render-copy/float rounding —
        // the same, much smaller-scale case already documented), or simply
        // because every visible mesh's on-screen silhouette merely LOOKED
        // close to the cursor — drop this pick; the user just tries the
        // click again.
        return;
      }
      const { node } = best.candidate;
      const hit = best.hit;

      if (kind === 'pointToSurface' && this.pending.length === 1) {
        // Second pick for point-to-surface SELECTS THE TARGET SURFACE
        // (mesh B) — the measured value is the closest point on B's WHOLE
        // surface to the first pick, not this click's exact position (this
        // task's brief: "point-to-surface (pick point on mesh A, target
        // mesh B)").
        const first = this.pending[0]!;
        const closest = await getMeasurementWorkerPool().run('measurePointToSurface', {
          contentHash: node.meshId,
          point: first.position,
        });
        this.pending.push({ nodeId: node.id, position: closest.point });
      } else {
        this.pending.push({ nodeId: node.id, position: hit.point });
      }

      useToolStore.getState().setPendingPointCount(this.pending.length);
      if (this.pending.length >= REQUIRED_POINT_COUNT[kind]) {
        this.finalize(kind);
      }
    } catch (error) {
      useToolStore.getState().setError(error instanceof Error ? error.message : String(error));
      this.pending = [];
      useToolStore.getState().setPendingPointCount(0);
    } finally {
      useToolStore.getState().setBusy(false);
    }
  }

  /** Computes the measurement value, records it in caseStore, and returns
   * to "no tool active" — a subsequent measurement of the same kind
   * requires the user to invoke `startTool` again (a simple, deliberately
   * non-"repeat mode" UX for this task's scope). */
  private finalize(kind: MeasurementKind): void {
    const points = this.pending;
    const value =
      kind === 'angle'
        ? angleDegrees(points[0]!.position, points[1]!.position, points[2]!.position)
        : distanceMm(points[0]!.position, points[1]!.position);

    const measurement: Measurement = {
      id: crypto.randomUUID(),
      kind,
      points,
      value,
      createdAt: new Date().toISOString(),
    };
    caseStore.addMeasurement(measurement);

    this.pending = [];
    const store = useToolStore.getState();
    store.setActiveTool(null);
    store.setPendingPointCount(0);
  }

  /** TEST-ONLY: mirrors caseStore.resetForTests()'s reset-module-singleton
   * convention. */
  resetForTests(): void {
    this.pending = [];
    const store = useToolStore.getState();
    store.setActiveTool(null);
    store.setPendingPointCount(0);
    store.setBusy(false);
    store.setError(null);
  }
}

/** Module-level singleton — same pattern as engine/caseStore.ts's
 * `caseStore` / engine/workers.ts's lazily constructed pool. */
export const toolManager = new ToolManagerEngine();
