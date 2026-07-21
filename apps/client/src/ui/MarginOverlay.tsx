// apps/client/src/ui/MarginOverlay.tsx
//
// Screen-space margin-editor overlay (Phase 3 Task 5): one draggable HTML
// handle per anchor (positioned every animation frame via
// `SceneManager.projectToScreen`, same pattern as ui/MeasurementOverlay.tsx's
// numeric labels) plus a magnifier "lens" widget that follows the cursor
// while the tool is active.
//
// ## Anchor interactions (documented choice — deliverable 2)
//
// - Click a handle (pointerdown+up with < 5px movement): SELECTS it
//   (`marginEditor.selectAnchor`) — a selected handle can then be deleted via
//   the Delete/Backspace key (below) OR ui/MarginPanel.tsx's "Delete anchor"
//   button (the "select+key or context affordance" this task's brief asks
//   to document — both are wired to the SAME `deleteSelectedAnchor()` call).
// - SHIFT-click a handle (Phase 3 editor-enhancement task 2 — "I can't
//   delete points in groups"): toggles it in/out of the bulk multi-select
//   set (`marginEditor.toggleAnchorSelection` ->
//   `marginStore.selectedAnchorIndices`); Delete/Backspace (or
//   ui/MarginPanel.tsx's "Delete selected" button) then removes the WHOLE
//   set as ONE coalesced journal op (`deleteSelectedAnchors`). Shift-click
//   is the DELIBERATE mechanism choice over box/lasso select (this task's
//   brief: "pick ONE mechanism that fits the existing overlay
//   interaction"): every per-anchor gesture in this overlay already routes
//   through the per-handle pointerdown/up machinery (including the
//   capture-phase pick-priority interception below), so a modifier on the
//   EXISTING click gesture composes with all of it for free — whereas a
//   box/lasso drag on the canvas would collide head-on with OrbitControls'
//   own drag-to-orbit (the exact conflict the pick-priority section below
//   exists to referee) and would need a whole new projected-rectangle hit
//   pipeline. With ~20-50 anchors after the task-1 slider (the same
//   feedback batch), shift-clicking a handful of anchors is fast; a lasso
//   only pays for itself at the 200+ densities the slider now avoids.
// - Drag a handle (pointerdown+move past 5px): moves it — LIVE geodesic
//   re-snap on every pointermove (`marginEditor.updateAnchorDrag`, coalesced
//   against stale frames), committed + journaled ONCE on pointerup
//   (`marginEditor.endAnchorDrag`) — see engine/marginEditor.ts's top doc for
//   why this is NOT a per-mousemove-journaled operation.
// - Clicking empty mesh surface (not a handle) is handled separately by
//   ui/Viewport.tsx's existing measure-mode click pipeline, routed to
//   `marginEditor.handlePick` — this component only owns EXISTING handles.
//
// ## Handle decluttering (T5 review item 3a — density UX, disclosed as an
// open concern in this task's own report §5 item 3)
//
// `proposeMargin`'s real curvature-adaptive density (~260 anchors over a
// ~30mm real margin) puts handles well under a pixel apart at normal zoom —
// individually indistinguishable. `handles` (the projected, RENDERED
// subset) runs every projected anchor through `declutterScreenPoints`
// (engine/marginFrame.ts) every animation frame: a greedy
// minimum-screen-pixel-spacing filter (`HANDLE_DECLUTTER_MIN_SPACING_PX`)
// that keeps a handle only if it's far enough from every already-kept one.
// This is RENDER-ONLY — `useMarginStore`'s own `anchors` (the actual data)
// is never touched, only which anchors get an actual `<div>` drawn. It
// self-resolves as the user zooms in (two fixed-world-distance anchors
// project further apart on screen at higher zoom, so more of them clear the
// spacing threshold) with no separate zoom-aware logic needed — see
// `declutterScreenPoints`'s own doc.
//
// ## Nearest-anchor pick PRIORITY (T5 review item 3b — the OrbitControls-
// hijack bug this task's own report §5 item 3 disclosed manually: "a casual
// drag attempt easily misses every handle and grabs the 3D camera's orbit
// control instead")
//
// A pointerdown landing within `ANCHOR_PICK_PRIORITY_RADIUS_PX` of ANY
// anchor — the FULL set from the store, not just the decluttered `handles`
// actually rendered above — begins an anchor drag instead of letting
// OrbitControls start an orbit, even when that anchor has no handle `<div>`
// under the cursor at all. Wired as a CAPTURE-phase `pointerdown` listener
// on the canvas's PARENT element (`SceneManager`'s own `container`, which
// `appendChild`s the canvas — see SceneManager.ts's constructor), not on
// the canvas itself, and not via `controls.enabled` toggling. Why: per the
// DOM Events spec, listeners registered on the SAME element (the canvas)
// fire in REGISTRATION ORDER regardless of the `capture` flag — there is no
// separate capture/bubble sub-ordering "at target". `OrbitControls`'
// own `pointerdown` listener is attached directly to the canvas inside
// `SceneManager`'s constructor, which always runs before this component's
// effects ever get a chance to register anything — so a same-element
// listener here, even a capturing one, could never win that race. A
// capture-phase listener on an ANCESTOR, by contrast, always fires during
// the capture phase, strictly before the event even reaches the canvas (the
// target) — a guarantee that does not depend on registration order at all.
// `event.stopPropagation()` there halts the ENTIRE dispatch (capture, at-
// target, and bubble) before it reaches the canvas, so neither
// `OrbitControls`' own listener NOR `SceneManager`'s own click-vs-drag pick
// heuristic (which would otherwise mis-fire `addAnchorOnSegment`/
// `appendAnchor` for what the user meant as a plain re-grab of an existing
// anchor) ever runs. Guarded to `event.target === canvas` so it never
// intercepts clicks on actual UI chrome (toolbar buttons, this component's
// OWN rendered handle `<div>`s, which sit in the same container as siblings
// of the canvas, never as its descendants).
//
// ## Magnifier widget (deliverable 2 — "implementer picks the cheap correct
// approach")
//
// Chosen approach: a small secondary 2D `<canvas>` that `drawImage`s a
// cropped, scaled-up region of the MAIN WebGL canvas
// (`SceneManager.getCanvasElement()`) centered on the cursor, redrawn every
// animation frame. This needs NO secondary Three.js render pass and no
// duplicate scene/camera — just a 2D canvas pixel copy. It DOES require
// `WebGLRenderer({ preserveDrawingBuffer: true })` (SceneManager.ts's
// constructor) — manual verification caught this the hard way: this
// magnifier's OWN, independently-timed rAF loop reads the main canvas from a
// DIFFERENT callback than the one that just rendered it, and without
// `preserveDrawingBuffer` the browser is free to clear/swap the drawing
// buffer as soon as compositing finishes — the magnifier rendered reliably
// BLANK in practice, not merely "a worst-case one-frame lag" as an earlier
// draft of this doc assumed before it was actually tested end-to-end.
// `preserveDrawingBuffer: true` keeps the buffer intact between frames, at a
// small, well-understood perf cost (no implicit clear-on-present) — fine at
// this app's scale. The alternative (a second Three.js viewport
// rendering the same scene at a tighter FOV) would be strictly more
// "correct" pixel-for-pixel but costs a full duplicate render pass per
// frame for a widget that only needs to help the eye place a click
// precisely — not chosen, documented here per this task's brief.
import { useEffect, useRef, useState } from 'react';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import { declutterScreenPoints, nearestScreenPointWithinRadius, toRenderPoint, toWorldRay } from '../engine/marginFrame';
import { getActiveSceneManager } from '../engine/viewerController';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore, type MagnifierSectionSnapshot } from '../state/marginStore';

const CLICK_DRAG_THRESHOLD_PX = 5;
const MAGNIFIER_SIZE_PX = 160;
const MAGNIFIER_SOURCE_CROP_PX = 56;
const MAGNIFIER_OFFSET_PX = 28;
/** Half-extent (mm) of the cross-section profile view drawn INSIDE the
 * magnifier (Phase 3 editor-enhancement task 3) — the lens shows ±this many
 * mm of the section curve around the cursor's own on-plane position, at a
 * FIXED mm->px scale (`MAGNIFIER_SIZE_PX / (2 * this)`). Deliberately NOT
 * aligned/scaled to the magnified screen pixels underneath (that would need
 * a world-units-per-screen-pixel camera query per frame for a purely
 * decorative alignment): the curve is a PROFILE READOUT — "is there a dip or
 * a rise here, and how steep" (the dentist project owner's own ask) — not a
 * pixel-registered annotation, and the fixed physical scale is exactly what
 * makes steepness comparable between zoom levels. 2mm comfortably covers a
 * margin shoulder's own feature scale (shelf widths/step heights are a few
 * hundred µm to ~1.5mm) while staying well inside the section job's own
 * `MARGIN_SECTION_PREVIEW_ROI_RADIUS_MM` (4mm) query window, so the drawn
 * curve is never truncated by the ROI boundary. */
const MAGNIFIER_SECTION_VIEW_HALF_MM = 2;
/** Cross-section stroke/marker colors — fixed high-contrast values (not
 * theme variables: they draw over the magnified SCENE pixels, whose
 * background is the 3D viewport's own dark-ish clear color in both UI
 * themes, not the page background). */
const MAGNIFIER_SECTION_STROKE = '#ffd23f';
const MAGNIFIER_SECTION_CURSOR = '#ff5c5c';
/** Minimum on-screen spacing (px) between two RENDERED anchor handles — see
 * this file's top doc, "Handle decluttering". Picked from the brief's own
 * "~18-24px" range. */
const HANDLE_DECLUTTER_MIN_SPACING_PX = 20;
/** Pointerdown-to-anchor pick-priority radius (px) — see this file's top
 * doc, "Nearest-anchor pick priority". Picked from the brief's own "~12px"
 * figure. */
const ANCHOR_PICK_PRIORITY_RADIUS_PX = 12;

interface HandlePosition {
  index: number;
  xPx: number;
  yPx: number;
}

/**
 * Draws the live cross-section profile (Phase 3 editor-enhancement task 3 —
 * `marginStore.magnifierSection`, see that type's doc) INTO the magnifier's
 * 2D canvas, over the already-drawn magnified pixels: every section polyline
 * in plane-local (u, v) mm, translated so the CURSOR's own on-plane
 * coordinate (`snapshot.cursorUV`) sits at the lens center (which is also
 * where the magnified crop is centered — the two stay visually associated),
 * at the fixed `MAGNIFIER_SECTION_VIEW_HALF_MM` physical scale (see that
 * constant's doc for why it is deliberately NOT registered to the magnified
 * screen pixels). v points UP on screen (canvas y grows downward, so v is
 * negated) — with the plane's u/v basis orthonormal (kernel
 * `normalizePlane`), the curve reads as a true undistorted profile; its
 * in-plane ROTATION is whatever the basis happens to be, which is fine for
 * the "see dips/rises" purpose (a profile's shape, not its heading, is the
 * signal). A small crosshair marks the cursor position on the profile.
 * No-op when `snapshot` is `null` (nothing computed yet / cursor off-mesh).
 */
function drawMagnifierSection(ctx: CanvasRenderingContext2D, snapshot: MagnifierSectionSnapshot | null): void {
  if (!snapshot || snapshot.polylines.length === 0) return;
  const center = MAGNIFIER_SIZE_PX / 2;
  const pxPerMm = MAGNIFIER_SIZE_PX / (2 * MAGNIFIER_SECTION_VIEW_HALF_MM);
  const [cu, cv] = snapshot.cursorUV;

  ctx.save();
  // Clip to the lens circle so the profile never pokes out of the round
  // magnifier border (the <canvas> itself is square; CSS only rounds it).
  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.clip();

  ctx.strokeStyle = MAGNIFIER_SECTION_STROKE;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const polyline of snapshot.polylines) {
    if (polyline.points.length < 2) continue;
    ctx.beginPath();
    polyline.points.forEach(([u, v], i) => {
      const x = center + (u - cu) * pxPerMm;
      const y = center - (v - cv) * pxPerMm; // v up on screen
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (polyline.closed) ctx.closePath();
    ctx.stroke();
  }

  // Cursor crosshair — the fixed lens center by construction.
  ctx.strokeStyle = MAGNIFIER_SECTION_CURSOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(center - 6, center);
  ctx.lineTo(center + 6, center);
  ctx.moveTo(center, center - 6);
  ctx.lineTo(center, center + 6);
  ctx.stroke();
  ctx.restore();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function MarginOverlay() {
  const document = useCaseStore((state) => state.document);
  const phase = useMarginStore((state) => state.phase);
  const anchors = useMarginStore((state) => state.anchors);
  const selectedAnchorIndex = useMarginStore((state) => state.selectedAnchorIndex);
  const selectedAnchorIndices = useMarginStore((state) => state.selectedAnchorIndices);
  const draggingAnchorIndex = useMarginStore((state) => state.draggingAnchorIndex);
  const cursorScreenPos = useMarginStore((state) => state.cursorScreenPos);

  const [handles, setHandles] = useState<readonly HandlePosition[]>([]);
  const magnifierCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{ index: number; downX: number; downY: number; dragging: boolean } | null>(null);

  // Project every anchor's world position to screen every animation frame —
  // same RAF pattern as ui/MeasurementOverlay.tsx.
  useEffect(() => {
    let frameId: number;
    function tick(): void {
      const sceneManager = getActiveSceneManager();
      if (!sceneManager || phase !== 'active' || anchors.length === 0) {
        setHandles((prev) => (prev.length === 0 ? prev : []));
        frameId = requestAnimationFrame(tick);
        return;
      }
      const worldOffset = caseStore.getRenderWorldOffset();
      const projected: HandlePosition[] = [];
      anchors.forEach((anchor, index) => {
        const p = sceneManager.projectToScreen(toRenderPoint(anchor.position, worldOffset));
        if (!p) return;
        projected.push({ index, xPx: p.xPx, yPx: p.yPx });
      });
      // Decluttered for DISPLAY only (T5 review item 3a) — `anchors` itself
      // (the store's full data) is completely unaffected; see this file's
      // top doc.
      setHandles(declutterScreenPoints(projected, HANDLE_DECLUTTER_MIN_SPACING_PX));
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, anchors, document]);

  // Cursor tracking (for the magnifier) — attaches to the MAIN canvas
  // (owned by SceneManager, not this component) while the tool is active.
  // ALSO the hover-path trigger for the magnifier cross-section preview
  // (Phase 3 editor-enhancement task 3): every tracked pointermove requests
  // a (throttled, engine-side — see marginEditor.updateMagnifierSection's
  // doc) section through the cursor's mesh hit point. The two drag paths
  // (per-handle drag below, capture-phase priority drag above) fire the
  // same request from their own pointermove handlers — pointer capture
  // keeps THIS canvas listener from seeing those moves.
  useEffect(() => {
    if (phase !== 'active') {
      marginEditor.setCursorScreenPos(null);
      marginEditor.clearMagnifierSection();
      return;
    }
    const sceneManager = getActiveSceneManager();
    const canvas = sceneManager?.getCanvasElement();
    if (!canvas) return;
    function handleMove(event: PointerEvent): void {
      const rect = canvas!.getBoundingClientRect();
      marginEditor.setCursorScreenPos({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
      const ray = sceneManager!.rayAtClientPosition(event.clientX, event.clientY);
      if (ray) {
        marginEditor.updateMagnifierSection(toWorldRay(ray, caseStore.getRenderWorldOffset()));
      }
    }
    function handleLeave(): void {
      marginEditor.setCursorScreenPos(null);
      marginEditor.clearMagnifierSection();
    }
    canvas.addEventListener('pointermove', handleMove);
    canvas.addEventListener('pointerleave', handleLeave);
    return () => {
      canvas.removeEventListener('pointermove', handleMove);
      canvas.removeEventListener('pointerleave', handleLeave);
      marginEditor.clearMagnifierSection();
    };
  }, [phase]);

  // Nearest-anchor pick PRIORITY (T5 review item 3b) — see this file's top
  // doc, "Nearest-anchor pick priority", for the full reasoning behind
  // wiring this as a capture-phase listener on the canvas's PARENT.
  useEffect(() => {
    if (phase !== 'active') return;
    const sceneManager = getActiveSceneManager();
    const canvas = sceneManager?.getCanvasElement();
    const container = canvas?.parentElement;
    if (!sceneManager || !canvas || !container) return;

    let activePointerId: number | null = null;

    function nearestAnchorIndexAt(clientX: number, clientY: number): number | null {
      const rect = canvas!.getBoundingClientRect();
      const worldOffset = caseStore.getRenderWorldOffset();
      // The FULL anchor set — not the decluttered `handles` render state —
      // see this file's top doc for why.
      const projected: HandlePosition[] = [];
      useMarginStore.getState().anchors.forEach((anchor, index) => {
        const p = sceneManager!.projectToScreen(toRenderPoint(anchor.position, worldOffset));
        if (!p) return;
        projected.push({ index, xPx: p.xPx, yPx: p.yPx });
      });
      const nearest = nearestScreenPointWithinRadius(
        projected,
        clientX - rect.left,
        clientY - rect.top,
        ANCHOR_PICK_PRIORITY_RADIUS_PX,
      );
      return nearest ? nearest.index : null;
    }

    function handleWindowPointerMove(event: PointerEvent): void {
      if (event.pointerId !== activePointerId) return;
      const ray = sceneManager!.rayAtClientPosition(event.clientX, event.clientY);
      if (!ray) return;
      const worldOffset = caseStore.getRenderWorldOffset();
      const worldRay = toWorldRay(ray, worldOffset);
      void marginEditor.updateAnchorDrag(worldRay);
      // Keep the magnifier (and its cross-section preview) following the
      // cursor during a priority drag too — this window-level listener is
      // the only pointermove the canvas's own tracking effect never sees.
      const rect = canvas!.getBoundingClientRect();
      marginEditor.setCursorScreenPos({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
      marginEditor.updateMagnifierSection(worldRay);
    }

    function endPriorityDrag(): void {
      activePointerId = null;
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      void marginEditor.endAnchorDrag();
    }

    function handleWindowPointerUp(event: PointerEvent): void {
      if (event.pointerId !== activePointerId) return;
      endPriorityDrag();
    }

    function handleCapturePointerDown(event: PointerEvent): void {
      if (event.target !== canvas) return; // only bare-canvas clicks — see top doc
      if (useMarginStore.getState().draggingAnchorIndex !== null) return; // a handle-div drag already owns this gesture
      const index = nearestAnchorIndexAt(event.clientX, event.clientY);
      if (index === null) return;
      // Must run BEFORE OrbitControls'/SceneManager's own listeners ever
      // see this event — see this file's top doc for why an ancestor
      // capture-phase listener is the only reliable way to guarantee that.
      event.stopPropagation();
      activePointerId = event.pointerId;
      marginEditor.beginAnchorDrag(index);
      window.addEventListener('pointermove', handleWindowPointerMove);
      window.addEventListener('pointerup', handleWindowPointerUp);
    }

    container.addEventListener('pointerdown', handleCapturePointerDown, { capture: true });
    return () => {
      container.removeEventListener('pointerdown', handleCapturePointerDown, { capture: true });
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
  }, [phase]);

  // Magnifier draw loop — see this file's top doc for the chosen approach.
  useEffect(() => {
    let frameId: number;
    function tick(): void {
      const sceneManager = getActiveSceneManager();
      const canvas = magnifierCanvasRef.current;
      if (sceneManager && canvas && phase === 'active' && cursorScreenPos) {
        const ctx = canvas.getContext('2d');
        const source = sceneManager.getCanvasElement();
        if (ctx) {
          ctx.clearRect(0, 0, MAGNIFIER_SIZE_PX, MAGNIFIER_SIZE_PX);
          // `cursorScreenPos` is in CSS-pixel space (computed from
          // `getBoundingClientRect()` in the pointermove handler above), but
          // `drawImage`'s SOURCE rectangle addresses the canvas's actual
          // backing-store PIXEL space — `source.width`/`clientWidth` differ
          // by the device pixel ratio (manual verification caught this: on a
          // 2x-DPR display the magnifier rendered reliably BLANK, always
          // sampling a ~50x50 backing-store-pixel patch near the canvas's
          // top-left corner — background, never the cursor's actual
          // location — regardless of where the cursor was). Scale by the
          // canvas's own actual-size/display-size ratio (not a bare
          // `window.devicePixelRatio` assumption — SceneManager's renderer
          // may cap its own pixel ratio) so the source rect lands exactly
          // under the cursor at every zoom/DPR combination.
          const scaleX = source.width / source.clientWidth;
          const scaleY = source.height / source.clientHeight;
          const cropW = MAGNIFIER_SOURCE_CROP_PX * scaleX;
          const cropH = MAGNIFIER_SOURCE_CROP_PX * scaleY;
          const sx = cursorScreenPos.xPx * scaleX - cropW / 2;
          const sy = cursorScreenPos.yPx * scaleY - cropH / 2;
          try {
            ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, MAGNIFIER_SIZE_PX, MAGNIFIER_SIZE_PX);
          } catch {
            // Transient (e.g. a resize mid-frame) — just skip this frame.
          }
          drawMagnifierSection(ctx, useMarginStore.getState().magnifierSection);
        }
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, cursorScreenPos]);

  // Delete/Backspace deletes the selection — the bulk multi-select set when
  // non-empty (ONE coalesced journal op — Phase 3 editor-enhancement task
  // 2), else the single selected anchor (existing behavior, unchanged).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (phase !== 'active') return;
      const hasBulkSelection = selectedAnchorIndices.size > 0;
      if (!hasBulkSelection && selectedAnchorIndex === null) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (hasBulkSelection) {
        void marginEditor.deleteSelectedAnchors();
      } else {
        void marginEditor.deleteSelectedAnchor();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, selectedAnchorIndex, selectedAnchorIndices]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, index: number): void {
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // NotFoundError when the pointerId has no active pointer — a pointer
      // released between event dispatch and this call, or a synthetic
      // (untrusted) event (browser-lane tests). Capture is an ENHANCEMENT
      // (keeps a fast drag from escaping the handle), not a correctness
      // requirement — the gesture still works without it.
    }
    dragStateRef.current = { index, downX: event.clientX, downY: event.clientY, dragging: false };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>, index: number): void {
    const state = dragStateRef.current;
    if (!state || state.index !== index) return;
    const dx = event.clientX - state.downX;
    const dy = event.clientY - state.downY;
    if (!state.dragging) {
      if (Math.hypot(dx, dy) < CLICK_DRAG_THRESHOLD_PX) return;
      state.dragging = true;
      marginEditor.beginAnchorDrag(index);
    }
    const sceneManager = getActiveSceneManager();
    const ray = sceneManager?.rayAtClientPosition(event.clientX, event.clientY);
    if (!ray) return;
    const worldOffset = caseStore.getRenderWorldOffset();
    const worldRay = toWorldRay(ray, worldOffset);
    void marginEditor.updateAnchorDrag(worldRay);
    // Handle-div drags capture the pointer, so the canvas's own cursor
    // tracking never fires — keep the magnifier + cross-section preview
    // following from here (same as the priority-drag path).
    const canvas = sceneManager?.getCanvasElement();
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      marginEditor.setCursorScreenPos({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
    }
    marginEditor.updateMagnifierSection(worldRay);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>, index: number): void {
    const state = dragStateRef.current;
    dragStateRef.current = null;
    if (!state) return;
    if (state.dragging) {
      void marginEditor.endAnchorDrag();
    } else if (event.shiftKey) {
      // Bulk multi-select toggle (Phase 3 editor-enhancement task 2) — see
      // this file's top doc, "Anchor interactions", for why shift-click is
      // the chosen mechanism.
      marginEditor.toggleAnchorSelection(index);
    } else {
      marginEditor.selectAnchor(index === selectedAnchorIndex ? null : index);
    }
  }

  if (phase !== 'active') return null;

  return (
    <div className="margin-overlay" data-testid="margin-overlay">
      {handles.map((handle) => (
        <div
          key={handle.index}
          className={[
            'margin-overlay__handle',
            handle.index === selectedAnchorIndex ? 'margin-overlay__handle--selected' : '',
            selectedAnchorIndices.has(handle.index) ? 'margin-overlay__handle--multi-selected' : '',
            handle.index === draggingAnchorIndex ? 'margin-overlay__handle--dragging' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ left: `${handle.xPx}px`, top: `${handle.yPx}px` }}
          data-testid="margin-anchor-handle"
          data-anchor-index={handle.index}
          onPointerDown={(event) => handlePointerDown(event, handle.index)}
          onPointerMove={(event) => handlePointerMove(event, handle.index)}
          onPointerUp={(event) => handlePointerUp(event, handle.index)}
        />
      ))}
      {cursorScreenPos && (
        <canvas
          ref={magnifierCanvasRef}
          className="margin-overlay__magnifier"
          width={MAGNIFIER_SIZE_PX}
          height={MAGNIFIER_SIZE_PX}
          style={{ left: `${cursorScreenPos.xPx + MAGNIFIER_OFFSET_PX}px`, top: `${cursorScreenPos.yPx + MAGNIFIER_OFFSET_PX}px` }}
          data-testid="margin-magnifier"
        />
      )}
    </div>
  );
}
