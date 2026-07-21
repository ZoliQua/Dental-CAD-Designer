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

// ---------------------------------------------------------------------------
// Validation snapshot (Phase 3 Task 6)
//
// A LOCAL, structural-twin type — NOT imported from `@dqcad/kernel-workers`'
// `ValidateMarginResult` (this file's own layer rule, eslint.config.js's
// `boundaries/dependencies`: `state` may only import `shared-types`).
// `engine/marginEditor.ts` (which CAN import `@dqcad/kernel-workers`) is
// responsible for calling the `validateMargin` worker job and translating
// its result into this shape before publishing it here — same "duplicate
// the trivial shape at the layer boundary" convention marginEditor.ts's own
// `evaluateSurfacePointOnMesh` doc already documents for the analogous
// engine<->kernel boundary.
// ---------------------------------------------------------------------------

/** The 4 finding kinds that BLOCK confirm (CLAUDE.md gate semantics: "hard
 * failures block confirm; warnings acknowledgeable") — mirrors
 * `@dqcad/kernel`'s `MarginValidationHardFailureKind` exactly. */
export type MarginHardFailureKind = 'open' | 'selfIntersecting' | 'offSurface' | 'degenerate';

/** Live validation badge state — set by `engine/marginEditor.ts`'s
 * `refreshValidation()` (fire-and-forget after every settled commit, and
 * after loading an existing margin) and re-derived, synchronously fresh,
 * by `confirmMargin()` right before deciding whether to journal a confirm
 * (never trusts a possibly-stale badge for the actual gating decision — see
 * that method's doc). `null` while no validation has run yet for the
 * current session (e.g. between `start()` and the first `refreshValidation`
 * resolving) — the UI shows a neutral "checking" state then, never a false
 * "invalid". */
export interface MarginValidationSnapshot {
  closed: boolean;
  selfIntersecting: boolean;
  selfIntersectionCount: number;
  onSurface: boolean;
  offSurfaceCount: number;
  maxSurfaceDeviationMm: number;
  smoothnessWarningCount: number;
  degenerate: boolean;
  degenerateReasons: readonly ('tooFewAnchors' | 'zeroLength')[];
  /** Empty iff the margin can be confirmed outright. */
  hardFailureKinds: readonly MarginHardFailureKind[];
  hasWarnings: boolean;
  /** `true` iff `hardFailureKinds` is non-empty. */
  blocked: boolean;
}

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

/** One polyline of a live magnifier cross-section preview (Phase 3
 * editor-enhancement task 3) — PLANE-LOCAL 2D (u, v) mm coordinates, same
 * frame `cursorUV` (below) is expressed in, so `ui/MarginOverlay.tsx` can
 * draw both with a single, shared (u, v) -> screen-px transform without any
 * further plane math of its own. */
export interface MagnifierSectionPolyline {
  points: readonly (readonly [number, number])[];
  closed: boolean;
}

/** Live magnifier cross-section snapshot — set by
 * `engine/marginEditor.ts`'s `updateMagnifierSection()` (throttled, fired
 * from the SAME pointermove paths that already drive the magnifier's pixel
 * crop, both while HOVERING/placing a new anchor and while DRAGGING an
 * existing one — see that method's own doc) and read by
 * `ui/MarginOverlay.tsx` to render the section curve inside/beside the
 * magnifier. `null` whenever there is nothing to show yet (tool inactive,
 * cursor off the mesh, or no section run has completed for the current
 * hover/drag session). */
export interface MagnifierSectionSnapshot {
  polylines: readonly MagnifierSectionPolyline[];
  /** The query point's OWN (u, v) in the same plane-local frame as
   * `polylines` — where to draw the cursor marker (see
   * `@dqcad/kernel-workers`' `SectionMeshResult.cursorUV`'s doc for the
   * derivation). */
  cursorUV: readonly [number, number];
}

interface MarginToolState {
  restorationId: string | null;
  tooth: FdiTooth | null;
  targetNodeId: string | null;
  phase: MarginToolPhase;
  mode: MarginToolMode;
  /** Anchor-count SLIDER value (Phase 3 editor-enhancement task 1 — the
   * dentist project owner's "200+ auto-generated points are unusable... a
   * complex margin needs max 40-50, simple ones 20-30") for the NEXT
   * `runPropose()` call — read by `engine/marginEditor.ts`'s `runPropose`
   * and threaded through as `proposeMargin`'s `targetAnchorCount` job
   * param. Range/default (20-200, default 50) mirrored from
   * `engine/marginEditor.ts`'s `MARGIN_PROPOSAL_ANCHOR_COUNT_MIN/MAX/
   * DEFAULT` — those engine-side constants are the single authoritative
   * source (this field's own default literal below must stay in sync; `state/`
   * cannot import from `engine/` — CLAUDE.md's layer rule — so this is the
   * same "duplicate the literal at the layer boundary" convention this
   * file's other engine-derived defaults already follow). Only meaningful
   * while `mode === 'auto'` and no anchors exist yet (the slider is only
   * ever shown then — ui/MarginPanel.tsx). */
  proposalTargetAnchorCount: number;
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
  /** Bulk multi-select set (Phase 3 editor-enhancement task 2 — "I can't
   * delete points in groups") — populated ONLY by shift-click
   * (ui/MarginOverlay.tsx's `handlePointerUp`), independent of
   * `selectedAnchorIndex` (a PLAIN click keeps its existing single-select
   * behavior unchanged, and additionally clears this set — see
   * `setSelectedAnchorIndex`'s implementation below — so the two mechanisms
   * never fight: a plain click always starts a fresh single selection, a
   * shift-click always toggles membership in this bulk set). Read by
   * `engine/marginEditor.ts`'s `deleteSelectedAnchors()` (the coalesced
   * bulk-delete op) and by the Delete/Backspace keyboard handler
   * (ui/MarginOverlay.tsx), which prefers this set over the single
   * `selectedAnchorIndex` whenever it is non-empty. */
  selectedAnchorIndices: ReadonlySet<number>;
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
  /** Live validation badge state — see `MarginValidationSnapshot`'s doc.
   * `null` = no validation run yet this session (neutral "checking" UI
   * state, not "invalid"). */
  validation: MarginValidationSnapshot | null;
  /** `true` while a `validateMargin` worker call (either the live badge
   * refresh or `confirmMargin`'s own fresh check) is in flight. */
  validationBusy: boolean;
  /** `true` immediately after a successful `confirmMargin()` call, for
   * whichever anchor state was confirmed — reset to `false` by ANY further
   * commit-worthy edit (engine/marginEditor.ts's `commit()`), since a new
   * edit invalidates the prior confirmation. */
  confirmed: boolean;
  /** Live magnifier cross-section preview — see `MagnifierSectionSnapshot`'s
   * doc. `null` whenever there's nothing to show (tool inactive, cursor off
   * the mesh, or the throttled `sectionMesh` request hasn't resolved yet for
   * the current hover/drag position). */
  magnifierSection: MagnifierSectionSnapshot | null;

  start: (restorationId: string, tooth: FdiTooth, targetNodeId: string) => void;
  setMode: (mode: MarginToolMode) => void;
  setProposalTargetAnchorCount: (count: number) => void;
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
  /** Plain single-select (existing behavior, UNCHANGED) — additionally
   * clears `selectedAnchorIndices` (see that field's doc: a plain click
   * always starts a fresh selection, dropping any bulk multi-select). */
  setSelectedAnchorIndex: (index: number | null) => void;
  /** Shift-click toggle (Phase 3 editor-enhancement task 2) — adds/removes
   * `index` from `selectedAnchorIndices` without touching
   * `selectedAnchorIndex`. */
  toggleAnchorSelection: (index: number) => void;
  /** Empties `selectedAnchorIndices` — called after a bulk delete commits,
   * and by `setActive`/`reset` (a fresh anchor set invalidates any prior
   * selection, same as `selectedAnchorIndex`'s own reset there). */
  clearAnchorSelection: () => void;
  setDraggingAnchorIndex: (index: number | null) => void;
  setCursorScreenPos: (pos: { xPx: number; yPx: number } | null) => void;
  setValidation: (validation: MarginValidationSnapshot | null) => void;
  setValidationBusy: (busy: boolean) => void;
  setConfirmed: (confirmed: boolean) => void;
  setMagnifierSection: (section: MagnifierSectionSnapshot | null) => void;
  reset: () => void;
}

const INITIAL: Omit<
  MarginToolState,
  | 'start'
  | 'setMode'
  | 'setProposalTargetAnchorCount'
  | 'setProposing'
  | 'setActive'
  | 'setLiveGeometry'
  | 'setBusy'
  | 'setProgress'
  | 'setError'
  | 'setSelectedAnchorIndex'
  | 'toggleAnchorSelection'
  | 'clearAnchorSelection'
  | 'setDraggingAnchorIndex'
  | 'setCursorScreenPos'
  | 'setValidation'
  | 'setValidationBusy'
  | 'setConfirmed'
  | 'setMagnifierSection'
  | 'reset'
> = {
  restorationId: null,
  tooth: null,
  targetNodeId: null,
  phase: 'idle',
  mode: 'auto',
  // Default 50 — NOT the dentist project owner's literal "suggest 30"
  // comfort figure: the measured 30-anchor fidelity cost on the real golden
  // case exceeds this task's own 50µm mean-deviation guardrail (test/golden/
  // margin-anchor-count-fidelity.test.ts has the numbers); 50 is the lowest
  // slider value measured under it. See `engine/marginEditor.ts`'s
  // `MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT` (authoritative; kept in sync by
  // hand, per this field's own doc).
  proposalTargetAnchorCount: 50,
  anchors: [],
  segments: [],
  closed: false,
  segmentConfidence: null,
  humanEdited: true,
  selectedAnchorIndex: null,
  selectedAnchorIndices: new Set(),
  draggingAnchorIndex: null,
  unresolvedAnchorCount: 0,
  progress: 0,
  busy: false,
  error: null,
  cursorScreenPos: null,
  validation: null,
  validationBusy: false,
  confirmed: false,
  magnifierSection: null,
};

export const useMarginStore = create<MarginToolState>((set) => ({
  ...INITIAL,
  start: (restorationId, tooth, targetNodeId) =>
    // `proposalTargetAnchorCount` deliberately SURVIVES both `start` and
    // `reset` (unlike every other field): the motivating workflow is the
    // dentist project owner's own "especially with 10 prepped teeth" — a
    // user who dialed in their preferred anchor count for tooth 1 should
    // not have to re-dial it for teeth 2-10 (the value is journaled per
    // proposal anyway, so nothing about reproducibility depends on when it
    // resets). It still returns to the default on a full page reload (this
    // store is in-memory only, deliberately not persisted).
    set((state) => ({
      ...INITIAL,
      proposalTargetAnchorCount: state.proposalTargetAnchorCount,
      restorationId,
      tooth,
      targetNodeId,
      phase: 'active',
    })),
  setMode: (mode) => set({ mode }),
  setProposalTargetAnchorCount: (proposalTargetAnchorCount) => set({ proposalTargetAnchorCount }),
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
      selectedAnchorIndices: new Set(),
      draggingAnchorIndex: null,
    }),
  setLiveGeometry: (input) =>
    set({ anchors: input.anchors, segments: input.segments, humanEdited: input.humanEdited }),
  setBusy: (busy) => set({ busy }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ phase: 'active', busy: false, progress: 0, error }),
  setSelectedAnchorIndex: (selectedAnchorIndex) => set({ selectedAnchorIndex, selectedAnchorIndices: new Set() }),
  toggleAnchorSelection: (index) =>
    set((state) => {
      const next = new Set(state.selectedAnchorIndices);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { selectedAnchorIndices: next };
    }),
  clearAnchorSelection: () => set({ selectedAnchorIndices: new Set() }),
  setDraggingAnchorIndex: (draggingAnchorIndex) => set({ draggingAnchorIndex }),
  setCursorScreenPos: (cursorScreenPos) => set({ cursorScreenPos }),
  setValidation: (validation) => set({ validation }),
  setValidationBusy: (validationBusy) => set({ validationBusy }),
  setConfirmed: (confirmed) => set({ confirmed }),
  setMagnifierSection: (magnifierSection) => set({ magnifierSection }),
  // Preserves `proposalTargetAnchorCount` — see `start`'s own comment.
  reset: () => set((state) => ({ ...INITIAL, proposalTargetAnchorCount: state.proposalTargetAnchorCount })),
}));
