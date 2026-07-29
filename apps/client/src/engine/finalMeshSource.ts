// apps/client/src/engine/finalMeshSource.ts
//
// Phase 7 Task 6 (Part A — the T4-F2 closure) — the single resolver for a
// restoration's LIVE final-mesh Float64 buffers, backed by whichever design
// session (crown shell / cavity shell / assembled bridge) currently holds them.
// `null` when no live session holds the geometry (e.g. right after a reload —
// the T3 `finalMeshForExport` getters return null there). Shared by the export
// controller (engine/exportFlow.ts) and scene persistence
// (engine/persistence.ts, which persists these bytes content-addressed so the
// server can certify the delivered outer envelope).
//
// Layer rule: engine → engine (the design-engine singletons) only.
import type { Restoration } from '@dqcad/shared-types';
import { bridgeDesignEngine } from './bridgeDesign';
import { cavityDesignEngine } from './cavityDesign';
import { crownDesignEngine } from './crownDesign';

export interface LiveFinalMeshBuffers {
  positions: Float64Array;
  indices: Uint32Array;
  /** The canonical content hash of these buffers — equals
   * `Restoration.stages.finalMesh` when the session is in sync. */
  contentHash: string;
}

/** Resolves the live final-mesh buffers for a restoration from the matching
 * design engine, or `null` when no active session holds them. Read-only access
 * to the session masters — callers copy before transfer/serialization. */
export function liveFinalMeshForRestoration(restoration: Restoration): LiveFinalMeshBuffers | null {
  switch (restoration.type) {
    case 'crown':
      return crownDesignEngine.finalMeshForExport(restoration.id);
    case 'inlay':
    case 'onlay':
      return cavityDesignEngine.finalMeshForExport(restoration.id);
    case 'bridge':
      return bridgeDesignEngine.finalMeshForExport(restoration.id);
  }
}
