// apps/client/src/engine/marginFrame.ts
//
// Pure world<->render-frame conversions for the margin editor (Phase 3 Task
// 5) — same split-out-for-testability rationale as engine/measurementFrame.ts
// (kept Three.js-free / DOM-free so both directions are unit-testable
// without a real SceneManager). "World frame" = the frame `MarginAnchor.
// position` is stored in (a mesh's Float64 master `positions` frame —
// meshStore.ts's module doc). "Render frame" = meshStore.ts's re-centered
// Float32 frame (`renderPositions = positions - worldOffset`), which is what
// SceneManager's camera/raycaster/overlay geometry actually operates in.
import type { Vec3 } from '@dqcad/shared-types';
import type { MarginOverlayRenderData } from './SceneManager';
import { MARGIN_WEAK_CONFIDENCE_THRESHOLD } from './marginEditor';
import type { LiveMarginSegment, SegmentConfidence } from '../state/marginStore';

function subtract(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: readonly [number, number, number], b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** One anchor's render-frame position, plus the segment (if any) leading to
 * the NEXT anchor (empty for the last anchor of an open polyline) — see
 * SceneManager.ts's `MarginOverlayRenderData` for the consumer shape this
 * feeds. */
export interface MarginAnchorRenderPoint {
  xyz: readonly [number, number, number];
}

/** World -> render frame for a live margin curve's anchors + per-segment
 * sampled points — feeds `SceneManager.syncMarginOverlay`. `segments[i]` is
 * the (already geodesic-sampled) polyline from `anchors[i]` to `anchors[(i+1)
 * % anchors.length]` (only `anchors.length - (closed ? 0 : 1)` entries are
 * meaningful — see engine/marginEditor.ts's `LiveMarginSegment`'s doc for
 * why this module accepts already-flat Vec3 arrays rather than any kernel
 * type). */
export function toMarginRenderPoints(
  points: readonly Vec3[],
  worldOffset: Vec3,
): Array<readonly [number, number, number]> {
  return points.map((p) => subtract(p, worldOffset));
}

/** Render -> world frame for a pick ray's origin (direction is offset-
 * invariant) — same shape/contract as measurementFrame.ts's `toWorldRay`,
 * duplicated here (not imported) so engine/marginEditor.ts has no
 * measurement-domain dependency, matching this repo's per-domain-module
 * convention (e.g. jobs/geodesic.ts's `SurfacePointPayload` vs jobs/
 * spline.ts's `SplineSurfacePointPayload`). */
export interface RenderFrameRay {
  rayOrigin: readonly [number, number, number];
  rayDirection: readonly [number, number, number];
}

export function toWorldRay(ray: RenderFrameRay, worldOffset: Vec3): { rayOrigin: Vec3; rayDirection: Vec3 } {
  return {
    rayOrigin: add(ray.rayOrigin, worldOffset),
    rayDirection: [ray.rayDirection[0], ray.rayDirection[1], ray.rayDirection[2]],
  };
}

/** World -> render frame for a single point (anchor handle screen-space
 * projection input, or the magnifier's cursor-following target). */
export function toRenderPoint(point: Vec3, worldOffset: Vec3): [number, number, number] {
  return subtract(point, worldOffset);
}

/** Builds `SceneManager.syncMarginOverlay`'s input from the live margin
 * store's segments/confidence — the one place that converts world-frame
 * segment points to render frame AND applies the weak-confidence threshold
 * (deliverable 4). `segmentConfidence[i]`, when present, covers
 * `segments[i]` (this module's/marginStore.ts's shared indexing convention —
 * see marginEditor.ts's `MarginToolState.segmentConfidence` doc). */
export function toMarginOverlayRenderData(
  segments: readonly LiveMarginSegment[],
  segmentConfidence: SegmentConfidence,
  humanEdited: boolean,
  worldOffset: Vec3,
): MarginOverlayRenderData | null {
  if (segments.length === 0) return null;
  return {
    origin: humanEdited ? 'confirmed' : 'proposed',
    segments: segments.map((segment, i) => ({
      points: toMarginRenderPoints(segment.points, worldOffset),
      weak: (segmentConfidence?.[i] ?? 1) < MARGIN_WEAK_CONFIDENCE_THRESHOLD,
    })),
  };
}
