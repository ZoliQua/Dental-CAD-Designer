// apps/client/src/engine/section.ts
//
// Imperative owner of the cross-section tool (Task 10) — same "engine owns,
// state mirrors, ui subscribes" pattern as engine/heatmap.ts/
// engine/ToolManager.ts: this class is the sole writer of
// state/sectionStore.ts, publishing a fresh snapshot after every state
// change; ui/SectionPanel.tsx only ever reads that store and calls back
// into this module's exported methods. The actual outline/cap geometry
// (Float32, render-frame) is kept in PRIVATE fields here, not the zustand
// store — see sectionStore.ts's module doc — exposed via `getOutline`/
// `getCaps`/`getClipPlane` for ui/Viewport.tsx to read directly when
// re-syncing SceneManager (mirroring engine/heatmap.ts's
// `getActiveOverlay`).
//
// ## Why this runs on the GENERAL pool, not the size:1 measurement pool
//
// Unlike measurePointToSurface/raycastMesh/distanceHeatmap (which query a
// per-worker-CACHED BVH — see engine/workers.ts's module doc), the
// `sectionMesh` job takes the mesh buffers directly and does one bounded
// pass over the whole mesh with no cross-call cache to keep warm (see
// kernel-workers' jobs/section.ts `sectionMesh` job doc) — there is no "build once,
// query many times on the SAME worker" requirement here, so pinning it to a
// single-worker pool would only serialize section runs against every other
// measurement pool user for no correctness benefit. A case with multiple
// scene nodes (e.g. upper + lower jaw) sections EVERY visible node in one
// `recompute()` call — running those on the general (multi-worker) pool
// lets them execute in parallel.
//
// ## Plane construction: axis presets + arbitrary plane sliders
//
// The active plane is always `anchor (scene bbox center) + offsetMm *
// normal`, where `normal` is an axis preset (X/Y/Z, this task's brief) OR
// (for 'custom') the Z axis rotated by `yawDeg` (around world Y) then
// `pitchDeg` (around the yaw-rotated X) — the brief's "position along
// normal via slider + rotation via two angle sliders". Recomputed from
// scratch on every UI change (never incrementally adjusted), since the
// anchor itself (the scene bbox center) can shift between calls (a mesh
// added/removed/hidden) and re-deriving it fresh is far simpler than
// tracking staleness.
import { caseStore } from './caseStore';
import { getPool } from './workers';
import {
  useSectionStore,
  type SectionAxis,
  type SectionPlaneSummary,
} from '../state/sectionStore';
import { sectionToSvg, type SectionSvgPolyline } from '@dqcad/kernel-workers';

type Vec3 = readonly [number, number, number];

export interface SectionOutlineRender {
  points: Float32Array;
  closed: boolean;
}

export interface SectionCapRender {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SectionClipPlaneRender {
  normal: Vec3;
  /** Three.js `Plane` convention — see SceneManager.ts's
   * `RenderFrameClipPlane` doc. */
  constant: number;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Union bbox center (Float64 mm, world/kernel frame) across every VISIBLE
 * scene node's mesh record — the anchor axis presets and the arbitrary
 * plane's `offsetMm` slider are both measured from. Falls back to the
 * origin when there are no visible meshes (an inert-but-valid anchor: the
 * tool simply has nothing to section). */
function visibleSceneBboxCenter(): Vec3 {
  const document = caseStore.getDocument();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const node of document.scene) {
    if (!node.visible) continue;
    const record = caseStore.getMeshRecord(node.meshId);
    if (!record) continue;
    any = true;
    const { min, max } = record.stats.bbox;
    if (min[0] < minX) minX = min[0];
    if (min[1] < minY) minY = min[1];
    if (min[2] < minZ) minZ = min[2];
    if (max[0] > maxX) maxX = max[0];
    if (max[1] > maxY) maxY = max[1];
    if (max[2] > maxZ) maxZ = max[2];
  }
  if (!any) return [0, 0, 0];
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

const AXIS_NORMALS: Record<Exclude<SectionAxis, 'custom'>, Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Rotates the Z axis by `yawDeg` around world Y, then `pitchDeg` around the
 * (already yaw-rotated) X axis — a standard, order-documented Euler
 * composition (matches three.js/manifold-3d's own "apply in a fixed,
 * documented order" convention for exactly this reason: rotation order
 * changes the result). Degenerate-safe for any angle (pure trig, no
 * division). */
function eulerNormalFromZ(yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  // Start at +Z, yaw around Y: rotates in the XZ plane.
  const x1 = Math.sin(yaw);
  const y1 = 0;
  const z1 = Math.cos(yaw);
  // Then pitch around the (yaw-rotated) X axis: rotates in the YZ' plane —
  // approximated here by rotating around world X for simplicity (Phase 1
  // scope: two independent slider angles, not a full gimbal-free
  // orientation control — acceptable per this task's brief, which asks for
  // exactly two angle sliders).
  const y2 = y1 * Math.cos(pitch) - z1 * Math.sin(pitch);
  const z2 = y1 * Math.sin(pitch) + z1 * Math.cos(pitch);
  return [x1, y2, z2];
}

function computePlane(): { point: Vec3; normal: Vec3 } {
  const state = useSectionStore.getState();
  const anchor = visibleSceneBboxCenter();
  const normal: Vec3 =
    state.axis === 'custom' ? eulerNormalFromZ(state.yawDeg, state.pitchDeg) : AXIS_NORMALS[state.axis];
  const point: Vec3 = [
    anchor[0] + normal[0] * state.offsetMm,
    anchor[1] + normal[1] * state.offsetMm,
    anchor[2] + normal[2] * state.offsetMm,
  ];
  return { point, normal };
}

class SectionEngine {
  private outline: SectionOutlineRender[] = [];
  private caps: SectionCapRender[] = [];
  /** Plane-local 2D (Float64 mm) polylines from the last successful run,
   * for `exportSvg` — kept separate from `outline` (render-frame Float32)
   * since SVG export wants the exact kernel-computed coordinates, not the
   * Float32 render copy. */
  private svgPolylines: SectionSvgPolyline[] = [];
  private generation = 0;
  /** The most recently started `recompute()` call — every public setter
   * below assigns its own `recompute()` call here (fire-and-forget from the
   * UI's point of view, since these setters are wired straight to slider
   * `onChange`/button `onClick` handlers), so `waitForIdle` (primarily for
   * tests, but a legitimate public entry point for any future caller that
   * needs to await a specific plane computation) always resolves once the
   * LATEST change has actually settled. */
  private pending: Promise<void> = Promise.resolve();

  /** Applies an axis preset (X/Y/Z through the current scene bbox center) —
   * resets the arbitrary-plane sliders to 0 (this task's brief: "axis-
   * aligned presets... through bbox center"). */
  setAxisPreset(axis: Exclude<SectionAxis, 'custom'>): void {
    const store = useSectionStore.getState();
    store.setAxis(axis);
    store.setOffsetMm(0);
    store.setYawDeg(0);
    store.setPitchDeg(0);
    this.pending = this.recompute();
  }

  /** Switches to the arbitrary-plane sliders (position + two angles),
   * keeping whatever values they currently hold. */
  useCustomPlane(): void {
    useSectionStore.getState().setAxis('custom');
    this.pending = this.recompute();
  }

  setEnabled(enabled: boolean): void {
    useSectionStore.getState().setEnabled(enabled);
    if (enabled) {
      this.pending = this.recompute();
    } else {
      this.clear();
    }
  }

  setOffsetMm(mm: number): void {
    useSectionStore.getState().setOffsetMm(mm);
    this.pending = this.recompute();
  }

  setYawDeg(deg: number): void {
    useSectionStore.getState().setYawDeg(deg);
    this.pending = this.recompute();
  }

  setPitchDeg(deg: number): void {
    useSectionStore.getState().setPitchDeg(deg);
    this.pending = this.recompute();
  }

  setShowCap(show: boolean): void {
    useSectionStore.getState().setShowCap(show);
    this.pending = this.recompute();
  }

  /** Toggling the clip plane never needs a new worker run — it only affects
   * how SceneManager renders the ALREADY-computed plane (see
   * `getClipPlane`). */
  setClipEnabled(enabled: boolean): void {
    useSectionStore.getState().setClipEnabled(enabled);
  }

  private async recompute(): Promise<void> {
    const store = useSectionStore.getState();
    if (!store.enabled) return;

    const plane = computePlane();
    const myGeneration = ++this.generation;
    store.setRunning();

    const visibleNodes = caseStore.getDocument().scene.filter((node) => node.visible);
    const outline: SectionOutlineRender[] = [];
    const caps: SectionCapRender[] = [];
    const svgPolylines: SectionSvgPolyline[] = [];

    try {
      const worldOffset = caseStore.getRenderWorldOffset();
      for (const node of visibleNodes) {
        const record = caseStore.getMeshRecord(node.meshId);
        if (!record) continue;
        // Kernel Float64 rule: section polylines come from the master
        // Float64 buffers, never the Float32 render copy (this task's
        // guardrail). `.slice()` so the worker's transfer never detaches
        // the mesh's live master buffer (same convention as
        // engine/workers.ts's `ensureBvhBuilt`).
        const positions = record.positions.slice();
        const indices = record.indices.slice();
        const result = await getPool().run(
          'sectionMesh',
          { positions, indices, point: plane.point, normal: plane.normal, computeCap: store.showCap },
          { transfer: [positions.buffer, indices.buffer] },
        );
        if (myGeneration !== this.generation) return; // superseded while awaiting

        let offset3 = 0;
        let offset2 = 0;
        for (let i = 0; i < result.polylineCounts.length; i++) {
          const count = result.polylineCounts[i]!;
          const points = new Float32Array(count * 3);
          for (let k = 0; k < count; k++) {
            points[k * 3] = result.pointsFlat[offset3 + k * 3]! - worldOffset[0];
            points[k * 3 + 1] = result.pointsFlat[offset3 + k * 3 + 1]! - worldOffset[1];
            points[k * 3 + 2] = result.pointsFlat[offset3 + k * 3 + 2]! - worldOffset[2];
          }
          outline.push({ points, closed: result.polylineClosed[i] === 1 });
          svgPolylines.push({
            points: result.points2dFlat.slice(offset2, offset2 + count * 2),
            closed: result.polylineClosed[i] === 1,
          });
          offset3 += count * 3;
          offset2 += count * 2;
        }

        if (result.capPositions && result.capIndices) {
          const capPositions = new Float32Array(result.capPositions.length);
          for (let k = 0; k < result.capPositions.length / 3; k++) {
            capPositions[k * 3] = result.capPositions[k * 3]! - worldOffset[0];
            capPositions[k * 3 + 1] = result.capPositions[k * 3 + 1]! - worldOffset[1];
            capPositions[k * 3 + 2] = result.capPositions[k * 3 + 2]! - worldOffset[2];
          }
          caps.push({ positions: capPositions, indices: result.capIndices });
        }
      }
      if (myGeneration !== this.generation) return;

      this.outline = outline;
      this.caps = caps;
      this.svgPolylines = svgPolylines;
      const pointCount = outline.reduce((sum, polyline) => sum + polyline.points.length / 3, 0);
      const planeSummary: SectionPlaneSummary = { point: plane.point, normal: plane.normal };
      store.setResult({ plane: planeSummary, pointCount });
    } catch (error) {
      if (myGeneration !== this.generation) return;
      this.outline = [];
      this.caps = [];
      this.svgPolylines = [];
      store.setError(error instanceof Error ? error.message : String(error));
    }
  }

  clear(): void {
    this.generation++;
    this.outline = [];
    this.caps = [];
    this.svgPolylines = [];
    useSectionStore.getState().clear();
  }

  /** Resolves once the most recently started `recompute()` (from ANY
   * setter call) has settled — see `pending`'s doc. */
  async waitForIdle(): Promise<void> {
    await this.pending;
  }

  /** Render-frame outline polylines from the last completed run — consumed
   * by ui/Viewport.tsx's SceneManager sync effect. Empty when the tool is
   * disabled, mid-run, or errored. */
  getOutline(): readonly SectionOutlineRender[] {
    return this.outline;
  }

  /** Render-frame filled-cap meshes from the last completed run — empty
   * unless `showCap` is on AND at least one visible mesh was watertight AND
   * the plane actually crossed it. */
  getCaps(): readonly SectionCapRender[] {
    return this.caps;
  }

  /**
   * The active clip plane in RENDER frame, or `null` if the tool/clip
   * toggle is off or no plane has been computed yet — for
   * `SceneManager.setSectionClipPlane`.
   *
   * Derivation: a world-frame plane point `P`/unit normal `N` satisfies
   * `N . p = N . P` for world points `p` on it. A render-frame point
   * `r = p - worldOffset` (meshStore.ts's re-centering) therefore satisfies
   * `N . r = N . P - N . worldOffset`, i.e. (Three.js `Plane`'s
   * `N . r + constant = 0` convention) `constant = N . worldOffset - N . P
   * = N . (worldOffset - P)`.
   */
  getClipPlane(): SectionClipPlaneRender | null {
    const store = useSectionStore.getState();
    if (!store.enabled || !store.clipEnabled || !store.plane) return null;
    const { point, normal } = store.plane;
    const normalLength = length(normal);
    if (normalLength === 0) return null;
    const unit: Vec3 = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];
    const worldOffset = caseStore.getRenderWorldOffset();
    const offsetFromWorld = subtract(worldOffset, point);
    const constant = unit[0] * offsetFromWorld[0] + unit[1] * offsetFromWorld[1] + unit[2] * offsetFromWorld[2];
    return { normal: unit, constant };
  }

  /** Renders the last completed run's polylines as an SVG document (kernel
   * `sectionToSvg`, re-exported via `@dqcad/kernel-workers` — see that
   * module's doc for why engine may call it directly, no worker round
   * trip). `null` if there's nothing to export yet. */
  exportSvg(): string | null {
    if (this.svgPolylines.length === 0) return null;
    return sectionToSvg(this.svgPolylines);
  }

  /** Triggers a browser download of `exportSvg()`'s output — a no-op if
   * there's nothing to export. Kept here (not in ui/SectionPanel.tsx) so
   * the panel component stays a pure view, matching every other panel's
   * "component calls an engine action" convention in this codebase. */
  downloadSvg(filename = 'section.svg'): void {
    const svg = this.exportSvg();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** TEST-ONLY: mirrors caseStore.resetForTests()'s reset-module-singleton
   * convention. */
  resetForTests(): void {
    this.generation++;
    this.outline = [];
    this.caps = [];
    this.svgPolylines = [];
    useSectionStore.getState().clear();
  }
}

/** Module-level singleton — same pattern as engine/heatmap.ts's
 * `heatmapEngine`. */
export const sectionEngine = new SectionEngine();
