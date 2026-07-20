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
import type {
  FdiTooth,
  MarginAnchor,
  MarginLine,
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
} from '@dqcad/kernel-workers';
import {
  useMarginStore,
  type LiveMarginAnchor,
  type LiveMarginSegment,
  type MarginToolMode,
  type SegmentConfidence,
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

export type MarginErrorKind = 'noRidgeFound' | 'noClosure' | 'other';

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
    useMarginStore.getState().reset();
  }

  setMode(mode: MarginToolMode): void {
    useMarginStore.getState().setMode(mode);
  }

  selectAnchor(index: number | null): void {
    useMarginStore.getState().setSelectedAnchorIndex(index);
  }

  setCursorScreenPos(pos: { xPx: number; yPx: number } | null): void {
    useMarginStore.getState().setCursorScreenPos(pos);
  }

  /** TEST-ONLY: mirrors alignmentEngine.resetForTests()'s convention. */
  resetForTests(): void {
    this.hasCommittedThisSession = false;
    this.dragGeneration = 0;
    this.pendingDrag = null;
    useMarginStore.getState().reset();
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
    if (!store.closed) {
      await this.appendAnchor(hit);
      return;
    }
    await this.addAnchorOnSegment(hit);
  }

  // ---------------------------------------------------------------------
  // Auto-propose
  // ---------------------------------------------------------------------

  private async runPropose(seed: RayHit): Promise<void> {
    const contentHash = this.targetContentHashOrThrow();
    useMarginStore.getState().setProposing();
    try {
      await ensureBvhBuilt(contentHash, this.targetRecordOrThrow().positions, this.targetRecordOrThrow().indices);
      const result: ProposeMarginResult = await getPool().run(
        'proposeMargin',
        { contentHash, seed: { triangleIndex: seed.triangleIndex, barycentric: seed.barycentric } },
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
    await this.commit(store.anchors, store.segments, store.closed, store.segmentConfidence, false, 'auto-propose', {
      seed: this.lastProposalSeed
        ? { triangleIndex: this.lastProposalSeed.triangleIndex, barycentric: this.lastProposalSeed.barycentric }
        : null,
      proposalDefaults: { searchRadiusMm: MARGIN_SEARCH_RADIUS_MM },
    });
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

/** Module-level singleton — same pattern as engine/alignment.ts's
 * `alignmentEngine`. */
export const marginEditor = new MarginEditorEngine();
