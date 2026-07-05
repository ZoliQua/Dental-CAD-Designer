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
import type { CaseDocument, MeshAsset, MeshRole, Operation, SceneNode } from '@dqcad/shared-types';
import { createEmptyCaseDocument, useCaseStore } from '../state/caseStore';
import { MeshStore, type EngineMeshRecord, type RegisterMeshInput } from './meshStore';

/** Identity 4x4 (column-major, per SceneNode's doc) — every newly imported
 * mesh is placed at the scan's own coordinate frame; Task 6+ (alignment/
 * transform tools) is what ever changes this away from identity. */
const IDENTITY_TRANSFORM_4X4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const DEFAULT_OPACITY = 1;

export interface RenderNode {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  visible: boolean;
  opacity: number;
}

/** Input for registerImportedMesh: the already-computed final mesh (from
 * intakeMesh, and possibly rescaleMesh — see importer.ts) plus the journal
 * Operation(s) to append atomically alongside its MeshAsset. */
export interface RegisterImportedMeshInput extends RegisterMeshInput {
  /** In order: an optional `unit-rescale` Operation first (only present if
   * the user confirmed a rescale), then always exactly one `import-mesh`
   * Operation — see importer.ts. */
  operations: readonly Operation[];
}

class CaseStoreEngine {
  readonly meshStore = new MeshStore();
  private document: CaseDocument = createEmptyCaseDocument();

  getDocument(): CaseDocument {
    return this.document;
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

    const alreadyKnownAsset = this.document.meshes.some((mesh) => mesh.contentHash === input.contentHash);
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

  removeSceneNode(nodeId: string): void {
    this.document = {
      ...this.document,
      scene: this.document.scene.filter((node) => node.id !== nodeId),
    };
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
      scene: this.document.scene.map((node) => (node.id === nodeId ? { ...node, opacity: clamped } : node)),
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
    for (const node of this.document.scene) {
      const record = this.meshStore.get(node.meshId);
      if (!record) continue;
      nodes.push({
        id: node.id,
        positions: record.renderPositions,
        indices: record.renderIndices,
        visible: node.visible,
        opacity: node.opacity,
      });
    }
    return nodes;
  }

  private publish(): void {
    useCaseStore.getState().setDocument(this.document);
  }

  /** TEST-ONLY: resets to a fresh empty document + mesh registry so tests
   * don't leak state through this module-level singleton across files. */
  resetForTests(): void {
    this.document = createEmptyCaseDocument();
    this.meshStore.clear();
    this.publish();
  }
}

/** Module-level singleton — same pattern as engine/workers.ts's lazily
 * constructed pool, except this one has no lazy-init reason to defer
 * construction (no browser-only globals touched at construction time). */
export const caseStore = new CaseStoreEngine();
