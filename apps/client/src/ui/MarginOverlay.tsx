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
import { useMarginStore } from '../state/marginStore';

const CLICK_DRAG_THRESHOLD_PX = 5;
const MAGNIFIER_SIZE_PX = 160;
const MAGNIFIER_SOURCE_CROP_PX = 56;
const MAGNIFIER_OFFSET_PX = 28;
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
  useEffect(() => {
    if (phase !== 'active') {
      marginEditor.setCursorScreenPos(null);
      return;
    }
    const sceneManager = getActiveSceneManager();
    const canvas = sceneManager?.getCanvasElement();
    if (!canvas) return;
    function handleMove(event: PointerEvent): void {
      const rect = canvas!.getBoundingClientRect();
      marginEditor.setCursorScreenPos({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
    }
    function handleLeave(): void {
      marginEditor.setCursorScreenPos(null);
    }
    canvas.addEventListener('pointermove', handleMove);
    canvas.addEventListener('pointerleave', handleLeave);
    return () => {
      canvas.removeEventListener('pointermove', handleMove);
      canvas.removeEventListener('pointerleave', handleLeave);
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
      void marginEditor.updateAnchorDrag(toWorldRay(ray, worldOffset));
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
        }
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, cursorScreenPos]);

  // Delete/Backspace deletes the selected anchor — see this file's top doc.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (phase !== 'active' || selectedAnchorIndex === null) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void marginEditor.deleteSelectedAnchor();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, selectedAnchorIndex]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, index: number): void {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
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
    void marginEditor.updateAnchorDrag(toWorldRay(ray, worldOffset));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>, index: number): void {
    const state = dragStateRef.current;
    dragStateRef.current = null;
    if (!state) return;
    if (state.dragging) {
      void marginEditor.endAnchorDrag();
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
