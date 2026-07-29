// apps/client/src/engine/caseStore.ts
//
// CANONICAL, imperative owner of the case document (CLAUDE.md/PLAN.md §2.2)
// for the current session. This is where every mutating case operation
// lands — MeshAsset registration, SceneNode add/remove/visibility/opacity,
// and journal Operations — and it publishes a fresh, immutable
// `CaseDocument` snapshot into `state/caseStore.ts`'s zustand store after
// EVERY mutation (same "engine owns, state mirrors, ui subscribes" pattern
// as engine/workers.ts -> state/appStore.ts).
//
// In-memory only for this task — persistence (server upload/download) is
// Task 11 (see docs/plans/phase-1-import-viewer.md). Geometry buffers are
// NOT part of CaseDocument; they live in `meshStore` (engine/meshStore.ts),
// keyed by the same contentHash a CaseDocument MeshAsset carries.
import type {
  CaseDocument,
  Measurement,
  MeshAsset,
  MeshRole,
  Operation,
  Restoration,
  SceneNode,
} from '@dqcad/shared-types';
import type { MeshStats } from '@dqcad/kernel-workers';
import { createEmptyCaseDocument, useCaseStore } from '../state/caseStore';
import { useLodStore } from '../state/lodStore';
import { shouldUseLod } from './lodPolicy';
import { MeshStore, type EngineMeshRecord, type RegisterMeshInput } from './meshStore';
import type { RenderNode } from './renderNode';
import { renderFrameTransform } from './sceneTransform';
import { releaseBvhForMesh } from './workers';

/** Identity 4x4 (column-major, per SceneNode's doc) — every newly imported
 * mesh is placed at the scan's own coordinate frame; Task 6+ (alignment/
 * transform tools) is what ever changes this away from identity. */
const IDENTITY_TRANSFORM_4X4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const DEFAULT_OPACITY = 1;

export type { RenderNode };

/** Input for registerImportedMesh: the already-computed final mesh (from
 * intakeMesh, and possibly rescaleMesh — see importer.ts) plus the journal
 * Operation(s) to append atomically alongside its MeshAsset. */
export interface RegisterImportedMeshInput extends RegisterMeshInput {
  /** In order: an optional `unit-rescale` Operation first (only present if
   * the user confirmed a rescale), then always exactly one `import-mesh`
   * Operation — see importer.ts. */
  operations: readonly Operation[];
}

/** Input for `applyRepair` — see engine/repair.ts for how this is built (a
 * repair's kernel-worker job result, already computed for preview, plus the
 * journal `Operation` the UI's explicit "Apply" click authorizes appending). */
export interface ApplyRepairInput {
  /** contentHash of the mesh this repair was computed FROM — every SceneNode
   * currently referencing it gets repointed to `operation.outputHashes[0]`. */
  previousContentHash: string;
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  /** Journal entry — `outputHashes[0]` is REQUIRED and becomes the new
   * mesh's `MeshAsset.contentHash`/`EngineMeshRecord.contentHash` (see
   * @dqcad/shared-types' `Operation` doc: `outputHashes` is the
   * reproducibility identity of an operation's result). */
  operation: Operation;
}

class CaseStoreEngine {
  readonly meshStore = new MeshStore();
  private document: CaseDocument = createEmptyCaseDocument();
  /** Click-picked SceneNode id — see state/caseStore.ts's `selectedNodeId`
   * doc for why this lives outside CaseDocument. */
  private selectedNodeId: string | null = null;
  /** The restoration currently active in the wizard/sidebar (Phase 3 Task 2)
   * — same "ephemeral UI state, not part of the persisted document" rationale
   * as `selectedNodeId` above; drives which restoration's per-tooth chips are
   * highlighted now, and which restoration later margin/axis tools (Task 4+)
   * operate on. */
  private selectedRestorationId: string | null = null;

  getDocument(): CaseDocument {
    return this.document;
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId;
  }

  /** Sets (or clears, via `null`) the selected SceneNode — driven by
   * SceneManager's click-pick raycast (routed through ui/Viewport.tsx's
   * `onSelect` callback) or, later, by other selection sources (e.g. a
   * scene-tree row click). A `nodeId` that no longer exists in the scene is
   * accepted as given (defensive no-op from the caller's point of view) —
   * `removeSceneNode` below is what actually keeps this from going stale in
   * the common case. */
  setSelectedNodeId(nodeId: string | null): void {
    if (this.selectedNodeId === nodeId) {
      return;
    }
    this.selectedNodeId = nodeId;
    this.publishSelection();
  }

  getSelectedRestorationId(): string | null {
    return this.selectedRestorationId;
  }

  /** Sets (or clears, via `null`) the active restoration — see
   * `selectedRestorationId`'s doc. A restoration id that no longer exists in
   * `document.restorations` is accepted as given (same defensive-no-op
   * stance `setSelectedNodeId` takes). */
  setSelectedRestorationId(restorationId: string | null): void {
    if (this.selectedRestorationId === restorationId) {
      return;
    }
    this.selectedRestorationId = restorationId;
    this.publishSelection();
  }

  /** Float64 mm world-space offset currently subtracted from every mesh's
   * render copy (meshStore.ts's `getWorldOffset`) — for converting a
   * render-frame pick/measurement back to true case coordinates. */
  getRenderWorldOffset(): readonly [number, number, number] {
    return this.meshStore.getWorldOffset();
  }

  getMeshRecord(contentHash: string): EngineMeshRecord | undefined {
    return this.meshStore.get(contentHash);
  }

  /**
   * Registers a fully intake'd mesh's geometry (in `meshStore`) and its
   * `MeshAsset` + journal `Operation`(s) (in the `CaseDocument`) as one
   * atomic publish. Idempotent by contentHash for the MeshAsset list (same
   * dedup rule as `MeshStore.register`) — but journal Operations are always
   * appended (a re-import is still a real, journal-worthy event, even if
   * the resulting mesh content happens to already be registered).
   */
  registerImportedMesh(input: RegisterImportedMeshInput): EngineMeshRecord {
    const record = this.meshStore.register(input);

    const alreadyKnownAsset = this.document.meshes.some(
      (mesh) => mesh.contentHash === input.contentHash,
    );
    const asset: MeshAsset = {
      id: input.contentHash,
      contentHash: input.contentHash,
      name: input.name,
      unit: 'mm',
      triangleCount: input.indices.length / 3,
    };

    this.document = {
      ...this.document,
      meshes: alreadyKnownAsset ? this.document.meshes : [...this.document.meshes, asset],
      history: [...this.document.history, ...input.operations],
    };
    this.publish();
    return record;
  }

  /** Places `meshId` (a MeshAsset.id/contentHash) into the scene under
   * `role`, at the identity transform, visible, full opacity. Multiple
   * SceneNodes may reference the same meshId (e.g. using one scan as both
   * `situ` and `antagonist` reference) — this is intentionally not
   * deduplicated. */
  addSceneNode(meshId: string, role: MeshRole): SceneNode {
    const node: SceneNode = {
      id: crypto.randomUUID(),
      meshId,
      role,
      transform: IDENTITY_TRANSFORM_4X4,
      visible: true,
      opacity: DEFAULT_OPACITY,
    };
    this.document = { ...this.document, scene: [...this.document.scene, node] };
    this.publish();
    return node;
  }

  /**
   * Drops `nodeId` from the scene and, if that was the LAST remaining
   * SceneNode referencing its meshId (contentHash), releases that mesh's
   * Float64 master + Float32 render buffers from `meshStore` too — see this
   * module's top-of-file doc for why this matters (large scans otherwise
   * stay resident for the whole session even after being removed from the
   * tree). Reference-counted over the scene array rather than tracked with
   * a separate counter so it can never drift from the actual document
   * state. A mesh referenced by another SceneNode (e.g. the same scan used
   * as both `situ` and `antagonist`, per addSceneNode's doc) is correctly
   * left alone. The MeshAsset entry in `document.meshes` is intentionally
   * NOT removed — it's case history/journal metadata, not a live buffer,
   * and `getRenderNodes()` already tolerates a SceneNode (or a future
   * re-add) whose mesh record is momentarily absent.
   */
  removeSceneNode(nodeId: string): void {
    const removedNode = this.document.scene.find((node) => node.id === nodeId);
    const remainingScene = this.document.scene.filter((node) => node.id !== nodeId);
    this.document = { ...this.document, scene: remainingScene };

    if (removedNode) {
      this.releaseMeshIfUnreferenced(removedNode.meshId);
    }

    // A removed node can no longer be the selection — leaving it set would
    // let a stale id reach SceneManager/measurements.
    if (this.selectedNodeId === nodeId) {
      this.selectedNodeId = null;
      this.publishSelection();
    }

    this.publish();
  }

  setSceneNodeVisibility(nodeId: string, visible: boolean): void {
    this.document = {
      ...this.document,
      scene: this.document.scene.map((node) => (node.id === nodeId ? { ...node, visible } : node)),
    };
    this.publish();
  }

  setSceneNodeOpacity(nodeId: string, opacity: number): void {
    const clamped = Math.min(1, Math.max(0, opacity));
    this.document = {
      ...this.document,
      scene: this.document.scene.map((node) =>
        node.id === nodeId ? { ...node, opacity: clamped } : node,
      ),
    };
    this.publish();
  }

  /**
   * Phase 3 Task 3: commits the alignment tool's EXPLICITLY user-confirmed
   * result — replaces `nodeId`'s `SceneNode.transform` with `transform`
   * (a WORLD-frame column-major 16, `icpRegister`'s output) and appends
   * `operation` (name `'alignment-apply'`) to the journal in the SAME
   * atomic publish (CLAUDE.md invariant 3: "journal everything
   * destructive"). No other SceneNode/mesh state changes — unlike
   * `applyRepair`, this never produces a NEW mesh (the geometry itself is
   * untouched; only where it's DRAWN moves), so there is no
   * `outputHashes[0]` mesh to register and no measurement-staleness
   * clearing to do (a `Measurement`'s points are frozen WORLD-space
   * snapshots already anchored to the transform-carrying `SceneNode` at
   * pick time — see `MeasurementPoint`'s doc; they remain valid, since
   * re-deriving a render-frame point from a `SceneNode.transform` is
   * exactly what `getRenderNodes()`/`renderFrameTransform` already do for
   * ANY node, transform included).
   *
   * A `SceneNode.transform`-only write is exactly the category
   * docs/adr/002-scene-ops-not-journaled.md's Decision puts in the
   * NEVER-journaled bucket (alongside `setSceneNodeOpacity`/
   * `setSceneNodeVisibility` just above) — journaling it anyway is a
   * DELIBERATE, bounded exception, not an inconsistency: see that ADR's
   * "Amendment (Phase 3): alignment-apply" section for why (clinically
   * consequential, unlike opacity/visibility) and why it needs no
   * PLAN.md §6.3 replay coverage (no mesh bytes ever change).
   *

   * @throws {Error} if no SceneNode with id `nodeId` exists — mirrors
   * `updateRestoration`'s "loud failure on a caller programming error"
   * stance (unlike e.g. `removeMeasurement`'s tolerant-of-a-stale-id style,
   * which is for USER-driven races, not this method's caller — see
   * engine/alignment.ts's `confirm()`, the only caller, which always holds
   * a freshly-read `srcNodeId` from its own store).
   */
  applyAlignment(nodeId: string, transform: readonly number[], operation: Operation): void {
    const exists = this.document.scene.some((node) => node.id === nodeId);
    if (!exists) {
      throw new Error(`applyAlignment: no SceneNode registered for id ${nodeId}`);
    }
    this.document = {
      ...this.document,
      scene: this.document.scene.map((node) => (node.id === nodeId ? { ...node, transform } : node)),
      history: [...this.document.history, operation],
    };
    this.publish();
  }

  /** Render-ready data for every current SceneNode, resolved against
   * `meshStore`'s Float32 render copies (see meshStore.ts's module doc) —
   * consumed by ui/Viewport.tsx to feed SceneManager's minimal mesh
   * display. A SceneNode whose mesh record is missing (should not happen in
   * practice — meshes are always registered before a SceneNode can
   * reference them) is silently skipped rather than thrown, since this is a
   * read-only display projection, not a validation point. */
  getRenderNodes(): RenderNode[] {
    const nodes: RenderNode[] = [];
    // LOD selection (Phase 2 Task 10): a node whose mesh is above the
    // render triangle budget (or whose LOD is force-enabled — see
    // state/lodStore.ts's `LodMode`) renders its decimated LOD copy ONCE
    // one has been built (engine/lod.ts); until then — and always, in
    // 'off'/below-budget cases — the full-res render copy is used. This is
    // strictly a choice between two RENDER copies: the Float64 kernel
    // masters are untouched either way, and every non-display consumer
    // (picking/measuring/sections/heatmaps/exports) reads the masters —
    // see engine/lod.ts's module doc for the consumer-by-consumer
    // verification.
    const lodMode = useLodStore.getState().mode;
    const worldOffset = this.meshStore.getWorldOffset();
    for (const node of this.document.scene) {
      const record = this.meshStore.get(node.meshId);
      if (!record) continue;
      const lod = record.lod;
      const useLod = lod !== undefined && shouldUseLod(lodMode, record.indices.length / 3);
      nodes.push({
        id: node.id,
        positions: useLod ? lod.renderPositions : record.renderPositions,
        indices: useLod ? lod.indices : record.renderIndices,
        visible: node.visible,
        opacity: node.opacity,
        role: node.role,
        // Phase 3 Task 3: converts node.transform (WORLD frame) into THIS
        // render frame — see engine/sceneTransform.ts's module doc. Every
        // node stays at identity until the alignment tool ever writes a
        // non-identity SceneNode.transform (applyAlignment below).
        transform: renderFrameTransform(node.transform, worldOffset),
      });
    }
    return nodes;
  }

  /** Appends a completed measurement (point-to-point/point-to-surface/angle
   * — see ToolManager.ts) to the case document. Not journaled as an
   * `Operation` — see `Measurement`'s doc in @dqcad/shared-types for why
   * (measurements don't mutate mesh geometry, so CLAUDE.md invariant 5's
   * journaling requirement doesn't apply to them). */
  addMeasurement(measurement: Measurement): void {
    this.document = {
      ...this.document,
      measurements: [...this.document.measurements, measurement],
    };
    this.publish();
  }

  /** Deletes a measurement by id — a no-op (not an error) if `id` is
   * already gone, mirroring `resolveUnitConfirmation`'s tolerant style for
   * a UI action that could legitimately race a re-render. */
  removeMeasurement(id: string): void {
    this.document = {
      ...this.document,
      measurements: this.document.measurements.filter((measurement) => measurement.id !== id),
    };
    this.publish();
  }

  // -------------------------------------------------------------------------
  // Restorations (Phase 3 Task 2): create/update/delete, always journaled —
  // see engine/restorations.ts for the orchestration layer that builds the
  // `Restoration`/`Operation` values these methods commit (mirrors
  // registerImportedMesh's "caller computes, caseStore applies + journals"
  // split above).
  // -------------------------------------------------------------------------

  /** Appends a newly created `Restoration` and its `restoration-create`
   * journal `Operation` as one atomic publish. */
  addRestoration(restoration: Restoration, operation: Operation): Restoration {
    this.document = {
      ...this.document,
      restorations: [...this.document.restorations, restoration],
      history: [...this.document.history, operation],
    };
    this.publish();
    return restoration;
  }

  /** Replaces an existing `Restoration` (by id) with `restoration` (the full,
   * already-recomputed replacement — same "caller builds the new value,
   * caseStore commits it" split as `applyRepair`) and appends its
   * `restoration-update` journal `Operation`.
   * @throws {Error} if no restoration with `restoration.id` exists. */
  updateRestoration(restoration: Restoration, operation: Operation): Restoration {
    const exists = this.document.restorations.some((existing) => existing.id === restoration.id);
    if (!exists) {
      throw new Error(`updateRestoration: no restoration registered for id ${restoration.id}`);
    }
    this.document = {
      ...this.document,
      restorations: this.document.restorations.map((existing) =>
        existing.id === restoration.id ? restoration : existing,
      ),
      history: [...this.document.history, operation],
    };
    this.publish();
    return restoration;
  }

  /** Removes a `Restoration` by id and appends its `restoration-delete`
   * journal `Operation` — a no-op body (still journals) if `id` is already
   * gone, mirroring `removeMeasurement`'s tolerant style. Clears
   * `selectedRestorationId` if it pointed at the removed restoration, same
   * as `removeSceneNode` does for `selectedNodeId`. */
  removeRestoration(id: string, operation: Operation): void {
    this.document = {
      ...this.document,
      restorations: this.document.restorations.filter((existing) => existing.id !== id),
      history: [...this.document.history, operation],
    };
    if (this.selectedRestorationId === id) {
      this.selectedRestorationId = null;
      this.publishSelection();
    }
    this.publish();
  }

  /** Releases `contentHash`'s Float64/Float32 buffers (`meshStore.remove`)
   * and worker-side BVH (`releaseBvhForMesh`) iff no SceneNode in the
   * CURRENT `this.document.scene` still references it — the shared "last
   * reference gone" check used by both `removeSceneNode` and `applyRepair`
   * (call this AFTER updating `this.document.scene`, never before). */
  private releaseMeshIfUnreferenced(contentHash: string): void {
    const stillReferenced = this.document.scene.some((node) => node.meshId === contentHash);
    if (!stillReferenced) {
      this.meshStore.remove(contentHash);
      // Same "last reference gone" trigger as the Float64/Float32 buffer
      // release just above — a mesh with no remaining SceneNode also has no
      // reason to keep a worker-side BVH resident for the rest of the
      // session (Task 7's brief: "Worker BVH cache: memory-conscious
      // (releaseBvh wired to mesh removal)").
      releaseBvhForMesh(contentHash);
    }
  }

  /**
   * Commits a user-approved repair (Task 8): registers the ALREADY-COMPUTED
   * result mesh (`input.positions`/`input.indices` — see
   * engine/repair.ts's preview/apply split, which computes these before
   * this method is ever called) under `input.operation.outputHashes[0]`,
   * repoints every SceneNode that referenced the PRE-repair mesh
   * (`input.previousContentHash`) to the new one (the "result mesh replaces
   * the scene mesh" requirement — render copies are refreshed as a side
   * effect of `MeshStore.register`'s `recenterAll()`), appends
   * `input.operation` to the journal, and releases the pre-repair mesh's
   * buffers/BVH if nothing references it anymore (same reference-counted
   * lifecycle `removeSceneNode` uses — see `releaseMeshIfUnreferenced`).
   *
   * Idempotent by content hash for the MeshAsset list (same dedup rule as
   * `registerImportedMesh`) — but, like `registerImportedMesh`, the journal
   * `Operation` is always appended: a repair is a real, journal-worthy event
   * even on the rare chance its output happens to hash-collide with an
   * already-known mesh.
   *
   * ALSO removes every `Measurement` that has any `MeasurementPoint`
   * referencing a SceneNode being repointed here. Rationale (this project's
   * "a silently wrong value is worse than no value" principle): a
   * measurement's points are frozen world-space snapshots taken against the
   * mesh that was live at pick time — once that node's `meshId` moves to the
   * repaired mesh, those snapshots describe a surface that no longer exists,
   * but the UI would keep displaying the old mm/degree value as if it still
   * applied to the CURRENT (repaired) surface. That's not a crash, it's
   * quietly-wrong clinical data. Keeping the stale measurement around "just
   * in case" is not a safe default here — re-measuring on the new surface is
   * a few clicks, whereas a silently-stale distance/angle could go
   * unnoticed into a restoration decision. So: clear, don't try to
   * re-project. The removal is recorded on the SAME journal `Operation`
   * (`measurementsCleared` / `clearedMeasurementIds` in `params`, see below)
   * so the journal remains a complete account of what a repair did.
   */
  applyRepair(input: ApplyRepairInput): EngineMeshRecord {
    const previous = this.meshStore.get(input.previousContentHash);
    if (!previous) {
      throw new Error(
        `applyRepair: no mesh registered for contentHash ${input.previousContentHash}`,
      );
    }
    const outputHash = input.operation.outputHashes[0];
    if (!outputHash) {
      throw new Error(
        'applyRepair: operation.outputHashes must carry the repaired mesh contentHash',
      );
    }

    const record = this.meshStore.register({
      contentHash: outputHash,
      name: previous.name,
      format: previous.format,
      positions: input.positions,
      indices: input.indices,
      stats: input.stats,
      // Repair doesn't re-run intake — carry over the ORIGINAL mesh's intake
      // report unchanged (still meaningful provenance/warnings display, see
      // ImportPanel.tsx's MeshSummary) rather than fabricating a hollow one.
      report: previous.report,
    });

    const alreadyKnownAsset = this.document.meshes.some((mesh) => mesh.contentHash === outputHash);
    const asset: MeshAsset = {
      id: outputHash,
      contentHash: outputHash,
      name: previous.name,
      unit: 'mm',
      triangleCount: input.indices.length / 3,
    };

    // Every SceneNode about to be repointed away from `previousContentHash`
    // (computed against the PRE-update scene) — any Measurement anchored to
    // one of these nodes is about to go stale (see this method's doc above).
    const repointedNodeIds = new Set(
      this.document.scene
        .filter((node) => node.meshId === input.previousContentHash)
        .map((node) => node.id),
    );
    const clearedMeasurements = this.document.measurements.filter((measurement) =>
      measurement.points.some((point) => repointedNodeIds.has(point.nodeId)),
    );
    const remainingMeasurements =
      clearedMeasurements.length === 0
        ? this.document.measurements
        : this.document.measurements.filter(
            (measurement) => !clearedMeasurements.includes(measurement),
          );

    // `measurementsCleared` is always present (even 0) so a journal reader
    // can always find it without checking for its existence first; the id
    // list is omitted (not an empty array) when there's nothing to list —
    // consistent with `repair.ts#paramsFor`'s existing style of collapsing
    // trivial/empty detail into a bare count (e.g. `loopsSkipped: length`).
    const operation: Operation = {
      ...input.operation,
      params: {
        ...input.operation.params,
        measurementsCleared: clearedMeasurements.length,
        ...(clearedMeasurements.length > 0
          ? { clearedMeasurementIds: clearedMeasurements.map((measurement) => measurement.id) }
          : {}),
      },
    };

    this.document = {
      ...this.document,
      meshes: alreadyKnownAsset ? this.document.meshes : [...this.document.meshes, asset],
      scene: this.document.scene.map((node) =>
        node.meshId === input.previousContentHash ? { ...node, meshId: outputHash } : node,
      ),
      measurements: remainingMeasurements,
      history: [...this.document.history, operation],
    };

    this.releaseMeshIfUnreferenced(input.previousContentHash);
    this.publish();
    return record;
  }

  /**
   * Appends a journal `Operation` that mutates NO document state beyond the
   * journal itself (Phase 7 Task 3: the `restoration-export` op — export
   * serializes the ALREADY-COMMITTED `stages.finalMesh` geometry to bytes,
   * so there is no restoration/scene/mesh field to update alongside it; the
   * op's `outputHashes[0]` is the exported BYTES hash, a value that lives in
   * the journal + export record, not in `Restoration`). Journaling a
   * destructive-output-producing action is CLAUDE.md invariant 3; the
   * export flow calls this exactly once per completed export.
   */
  appendOperation(operation: Operation): void {
    this.document = {
      ...this.document,
      history: [...this.document.history, operation],
    };
    this.publish();
  }

  /**
   * Records the server-assigned `fileHash` (SHA-256 of the uploaded binary
   * STL bytes — see `MeshAsset.fileHash`'s doc in @dqcad/shared-types) for
   * an already-registered `MeshAsset`. Called by engine/persistence.ts's
   * `save()` right after a mesh's bytes are confirmed stored on the server
   * (either freshly uploaded, or already present per a `HEAD` check), so a
   * later save of the SAME mesh can skip re-serializing/re-uploading it. A
   * no-op (not an error) if `contentHash` isn't a known MeshAsset — mirrors
   * `removeMeasurement`'s tolerant style for a caller that could legitimately
   * race a concurrent document mutation (e.g. the mesh's SceneNode got
   * removed mid-save).
   */
  setMeshAssetFileHash(contentHash: string, fileHash: string): void {
    const asset = this.document.meshes.find((mesh) => mesh.contentHash === contentHash);
    if (!asset || asset.fileHash === fileHash) {
      return;
    }
    this.document = {
      ...this.document,
      meshes: this.document.meshes.map((mesh) =>
        mesh.contentHash === contentHash ? { ...mesh, fileHash } : mesh,
      ),
    };
    this.publish();
  }

  /**
   * Sets the case's material-profile identity (`settings.materialProfileId` +
   * `settings.profileVersion`) in one publish — a NON-journaled settings edit
   * (settings are placeholder/config, not geometry — see
   * apps/server/src/case-document.ts's doc; scene ops aren't journaled either,
   * ADR-002). This is the write the LIVE MATERIAL PICKER will own once it lands
   * (tracked, not this phase); until then the only caller is the DEV/e2e test
   * hook `seedMaterialProfile`, which selects the same standard-zirconia profile
   * whose thresholds the design engines already use — so the client-computed
   * `QcReport.profileVersion` matches the profile the export request resolves,
   * and the server's dual re-validation agrees instead of 409-ing on the
   * `profileVersion` field (the real gap the Phase 7 e2e surfaced — see
   * docs/demos/phase-7.md's open items). No-ops if unchanged. */
  setMaterialProfile(materialProfileId: string, profileVersion: string): void {
    if (
      this.document.settings.materialProfileId === materialProfileId &&
      this.document.settings.profileVersion === profileVersion
    ) {
      return;
    }
    this.document = {
      ...this.document,
      settings: { ...this.document.settings, materialProfileId, profileVersion },
    };
    this.publish();
  }

  /**
   * LOAD-ONLY: installs `document` (freshly fetched from the server — see
   * engine/persistence.ts's `openCase()`) as the CURRENT case document in
   * ONE atomic publish, bypassing the incremental per-node mutation methods
   * above (`addSceneNode`/`registerImportedMesh`/etc.) — a loaded document
   * already has its full, valid `scene`/`meshes`/`history`/`measurements`
   * arrays; replaying it node-by-node would fire a publish per node for no
   * benefit and would (per persistence.ts's dirty-tracking doc) look
   * indistinguishable from a burst of real user edits.
   *
   * Does NOT touch `meshStore` — persistence.ts's `openCase()` is
   * responsible for registering (via the NORMAL `meshStore.register()` path
   * — recenter etc. — never a shortcut) every mesh `document.scene`
   * references BEFORE calling this, so `getRenderNodes()` never observes a
   * SceneNode with a dangling `meshId`, even transiently. Selection is
   * cleared (a freshly loaded case has no meaningful prior selection).
   */
  loadDocument(document: CaseDocument): void {
    this.document = document;
    this.selectedNodeId = null;
    this.selectedRestorationId = null;
    this.publish();
    this.publishSelection();
  }

  private publish(): void {
    useCaseStore.getState().setDocument(this.document);
  }

  private publishSelection(): void {
    useCaseStore.getState().setSelectedNodeId(this.selectedNodeId);
    useCaseStore.getState().setSelectedRestorationId(this.selectedRestorationId);
  }

  /** TEST-ONLY: resets to a fresh empty document + mesh registry so tests
   * don't leak state through this module-level singleton across files. */
  resetForTests(): void {
    this.document = createEmptyCaseDocument();
    this.meshStore.clear();
    this.selectedNodeId = null;
    this.selectedRestorationId = null;
    this.publish();
    this.publishSelection();
  }
}

/** Module-level singleton — same pattern as engine/workers.ts's lazily
 * constructed pool, except this one has no lazy-init reason to defer
 * construction (no browser-only globals touched at construction time). */
export const caseStore = new CaseStoreEngine();
