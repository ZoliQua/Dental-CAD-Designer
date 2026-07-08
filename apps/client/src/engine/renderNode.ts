// apps/client/src/engine/renderNode.ts
//
// Shared contract between engine/caseStore.ts (producer, via getRenderNodes)
// and engine/SceneManager.ts (consumer, via setRenderNodes). Lives in its
// own module so neither side has to import the other just for this type —
// caseStore is case-document/business logic and SceneManager is the
// Three.js rendering class; a shared, dependency-free type keeps that
// separation intact even though both are within the `engine` boundary
// (see eslint.config.js's `boundaries/dependencies`, which would permit
// either direction — this is a design choice, not a lint requirement).
import type { MeshRole } from '@dqcad/shared-types';

export interface RenderNode {
  id: string;
  /** Float32, already re-centered at the case bbox centroid — see
   * engine/meshStore.ts's module doc. SceneManager never re-centers or
   * otherwise transforms these; it only renders them as given. */
  positions: Float32Array;
  indices: Uint32Array;
  visible: boolean;
  opacity: number;
  /** Carried through from SceneNode.role — SceneManager's jaw-aware standard
   * views (engine/standardViews.ts) need to know which jaws are present in
   * the scene; this avoids SceneManager importing engine/caseStore.ts just
   * to read that one field (see this module's top doc on why the type lives
   * here, dependency-free, rather than in either producer/consumer file). */
  role: MeshRole;
  /** Optional per-vertex RGB color override (Task 9's surface-distance
   * heatmap — see engine/colormap.ts's `distancesToVertexColors`), Float32,
   * length `positions.length` (one RGB triple per vertex, same indexing as
   * `positions`). `undefined`/absent means "no heatmap active for this
   * node" — SceneManager renders the mesh's ordinary material color, same
   * as before Task 9. Producers (ui/Viewport.tsx, via
   * engine/heatmap.ts's `getActiveOverlay()`) are responsible for supplying
   * a buffer sized to match `positions` exactly; SceneManager does not
   * re-validate the length. */
  colors?: Float32Array;
}
