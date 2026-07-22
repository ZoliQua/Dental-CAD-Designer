// apps/client/src/engine/marginEditor.ts
//
// Margin editor tool orchestration (Phase 3 Task 5). Same "engine owns,
// state mirrors, ui subscribes" pattern as engine/alignment.ts — this class
// is the sole writer of state/marginStore.ts and the sole caller of the
// `proposeMargin`/`geodesicPath`/`snapPolyline`/`raycastMesh` kernel-worker
// jobs for margin editing.
//
// ## Curve representation (a documented design decision)
//
// The live, editable margin curve — for BOTH auto-propose and manual-trace
// modes — is a GEODESIC-SNAPPED anchor chain: an ordered `LiveMarginAnchor[]`
// joined by `LiveMarginSegment`s, each the EXACT shortest on-surface path
// between two consecutive anchors (`geodesicPath`/`snapPolyline`, @dqcad/
// kernel's geodesic/ module — already proven < 100ms per segment on the real
// 250k-tri upperjaw, Phase 2 Task 4). This module deliberately does NOT use
// `fitSurfaceSpline`/`refitSurfaceSplineControlPoint` (also available per
// this task's brief) for the LIVE editing representation: a margin line
// should hug the actual scanned anatomy exactly, not a smoothed
// interpolant that can bow away from the surface between sparse anchors
// (`SurfaceSpline.maxAmbientDeviationMm` is a real, non-zero deviation by
// construction — see kernel/src/spline/surfaceSpline.ts's own `@errorBound`
// doc) — CLAUDE.md's "accuracy over speed" rule favors the EXACT geodesic
// chain here, and `proposeMargin`'s own anchor density (curvature-adaptive,
// ~200-300 anchors for a real ~30mm margin — Phase 3 Task 4's report) is
// already dense enough that consecutive geodesic segments read as a smooth
// curve visually. Every `proposeMargin` anchor becomes its own draggable
// handle + a between-anchor geodesic segment; `fitSurfaceSpline` stays an
// available, documented, UNUSED seam for a future task that wants a
// genuinely smoothed overlay.
//
// ## Commit model (a documented design decision — see this task's report for
// the full reasoning)
//
// Nothing is written to `restoration.marginLines[tooth]` / journaled until
// an explicit, named "commit-worthy" action completes:
//   - `acceptProposal()` — accept a fresh auto-proposal unedited.
//   - `toggleClosed()` (closing, ≥ 3 anchors) / `saveOpenTrace()` (≥ 2
//     anchors) — finish an initial freehand manual placement session (the
//     FIRST commit for a from-scratch trace).
//   - `endAnchorDrag()`, `addAnchorOnSegment()`, `deleteSelectedAnchor()`,
//     `toggleClosed()` (on an already-established curve),
//     `reSnapUnresolvedAnchors()` — each its own gesture.
// Once a tooth's margin has been committed at least once (either loaded from
// a persisted document, or committed earlier this session), EVERY further
// gesture — including plain anchor placement while extending an open curve —
// commits immediately (there is an established baseline worth protecting).
// Before the first commit, placement clicks and live drag-preview frames
// update ONLY the in-memory store (`useMarginStore`) — never caseStore/the
// journal — satisfying this task's "no per-mousemove spam" / "ONE coalesced
// op per completed gesture" guardrail literally for every named gesture
// while avoiding one-journal-entry-per-click during freehand tracing.
//
// T5 REVIEW FIX (T8 reproducibility): whichever gesture turns out to be a
// session's FIRST commit ALSO carries `params.seed`/`params.proposalDefaults`
// when that session started from a successful auto-proposal — regardless of
// whether that first commit is `acceptProposal()` or something else entirely
// (e.g. dragging a misplaced anchor immediately after a proposal, never
// clicking Accept). See `commit()`'s own doc for the exact session-state
// gate this uses.
import type {
  FdiTooth,
  MarginAnchor,
  MarginLine,
  MarginReferenceExport,
  Operation,
  Restoration,
  Vec3,
} from '@dqcad/shared-types';
import {
  KERNEL_VERSION,
  MARGIN_SEARCH_RADIUS_MM,
  NoClosureError,
  NoRidgeFoundError,
  type ProposeMarginResult,
  type MarginLinePayload,
  type ValidateMarginResult,
  type SectionMeshResult,
} from '@dqcad/kernel-workers';
import { APP_VERSION } from '../appVersion';
import {
  useMarginStore,
  type LiveMarginAnchor,
  type LiveMarginSegment,
  type MarginToolMode,
  type SegmentConfidence,
  type MarginValidationSnapshot,
  type MarginHardFailureKind,
  type MagnifierSectionSnapshot,
} from '../state/marginStore';
import { UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX } from './caseDocumentMigration';
import { caseStore } from './caseStore';
import type { EngineMeshRecord } from './meshStore';
import { ensureBvhBuilt, getPool } from './workers';

/** Below this, a segment is flagged "weak" (deliverable 4). `proposeMargin`'s
 * confidence is `ridgeMean / (ridgeMean + backgroundMean)` (@dqcad/kernel's
 * `marginRidge.ts`) — 0.5 is the PRINCIPLED threshold, not an arbitrary pick:
 * it is exactly the point where the ridge signal along a segment equals the
 * local background (i.e. "no better than noise"), not merely a low number. */
export const MARGIN_WEAK_CONFIDENCE_THRESHOLD = 0.5;

/** Anchor-count slider range/default (Phase 3 editor-enhancement task 1 —
 * the dentist project owner's own stated ranges: "a complex margin needs
 * max 40-50, simple ones 20-30", "especially with 10 prepped teeth" — a
 * user cannot usefully drag 200+ points). `MIN` 20 / `MAX` 200 are the
 * brief's own literal slider bounds (the dentist can still freely choose 30
 * or lower for a case they judge acceptable).
 *
 * `DEFAULT` is 50, NOT the dentist's own literal "suggest 30" comfort
 * figure — a deliberate, MEASURED override (test/golden/
 * margin-anchor-count-fidelity.test.ts, run against the real golden
 * tooth-11 proposal): the resampled-polyline deviation between a sparser
 * anchor set's geodesic chain and the dense 261-anchor reference curve
 * measured mean=71.05um/max=266.45um at target=20, mean=67.56um/
 * max=272.93um at target=30, and mean=54.63um/max=288.89um at target=40 —
 * ALL exceeding this task's own 50um mean-deviation guardrail on this real,
 * clinically-challenging fixture. Only target=50 crosses under it
 * (mean=40.89um/max=222.80um). Per the brief's own explicit instruction
 * ("if thinning anchors materially degrades the dense curve (>50µm), say so
 * and cap the default slider suggestion accordingly"), this measured result
 * — not the dentist's own unvalidated guess — sets the shipped default. See
 * that test file's own module doc for the full table and discussion. */
export const MARGIN_PROPOSAL_ANCHOR_COUNT_MIN = 20;
export const MARGIN_PROPOSAL_ANCHOR_COUNT_MAX = 200;
export const MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT = 50;

/** ROI radius (mm) for `updateMagnifierSection`'s `sectionMesh` query
 * (Phase 3 editor-enhancement task 3) — generously larger than the
 * magnifier's own visible footprint at comfortable zoom
 * (ui/MarginOverlay.tsx's `MAGNIFIER_SOURCE_CROP_PX` samples a small
 * screen-space patch, typically well under this many mm of real surface for
 * a several-mm-scale prep) so the rendered section is never visibly
 * truncated by the ROI boundary in normal use, while still measurably
 * cheaper than a full-mesh query (this task's report:
 * `sectionMeshRoiPerf.test.ts`, kernel-workers, measured ~0.44-0.49x the
 * full-mesh cost on the real 250k-tri upperjaw at this radius). NOT a
 * clinical parameter (CLAUDE.md's clinical-profiles rule doesn't apply — a
 * display-only preview radius, same "kernel/UX algorithmic default, not a
 * clinical one" precedent as `MARGIN_SEARCH_RADIUS_MM`). */
export const MARGIN_SECTION_PREVIEW_ROI_RADIUS_MM = 4;

/** Minimum wall-clock interval (ms) between magnifier cross-section run
 * STARTS (`updateMagnifierSection`'s throttle — see `pumpMagnifierSection`'s
 * doc for the two-layer design and why the floor exists at all: protecting
 * the drag-latency budget on the shared affinity worker, this task's report
 * has the measured numbers). 100ms = 10 previews/s — comfortably fluid for
 * a positioning aid (the preview is meant to be read while the hand slows
 * down near the target, not tracked at pointer speed), while capping the
 * section work at ~1/10th of the pointermove rate. Display-only timing —
 * never journaled, never part of any geometry computation. */
export const MAGNIFIER_SECTION_MIN_INTERVAL_MS = 100;

export type MarginErrorKind = 'noRidgeFound' | 'noClosure' | 'other';

/** `confirmMargin()`'s return shape — see that method's doc. `ok: true`
 * means the confirm was journaled; `ok: false` + `requiresAcknowledgement:
 * true` means the caller must re-invoke with `{ acknowledgeWarnings: true
 * }` after presenting the warnings to the user; `ok: false` + `blocked:
 * true` means a hard failure exists and confirm cannot proceed at all
 * (`hardFailureKinds` has the reasons — the UI badge already shows these
 * live via `marginStore.validation`, this is the same data echoed back for
 * a caller that only wants the outcome of ITS OWN confirm attempt).
 *
 * `stale` (Task-11-review Critical 3): `true` when a NEWER edit (a drag
 * commit, or any other `commit()`-going gesture) landed on this tooth's
 * `marginLines` entry WHILE this call's validation round trip was in
 * flight, or a drag is actively in progress the instant validation
 * resolves. In that case `confirmMargin` does NOT journal anything (the
 * validation snapshot it just computed no longer describes the CURRENT
 * geometry, so journaling a confirm against it would be dishonest) — the
 * concurrent commit itself is already safely journaled by `commit()`
 * regardless, so nothing is lost; the caller is expected to simply retry
 * (call `confirmMargin` again), which validates the fresh anchors
 * correctly. `ok` is `false` whenever `stale` is `true`. */
export interface MarginConfirmOutcome {
  ok: boolean;
  requiresAcknowledgement: boolean;
  blocked: boolean;
  hardFailureKinds: readonly MarginHardFailureKind[];
  hasWarnings: boolean;
  stale: boolean;
}

/** Translates a `validateMargin` worker job result (`@dqcad/kernel-workers`'
 * `ValidateMarginResult`, structurally identical to `@dqcad/kernel`'s
 * `MarginValidationReport`) into `state/marginStore.ts`'s local
 * `MarginValidationSnapshot` — the classification logic here is a
 * DELIBERATE, small duplication of `@dqcad/kernel`'s own
 * `classifyMarginValidation` (margin/validate.ts): `engine/` cannot import
 * `@dqcad/kernel` directly (CLAUDE.md layer rule: `engine -> kernel-workers
 * | state | shared-types`), so this is the same "duplicate the trivial
 * shape/logic at a layer boundary" convention this file's own
 * `evaluateSurfacePointOnMesh` doc already documents — the RULE (hard
 * failures = open/selfIntersecting/offSurface/degenerate; smoothness is
 * warning-only) is a 4-line `if` chain, not real logic drift risk. */
function classifyValidationResult(result: ValidateMarginResult): MarginValidationSnapshot {
  const hardFailureKinds: MarginHardFailureKind[] = [];
  if (!result.closed) hardFailureKinds.push('open');
  if (result.selfIntersecting) hardFailureKinds.push('selfIntersecting');
  if (!result.onSurface) hardFailureKinds.push('offSurface');
  if (result.degenerate) hardFailureKinds.push('degenerate');
  return {
    closed: result.closed,
    selfIntersecting: result.selfIntersecting,
    selfIntersectionCount: result.selfIntersections.length,
    onSurface: result.onSurface,
    offSurfaceCount: result.offSurfacePoints.length,
    maxSurfaceDeviationMm: result.maxSurfaceDeviationMm,
    smoothnessWarningCount: result.smoothnessWarnings.length,
    degenerate: result.degenerate,
    degenerateReasons: result.degenerateReasons,
    hardFailureKinds,
    hasWarnings: result.smoothnessWarnings.length > 0,
    blocked: hardFailureKinds.length > 0,
  };
}

export interface MarginPickRequest {
  rayOrigin: Vec3;
  rayDirection: Vec3;
}

interface RayHit {
  point: Vec3;
  triangleIndex: number;
  barycentric: readonly [number, number, number];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Barycentric interpolation of a mesh's own Float64 master vertex
 * positions — the local, structural-twin equivalent of `@dqcad/kernel`'s
 * `evaluateSurfacePoint` (kept here, not imported, because `engine/` may
 * depend on `@dqcad/kernel-workers` but NOT `@dqcad/kernel` directly — see
 * CLAUDE.md's layer rule; this is the exact same "duplicate the trivial pure
 * math" convention `packages/kernel/src/spline/marginLine.ts`'s own module
 * doc documents for the analogous kernel<->shared-types boundary). */
function evaluateSurfacePointOnMesh(
  record: EngineMeshRecord,
  triangleIndex: number,
  barycentric: readonly [number, number, number],
): Vec3 {
  const i0 = record.indices[triangleIndex * 3]!;
  const i1 = record.indices[triangleIndex * 3 + 1]!;
  const i2 = record.indices[triangleIndex * 3 + 2]!;
  const [b0, b1, b2] = barycentric;
  const p = record.positions;
  return [
    b0 * p[i0 * 3]! + b1 * p[i1 * 3]! + b2 * p[i2 * 3]!,
    b0 * p[i0 * 3 + 1]! + b1 * p[i1 * 3 + 1]! + b2 * p[i2 * 3 + 1]!,
    b0 * p[i0 * 3 + 2]! + b1 * p[i1 * 3 + 2]! + b2 * p[i2 * 3 + 2]!,
  ];
}

/** SHA-256 hex of a flat Float64 anchor-position buffer — the "resulting
 * anchors hash" this task's brief asks each `margin-edit` Operation to
 * record in `outputHashes[0]`. Web Crypto (`crypto.subtle`), not a
 * kernel-workers job: this hashes at most a few hundred numbers (an anchor
 * LIST, not a quarter-million-vertex mesh) — a genuinely different scale
 * from the mesh-hashing-off-main-thread concern that motivated moving mesh
 * hashing into a worker (Phase 2 Task 1); `crypto.subtle.digest` is
 * inherently async regardless, so this stays a Promise for correctness, not
 * for perf. */
async function hashAnchorPositionsHex(anchors: readonly LiveMarginAnchor[]): Promise<string> {
  const flat = new Float64Array(anchors.length * 3);
  anchors.forEach((a, i) => {
    flat[i * 3] = a.position[0];
    flat[i * 3 + 1] = a.position[1];
    flat[i * 3 + 2] = a.position[2];
  });
  const digest = await crypto.subtle.digest('SHA-256', flat.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Exported (with `summarizeAnchorDiff`/`planAnchorDeletion`/
 * `rebuildSegmentsAfterDeletion`/`nearestSegmentIndex` below) specifically so
 * this task's "margin-tool state machine (pure gesture logic)" node-lane
 * tests (marginEditor.test.ts) can exercise the tricky INDEX MATH directly,
 * without a worker/kernel round trip — see this module's top doc. */
export interface AnchorDiffSummary {
  previousCount: number;
  nextCount: number;
  added: number;
  removed: number;
  /** Only meaningful when `added === 0 && removed === 0` — how many anchors
   * at the same index changed position (e.g. a drag). */
  moved: number;
}

export function summarizeAnchorDiff(previous: readonly MarginAnchor[], next: readonly LiveMarginAnchor[]): AnchorDiffSummary {
  const added = Math.max(0, next.length - previous.length);
  const removed = Math.max(0, previous.length - next.length);
  let moved = 0;
  if (added === 0 && removed === 0) {
    for (let i = 0; i < next.length; i++) {
      const a = previous[i]!.position;
      const b = next[i]!.position;
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) moved++;
    }
  }
  return { previousCount: previous.length, nextCount: next.length, added, removed, moved };
}

function flattenLiveAnchor(a: LiveMarginAnchor): MarginAnchor {
  return { position: a.position, triangleIndex: a.triangleIndex, barycentric: a.barycentric };
}

/** Dense display polyline (`MarginLine.resampledPoints`) — every segment's
 * sampled points concatenated, closing-segment included when `closed`. Not
 * authoritative (`anchors` is) — see `MarginLine`'s own doc. */
function flattenResampledPoints(segments: readonly LiveMarginSegment[]): Vec3[] {
  const out: Vec3[] = [];
  segments.forEach((segment) => {
    segment.points.forEach((p) => out.push(p));
  });
  return out;
}

class MarginEditorEngine {
  /** Whether THIS session has already committed at least once for the
   * tooth currently being edited (either loaded already-saved, or committed
   * during this session) — see this module's top doc, "Commit model". */
  private hasCommittedThisSession = false;
  /** Guards against a stale, superseded drag-preview response clobbering a
   * newer one — same "generation counter" pattern as engine/curvature.ts. */
  private dragGeneration = 0;
  /** The last settled (or in-flight) drag computation for the anchor
   * currently being dragged — `endAnchorDrag` awaits this so it always
   * commits the FINAL, freshest geometry rather than racing it. */
  private pendingDrag: Promise<{ anchors: LiveMarginAnchor[]; segments: LiveMarginSegment[] }> | null = null;

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  /** Begins (or resumes) editing `tooth`'s margin line on `restorationId`.
   * @throws {Error} if the restoration doesn't exist or has no assigned
   * target scan yet (Phase 3 Task 2's wizard step). */
  startForTooth(restorationId: string, tooth: FdiTooth): void {
    const restoration = this.findRestoration(restorationId);
    if (!restoration) {
      throw new Error(`marginEditor.startForTooth: no restoration registered for id ${restorationId}`);
    }
    if (!restoration.targetNodeId) {
      throw new Error('marginEditor.startForTooth: restoration has no assigned target scan yet');
    }
    useMarginStore.getState().start(restorationId, tooth, restoration.targetNodeId);
    const existing = restoration.marginLines[tooth];
    this.hasCommittedThisSession = existing !== undefined;
    if (!existing) {
      return;
    }
    const unresolvedAnchorCount = existing.anchors.filter(
      (a) => a.triangleIndex === UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX,
    ).length;
    const anchors: LiveMarginAnchor[] = existing.anchors.map((a) => ({
      position: a.position,
      triangleIndex: a.triangleIndex,
      barycentric: a.barycentric,
    }));
    if (unresolvedAnchorCount > 0) {
      // Degraded display ONLY (straight lines between the still-trustworthy
      // `position` echoes) — never a geodesic kernel call against a bogus
      // triangleIndex. See `reSnapUnresolvedAnchors` for the explicit,
      // non-silent fix action (CLAUDE.md invariant 5).
      useMarginStore.getState().setActive({
        anchors,
        segments: this.straightLineSegments(anchors, existing.closed),
        closed: existing.closed,
        segmentConfidence: null,
        humanEdited: true,
        mode: 'manual',
        unresolvedAnchorCount,
      });
      return;
    }
    void this.resolveAndPublish(anchors, existing.closed, null, true, 'manual');
  }

  /** Aborts the current editing session — any UNCOMMITTED local draft
   * (manual placement pre-first-commit, or an in-flight drag preview) is
   * discarded; anything already committed this session stays in the
   * document (journal is append-only — see this module's top doc). */
  cancel(): void {
    this.pendingDrag = null;
    // Invalidate any in-flight magnifier-section job (its late result must
    // not re-publish a snapshot into the now-reset store), drop any
    // coalesced pending request, and disarm the throttle timer.
    this.clearMagnifierSection();
    useMarginStore.getState().reset();
  }

  setMode(mode: MarginToolMode): void {
    useMarginStore.getState().setMode(mode);
  }

  /** Sets the anchor-count SLIDER value (Phase 3 editor-enhancement task 1)
   * for the NEXT `runPropose()` call — see `marginStore.
   * proposalTargetAnchorCount`'s doc. Clamps to
   * `[MARGIN_PROPOSAL_ANCHOR_COUNT_MIN, MARGIN_PROPOSAL_ANCHOR_COUNT_MAX]`
   * (defense in depth — ui/MarginPanel.tsx's `<input type="range">` already
   * enforces this range natively). */
  setProposalTargetAnchorCount(count: number): void {
    const clamped = Math.round(Math.min(MARGIN_PROPOSAL_ANCHOR_COUNT_MAX, Math.max(MARGIN_PROPOSAL_ANCHOR_COUNT_MIN, count)));
    useMarginStore.getState().setProposalTargetAnchorCount(clamped);
  }

  selectAnchor(index: number | null): void {
    useMarginStore.getState().setSelectedAnchorIndex(index);
  }

  /** Shift-click multi-select toggle (Phase 3 editor-enhancement task 2) —
   * see `marginStore.selectedAnchorIndices`'s own doc for why this is a
   * SEPARATE mechanism from `selectAnchor`'s plain single-select, not a
   * modifier flag on it. */
  toggleAnchorSelection(index: number): void {
    const store = useMarginStore.getState();
    if (index < 0 || index >= store.anchors.length) return;
    useMarginStore.getState().toggleAnchorSelection(index);
  }

  setCursorScreenPos(pos: { xPx: number; yPx: number } | null): void {
    useMarginStore.getState().setCursorScreenPos(pos);
  }

  /** TEST-ONLY: mirrors alignmentEngine.resetForTests()'s convention.
   * Unlike a production `reset()`, ALSO restores the anchor-count slider to
   * its default (`marginStore.reset` deliberately preserves it across
   * sessions — see that store's `start` comment — but tests must not leak a
   * previous test's slider value into the next). */
  resetForTests(): void {
    this.hasCommittedThisSession = false;
    this.dragGeneration = 0;
    this.pendingDrag = null;
    this.lastProposalSeed = null;
    this.lastProposalTargetAnchorCount = null;
    this.clearMagnifierSection();
    this.lastMagnifierSectionStartMs = -Infinity;
    useMarginStore.getState().reset();
    useMarginStore.getState().setProposalTargetAnchorCount(MARGIN_PROPOSAL_ANCHOR_COUNT_DEFAULT);
  }

  // ---------------------------------------------------------------------
  // Picking (viewport clicks) — see this module's top doc for routing
  // ---------------------------------------------------------------------

  /**
   * Handles one margin-tool viewport click (world frame — ui/Viewport.tsx
   * converts from SceneManager's render frame via engine/marginFrame.ts's
   * `toWorldRay`, exactly like ToolManager.ts/alignmentEngine). Routes to
   * seed-propose / append-anchor / add-anchor-on-segment depending on
   * current store state — see this module's top doc.
   */
  async handlePick(request: MarginPickRequest): Promise<void> {
    const store = useMarginStore.getState();
    if (store.phase !== 'active' || store.busy) return;
    if (store.unresolvedAnchorCount > 0) return; // must re-snap first
    const hit = await this.raycastTarget(request.rayOrigin, request.rayDirection);
    if (!hit) return;

    if (store.mode === 'auto' && store.anchors.length === 0) {
      await this.runPropose(hit);
      return;
    }
    // Task 5 review item 4b: re-check `busy` HERE, after the raycast's own
    // await, and hold it for the duration of the manual-placement gesture
    // below. The check at the top of this method (before the raycast) is
    // NOT enough on its own: two `handlePick` calls fired back-to-back
    // (without awaiting the first) both pass that check while `busy` is
    // still `false`, then both suspend on their own `raycastTarget` await —
    // without a SECOND check here, both would go on to call
    // `appendAnchor`/`addAnchorOnSegment` concurrently, each reading its own
    // now-stale snapshot of `store.anchors`/`segments` and racing to
    // `setActive`/commit, silently losing whichever call's write loses the
    // race (a real "lost anchor" bug, not merely a redundant duplicate
    // click). There is no `await` between this check and `setBusy(true)`,
    // so the two together are atomic w.r.t. any other `handlePick` call's
    // continuation. The `finally` guarantees `busy` is released even if
    // `targetContentHashOrThrow`/the placement call throws synchronously,
    // rather than leaving the tool permanently stuck.
    if (useMarginStore.getState().busy) return;
    useMarginStore.getState().setBusy(true);
    try {
      if (!store.closed) {
        await this.appendAnchor(hit);
        return;
      }
      await this.addAnchorOnSegment(hit);
    } finally {
      useMarginStore.getState().setBusy(false);
    }
  }

  /**
   * DEV/TEST-ONLY: seeds auto-propose directly from a known
   * `(triangleIndex, barycentric)` surface location, bypassing the
   * viewport-ray raycast step `handlePick` normally performs first
   * (`raycastTarget` — itself a thin wrapper around the `raycastMesh`
   * worker job, already covered on its own by
   * `packages/kernel-workers/src/bvhJobs.test.ts` and
   * e2e/phase1.spec.ts's point-to-point measurement test). Exists because a
   * real screen-pixel click cannot reliably land on the sub-millimeter seed
   * location a margin proposal needs on a real, dense, ~250k-triangle
   * clinical scan at whole-arch camera framing (curvature-ridge walk seeds
   * are sensitive to which triangle they land on — see
   * `packages/kernel/src/margin/marginRidge.ts`'s own module doc) — see
   * e2e/phase3.spec.ts's top doc for the full reasoning and how the
   * `(triangleIndex, barycentric)` seed passed in is itself derived
   * (reusing `scripts/margin-acceptance.ts`'s own "ambient centroid of a
   * committed hand-traced reference, `snapToSurface`-projected" method).
   * Everything downstream of the seed — the real curvature-ridge walk
   * (`proposeMargin` worker job), geodesic segment resampling, journal
   * commit — runs completely for real, unmodified; only the "which
   * triangle did this ray hit" step is skipped. Only ever called from
   * `engine/testHooks.ts`, itself only installed in DEV builds (see that
   * module's doc) — never reachable from a production build or from any
   * other production code path.
   */
  async seedProposeForTest(triangleIndex: number, barycentric: readonly [number, number, number]): Promise<void> {
    const store = useMarginStore.getState();
    if (store.phase !== 'active' || store.busy) return;
    if (store.mode !== 'auto' || store.anchors.length !== 0) return;
    const record = this.targetRecordOrThrow();
    const point = evaluateSurfacePointOnMesh(record, triangleIndex, barycentric);
    await this.runPropose({ point, triangleIndex, barycentric });
  }

  // ---------------------------------------------------------------------
  // Auto-propose
  // ---------------------------------------------------------------------

  private async runPropose(seed: RayHit): Promise<void> {
    const contentHash = this.targetContentHashOrThrow();
    // Phase 3 editor-enhancement task 1: the panel's anchor-count slider
    // (`marginStore.proposalTargetAnchorCount`) is read HERE, at the
    // moment propose actually runs — not earlier — so a slider change made
    // right up until the seed click still applies (the slider is only ever
    // shown before any anchor exists, per ui/MarginPanel.tsx, so there is
    // no "propose already ran, slider still visible" race to worry about).
    const targetAnchorCount = useMarginStore.getState().proposalTargetAnchorCount;
    useMarginStore.getState().setProposing();
    try {
      await ensureBvhBuilt(contentHash, this.targetRecordOrThrow().positions, this.targetRecordOrThrow().indices);
      const result: ProposeMarginResult = await getPool().run(
        'proposeMargin',
        { contentHash, seed: { triangleIndex: seed.triangleIndex, barycentric: seed.barycentric }, targetAnchorCount },
        {
          affinityKey: contentHash,
          onProgress: (fraction) => {
            if (useMarginStore.getState().phase === 'proposing') useMarginStore.getState().setProgress(fraction);
          },
        },
      );
      const record = this.targetRecordOrThrow();
      const anchors: LiveMarginAnchor[] = [];
      for (let i = 0; i < result.triangleIndices.length; i++) {
        const triangleIndex = result.triangleIndices[i]!;
        const barycentric: readonly [number, number, number] = [
          result.barycentric[i * 3]!,
          result.barycentric[i * 3 + 1]!,
          result.barycentric[i * 3 + 2]!,
        ];
        anchors.push({ triangleIndex, barycentric, position: evaluateSurfacePointOnMesh(record, triangleIndex, barycentric) });
      }
      const segmentConfidence: SegmentConfidence = Array.from(result.segmentConfidence);
      const segments = await this.geodesicSegmentsForClosedLoop(anchors, contentHash);
      this.lastProposalSeed = seed;
      this.lastProposalTargetAnchorCount = targetAnchorCount;
      useMarginStore.getState().setActive({
        anchors,
        segments,
        closed: true,
        segmentConfidence,
        humanEdited: false,
        mode: 'auto',
        unresolvedAnchorCount: 0,
      });
    } catch (error) {
      this.handleProposeError(error);
    }
  }

  private lastProposalSeed: RayHit | null = null;
  /** Mirrors `lastProposalSeed`'s own "captured at propose time, attached to
   * whichever gesture turns out to be the session's FIRST commit" pattern —
   * see `commit()`'s `seedParams` doc. */
  private lastProposalTargetAnchorCount: number | null = null;

  private handleProposeError(error: unknown): void {
    const isNoRidge = error instanceof NoRidgeFoundError || (error instanceof Error && error.name === 'NoRidgeFoundError');
    const isNoClosure = error instanceof NoClosureError || (error instanceof Error && error.name === 'NoClosureError');
    const kind: MarginErrorKind = isNoRidge ? 'noRidgeFound' : isNoClosure ? 'noClosure' : 'other';
    const message = error instanceof Error ? error.message : String(error);
    // Typed errors carry no partial loop (verified against @dqcad/kernel's
    // NoRidgeFoundError/NoClosureError — see this module's top doc and this
    // task's report) — nothing to discard beyond leaving `anchors` empty,
    // which they already are (propose only ever runs from a 0-anchor state).
    // `setError` keeps `phase: 'active'` (marginStore.ts's `MarginToolPhase`
    // doc) — the session (restorationId/tooth/targetNodeId) is untouched, so
    // no need to re-run `start()`; just switch to manual mode and surface
    // the message, leaving the tool immediately clickable again.
    useMarginStore.getState().setMode('manual');
    useMarginStore.getState().setError(message);
    this.errorKind = kind;
  }

  /** Not part of the store's typed setter surface (kept as a plain engine
   * field, read by ui/MarginPanel.tsx via `marginEditor.getErrorKind()`) —
   * avoids growing marginStore's action surface for a value that is 1:1 with
   * `error` and only ever read alongside it. */
  private errorKind: MarginErrorKind | null = null;
  getErrorKind(): MarginErrorKind | null {
    return this.errorKind;
  }

  /** Commits the current live proposal UNEDITED. No-op if there's nothing
   * to accept (already committed / not in 'auto' proposal state). */
  async acceptProposal(): Promise<void> {
    const store = useMarginStore.getState();
    if (store.phase !== 'active' || store.anchors.length === 0) return;
    // Task 5 review item 1: seed/proposalDefaults are no longer attached
    // HERE — `commit()` itself attaches them to whichever gesture turns out
    // to be the FIRST commit of an auto-proposed session (see its own doc).
    // This call is very often exactly that first commit (an unedited
    // accept), so it still ends up carrying them — just via the same
    // session-state gate every other gesture goes through, not a
    // call-site special case.
    await this.commit(store.anchors, store.segments, store.closed, store.segmentConfidence, false, 'auto-propose', {});
  }

  // ---------------------------------------------------------------------
  // Manual placement
  // ---------------------------------------------------------------------

  private async appendAnchor(hit: RayHit): Promise<void> {
    const store = useMarginStore.getState();
    const contentHash = this.targetContentHashOrThrow();
    const newAnchor: LiveMarginAnchor = { position: hit.point, triangleIndex: hit.triangleIndex, barycentric: hit.barycentric };
    const anchors = [...store.anchors, newAnchor];
    const segments = [...store.segments];
    if (store.anchors.length > 0) {
      const prev = store.anchors[store.anchors.length - 1]!;
      segments.push(await this.geodesicSegmentBetween(prev, newAnchor, contentHash));
    }
    if (this.hasCommittedThisSession) {
      await this.commit(anchors, segments, false, null, true, 'append-anchor', {});
      return;
    }
    useMarginStore.getState().setActive({
      anchors,
      segments,
      closed: false,
      segmentConfidence: null,
      humanEdited: true,
      mode: 'manual',
      unresolvedAnchorCount: 0,
    });
  }

  /** Explicitly saves the CURRENT open trace as-is (≥ 2 anchors) — the
   * "first commit" boundary for a from-scratch manual trace that the user
   * deliberately wants to leave OPEN (deliverable 2: "close/open toggle"
   * applies to an in-progress trace too, not only an already-saved curve).
   * To finish a fresh trace CLOSED instead, use `toggleClosed()` (≥ 3
   * anchors) — it works identically whether or not this tooth has ever been
   * committed before. */
  async saveOpenTrace(): Promise<void> {
    const store = useMarginStore.getState();
    if (store.anchors.length < 2 || store.closed) return;
    await this.commit(store.anchors, store.segments, false, null, true, 'save-open-trace', {});
  }

  // ---------------------------------------------------------------------
  // Editing: drag
  // ---------------------------------------------------------------------

  beginAnchorDrag(index: number): void {
    const store = useMarginStore.getState();
    if (index < 0 || index >= store.anchors.length) return;
    useMarginStore.getState().setDraggingAnchorIndex(index);
    useMarginStore.getState().setSelectedAnchorIndex(index);
  }

  /**
   * Live, per-pointermove drag update — recomputes ONLY the (up to 2)
   * segments touching the dragged anchor via `geodesicPath` job calls
   * (locality mirrors `resnapPolylineAnchor`'s kernel-level contract,
   * Phase 2 Task 4), coalesced against stale/superseded calls via a
   * generation counter (same pattern as engine/curvature.ts). Updates ONLY
   * the live store — never caseStore/the journal (see this module's top
   * doc's "no per-mousemove spam" point) — `endAnchorDrag` is what commits.
   */
  async updateAnchorDrag(request: MarginPickRequest): Promise<void> {
    const store = useMarginStore.getState();
    const index = store.draggingAnchorIndex;
    if (index === null) return;
    const hit = await this.raycastTarget(request.rayOrigin, request.rayDirection);
    if (!hit) return;
    const generation = ++this.dragGeneration;
    const contentHash = this.targetContentHashOrThrow();
    const compute = this.recomputeAroundMovedAnchor(store.anchors, store.segments, store.closed, index, hit, contentHash);
    this.pendingDrag = compute;
    const result = await compute;
    if (generation !== this.dragGeneration) return; // superseded by a newer move
    // `setLiveGeometry`, NOT `setActive` — a live drag is still IN PROGRESS
    // here (`setActive` unconditionally clears `draggingAnchorIndex`, which
    // would make `endAnchorDrag`'s "is a drag in progress?" check go stale
    // mid-drag — a real bug this task's own test caught: see
    // state/marginStore.ts's `setLiveGeometry` doc).
    useMarginStore.getState().setLiveGeometry({ anchors: result.anchors, segments: result.segments, humanEdited: true });
  }

  /** Completed gesture — awaits any in-flight drag update (so it always
   * commits the FRESHEST geometry, never a stale intermediate frame), then
   * commits. No-op if no drag is in progress. */
  async endAnchorDrag(): Promise<void> {
    const store = useMarginStore.getState();
    const index = store.draggingAnchorIndex;
    if (index === null) return;
    if (this.pendingDrag) {
      await this.pendingDrag;
    }
    this.pendingDrag = null;
    const settled = useMarginStore.getState();
    useMarginStore.getState().setDraggingAnchorIndex(null);
    await this.commit(settled.anchors, settled.segments, settled.closed, settled.segmentConfidence, true, 'drag-anchor', {
      anchorIndex: index,
    });
  }

  private async recomputeAroundMovedAnchor(
    anchors: readonly LiveMarginAnchor[],
    segments: readonly LiveMarginSegment[],
    closed: boolean,
    index: number,
    hit: RayHit,
    contentHash: string,
  ): Promise<{ anchors: LiveMarginAnchor[]; segments: LiveMarginSegment[] }> {
    const nextAnchors = anchors.slice();
    nextAnchors[index] = { position: hit.point, triangleIndex: hit.triangleIndex, barycentric: hit.barycentric };
    const nextSegments = segments.slice();
    const n = nextAnchors.length;
    const prevSegIndex = closed ? (index - 1 + n) % n : index - 1;
    const nextSegIndex = closed ? index % n : index;
    if (prevSegIndex >= 0 && prevSegIndex < nextSegments.length) {
      nextSegments[prevSegIndex] = await this.geodesicSegmentBetween(
        nextAnchors[closed ? (index - 1 + n) % n : index - 1]!,
        nextAnchors[index]!,
        contentHash,
      );
    }
    if (nextSegIndex >= 0 && nextSegIndex < nextSegments.length && (closed || index < n - 1)) {
      nextSegments[nextSegIndex] = await this.geodesicSegmentBetween(
        nextAnchors[index]!,
        nextAnchors[closed ? (index + 1) % n : index + 1]!,
        contentHash,
      );
    }
    return { anchors: nextAnchors, segments: nextSegments };
  }

  // ---------------------------------------------------------------------
  // Editing: add / delete / close-open toggle
  // ---------------------------------------------------------------------

  private async addAnchorOnSegment(hit: RayHit): Promise<void> {
    const store = useMarginStore.getState();
    const contentHash = this.targetContentHashOrThrow();
    const segmentIndex = nearestSegmentIndex(store.segments, hit.point);
    if (segmentIndex === null) return;
    const n = store.anchors.length;
    const startIdx = segmentIndex;
    const endIdx = (segmentIndex + 1) % n;
    const newAnchor: LiveMarginAnchor = { position: hit.point, triangleIndex: hit.triangleIndex, barycentric: hit.barycentric };

    const anchors = [...store.anchors.slice(0, startIdx + 1), newAnchor, ...store.anchors.slice(startIdx + 1)];
    const [segA, segB] = await Promise.all([
      this.geodesicSegmentBetween(store.anchors[startIdx]!, newAnchor, contentHash),
      this.geodesicSegmentBetween(newAnchor, store.anchors[endIdx]!, contentHash),
    ]);
    const segments = [...store.segments.slice(0, segmentIndex), segA, segB, ...store.segments.slice(segmentIndex + 1)];

    await this.commit(anchors, segments, store.closed, null, true, 'add-anchor-on-segment', {
      segmentIndex,
    });
  }

  /**
   * Deletes the currently SELECTED anchor (deliverable 2: "select+key or
   * context affordance" — see ui/MarginOverlay.tsx for the Delete/Backspace
   * keyboard binding and ui/MarginPanel.tsx for the equivalent button; both
   * call this same method). Refuses (no-op) below the minimum anchor count
   * for the current `closed` state (2 open / 3 closed) — mirrors
   * `toggleClosed`'s own minimum for closing.
   */
  async deleteSelectedAnchor(): Promise<void> {
    const store = useMarginStore.getState();
    const index = store.selectedAnchorIndex;
    if (index === null || index < 0 || index >= store.anchors.length) return;
    const minCount = store.closed ? 3 : 2;
    if (store.anchors.length <= minCount) return;
    const contentHash = this.targetContentHashOrThrow();
    const closed = store.closed;

    const plan = planAnchorDeletion(store.anchors.length, closed, index);
    let bridging: LiveMarginSegment | null = null;
    if (plan.needsBridging) {
      bridging = await this.geodesicSegmentBetween(
        store.anchors[plan.prevAnchorIdx]!,
        store.anchors[plan.nextAnchorIdx]!,
        contentHash,
      );
    }
    const anchors = store.anchors.filter((_, i) => i !== index);
    const segments = rebuildSegmentsAfterDeletion(store.segments, plan, bridging);

    await this.commit(anchors, segments, closed, null, true, 'delete-anchor', { deletedIndex: index });
  }

  /**
   * Bulk-deletes every anchor currently in `marginStore.selectedAnchorIndices`
   * (Phase 3 editor-enhancement task 2 — "I can't delete points in groups")
   * — ONE coalesced `margin-edit` commit/journal entry for the WHOLE batch,
   * not one per deleted anchor. Refuses (no-op) if deleting all of them
   * would drop below the same structural floor `deleteSelectedAnchor` itself
   * enforces (2 open / 3 closed).
   *
   * Implementation: repeatedly applies `deleteSelectedAnchor`'s own proven
   * single-anchor primitives (`planAnchorDeletion`/
   * `rebuildSegmentsAfterDeletion`) against a local WORKING COPY of
   * `anchors`/`segments`, one index at a time, in DESCENDING order —
   * deleting from the highest index down means every not-yet-processed
   * index is still valid against the shrinking array (removing a HIGHER
   * index never shifts a LOWER one), so this is exactly equivalent to the
   * user deleting them one at a time by hand, just without a commit (and a
   * geodesic-recompute round trip) between each step — only the FINAL
   * result is committed/journaled, once.
   */
  async deleteSelectedAnchors(): Promise<void> {
    const store = useMarginStore.getState();
    const indices = [...store.selectedAnchorIndices]
      .filter((i) => i >= 0 && i < store.anchors.length)
      .sort((a, b) => a - b);
    if (indices.length === 0) return;
    const minCount = store.closed ? 3 : 2;
    if (store.anchors.length - indices.length < minCount) return;
    const contentHash = this.targetContentHashOrThrow();
    const closed = store.closed;

    let anchors = store.anchors.slice();
    let segments = store.segments.slice();
    for (const index of [...indices].sort((a, b) => b - a)) {
      const plan = planAnchorDeletion(anchors.length, closed, index);
      let bridging: LiveMarginSegment | null = null;
      if (plan.needsBridging) {
        bridging = await this.geodesicSegmentBetween(anchors[plan.prevAnchorIdx]!, anchors[plan.nextAnchorIdx]!, contentHash);
      }
      anchors = anchors.filter((_, i) => i !== index);
      segments = rebuildSegmentsAfterDeletion(segments, plan, bridging);
    }

    await this.commit(anchors, segments, closed, null, true, 'delete-anchors-bulk', {
      deletedIndices: indices,
      deletedCount: indices.length,
    });
    useMarginStore.getState().clearAnchorSelection();
  }

  /** Explicit close/open toggle (deliverable 2). Closing requires ≥ 3
   * anchors (same minimum as any closed margin) and works identically for a
   * fresh, never-committed manual trace (this IS that trace's "explicit
   * close action") and for re-closing an already-open, already-committed
   * curve — see `saveOpenTrace` for the distinct "persist as open, don't
   * close" action. */
  async toggleClosed(): Promise<void> {
    const store = useMarginStore.getState();
    if (store.anchors.length === 0) return;
    const contentHash = this.targetContentHashOrThrow();
    if (store.closed) {
      // Opening: drop the closing segment (last -> first) — no kernel call.
      const segments = store.segments.slice(0, store.segments.length - 1);
      await this.commit(store.anchors, segments, false, null, true, 'toggle-open', {});
      return;
    }
    if (store.anchors.length < 3) return;
    const closingSegment = await this.geodesicSegmentBetween(
      store.anchors[store.anchors.length - 1]!,
      store.anchors[0]!,
      contentHash,
    );
    const segments = [...store.segments, closingSegment];
    await this.commit(store.anchors, segments, true, null, true, 'toggle-close', {});
  }

  // ---------------------------------------------------------------------
  // Magnifier cross-section preview (Phase 3 editor-enhancement task 3 —
  // "the magnifier is good — it could also show the scan's cross-section
  // ... easier to place points")
  // ---------------------------------------------------------------------

  /**
   * Requests a fresh magnifier cross-section through the cursor's current
   * world hit point — the throttled entry point ui/MarginOverlay.tsx calls
   * from every pointermove path that already drives the magnifier's pixel
   * crop (hover-while-placing AND active-drag alike), fire-and-forget.
   *
   * THROTTLE (this task's brief: "keep dragging fluid"): two layers, both
   * in `pumpMagnifierSection` (see its doc) — single-flight coalescing to
   * the LATEST request (never a backlog of stale requests), PLUS a
   * `MAGNIFIER_SECTION_MIN_INTERVAL_MS` wall-clock floor between run
   * starts, leading + trailing edge. On the wall-clock use: CLAUDE.md's
   * "no `Date.now()` in computations" targets JOURNALED geometry results
   * (determinism of persisted operations) — this is a display-only,
   * never-persisted UI preview throttle (`performance.now()`, request
   * TIMING only, never fed into any geometry), a genuinely different
   * concern; noted explicitly since the wording could otherwise read as
   * covering this too.
   */
  updateMagnifierSection(request: MarginPickRequest): void {
    if (useMarginStore.getState().phase !== 'active') return;
    this.pendingMagnifierSectionRequest = request;
    this.pumpMagnifierSection();
  }

  /** Drains `pendingMagnifierSectionRequest` subject to BOTH throttle
   * conditions: single-flight (never two concurrent section runs) AND a
   * minimum wall-clock interval between run STARTS
   * (`MAGNIFIER_SECTION_MIN_INTERVAL_MS`) — the latter is what actually
   * protects the drag-latency budget: the section run shares the SAME
   * affinity-routed worker as the drag's own `geodesicPath` calls, so
   * without a floor on the request rate, back-to-back section runs (each
   * cheap on its own) would interleave with — and delay — every single
   * drag-update job during a fast pointer move. Leading edge fires
   * immediately (a fresh hover gets its preview with no artificial lag);
   * trailing edge is guaranteed via the timer re-arm, so the LAST cursor
   * position always gets a section (never left showing a stale cut after
   * the pointer stops). See this task's report for the measured drag-latency
   * impact with this throttle in place. */
  private pumpMagnifierSection(): void {
    if (this.magnifierSectionBusy || this.magnifierSectionTimer !== null) return;
    const pending = this.pendingMagnifierSectionRequest;
    if (!pending) return;
    const elapsedMs = performance.now() - this.lastMagnifierSectionStartMs;
    if (elapsedMs < MAGNIFIER_SECTION_MIN_INTERVAL_MS) {
      this.magnifierSectionTimer = setTimeout(() => {
        this.magnifierSectionTimer = null;
        this.pumpMagnifierSection();
      }, MAGNIFIER_SECTION_MIN_INTERVAL_MS - elapsedMs);
      return;
    }
    this.pendingMagnifierSectionRequest = null;
    void this.runMagnifierSection(pending);
  }

  /** Clears the live cross-section preview (pointer left the viewport, or
   * the overlay unmounted) — also invalidates any in-flight/pending request
   * so a late worker result can never resurrect a stale snapshot (same
   * generation-counter convention as `dragGeneration`). */
  clearMagnifierSection(): void {
    this.magnifierSectionGeneration++;
    this.pendingMagnifierSectionRequest = null;
    if (this.magnifierSectionTimer !== null) {
      clearTimeout(this.magnifierSectionTimer);
      this.magnifierSectionTimer = null;
    }
    useMarginStore.getState().setMagnifierSection(null);
  }

  private magnifierSectionBusy = false;
  private magnifierSectionGeneration = 0;
  private pendingMagnifierSectionRequest: MarginPickRequest | null = null;
  private magnifierSectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMagnifierSectionStartMs = -Infinity;

  private async runMagnifierSection(request: MarginPickRequest): Promise<void> {
    this.magnifierSectionBusy = true;
    this.lastMagnifierSectionStartMs = performance.now();
    const generation = ++this.magnifierSectionGeneration;
    try {
      const hit = await this.raycastTarget(request.rayOrigin, request.rayDirection);
      if (hit === null) {
        if (generation === this.magnifierSectionGeneration) useMarginStore.getState().setMagnifierSection(null);
        return;
      }
      if (generation !== this.magnifierSectionGeneration) return;
      const contentHash = this.targetContentHashOrThrow();
      const store = useMarginStore.getState();
      const normal = computeMagnifierSectionNormal(
        store.anchors,
        store.closed,
        store.draggingAnchorIndex,
        hit.point,
        cameraAlignedFallbackNormal(request.rayDirection),
      );
      const result = await getPool().run(
        'sectionMesh',
        { contentHash, point: hit.point, normal, roiRadiusMm: MARGIN_SECTION_PREVIEW_ROI_RADIUS_MM },
        { affinityKey: contentHash },
      );
      if (generation !== this.magnifierSectionGeneration) return;
      useMarginStore.getState().setMagnifierSection(toMagnifierSectionSnapshot(result));
    } catch (err) {
      if (generation === this.magnifierSectionGeneration) {
        console.error('marginEditor.updateMagnifierSection: sectionMesh job failed', err);
        useMarginStore.getState().setMagnifierSection(null);
      }
    } finally {
      this.magnifierSectionBusy = false;
      // Trailing edge: whatever request arrived while this run was in
      // flight goes back through the SAME interval gate (never a direct
      // re-run — that would defeat the wall-clock floor for a slow worker).
      this.pumpMagnifierSection();
    }
  }

  // ---------------------------------------------------------------------
  // Unresolved (-1) anchor re-snap (Task 1's documented gap this tool closes)
  // ---------------------------------------------------------------------

  /** Explicit, non-silent fix for v1->v2-migrated anchors carrying the
   * `UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX` sentinel (CLAUDE.md invariant
   * 5: "no silent data mutation" — re-deriving triangleIndex/barycentric
   * from a stored `position` is a real mutation of persisted geometry
   * anchoring, so it only ever happens on this explicit user action, never
   * automatically on load). Journals its own `margin-edit` op (gesture
   * `resnap-unresolved`) distinct from an ordinary content edit.
   */
  async reSnapUnresolvedAnchors(): Promise<void> {
    const store = useMarginStore.getState();
    if (store.unresolvedAnchorCount === 0) return;
    const contentHash = this.targetContentHashOrThrow();
    await this.resolveAndPublish(store.anchors, store.closed, null, true, store.mode, contentHash);
    const settled = useMarginStore.getState();
    await this.commit(settled.anchors, settled.segments, settled.closed, null, true, 'resnap-unresolved', {
      resolvedCount: settled.anchors.length,
    });
  }

  // ---------------------------------------------------------------------
  // Validation + confirm (Phase 3 Task 6)
  // ---------------------------------------------------------------------

  /** Runs `validateMargin` against the CURRENT store geometry and publishes
   * the result to `marginStore.validation` — the live badge's data source.
   * Fire-and-forget by every caller (`commit()`, `startForTooth()`,
   * `reSnapUnresolvedAnchors()`) — deliberately NOT awaited inline with the
   * gesture it follows, so an extra worker round trip never adds to the
   * edit-gesture latency budget Task 5 already measured/protects (drag/edit
   * must stay < 100ms on the real upperjaw). `validateMarginLine` itself
   * measures ~6-9ms on the real 261-anchor golden margin (packages/kernel/
   * src/margin/validate.ts's own doc), so in practice the badge updates
   * near-instantly anyway — this is a belt-and-suspenders latency
   * guarantee, not a response to an observed slowdown. Errors are swallowed
   * (logged) rather than surfacing as a tool error: a failed BADGE refresh
   * must never block or corrupt an otherwise-successful edit gesture.
   *
   * Public (not `private`, unlike most of this section's internals) so a
   * caller that publishes store geometry OUTSIDE the normal commit path
   * (e.g. a test injecting `useMarginStore.getState().setActive(...)`
   * directly — see ui/MarginPanel.validation.dom.test.tsx's confirm-with-
   * acknowledge scenario) can still populate the live badge without first
   * synthesizing a full commit-worthy gesture.
   */
  async refreshValidation(): Promise<void> {
    const store = useMarginStore.getState();
    if (!store.restorationId || store.tooth === null || store.anchors.length === 0) {
      useMarginStore.getState().setValidation(null);
      return;
    }
    const generation = ++this.validationGeneration;
    useMarginStore.getState().setValidationBusy(true);
    try {
      const report = await this.runValidateMarginJob(store.anchors, store.closed, store.segments);
      // A newer refresh (or session reset) superseded this one while the
      // job was in flight — same "generation counter" guard as
      // `dragGeneration` (this module's own precedent) — discard a stale
      // result rather than clobbering a fresher one.
      if (generation !== this.validationGeneration) return;
      useMarginStore.getState().setValidation(report);
    } catch (err) {
      if (generation !== this.validationGeneration) return;
      console.error('marginEditor.refreshValidation: validateMargin job failed', err);
      useMarginStore.getState().setValidation(null);
    } finally {
      if (generation === this.validationGeneration) useMarginStore.getState().setValidationBusy(false);
    }
  }

  /** Calls the `validateMargin` worker job against `anchors`/`closed`
   * (building the SAME `resampledPoints` a real commit would — see
   * `flattenResampledPoints`) and classifies the result into
   * `MarginValidationSnapshot` (state/marginStore.ts) — the local,
   * structural-twin translation this engine layer owns (see that type's
   * own doc for why `state/` cannot import `@dqcad/kernel-workers`
   * directly).
   */
  private async runValidateMarginJob(
    anchors: readonly LiveMarginAnchor[],
    closed: boolean,
    segments: readonly LiveMarginSegment[],
  ): Promise<MarginValidationSnapshot> {
    const contentHash = this.targetContentHashOrThrow();
    const record = this.targetRecordOrThrow();
    await ensureBvhBuilt(contentHash, record.positions, record.indices);
    const margin: MarginLinePayload = {
      anchors: anchors.map((a) => ({ position: a.position, triangleIndex: a.triangleIndex, barycentric: a.barycentric })),
      closed,
      resampledPoints: flattenResampledPoints(segments),
    };
    const result: ValidateMarginResult = await getPool().run('validateMargin', { contentHash, margin }, { affinityKey: contentHash });
    return classifyValidationResult(result);
  }

  /** Live validation badge state for the tool currently being edited — see
   * `MarginValidationSnapshot`'s doc. Convenience accessor (also directly
   * readable via `useMarginStore`) mirroring `getErrorKind()`'s pattern. */
  getValidation(): MarginValidationSnapshot | null {
    return useMarginStore.getState().validation;
  }

  /** Guards `refreshValidation` against a stale, superseded response
   * clobbering a fresher one — same pattern as `dragGeneration`. */
  private validationGeneration = 0;

  /**
   * Confirms the current margin on its restoration — CLAUDE.md gate
   * semantics: hard failures (open, self-intersecting, off-surface,
   * degenerate) BLOCK confirm outright; a margin with ONLY smoothness
   * warnings requires `opts.acknowledgeWarnings: true` to proceed (the
   * explicit acknowledge path — the caller/UI is expected to call this
   * once with no options, see `requiresAcknowledgement: true` in the
   * result, present the warnings, then call again with
   * `acknowledgeWarnings: true` once the user confirms). A margin with
   * ZERO findings confirms immediately, no acknowledgement needed.
   *
   * ALWAYS re-validates fresh here (never trusts `marginStore.validation`,
   * which may be stale/debounced/in-flight relative to the exact anchor
   * state being confirmed) — the one place in this module where an extra
   * worker round trip is awaited inline, because correctness of the GATE
   * decision matters more than latency for an explicit, deliberate user
   * action (as opposed to `refreshValidation`'s purely advisory badge).
   *
   * On success, journals ONE `margin-confirm` Operation (see this method's
   * body for why a single op name — not two, e.g. a separate
   * `margin-acknowledge-warnings` — covers both the clean-confirm and the
   * acknowledged-warnings-confirm cases) via `caseStore.updateRestoration`
   * with the restoration object UNCHANGED (a legitimate "journal-only, no
   * content change" call — same precedent as `caseStore.removeRestoration`'s
   * own no-op-body-still-journals doc): confirm doesn't rewrite
   * `marginLines[tooth]` (already written by the anchors' own prior
   * `margin-edit` commit), it only records that THIS anchor state was
   * reviewed and accepted, with which (if any) warnings were acknowledged.
   *
   * ## Race safety (Task-11-review Critical 3)
   *
   * `store`/`restoration` above are captured BEFORE the validation await —
   * a drag (or any other gesture) can `commit()` a NEWER `marginLines[tooth]`
   * entry to `caseStore` WHILE this validation round trip is in flight.
   * Writing the STALE, entry-captured `restoration` back via
   * `caseStore.updateRestoration` after that would silently REVERT the
   * just-committed drag (even though this method never intends to change
   * `marginLines` itself — see the "UNCHANGED" doc above — the OBJECT it
   * writes back would still be the pre-drag one). Guarded below by
   * re-fetching the restoration fresh right before the write, and bailing
   * out (no caseStore write, `stale: true`) if either a drag is actively in
   * progress, or the tooth's committed anchors changed since entry — in
   * both cases this confirm's validation snapshot no longer describes the
   * CURRENT geometry, so the caller must retry rather than have this method
   * journal a confirm (or worse, clobber a newer commit) against stale
   * data. The concurrent commit itself is unaffected either way — `commit()`
   * always re-fetches+writes its own fresh restoration, so it's already
   * safely journaled by the time this check runs.
   */
  async confirmMargin(opts: { acknowledgeWarnings?: boolean } = {}): Promise<MarginConfirmOutcome> {
    const store = useMarginStore.getState();
    if (!store.restorationId || store.tooth === null) {
      throw new Error('marginEditor.confirmMargin: no active session');
    }
    const restorationId = store.restorationId;
    const tooth = store.tooth;
    const restoration = this.findRestoration(restorationId);
    if (!restoration) {
      throw new Error(`marginEditor.confirmMargin: restoration ${restorationId} no longer exists`);
    }
    // Snapshot of what THIS tooth's committed anchors look like at entry —
    // compared against the fresh value below, after the validation await,
    // to detect a concurrent `commit()` landing mid-flight (see this
    // method's own "Race safety" doc above).
    const committedAnchorsAtEntry = restoration.marginLines[tooth]?.anchors;

    useMarginStore.getState().setValidationBusy(true);
    let snapshot: MarginValidationSnapshot;
    try {
      snapshot = await this.runValidateMarginJob(store.anchors, store.closed, store.segments);
    } finally {
      useMarginStore.getState().setValidationBusy(false);
    }
    useMarginStore.getState().setValidation(snapshot);

    if (snapshot.blocked) {
      useMarginStore.getState().setConfirmed(false);
      return { ok: false, requiresAcknowledgement: false, blocked: true, hardFailureKinds: snapshot.hardFailureKinds, hasWarnings: snapshot.hasWarnings, stale: false };
    }
    if (snapshot.hasWarnings && !opts.acknowledgeWarnings) {
      return { ok: false, requiresAcknowledgement: true, blocked: false, hardFailureKinds: [], hasWarnings: true, stale: false };
    }

    // Re-fetch fresh + bail out on any concurrent change (see this method's
    // "Race safety" doc) — MUST happen after the gate checks above (a
    // blocked/needs-acknowledgement outcome is still correct to report even
    // if a concurrent commit landed, since neither path touches caseStore)
    // but BEFORE the write below.
    if (useMarginStore.getState().draggingAnchorIndex !== null) {
      return { ok: false, requiresAcknowledgement: false, blocked: false, hardFailureKinds: [], hasWarnings: snapshot.hasWarnings, stale: true };
    }
    const freshRestoration = this.findRestoration(restorationId);
    if (!freshRestoration) {
      throw new Error(`marginEditor.confirmMargin: restoration ${restorationId} no longer exists`);
    }
    if (freshRestoration.marginLines[tooth]?.anchors !== committedAnchorsAtEntry) {
      return { ok: false, requiresAcknowledgement: false, blocked: false, hardFailureKinds: [], hasWarnings: snapshot.hasWarnings, stale: true };
    }

    const meshId = caseStore.getDocument().scene.find((n) => n.id === store.targetNodeId)?.meshId;
    const anchorsHash = await hashAnchorPositionsHex(store.anchors);
    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'margin-confirm',
      params: {
        restorationId,
        tooth,
        anchorCount: store.anchors.length,
        closed: snapshot.closed,
        // A SINGLE op name covers both the clean-confirm and the
        // acknowledged-warnings-confirm case (this task's brief allows
        // either "extend margin-edit" or "a dedicated
        // margin-acknowledge-warnings op" — this is a third, documented
        // choice: one op, `acknowledgedWarnings` distinguishes the two
        // paths) — a replay/audit consumer can tell exactly what was
        // acknowledged from `smoothnessWarningCount`/`acknowledgedWarnings`
        // alone, without needing two op names to grep for.
        smoothnessWarningCount: snapshot.smoothnessWarningCount,
        acknowledgedWarnings: snapshot.hasWarnings, // true iff warnings existed AND this confirm required (and got) explicit acknowledgement
      },
      inputHashes: meshId ? [meshId] : [],
      outputHashes: [anchorsHash],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    caseStore.updateRestoration(freshRestoration, operation);
    useMarginStore.getState().setConfirmed(true);
    return { ok: true, requiresAcknowledgement: false, blocked: false, hardFailureKinds: [], hasWarnings: snapshot.hasWarnings, stale: false };
  }

  // ---------------------------------------------------------------------
  // Reference-margin export (Phase 3 Task 7 — DEV-ONLY tooling)
  // ---------------------------------------------------------------------

  /**
   * DEV-ONLY (see `ui/MarginPanel.tsx`'s `import.meta.env.DEV` gate — the
   * same convention `engine/testHooks.ts`'s `installTestHooksIfDev` already
   * establishes for this codebase): downloads the CURRENT CONFIRMED margin
   * for the tooth being edited as `<tooth>.reference.json` — the tooling
   * half of Phase 3 Task 7's hand-traced-reference workflow. The dentist
   * project owner traces + confirms a margin in the running app, then
   * clicks this once per tooth; the resulting files are committed BY HAND
   * to `test-fixtures/margins/<caseId>/` (see that directory's README.md
   * for the full schema/workflow doc and `test/golden/
   * margin-references.test.ts` for the automated reference-quality checks
   * that run against whatever has been committed there).
   *
   * Returns `false` (no-op, no download) unless the CURRENT session is
   * `confirmed` (CLAUDE.md gate semantics: a reference is only as good as a
   * margin that has actually passed Task 6's validation gate) — the UI
   * button is disabled under the exact same condition; this is defense in
   * depth against a stale/direct call, not the only enforcement.
   *
   * Reads `restoration.marginLines[tooth]` — the JOURNALED, persisted
   * margin — rather than the live store: by construction (`commit()`'s own
   * doc) the two are identical the instant `confirmed` becomes `true`
   * (confirm never rewrites `marginLines`, only the immediately-preceding
   * `margin-edit` commit does, and `confirmed` resets to `false` on any
   * later edit — `state/marginStore.ts`'s own doc), so this is a
   * belt-and-suspenders choice: the exported reference always matches
   * EXACTLY what got journaled, never a possibly-stale in-memory echo.
   */
  exportReferenceMargin(): boolean {
    const store = useMarginStore.getState();
    if (!store.confirmed || !store.restorationId || store.tooth === null) return false;
    const restoration = this.findRestoration(store.restorationId);
    if (!restoration) return false;
    const marginLine = restoration.marginLines[store.tooth];
    if (!marginLine) return false;
    const payload: MarginReferenceExport = {
      tooth: store.tooth,
      anchors: marginLine.anchors,
      closed: marginLine.closed,
      resampledPoints: marginLine.resampledPoints ?? [],
      meshContentHash: this.targetContentHashOrThrow(),
      traced: 'human-reference',
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
      exportedAt: nowIso(),
    };
    // Same `Blob` + `URL.createObjectURL` + throwaway `<a download>` anchor
    // pattern as `engine/section.ts`'s `downloadSvg` (this repo's one other
    // "trigger a browser file download" precedent) — `JSON.stringify(...,
    // null, 2)` (human-readable, diff-friendly: these files are committed
    // to git and hand-reviewed, unlike every other machine-generated golden
    // fixture in this repo).
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${store.tooth}.reference.json`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private findRestoration(restorationId: string): Restoration | undefined {
    return caseStore.getDocument().restorations.find((r) => r.id === restorationId);
  }

  private targetContentHashOrThrow(): string {
    const targetNodeId = useMarginStore.getState().targetNodeId;
    if (!targetNodeId) throw new Error('marginEditor: no active session');
    const node = caseStore.getDocument().scene.find((n) => n.id === targetNodeId);
    if (!node) throw new Error('marginEditor: target SceneNode no longer exists');
    return node.meshId;
  }

  private targetRecordOrThrow(): EngineMeshRecord {
    const record = caseStore.getMeshRecord(this.targetContentHashOrThrow());
    if (!record) throw new Error('marginEditor: target mesh record not found');
    return record;
  }

  private async raycastTarget(rayOrigin: Vec3, rayDirection: Vec3): Promise<RayHit | null> {
    const contentHash = this.targetContentHashOrThrow();
    const record = this.targetRecordOrThrow();
    await ensureBvhBuilt(contentHash, record.positions, record.indices);
    const result = await getPool().run(
      'raycastMesh',
      { contentHash, origin: rayOrigin, direction: rayDirection },
      { affinityKey: contentHash },
    );
    if (!result.hit) return null;
    return { point: result.point, triangleIndex: result.triangleIndex, barycentric: result.barycentric };
  }

  private async geodesicSegmentBetween(a: LiveMarginAnchor, b: LiveMarginAnchor, contentHash: string): Promise<LiveMarginSegment> {
    const record = this.targetRecordOrThrow();
    const result = await getPool().run(
      'geodesicPath',
      {
        contentHash,
        start: { triangleIndex: a.triangleIndex, barycentric: a.barycentric },
        end: { triangleIndex: b.triangleIndex, barycentric: b.barycentric },
      },
      { affinityKey: contentHash },
    );
    const points: Vec3[] = [];
    for (let i = 0; i < result.triangleIndices.length; i++) {
      points.push(
        evaluateSurfacePointOnMesh(record, result.triangleIndices[i]!, [
          result.barycentric[i * 3]!,
          result.barycentric[i * 3 + 1]!,
          result.barycentric[i * 3 + 2]!,
        ]),
      );
    }
    return { points };
  }

  private async geodesicSegmentsForClosedLoop(anchors: readonly LiveMarginAnchor[], contentHash: string): Promise<LiveMarginSegment[]> {
    const n = anchors.length;
    const segments = await Promise.all(
      Array.from({ length: n }, (_, i) => this.geodesicSegmentBetween(anchors[i]!, anchors[(i + 1) % n]!, contentHash)),
    );
    return segments;
  }

  private straightLineSegments(anchors: readonly LiveMarginAnchor[], closed: boolean): LiveMarginSegment[] {
    const n = anchors.length;
    const count = closed ? n : Math.max(0, n - 1);
    return Array.from({ length: count }, (_, i) => ({
      points: [anchors[i]!.position, anchors[(i + 1) % n]!.position],
    }));
  }

  /** Full re-resolve: snaps every anchor's `position` back onto the CURRENT
   * target mesh via `snapPolyline` (one job call) plus, when `closed`, one
   * extra `geodesicPath` call for the wraparound closing segment — used both
   * for loading an already-resolved persisted MarginLine (cheap "re-derive
   * the live working copy" step — re-snapping an already-on-surface point is
   * a no-op in effect) and for `reSnapUnresolvedAnchors`'s explicit fix. */
  private async resolveAndPublish(
    anchors: readonly LiveMarginAnchor[],
    closed: boolean,
    segmentConfidence: SegmentConfidence,
    humanEdited: boolean,
    mode: MarginToolMode,
    contentHashOverride?: string,
  ): Promise<void> {
    const contentHash = contentHashOverride ?? this.targetContentHashOrThrow();
    const record = this.targetRecordOrThrow();
    await ensureBvhBuilt(contentHash, record.positions, record.indices);
    const points = new Float64Array(anchors.length * 3);
    anchors.forEach((a, i) => {
      points[i * 3] = a.position[0];
      points[i * 3 + 1] = a.position[1];
      points[i * 3 + 2] = a.position[2];
    });
    const result = await getPool().run('snapPolyline', { contentHash, points }, { affinityKey: contentHash });
    const resolvedAnchors: LiveMarginAnchor[] = [];
    for (let i = 0; i < result.anchorTriangleIndices.length; i++) {
      const triangleIndex = result.anchorTriangleIndices[i]!;
      const barycentric: readonly [number, number, number] = [
        result.anchorBarycentric[i * 3]!,
        result.anchorBarycentric[i * 3 + 1]!,
        result.anchorBarycentric[i * 3 + 2]!,
      ];
      resolvedAnchors.push({ triangleIndex, barycentric, position: evaluateSurfacePointOnMesh(record, triangleIndex, barycentric) });
    }
    const segments: LiveMarginSegment[] = [];
    let offset = 0;
    for (let i = 0; i < result.segmentPointCounts.length; i++) {
      const count = result.segmentPointCounts[i]!;
      const pts: Vec3[] = [];
      for (let k = 0; k < count; k++) {
        const idx = offset + k;
        pts.push(
          evaluateSurfacePointOnMesh(record, result.segmentTriangleIndices[idx]!, [
            result.segmentBarycentric[idx * 3]!,
            result.segmentBarycentric[idx * 3 + 1]!,
            result.segmentBarycentric[idx * 3 + 2]!,
          ]),
        );
      }
      segments.push({ points: pts });
      offset += count;
    }
    if (closed && resolvedAnchors.length >= 2) {
      segments.push(await this.geodesicSegmentBetween(resolvedAnchors[resolvedAnchors.length - 1]!, resolvedAnchors[0]!, contentHash));
    }
    useMarginStore.getState().setActive({
      anchors: resolvedAnchors,
      segments,
      closed,
      segmentConfidence,
      humanEdited,
      mode,
      unresolvedAnchorCount: 0,
    });
    // Refresh the live validation badge for whatever margin was just
    // resolved/displayed (Phase 3 Task 6) — covers BOTH `startForTooth`'s
    // initial load (no commit follows) and `reSnapUnresolvedAnchors`'s
    // resolve step (redundant with, but harmless alongside, the
    // `commit()` call that follows it there — see `refreshValidation`'s
    // own generation-counter guard).
    void this.refreshValidation();
  }

  /** The single seam every commit-worthy gesture routes through — journals
   * ONE `margin-edit` Operation and writes `restoration.marginLines[tooth]`.
   * This is the natural insertion point for Phase 3 Task 6's future
   * validation gate (CLAUDE.md: "leave the confirm-gating seam") — no
   * validation runs here yet (YAGNI, this task's guardrail).
   */
  private async commit(
    anchors: readonly LiveMarginAnchor[],
    segments: readonly LiveMarginSegment[],
    closed: boolean,
    segmentConfidence: SegmentConfidence,
    humanEdited: boolean,
    gesture: string,
    extraParams: Record<string, unknown>,
  ): Promise<void> {
    const store = useMarginStore.getState();
    if (!store.restorationId || store.tooth === null) return;
    const restoration = this.findRestoration(store.restorationId);
    if (!restoration) {
      useMarginStore.getState().setError(`marginEditor.commit: restoration ${store.restorationId} no longer exists`);
      return;
    }
    const marginLine: MarginLine = {
      anchors: anchors.map(flattenLiveAnchor),
      closed,
      resampledPoints: flattenResampledPoints(segments),
    };
    const previousAnchors = restoration.marginLines[store.tooth]?.anchors ?? [];
    const diff = summarizeAnchorDiff(previousAnchors, anchors);
    const anchorsHash = await hashAnchorPositionsHex(anchors);
    const meshId = caseStore.getDocument().scene.find((n) => n.id === store.targetNodeId)?.meshId;

    // Task 5 review item 1 (CRITICAL fix): T8 journal-replay reproducibility
    // requires the auto-propose seed to be recoverable from the FIRST
    // committed op of a session that started with a proposal — regardless
    // of WHICH gesture that first commit happens to be. The realistic
    // workflow "propose, then immediately drag a misplaced anchor without
    // ever clicking Accept" journals a plain `drag-anchor` op; the original
    // implementation only ever attached `seed`/`proposalDefaults` at the
    // `acceptProposal()` call site, so that entirely normal workflow lost
    // the seed forever. Gated on SESSION STATE, not on which method called
    // `commit`: `store.mode` stays `'auto'` for a session's ENTIRE lifetime
    // once a proposal succeeds (ui/MarginPanel.tsx only shows the mode
    // selector before any anchor exists — see `MarginToolState.mode`'s own
    // call sites), so `mode === 'auto'` here reliably means "this session's
    // anchors originated from THIS session's own `runPropose` call".
    // `lastProposalSeed` is set immediately before that same call's
    // `setActive`, so it is never stale for a session that reaches this
    // state (never carried over from a different tooth/session — every
    // `runPropose` overwrites it before anything can be committed).
    // `!hasCommittedThisSession` makes this fire EXACTLY ONCE per session:
    // e.g. propose -> accept -> drag journals seed on the accept op only
    // (accept's own `commit()` call flips `hasCommittedThisSession` to
    // `true` before the drag's later `commit()` call ever runs this check) —
    // no duplication.
    const isFirstAutoProposeCommit = !this.hasCommittedThisSession && store.mode === 'auto' && this.lastProposalSeed !== null;
    const seedParams = isFirstAutoProposeCommit
      ? {
          seed: { triangleIndex: this.lastProposalSeed!.triangleIndex, barycentric: this.lastProposalSeed!.barycentric },
          // `targetAnchorCount` (Phase 3 editor-enhancement task 1): the
          // slider value actually used for THIS session's `runPropose` call
          // — journaled alongside `searchRadiusMm` for the same
          // journal-replay-reproducibility reason (T8 review, this file's
          // top doc) — `null` when the default (dense, no-option) path ran.
          proposalDefaults: { searchRadiusMm: MARGIN_SEARCH_RADIUS_MM, targetAnchorCount: this.lastProposalTargetAnchorCount },
        }
      : {};

    const operation: Operation = {
      id: crypto.randomUUID(),
      name: 'margin-edit',
      params: {
        restorationId: store.restorationId,
        tooth: store.tooth,
        gesture,
        anchorCount: anchors.length,
        closed,
        diff,
        ...seedParams,
        ...extraParams,
      },
      inputHashes: meshId ? [meshId] : [],
      outputHashes: [anchorsHash],
      kernelVersion: KERNEL_VERSION,
      timestamp: nowIso(),
    };
    const nextRestoration: Restoration = {
      ...restoration,
      marginLines: { ...restoration.marginLines, [store.tooth]: marginLine },
    };
    caseStore.updateRestoration(nextRestoration, operation);
    this.hasCommittedThisSession = true;
    useMarginStore.getState().setActive({
      anchors,
      segments,
      closed,
      segmentConfidence,
      humanEdited,
      mode: store.mode,
      unresolvedAnchorCount: 0,
    });
    // A committed edit invalidates any prior confirmation (Phase 3 Task 6)
    // — the badge itself is refreshed fire-and-forget (this method's own
    // doc: never adds worker round-trip latency to a commit-worthy
    // gesture).
    useMarginStore.getState().setConfirmed(false);
    void this.refreshValidation();
  }
}

function pointToSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abLenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = abLenSq === 0 ? 0 : Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLenSq));
  const closest: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return Math.hypot(p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]);
}

/** Finds the segment whose sampled polyline lies closest (ambient distance)
 * to `point` — "add anchor on segment" (deliverable 2)'s click-target
 * resolution. `null` for zero segments. Pure — no worker/kernel call. */
export function nearestSegmentIndex(segments: readonly LiveMarginSegment[], point: Vec3): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  segments.forEach((segment, index) => {
    for (let i = 0; i < segment.points.length - 1; i++) {
      const d = pointToSegmentDistance(point, segment.points[i]!, segment.points[i + 1]!);
      if (d < bestDist) {
        bestDist = d;
        best = index;
      }
    }
  });
  return best;
}

/** Pure index-math plan for `deleteSelectedAnchor` — see that method's doc
 * and `rebuildSegmentsAfterDeletion` for how the (up to 2) segments touching
 * `deleteIndex` collapse into ONE bridging segment (or none, at an open
 * curve's endpoint) — factored out specifically so the wraparound-
 * correctness case (`deleteIndex === 0` on a CLOSED curve, where the two
 * touched segments sit at OPPOSITE ends of the array, not adjacent) is
 * directly unit-testable without a worker/kernel round trip. */
export interface AnchorDeletionPlan {
  closed: boolean;
  deleteIndex: number;
  /** OLD anchor index immediately before `deleteIndex` (-1 if none — an
   * open curve's first anchor). */
  prevAnchorIdx: number;
  /** OLD anchor index immediately after `deleteIndex` (-1 if none — an
   * open curve's last anchor). */
  nextAnchorIdx: number;
  /** `true` iff BOTH neighbors exist — a bridging segment must be computed
   * (`geodesicSegmentBetween(anchors[prevAnchorIdx], anchors[nextAnchorIdx])`)
   * before `rebuildSegmentsAfterDeletion` can produce a valid result. */
  needsBridging: boolean;
}

export function planAnchorDeletion(oldAnchorCount: number, closed: boolean, deleteIndex: number): AnchorDeletionPlan {
  const prevAnchorIdx = closed
    ? (deleteIndex - 1 + oldAnchorCount) % oldAnchorCount
    : deleteIndex > 0
      ? deleteIndex - 1
      : -1;
  const nextAnchorIdx = closed
    ? (deleteIndex + 1) % oldAnchorCount
    : deleteIndex < oldAnchorCount - 1
      ? deleteIndex + 1
      : -1;
  return { closed, deleteIndex, prevAnchorIdx, nextAnchorIdx, needsBridging: prevAnchorIdx >= 0 && nextAnchorIdx >= 0 };
}

/** Rebuilds the segment list after deleting the anchor `plan` (from
 * `planAnchorDeletion`) describes — generic over the segment's own type `S`
 * (this module calls it with `LiveMarginSegment`; the node-lane test calls
 * it with a minimal `{ id: string }` stand-in, since this function never
 * inspects a segment's CONTENTS, only its position in the old array).
 * `oldSegments[i]` must follow this module's storage convention
 * (`segments[i]` joins `anchors[i]` -> `anchors[(i+1) % oldAnchorCount]` for
 * closed, or `anchors[i]` -> `anchors[i+1]` for open). `bridging` is
 * REQUIRED (non-null) iff `plan.needsBridging` — the caller computes it (an
 * async geodesic call) before invoking this pure function.
 *
 * @throws {RangeError} if `plan.needsBridging` but `bridging` is `null` (a
 * caller programming error — never a valid deletion state). */
export function rebuildSegmentsAfterDeletion<S>(oldSegments: readonly S[], plan: AnchorDeletionPlan, bridging: S | null): S[] {
  if (plan.needsBridging && bridging === null) {
    throw new RangeError('rebuildSegmentsAfterDeletion: plan.needsBridging is true but bridging is null');
  }
  const newAnchorCount = plan.closed ? oldSegments.length - 1 : oldSegments.length; // one fewer anchor than before deletion
  const newSegments: S[] = [];
  for (let j = 0; j < newAnchorCount; j++) {
    const oldIdx = j < plan.deleteIndex ? j : j + 1; // this NEW anchor's OLD index
    const hasOutgoing = plan.closed || j < newAnchorCount - 1;
    if (!hasOutgoing) continue;
    if (oldIdx === plan.prevAnchorIdx) {
      if (bridging) newSegments.push(bridging);
      continue; // no bridging (open-curve endpoint deletion): correctly no outgoing segment left.
    }
    newSegments.push(oldSegments[oldIdx]!);
  }
  return newSegments;
}

// ---------------------------------------------------------------------------
// Magnifier cross-section preview — pure helpers (Phase 3 editor-enhancement
// task 3). Exported specifically so this task's node-lane tests
// (marginEditor.test.ts) can exercise the plane-DERIVATION logic directly,
// without a worker/kernel round trip — same "pure gesture logic" testing
// convention this module's top doc already establishes for
// `summarizeAnchorDiff`/`planAnchorDeletion`/`rebuildSegmentsAfterDeletion`.
// ---------------------------------------------------------------------------

function vecSub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vecLength3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function vecNormalize3(v: Vec3): Vec3 {
  const len = vecLength3(v);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
function vecCross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Below this cross-product magnitude, `rayDirection` is treated as too
 * close to parallel with the world-up axis for `cross(rayDirection, [0, 1,
 * 0])` to give a numerically meaningful "camera right" direction (looking
 * straight up/down) — `cameraAlignedFallbackNormal` falls back to crossing
 * against world-X instead in that case. */
const CAMERA_FALLBACK_DEGENERACY_EPSILON = 1e-6;

/**
 * "Camera-aligned fallback" plane normal (`computeMagnifierSectionNormal`'s
 * own doc, "no established direction yet" case) — the camera's own "right"
 * direction at the cursor: `normalize(cross(rayDirection, worldUp))`, so the
 * preview section is a roughly VERTICAL cut through the cursor point, facing
 * across the view (a standard, easily-oriented convention — the same
 * "vertical cut facing the viewer" a person visualizes when told "show me a
 * cross-section here" with no other direction implied). Falls back to
 * crossing against world-X when `rayDirection` is itself near-parallel to
 * world-up (looking straight up/down), where the primary cross product would
 * be near-zero/numerically unstable — mirrors `@dqcad/kernel`'s
 * `normalizePlane`'s own "least-aligned axis" defensive pattern, simplified
 * to 2 candidates since only the degenerate world-up case is actually
 * reachable from a camera ray (a camera ray is never parallel to a
 * SECOND arbitrary axis at the same time).
 */
export function cameraAlignedFallbackNormal(rayDirection: Vec3): Vec3 {
  const worldUp: Vec3 = [0, 1, 0];
  let n = vecCross3(rayDirection, worldUp);
  if (vecLength3(n) < CAMERA_FALLBACK_DEGENERACY_EPSILON) {
    n = vecCross3(rayDirection, [1, 0, 0]);
  }
  return vecNormalize3(n);
}

/**
 * Derives the magnifier cross-section plane's NORMAL (this task's brief:
 * "plane perpendicular to the margin's local direction... or camera-aligned
 * fallback when no direction exists yet") — a plane perpendicular to a
 * direction vector has that vector AS its normal, so this function's return
 * value is used directly as `sectionMesh`'s `normal` parameter.
 *
 * Direction sources, in priority order:
 * 1. **Dragging an established anchor** (`draggingAnchorIndex !== null`,
 *    `>= 2` anchors): the tangent between the anchor's STABLE neighbors
 *    either side of it (never the dragged anchor's OWN — currently
 *    changing — position, which would make the section plane visibly jitter
 *    frame-to-frame as the anchor itself moves through it). At an open
 *    curve's endpoint (only one neighbor exists), falls back to the
 *    neighbor-to-cursor direction.
 * 2. **Extending an open curve** (not dragging, `>= 1` anchor, not closed):
 *    the direction from the last placed anchor to the cursor — the tangent
 *    of the segment ABOUT TO be created.
 * 3. **No established direction yet** (a fresh session, zero anchors, or a
 *    closed loop with no drag in progress): `cameraFallbackNormal` (see
 *    `cameraAlignedFallbackNormal`'s own doc).
 */
export function computeMagnifierSectionNormal(
  anchors: readonly LiveMarginAnchor[],
  closed: boolean,
  draggingAnchorIndex: number | null,
  hitPoint: Vec3,
  cameraFallbackNormal: Vec3,
): Vec3 {
  const n = anchors.length;
  if (draggingAnchorIndex !== null && n >= 2) {
    const idx = draggingAnchorIndex;
    const prevIdx = closed ? (idx - 1 + n) % n : idx > 0 ? idx - 1 : null;
    const nextIdx = closed ? (idx + 1) % n : idx < n - 1 ? idx + 1 : null;
    if (prevIdx !== null && nextIdx !== null) {
      return vecNormalize3(vecSub3(anchors[nextIdx]!.position, anchors[prevIdx]!.position));
    }
    if (prevIdx !== null) return vecNormalize3(vecSub3(hitPoint, anchors[prevIdx]!.position));
    if (nextIdx !== null) return vecNormalize3(vecSub3(anchors[nextIdx]!.position, hitPoint));
  } else if (n >= 1 && !closed) {
    return vecNormalize3(vecSub3(hitPoint, anchors[n - 1]!.position));
  }
  return cameraFallbackNormal;
}

/** Translates a `sectionMesh` worker job result (`@dqcad/kernel-workers`'
 * `SectionMeshResult`) into `state/marginStore.ts`'s local
 * `MagnifierSectionSnapshot` — the same "duplicate the trivial shape at the
 * layer boundary" convention `classifyValidationResult` (this module, above)
 * already follows for the analogous `validateMargin` translation. */
function toMagnifierSectionSnapshot(result: SectionMeshResult): MagnifierSectionSnapshot {
  const polylines: { points: readonly (readonly [number, number])[]; closed: boolean }[] = [];
  let offset = 0;
  for (let i = 0; i < result.polylineCounts.length; i++) {
    const count = result.polylineCounts[i]!;
    const points: [number, number][] = [];
    for (let k = 0; k < count; k++) {
      const idx = offset + k;
      points.push([result.points2dFlat[idx * 2]!, result.points2dFlat[idx * 2 + 1]!]);
    }
    polylines.push({ points, closed: result.polylineClosed[i] === 1 });
    offset += count;
  }
  return { polylines, cursorUV: [result.cursorUV[0], result.cursorUV[1]] };
}

/** Module-level singleton — same pattern as engine/alignment.ts's
 * `alignmentEngine`. */
export const marginEditor = new MarginEditorEngine();
