// apps/client/src/engine/axis.ts
//
// Imperative owner of the insertion-axis tool (Phase 3 Task 9) — same
// "engine owns, state mirrors, ui subscribes" pattern as engine/heatmap.ts/
// engine/section.ts: this class is the sole writer of state/axisStore.ts,
// publishing a fresh snapshot after every state change; ui/AxisPanel.tsx
// only ever reads that store and calls back into this module's exported
// methods. The heatmap's per-vertex COLOR buffer (Float32, render-frame)
// is kept in a PRIVATE field here, not the zustand store — see
// axisStore.ts's module doc — exposed via `getHeatmapOverlay()` for
// ui/Viewport.tsx to read directly when re-syncing SceneManager (mirrors
// engine/heatmap.ts's `getActiveOverlay`).
//
// ## Direction parameterization: standard spherical coordinates — NOT
// section.ts's yaw-then-pitch Euler composition
//
// engine/section.ts's `eulerNormalFromZ` (yaw around world Y, then pitch
// around the yaw-rotated X) is fine for a plane tool whose sliders always
// START at a world axis preset (X/Y/Z) — it never needs to represent an
// ARBITRARY starting direction handed to it from outside. THIS tool's
// sliders must initialize FROM whatever `suggestAxis` returns (an arbitrary
// unit vector), so this module uses the standard, fully round-trippable
// spherical parameterization instead (`sphericalToDirection`/
// `directionToSpherical` below): `azimuthDeg` = rotation around world Z
// (atan2(y, x)), `elevationDeg` = angle above the XY-plane (asin(z)) — a
// direction can always be converted to angles and back to the SAME
// direction (up to the poles' well-known gimbal ambiguity, where azimuth
// becomes undefined — never hit here since a real insertion axis is never
// exactly world-Z-aligned in the sense of `|z| = 1` for a a real prep).
//
// ## Live heatmap: "always fire, discard stale" — no explicit debounce
// timer
//
// Every `setAzimuthDeg`/`setElevationDeg` call immediately (fire-and-forget
// from the UI's point of view) kicks off a fresh `axisHeatmap` worker call,
// generation-guarded exactly like engine/heatmap.ts's own `run()` (a
// superseded, still-in-flight call's result is silently dropped). This
// task's report measures the real single-direction ROI scan at tens of
// milliseconds (well under the brief's <200ms adjust-loop target) — fast
// enough relative to realistic slider-drag event rates that an EXPLICIT
// debounce/throttle timer would add complexity without a measurable UX
// benefit; if a future, much larger ROI ever pushed this over budget, the
// documented fallback (per this task's brief) is a coarser interactive
// mode + a precise on-release scan, not a timer retrofit onto this same
// call site.
import { KERNEL_VERSION, type SuggestAxisCandidatePayload } from '@dqcad/kernel-workers';
import { DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM } from '@dqcad/clinical-profiles';
import type { FdiTooth, MarginAnchor, MarginLine, Operation, Restoration, Vec3 } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX } from './caseDocumentMigration';
import { ensureBvhBuilt, getPool } from './workers';
import { computeAutoRange, distancesToVertexColors } from './colormap';
import { getActiveSceneManager } from './viewerController';
import {
  useAxisStore,
  type AxisAbutmentReadout,
  type AxisBlockoutStats,
  type AxisCandidateSummary,
} from '../state/axisStore';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Standard spherical -> Cartesian unit vector: `azimuthDeg` rotates around
 * world Z (0 = +X axis), `elevationDeg` is the angle above the XY-plane
 * (+90 = +Z, -90 = -Z) — see this module's top-of-file doc for why this
 * (not section.ts's Euler composition) is used here. */
export function sphericalToDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = azimuthDeg * DEG2RAD;
  const el = elevationDeg * DEG2RAD;
  const cosEl = Math.cos(el);
  return [cosEl * Math.cos(az), cosEl * Math.sin(az), Math.sin(el)];
}

/** Inverse of `sphericalToDirection` — `direction` need not be unit length
 * (normalized internally). Degenerate ONLY at the exact poles (`|z/|v||
 * === 1`, azimuth undefined there — returns `0` for azimuth in that case,
 * an arbitrary but harmless convention, same "never actually hit for a real
 * prep axis" reasoning as this module's top-of-file doc). */
export function directionToSpherical(direction: Vec3): { azimuthDeg: number; elevationDeg: number } {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) return { azimuthDeg: 0, elevationDeg: 90 };
  const [x, y, z] = [direction[0] / len, direction[1] / len, direction[2] / len];
  const elevationDeg = Math.asin(Math.min(1, Math.max(-1, z))) * RAD2DEG;
  const azimuthDeg = Math.hypot(x, y) > 1e-12 ? Math.atan2(y, x) * RAD2DEG : 0;
  return { azimuthDeg, elevationDeg };
}

function toCandidateSummary(c: SuggestAxisCandidatePayload): AxisCandidateSummary {
  return {
    direction: c.direction,
    scoreMm3: c.scoreMm3,
    undercutAreaMm2: c.undercutAreaMm2,
    maxDepthMm: c.maxDepthMm,
    undercutTriangleCount: c.undercutTriangleCount,
  };
}

/** `true` iff `marginLine` still carries at least one UNRESOLVED anchor
 * (`triangleIndex === UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX`, `-1`) — the
 * v1->v2 migration's documented sentinel (caseDocumentMigration.ts) for an
 * anchor that hasn't been re-snapped to a real mesh triangle yet. Passing
 * such an anchor into `toMarginLoopPayload` and on into the worker job
 * indexes `mesh.indices[-3]` — `undefined`, propagating to `NaN` through the
 * ROI extraction (Task-11-review Important 6). */
function hasUnresolvedAnchor(marginLine: MarginLine): boolean {
  return marginLine.anchors.some((a) => a.triangleIndex === UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX);
}

/** A restoration's margin-bearing teeth (abutments; excludes pontics) whose
 * `marginLines` entry is both PRESENT and fully RESOLVED (no
 * `UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX` sentinel anchors) — order
 * matches `Restoration.teeth` filtered. A tooth with an unresolved margin
 * is deliberately NOT included here — see `unresolvedAbutmentTeethOf` below
 * and `AxisEngine.start`'s own doc for why that case throws a typed error
 * rather than silently omitting the tooth. */
function abutmentTeethOf(restoration: Restoration): FdiTooth[] {
  const pontics = new Set(restoration.pontics);
  return restoration.teeth.filter((tooth) => {
    if (pontics.has(tooth)) return false;
    const marginLine = restoration.marginLines[tooth];
    return marginLine !== undefined && !hasUnresolvedAnchor(marginLine);
  });
}

/** The subset of a restoration's margin-bearing teeth (abutments; excludes
 * pontics) that DO have a `marginLines` entry, but it still carries an
 * unresolved (`-1` sentinel) anchor — i.e. needs a re-snap
 * (`marginEditor.reSnapUnresolvedAnchors`) before the axis tool can use it.
 * Disjoint from `abutmentTeethOf`'s result. */
function unresolvedAbutmentTeethOf(restoration: Restoration): FdiTooth[] {
  const pontics = new Set(restoration.pontics);
  return restoration.teeth.filter((tooth) => {
    if (pontics.has(tooth)) return false;
    const marginLine = restoration.marginLines[tooth];
    return marginLine !== undefined && hasUnresolvedAnchor(marginLine);
  });
}

/** Thrown by `AxisEngine.start` when one or more of the restoration's
 * margin-bearing teeth has a margin line that still carries an unresolved
 * (`-1` sentinel) anchor — Task-11-review Important 6. Typed (not a plain
 * `Error`) so `ui/AxisPanel.tsx` can render a specific, i18n'd "re-snap
 * first" guidance instead of an untranslated raw message. */
export class AxisMarginUnresolvedError extends Error {
  readonly teeth: readonly FdiTooth[];
  constructor(teeth: readonly FdiTooth[]) {
    super(`axisEngine.start: margin line(s) for tooth/teeth ${teeth.join(', ')} still have an unresolved anchor — re-snap before using the axis tool`);
    this.name = 'AxisMarginUnresolvedError';
    this.teeth = teeth;
  }
}

/** `MarginAnchor[]` -> the worker job's `MarginSurfacePointPayload[]`
 * currency (triangleIndex + barycentric only — `position` is dropped, the
 * job re-evaluates from the mesh itself). */
function toMarginLoopPayload(anchors: readonly MarginAnchor[]): { triangleIndex: number; barycentric: readonly [number, number, number] }[] {
  return anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric }));
}

/** What ui/Viewport.tsx merges into `caseStore.getRenderNodes()`'s output
 * before handing render nodes to SceneManager — mirrors engine/heatmap.ts's
 * `HeatmapOverlay`. */
export interface AxisHeatmapOverlay {
  nodeId: string;
  colors: Float32Array;
}

class AxisEngine {
  private colors: Float32Array | null = null;
  /** Bumped on every run/clear so a stale, still-in-flight call never
   * overwrites state a NEWER call already replaced — mirrors
   * engine/heatmap.ts's own `generation` field. Shared by BOTH the
   * suggest-axis call and the live-heatmap call (a fresh `runSuggest()`
   * should also invalidate any in-flight manual-adjust heatmap request). */
  private generation = 0;

  /** Bumped on every start/clear/blockout-recompute so a stale, still-in-
   * flight `refreshBlockoutPreview()` call never overwrites state a NEWER
   * call already replaced — INDEPENDENT of `generation` above (Phase 3
   * Task 10): the blockout preview and the undercut heatmap are triggered
   * from the SAME slider-drag event and run CONCURRENTLY (see
   * `applyManualAngles`), so sharing one counter would make each call
   * spuriously invalidate the other's in-flight result. */
  private blockoutGeneration = 0;

  /** Begins (or resumes) the axis tool for `restorationId` — the
   * restoration must already have an assigned target scan AND at least one
   * confirmed margin line (Task 5), and NONE of its margin-bearing teeth
   * may have an unresolved (`-1` sentinel) anchor (Task-11-review Important
   * 6 — see `AxisMarginUnresolvedError`'s doc: an unresolved anchor
   * indexes `mesh.indices[-3]` downstream, producing a `NaN` ROI rather
   * than a clean error, if it were ever allowed through).
   * @throws {Error} if the restoration doesn't exist, has no target scan,
   * or has no confirmed margin line yet.
   * @throws {AxisMarginUnresolvedError} if one or more margin-bearing teeth
   * has a margin line with an unresolved anchor — re-snap it first
   * (`marginEditor.reSnapUnresolvedAnchors`). */
  start(restorationId: string): void {
    const restoration = this.findRestoration(restorationId);
    if (!restoration) {
      throw new Error(`axisEngine.start: no restoration registered for id ${restorationId}`);
    }
    if (!restoration.targetNodeId) {
      throw new Error('axisEngine.start: restoration has no assigned target scan yet');
    }
    const unresolvedTeeth = unresolvedAbutmentTeethOf(restoration);
    if (unresolvedTeeth.length > 0) {
      throw new AxisMarginUnresolvedError(unresolvedTeeth);
    }
    const abutmentTeeth = abutmentTeethOf(restoration);
    if (abutmentTeeth.length === 0) {
      throw new Error('axisEngine.start: restoration has no confirmed margin line yet');
    }
    this.generation++;
    this.blockoutGeneration++;
    this.colors = null;
    useAxisStore
      .getState()
      .start(restorationId, restoration.targetNodeId, abutmentTeeth, restoration.insertionAxis, DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM);
  }

  /** Runs `suggestAxis` (worker), updating the store with the winning
   * direction, ranked candidates, and a per-abutment readout AT that
   * direction. Also immediately kicks off a live heatmap recompute for the
   * new direction (fire-and-forget) so the panel's heatmap stays in sync
   * with the just-suggested axis without a separate user action. */
  async runSuggest(): Promise<void> {
    const store = useAxisStore.getState();
    const restoration = this.requireRestoration();
    const targetNodeId = store.targetNodeId;
    if (!targetNodeId) return;
    const record = this.targetRecordOrThrow(targetNodeId);

    const myGeneration = ++this.generation;
    store.setSuggesting();

    try {
      await ensureBvhBuilt(record.contentHash, record.positions, record.indices);
      if (myGeneration !== this.generation) return;

      const abutmentMarginLoops = store.abutmentTeeth.map((tooth) => toMarginLoopPayload(restoration.marginLines[tooth]!.anchors));
      const result = await getPool().run(
        'suggestAxis',
        { contentHash: record.contentHash, abutmentMarginLoops },
        {
          affinityKey: record.contentHash,
          onProgress: (fraction) => {
            if (myGeneration === this.generation) useAxisStore.getState().setSuggestProgress(fraction);
          },
        },
      );
      if (myGeneration !== this.generation) return;

      const { azimuthDeg, elevationDeg } = directionToSpherical(result.best.direction);
      const perAbutment: AxisAbutmentReadout[] = store.abutmentTeeth.map((tooth, i) => ({
        tooth,
        undercutAreaMm2: result.perAbutment[i]!.undercutAreaMm2,
        maxDepthMm: result.perAbutment[i]!.maxDepthMm,
        undercutTriangleCount: result.perAbutment[i]!.undercutTriangleCount,
        regionTriangleCount: result.regionTriangleCounts[i]!,
      }));
      useAxisStore.getState().setSuggestResult({
        direction: result.best.direction,
        azimuthDeg,
        elevationDeg,
        ranked: result.ranked.map(toCandidateSummary),
        perAbutment,
      });

      // AWAITED here (unlike the manual-adjust slider path below, which is
      // deliberately fire-and-forget): a caller of `runSuggest()` should be
      // able to trust the heatmap overlay is ready the moment this method's
      // own promise resolves, with no separate polling — the suggestion
      // call itself already dominates this method's latency, so awaiting
      // one more fast (tens of ms, this task's report) call costs nothing
      // perceptible.
      await this.refreshHeatmap();
      if (useAxisStore.getState().blockoutPreviewVisible) {
        await this.refreshBlockoutPreview();
      }
    } catch (error) {
      if (myGeneration !== this.generation) return;
      useAxisStore.getState().setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Applies a manual azimuth/elevation slider change: recomputes
   * `direction`, marks provenance `'manual'`, and kicks off a live heatmap
   * recompute (fire-and-forget, throttle-free — see this module's
   * top-of-file doc). */
  setAzimuthDeg(azimuthDeg: number): void {
    this.applyManualAngles(azimuthDeg, useAxisStore.getState().elevationDeg);
  }

  setElevationDeg(elevationDeg: number): void {
    this.applyManualAngles(useAxisStore.getState().azimuthDeg, elevationDeg);
  }

  private applyManualAngles(azimuthDeg: number, elevationDeg: number): void {
    const direction = sphericalToDirection(azimuthDeg, elevationDeg);
    useAxisStore.getState().setManualDirection({ direction, azimuthDeg, elevationDeg });
    void this.refreshHeatmap();
    if (useAxisStore.getState().blockoutPreviewVisible) {
      void this.refreshBlockoutPreview();
    }
  }

  /** Applies (selects) one of the last suggestion's other ranked
   * candidates — the panel's "try next-best axis" list. */
  async applyCandidate(candidate: AxisCandidateSummary): Promise<void> {
    const { azimuthDeg, elevationDeg } = directionToSpherical(candidate.direction);
    useAxisStore.getState().setManualDirection({ direction: candidate.direction, azimuthDeg, elevationDeg });
    await this.refreshHeatmap();
    if (useAxisStore.getState().blockoutPreviewVisible) {
      await this.refreshBlockoutPreview();
    }
  }

  setHeatmapVisible(visible: boolean): void {
    useAxisStore.getState().setHeatmapVisible(visible);
  }

  /** Blockout preview toggle (Phase 3 Task 10, "virtual wax") — turning it
   * ON always triggers a FRESH recompute at the store's current direction/
   * threshold (unlike `setHeatmapVisible`, which merely reveals an
   * already-computed color buffer: the ghost overlay may never have been
   * computed yet this session, and recomputing is cheap/idempotent — same
   * "always fire, discard stale" philosophy as the heatmap's own live
   * recompute). Turning it OFF clears the ghost overlay immediately, no
   * recompute. Returns a `Promise` (unlike `setHeatmapVisible`) so
   * callers/tests can await the overlay actually landing. */
  async setBlockoutPreviewVisible(visible: boolean): Promise<void> {
    useAxisStore.getState().setBlockoutPreviewVisible(visible);
    if (visible) {
      await this.refreshBlockoutPreview();
    } else {
      // Bumping `blockoutGeneration` here deliberately ABANDONS any
      // in-flight recompute (its eventual result must never re-show the
      // overlay after the user just hid it) — which means that in-flight
      // call's own `setBlockoutBusy(false)` will never run (its early-
      // return guard fires first). Reset busy explicitly here so the
      // panel's "(updating…)" indicator can never get stuck on.
      this.blockoutGeneration++;
      useAxisStore.getState().setBlockoutBusy(false);
      getActiveSceneManager()?.syncBlockoutPreview(null);
    }
  }

  /** Blockout threshold (mm) slider — recomputes the preview immediately
   * if it's currently visible (no-op on the ghost overlay otherwise; the
   * new threshold still lands in the store for the NEXT
   * `setBlockoutPreviewVisible(true)`, and is journaled either way on
   * `confirmAxis()`). */
  async setBlockoutThresholdMm(thresholdMm: number): Promise<void> {
    useAxisStore.getState().setBlockoutThresholdMm(thresholdMm);
    if (useAxisStore.getState().blockoutPreviewVisible) {
      await this.refreshBlockoutPreview();
    }
  }

  /** Recomputes the live undercut heatmap + per-abutment readout for the
   * store's CURRENT `direction` — see this module's top-of-file doc for why
   * this has no explicit debounce timer. A no-op (silently) if the tool
   * isn't active or the mesh record is gone (mirrors engine/heatmap.ts's
   * tolerant handling of a stale target). */
  private async refreshHeatmap(): Promise<void> {
    const store = useAxisStore.getState();
    if (store.status !== 'active' && store.status !== 'suggesting') return;
    const targetNodeId = store.targetNodeId;
    if (!targetNodeId) return;
    const record = caseStore.getMeshRecord(this.targetContentHashOf(targetNodeId) ?? '');
    if (!record) return;
    const restoration = this.findRestoration(store.restorationId ?? '');
    if (!restoration) return;

    const myGeneration = ++this.generation;
    useAxisStore.getState().setHeatmapBusy(true);

    try {
      await ensureBvhBuilt(record.contentHash, record.positions, record.indices);
      if (myGeneration !== this.generation) return;

      const abutmentMarginLoops = store.abutmentTeeth.map((tooth) => toMarginLoopPayload(restoration.marginLines[tooth]!.anchors));
      const result = await getPool().run(
        'axisHeatmap',
        { contentHash: record.contentHash, abutmentMarginLoops, direction: store.direction },
        { affinityKey: record.contentHash },
      );
      if (myGeneration !== this.generation) return;

      this.colors = this.buildVertexColors(record.positions.length / 3, record.indices, result.triangleIndices, result.undercut, result.depthMm);

      // Per-abutment readout at the LIVE direction (independent of a
      // suggestion having run — a manual-only session still gets numbers
      // too) — the job itself computes this per abutment (jobs/axis.ts's
      // `AxisHeatmapResult.perAbutment`), same order as `abutmentTeeth`.
      //
      // `undercutAreaMm2` is NOT one of the fields `axisHeatmap` computes
      // (jobs/axis.ts's own doc — a live single-direction preview never
      // computes area; only `suggestAxis` does, per abutment, at its
      // winning direction). Previously this overwrote every abutment's area
      // with a hardcoded `0` on every heatmap recompute — including the
      // ONE `runSuggest()` fires automatically right after populating the
      // real value (see `runSuggest()`'s own doc: it awaits
      // `refreshHeatmap()` so the panel's heatmap stays in sync) — so the
      // panel's "Undercut area" column always read a fabricated zero the
      // instant a suggestion finished (Task-11-review Critical 1). Fixed by
      // CARRYING FORWARD whatever area was already known for that tooth
      // (from the last `runSuggest()`, if any this session) instead of
      // clobbering it — the heatmap refresh only ever UPDATES the fields it
      // actually measures (depth/triangle counts); area only ever changes
      // when a fresh suggestion runs. `apps/client/src/ui/AxisPanel.tsx`
      // notes this staleness explicitly (`axis.abutmentAreaNote`) so the
      // clinician never reads it as a live number.
      const priorPerAbutment = useAxisStore.getState().perAbutment;
      const perAbutment: AxisAbutmentReadout[] = store.abutmentTeeth.map((tooth, i) => ({
        tooth,
        undercutAreaMm2: priorPerAbutment.find((p) => p.tooth === tooth)?.undercutAreaMm2 ?? 0,
        maxDepthMm: result.perAbutment[i]!.maxDepthMm,
        undercutTriangleCount: result.perAbutment[i]!.undercutTriangleCount,
        regionTriangleCount: result.perAbutment[i]!.regionTriangleCount,
      }));
      useAxisStore.getState().setHeatmapResult({ perAbutment });
    } catch {
      if (myGeneration !== this.generation) return;
      useAxisStore.getState().setHeatmapBusy(false);
    }
  }

  /** Recomputes the undercut blockout PREVIEW ghost overlay (Phase 3 Task
   * 10, "virtual wax") for the store's CURRENT direction/threshold — see
   * `blockoutGeneration`'s own doc for why this uses an INDEPENDENT
   * staleness counter from `refreshHeatmap`'s `generation`. A no-op
   * (silently) if the tool isn't active or the mesh record is gone (mirrors
   * `refreshHeatmap`'s own tolerant handling). Pushes the result STRAIGHT
   * to `SceneManager.syncBlockoutPreview` (not a pull-based
   * `getXOverlay()`, unlike the heatmap's per-vertex COLOR overlay) — same
   * "engine computes, SceneManager just draws whatever it's given" push
   * pattern as `engine/alignment.ts`'s ICP ghost preview (this task's
   * brief's own named precedent), because this overlay is a freshly
   * GENERATED small patch mesh, not a per-vertex color layer on an
   * existing render entry.
   */
  private async refreshBlockoutPreview(): Promise<void> {
    const store = useAxisStore.getState();
    if (store.status !== 'active' && store.status !== 'suggesting') return;
    const targetNodeId = store.targetNodeId;
    if (!targetNodeId) return;
    const record = caseStore.getMeshRecord(this.targetContentHashOf(targetNodeId) ?? '');
    if (!record) return;
    const restoration = this.findRestoration(store.restorationId ?? '');
    if (!restoration) return;

    const myGeneration = ++this.blockoutGeneration;
    useAxisStore.getState().setBlockoutBusy(true);

    try {
      await ensureBvhBuilt(record.contentHash, record.positions, record.indices);
      if (myGeneration !== this.blockoutGeneration) return;

      const abutmentMarginLoops = store.abutmentTeeth.map((tooth) => toMarginLoopPayload(restoration.marginLines[tooth]!.anchors));
      const result = await getPool().run(
        'blockoutPreview',
        {
          contentHash: record.contentHash,
          abutmentMarginLoops,
          direction: store.direction,
          thresholdMm: store.blockoutThresholdMm,
        },
        { affinityKey: record.contentHash },
      );
      if (myGeneration !== this.blockoutGeneration) return;

      const stats: AxisBlockoutStats = {
        blockoutTriangleCount: result.blockoutTriangleCount,
        vertexCount: result.vertexCount,
        maxDisplacementMm: result.maxDisplacementMm,
        approxVolumeMm3: result.approxVolumeMm3,
      };
      useAxisStore.getState().setBlockoutResult(stats);

      if (result.previewIndices.length === 0) {
        getActiveSceneManager()?.syncBlockoutPreview(null);
      } else {
        // Float64 world/case-frame -> Float32 render-frame (worldOffset
        // subtracted) — the SAME conversion engine/meshStore.ts's `setLod`
        // applies to every other kernel-generated Float64 mesh output; see
        // that method's doc for why (float precision far from the world
        // origin, CLAUDE.md's render-copy convention).
        const [ox, oy, oz] = caseStore.getRenderWorldOffset();
        const renderPositions = new Float32Array(result.previewPositions.length);
        for (let v = 0; v < result.previewPositions.length / 3; v++) {
          renderPositions[v * 3] = result.previewPositions[v * 3]! - ox;
          renderPositions[v * 3 + 1] = result.previewPositions[v * 3 + 1]! - oy;
          renderPositions[v * 3 + 2] = result.previewPositions[v * 3 + 2]! - oz;
        }
        getActiveSceneManager()?.syncBlockoutPreview({ positions: renderPositions, indices: result.previewIndices });
      }
    } catch {
      // Mirrors `refreshHeatmap`'s own tolerant catch: a failed blockout
      // recompute (e.g. a stale mesh mid-teardown) just clears the busy
      // flag, same "best-effort live preview" precedent — it must never
      // clobber the tool's primary suggest/heatmap error state.
      if (myGeneration !== this.blockoutGeneration) return;
      useAxisStore.getState().setBlockoutBusy(false);
    }
  }

  /** Per-triangle depth -> per-VERTEX color mapping (documented, per this
   * task's brief): a vertex's displayed depth is the MAXIMUM `depthMm`
   * over every ROI triangle incident to it (0 for a vertex with no
   * incident ROI triangle, or none undercut) — conservative/worst-case,
   * consistent with undercutScan.ts's own "corners sampling never
   * under-reports relative to centroid" philosophy: a shared-edge vertex
   * between a deep-undercut triangle and a shallow one shows the DEEPER
   * value, so a user never underestimates how bad an area is by looking at
   * its edge. Colors reuse engine/colormap.ts's existing diverging
   * blue(0)->white->red(max) unsigned-distance mapping (percentile
   * auto-range) — the SAME function the surface-distance heatmap uses,
   * just fed depth-in-mm instead of distance-in-mm (both are non-negative
   * "how far/deep" mm quantities, so the mapping is directly reusable
   * without kernel changes — CLAUDE.md: "colormap math in engine — no
   * kernel dependency on colors").
   */
  private buildVertexColors(
    vertexCount: number,
    indices: Uint32Array,
    triangleIndices: Uint32Array,
    undercut: Uint8Array,
    depthMm: Float64Array,
  ): Float32Array {
    const vertexDepth = new Float64Array(vertexCount); // 0-init
    for (let i = 0; i < triangleIndices.length; i++) {
      if (undercut[i] !== 1) continue;
      const t = triangleIndices[i]!;
      const depth = depthMm[i]!;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]!;
        if (depth > vertexDepth[v]!) vertexDepth[v] = depth;
      }
    }
    const range = computeAutoRange(vertexDepth);
    return distancesToVertexColors(vertexDepth, range);
  }

  /** Live overlay for ui/Viewport.tsx — `null` when the heatmap is off or
   * nothing has been computed yet. Mirrors engine/heatmap.ts's
   * `getActiveOverlay`. */
  getHeatmapOverlay(): AxisHeatmapOverlay | null {
    const store = useAxisStore.getState();
    if (!store.heatmapVisible || !store.targetNodeId || !this.colors) return null;
    return { nodeId: store.targetNodeId, colors: this.colors };
  }

  /** Journals `axis-set`: stamps `insertionAxis` on the restoration with
   * the store's current `direction`, recording full provenance (suggestion
   * source, params, score) in the Operation — this task's brief. No
   * geometry hash (this op mutates case-document bookkeeping only, same
   * "empty inputHashes/outputHashes" precedent as
   * engine/restorations.ts's `restoration-create`/`-update`).
   *
   * `params.blockout` (Phase 3 Task 10): the blockout preview's CURRENT
   * threshold/visibility, plus the last measured readout (if a preview has
   * been computed this session) — journaled REGARDLESS of whether the
   * preview toggle is currently on, so a replay/audit can see what
   * threshold the clinician was working with even if they later hid the
   * overlay before confirming. Display-only bookkeeping (see
   * `@dqcad/kernel`'s `blockoutPreview.ts` module doc for the scope
   * boundary) — no geometry hash here either, same reasoning as the rest
   * of this op.
   * @throws {Error} if the tool isn't active.
   */
  confirmAxis(): void {
    const store = useAxisStore.getState();
    if (!store.restorationId) {
      throw new Error('axisEngine.confirmAxis: no active session');
    }
    const restoration = this.requireRestoration();
    const next: Restoration = { ...restoration, insertionAxis: store.direction };
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'axis-set',
      params: {
        restorationId: restoration.id,
        axis: store.direction,
        source: store.source,
        azimuthDeg: store.azimuthDeg,
        elevationDeg: store.elevationDeg,
        ranked: store.ranked.slice(0, 5), // top-5 provenance — full list is worker-session-only, not journal-worthy
        abutmentTeeth: store.abutmentTeeth,
        blockout: {
          thresholdMm: store.blockoutThresholdMm,
          previewVisible: store.blockoutPreviewVisible,
          ...(store.blockoutStats
            ? {
                blockoutTriangleCount: store.blockoutStats.blockoutTriangleCount,
                maxDisplacementMm: store.blockoutStats.maxDisplacementMm,
                approxVolumeMm3: store.blockoutStats.approxVolumeMm3,
              }
            : {}),
        },
      },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date().toISOString(),
    };
    caseStore.updateRestoration(next, operation);
    useAxisStore.getState().setConfirmed(true);
  }

  clear(): void {
    this.generation++;
    this.blockoutGeneration++;
    this.colors = null;
    getActiveSceneManager()?.syncBlockoutPreview(null);
    useAxisStore.getState().reset();
  }

  resetForTests(): void {
    this.clear();
  }

  private requireRestoration(): Restoration {
    const restorationId = useAxisStore.getState().restorationId;
    const restoration = restorationId ? this.findRestoration(restorationId) : undefined;
    if (!restoration) throw new Error('axisEngine: no active session');
    return restoration;
  }

  private findRestoration(restorationId: string): Restoration | undefined {
    return caseStore.getDocument().restorations.find((r) => r.id === restorationId);
  }

  private targetContentHashOf(targetNodeId: string): string | undefined {
    return caseStore.getDocument().scene.find((n) => n.id === targetNodeId)?.meshId;
  }

  private targetRecordOrThrow(targetNodeId: string) {
    const meshId = this.targetContentHashOf(targetNodeId);
    const record = meshId ? caseStore.getMeshRecord(meshId) : undefined;
    if (!record) throw new Error('axisEngine: target mesh record not found');
    return record;
  }
}

/** Module-level singleton — same pattern as engine/heatmap.ts's
 * `heatmapEngine`. */
export const axisEngine = new AxisEngine();
