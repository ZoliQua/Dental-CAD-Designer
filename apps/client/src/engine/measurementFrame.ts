// apps/client/src/engine/measurementFrame.ts
//
// Pure world<->render-frame conversions for measurement data — split out
// from ui/Viewport.tsx's wiring (and kept Three.js-free / DOM-free) so both
// directions are unit-testable without constructing a real SceneManager
// (see SceneManager.test.ts's module doc for why that can't run under
// vitest's `node` environment).
//
// "World frame" = the frame `Measurement.points[].position` is stored in
// (same as a mesh's Float64 master `positions` — meshStore.ts's module doc).
// "Render frame" = meshStore.ts's re-centered Float32 frame
// (`renderPositions` = `positions - worldOffset`), which is what
// SceneManager's camera/raycaster/overlay geometry actually operates in.
import type { Measurement, Vec3 } from '@dqcad/shared-types';
import type { MeasurementRenderData } from './SceneManager';

function subtract(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: readonly [number, number, number], b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** World -> render frame, for feeding `SceneManager.syncMeasurements`. */
export function toMeasurementRenderData(
  measurements: readonly Measurement[],
  worldOffset: Vec3,
): MeasurementRenderData[] {
  return measurements.map((measurement) => ({
    id: measurement.id,
    kind: measurement.kind,
    points: measurement.points.map((point) => subtract(point.position, worldOffset)),
  }));
}

/** A measurement-mode click's ray, as SceneManager reports it (render
 * frame) — see SceneManager.ts's `MeasurePickCandidate`. */
export interface RenderFrameRay {
  rayOrigin: readonly [number, number, number];
  rayDirection: readonly [number, number, number];
}

/** Render -> world frame for a pick ray's ORIGIN only — `rayDirection` is a
 * pure direction vector, unaffected by the translation offset between the
 * two frames, so it passes through unchanged. This is what
 * ToolManager.ts's `handlePick` needs (it always re-casts against the
 * Float64 world-frame mesh via the `raycastMesh` worker job — see that
 * module's doc for why). */
export function toWorldRay(
  ray: RenderFrameRay,
  worldOffset: Vec3,
): { rayOrigin: Vec3; rayDirection: Vec3 } {
  return {
    rayOrigin: add(ray.rayOrigin, worldOffset),
    rayDirection: [ray.rayDirection[0], ray.rayDirection[1], ray.rayDirection[2]],
  };
}
