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

/** One screen-space point tagged with an arbitrary caller-defined `index`
 * (ui/MarginOverlay.tsx uses an anchor's index into `useMarginStore`'s
 * `anchors` array) — the shared shape `declutterScreenPoints`/
 * `nearestScreenPointWithinRadius` both operate on (Task 5 review items 3a
 * and 3b). */
export interface IndexedScreenPoint {
  index: number;
  xPx: number;
  yPx: number;
}

/** Greedy minimum-screen-pixel-spacing declutter filter (Task 5 review item
 * 3a): processes `points` in the given order (ui/MarginOverlay.tsx passes
 * them in anchor-curve order), keeping a point only when it is at least
 * `minSpacingPx` away from EVERY already-kept point. Deliberately a
 * RENDER-ONLY filter — the caller's full underlying anchor list (the
 * store's `anchors`) is completely untouched; this only decides which
 * anchors get an actual `<div>` HANDLE drawn on screen. This self-resolves
 * as the user zooms in: two anchors that are close in WORLD space project
 * further apart in SCREEN space as the camera moves closer (their world
 * distance is fixed, but the same distance subtends more screen pixels at
 * higher zoom), so more of them naturally clear the spacing threshold and
 * start rendering on their own — no separate "zoom level" input or LOD-
 * style anchor-count logic is needed; this function only ever looks at
 * already-projected screen coordinates.
 * @errorBound N/A — pure screen-space filter; never adjusts a single
 * anchor's own geometry, only which ones get a rendered handle. */
export function declutterScreenPoints<T extends { xPx: number; yPx: number }>(
  points: readonly T[],
  minSpacingPx: number,
): T[] {
  const kept: T[] = [];
  for (const point of points) {
    const tooClose = kept.some((k) => Math.hypot(k.xPx - point.xPx, k.yPx - point.yPx) < minSpacingPx);
    if (!tooClose) kept.push(point);
  }
  return kept;
}

/** Nearest of `points` to `(xPx, yPx)`, only if within `radiusPx` (`null`
 * otherwise, and for an empty `points`) — shared by ui/MarginOverlay.tsx's
 * nearest-anchor PICK-PRIORITY interception (Task 5 review item 3b): a
 * pointerdown landing within this radius of ANY anchor should begin a drag
 * instead of letting the camera orbit. Deliberately takes its OWN `points`
 * argument rather than assuming `declutterScreenPoints`'s output — the two
 * are used with DIFFERENT inputs by design: picking must search the FULL
 * anchor set (so a click can still grab an anchor the declutter pass chose
 * not to render a handle for), while rendering only shows the decluttered
 * subset. */
export function nearestScreenPointWithinRadius<T extends { xPx: number; yPx: number }>(
  points: readonly T[],
  xPx: number,
  yPx: number,
  radiusPx: number,
): T | null {
  let best: T | null = null;
  let bestDist = radiusPx;
  for (const point of points) {
    const dist = Math.hypot(point.xPx - xPx, point.yPx - yPx);
    if (dist <= bestDist) {
      bestDist = dist;
      best = point;
    }
  }
  return best;
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
