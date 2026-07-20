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
import { toRenderPoint, toWorldRay } from '../engine/marginFrame';
import { getActiveSceneManager } from '../engine/viewerController';
import { useCaseStore } from '../state/caseStore';
import { useMarginStore } from '../state/marginStore';

const CLICK_DRAG_THRESHOLD_PX = 5;
const MAGNIFIER_SIZE_PX = 160;
const MAGNIFIER_SOURCE_CROP_PX = 56;
const MAGNIFIER_OFFSET_PX = 28;

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
      const next: HandlePosition[] = [];
      anchors.forEach((anchor, index) => {
        const projected = sceneManager.projectToScreen(toRenderPoint(anchor.position, worldOffset));
        if (!projected) return;
        next.push({ index, xPx: projected.xPx, yPx: projected.yPx });
      });
      setHandles(next);
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
