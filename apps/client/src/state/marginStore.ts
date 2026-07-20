// apps/client/src/state/marginStore.ts
//
// UI-facing snapshot of the margin editor tool (Phase 3 Task 5) — same
// layering pattern as state/alignmentStore.ts: engine/marginEditor.ts is the
// sole writer (publishes after every state change), ui/MarginPanel.tsx and
// ui/MarginOverlay.tsx only ever read this store and call back into
// marginEditor's exported methods — never mutate it directly. Its own store
// (not folded into state/toolStore.ts) since margin editing operates on a
// per-restoration-per-tooth anchor LIST with a multi-phase (propose/manual/
// edit) lifecycle, not a single measurement's point picks.
import { create } from 'zustand';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';

export type MarginToolMode = 'auto' | 'manual';
/** Deliberately NO distinct 'error' phase: a failed `proposeMargin` call
 * (NoRidgeFoundError/NoClosureError) stays `'active'` — see
 * engine/marginEditor.ts's `handleProposeError` doc — so the tool remains
 * immediately usable in manual mode right after showing the guidance
 * message, rather than requiring a separate "dismiss error" step before any
 * further click does anything. `error`/`errorKind` (engine-side) carry the
 * message independently of `phase`. */
export type MarginToolPhase = 'idle' | 'proposing' | 'active';

/** Which mesh triangle/barycentric an anchor resolves against — mirrors
 * `@dqcad/shared-types`' `MarginAnchor` exactly (this store is the LIVE,
 * being-edited twin of that persisted shape; see engine/marginEditor.ts for
 * the conversion in both directions). */
export interface LiveMarginAnchor {
  position: Vec3;
  triangleIndex: number;
  barycentric: readonly [number, number, number];
}

/** One geodesic-snapped segment between two consecutive anchors — `points`
 * is the ordered on-surface polyline `geodesicPath` returned (world frame),
 * ENDPOINTS INCLUSIVE (so `points[0] === anchor A's position`, `points[last]
 * === anchor B's position` by construction — same convention @dqcad/kernel's
 * `GeodesicPathResult.points` uses). */
export interface LiveMarginSegment {
  points: readonly Vec3[];
}

/** Why confidence is "how much of the ORIGINAL walk this segment still
 * reflects" (this store) rather than a single fixed field: `proposeMargin`
 * gives ONE confidence value per anchor->next-anchor segment, indexed
 * against the ORIGINAL anchor order/count. The moment an ADD or DELETE
 * gesture changes the anchor count, every segment index's meaning shifts —
 * so `segmentConfidence` is cleared to `null` on any count-changing edit
 * (engine/marginEditor.ts's `clearConfidenceOnStructuralEdit` doc) and
 * survives ONLY a drag (which never changes anchor count/order). Manual-mode
 * curves never have confidence data (no walk ever ran) — always `null`. */
export type SegmentConfidence = readonly number[] | null;

interface MarginToolState {
  restorationId: string | null;
  tooth: FdiTooth | null;
  targetNodeId: string | null;
  phase: MarginToolPhase;
  mode: MarginToolMode;
  anchors: readonly LiveMarginAnchor[];
  /** `segments.length === anchors.length` if `closed`, else `anchors.length
   * - 1` (or 0 for a single anchor) — `segments[i]` joins `anchors[i]` to
   * `anchors[(i + 1) % anchors.length]`. */
  segments: readonly LiveMarginSegment[];
  closed: boolean;
  segmentConfidence: SegmentConfidence;
  /** `true` once ANY human edit gesture (drag/add/delete/close-toggle) has
   * been committed on top of an auto-proposal — drives the "proposed vs
   * confirmed" overlay color split (deliverable 4). A margin with no
   * proposal history (pure manual trace, or loaded from a persisted
   * document) is always `true` — there is no "proposed, untouched" state to
   * distinguish for it. */
  humanEdited: boolean;
  selectedAnchorIndex: number | null;
  draggingAnchorIndex: number | null;
  /** How many loaded anchors carry the v1->v2 migration's unresolved sentinel
   * (`triangleIndex === -1`, caseDocumentMigration.ts) — see
   * engine/marginEditor.ts's `reSnapUnresolvedAnchors`. 0 once resolved. */
  unresolvedAnchorCount: number;
  progress: number;
  busy: boolean;
  error: string | null;
  /** Screen-space cursor position (CSS px, viewport-container-relative)
   * while the tool is active — drives ui/MarginOverlay.tsx's magnifier
   * widget. `null` when the pointer is outside the viewport or the tool
   * isn't active. */
  cursorScreenPos: { xPx: number; yPx: number } | null;

  start: (restorationId: string, tooth: FdiTooth, targetNodeId: string) => void;
  setMode: (mode: MarginToolMode) => void;
  setProposing: () => void;
  setActive: (input: {
    anchors: readonly LiveMarginAnchor[];
    segments: readonly LiveMarginSegment[];
    closed: boolean;
    segmentConfidence: SegmentConfidence;
    humanEdited: boolean;
    mode: MarginToolMode;
    unresolvedAnchorCount: number;
  }) => void;
  /** Live, per-drag-frame geometry update — UNLIKE `setActive`, deliberately
   * leaves `draggingAnchorIndex`/`selectedAnchorIndex` untouched (a live drag
   * is still in progress while this fires — see engine/marginEditor.ts's
   * `updateAnchorDrag`, the sole caller). */
  setLiveGeometry: (input: { anchors: readonly LiveMarginAnchor[]; segments: readonly LiveMarginSegment[]; humanEdited: boolean }) => void;
  setBusy: (busy: boolean) => void;
  setProgress: (progress: number) => void;
  /** Records a `proposeMargin` failure's message WITHOUT leaving `'active'`
   * (see `MarginToolPhase`'s doc) — `busy`/`progress` reset the same way a
   * successful `setActive` would. */
  setError: (error: string) => void;
  setSelectedAnchorIndex: (index: number | null) => void;
  setDraggingAnchorIndex: (index: number | null) => void;
  setCursorScreenPos: (pos: { xPx: number; yPx: number } | null) => void;
  reset: () => void;
}

const INITIAL: Omit<
  MarginToolState,
  | 'start'
  | 'setMode'
  | 'setProposing'
  | 'setActive'
  | 'setLiveGeometry'
  | 'setBusy'
  | 'setProgress'
  | 'setError'
  | 'setSelectedAnchorIndex'
  | 'setDraggingAnchorIndex'
  | 'setCursorScreenPos'
  | 'reset'
> = {
  restorationId: null,
  tooth: null,
  targetNodeId: null,
  phase: 'idle',
  mode: 'auto',
  anchors: [],
  segments: [],
  closed: false,
  segmentConfidence: null,
  humanEdited: true,
  selectedAnchorIndex: null,
  draggingAnchorIndex: null,
  unresolvedAnchorCount: 0,
  progress: 0,
  busy: false,
  error: null,
  cursorScreenPos: null,
};

export const useMarginStore = create<MarginToolState>((set) => ({
  ...INITIAL,
  start: (restorationId, tooth, targetNodeId) =>
    set({
      ...INITIAL,
      restorationId,
      tooth,
      targetNodeId,
      phase: 'active',
    }),
  setMode: (mode) => set({ mode }),
  setProposing: () => set({ phase: 'proposing', busy: true, progress: 0, error: null }),
  setActive: (input) =>
    set({
      phase: 'active',
      busy: false,
      progress: 1,
      error: null,
      anchors: input.anchors,
      segments: input.segments,
      closed: input.closed,
      segmentConfidence: input.segmentConfidence,
      humanEdited: input.humanEdited,
      mode: input.mode,
      unresolvedAnchorCount: input.unresolvedAnchorCount,
      selectedAnchorIndex: null,
      draggingAnchorIndex: null,
    }),
  setLiveGeometry: (input) =>
    set({ anchors: input.anchors, segments: input.segments, humanEdited: input.humanEdited }),
  setBusy: (busy) => set({ busy }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ phase: 'active', busy: false, progress: 0, error }),
  setSelectedAnchorIndex: (selectedAnchorIndex) => set({ selectedAnchorIndex }),
  setDraggingAnchorIndex: (draggingAnchorIndex) => set({ draggingAnchorIndex }),
  setCursorScreenPos: (cursorScreenPos) => set({ cursorScreenPos }),
  reset: () => set({ ...INITIAL }),
}));
