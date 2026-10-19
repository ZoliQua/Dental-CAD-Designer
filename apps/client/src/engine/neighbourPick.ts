// apps/client/src/engine/neighbourPick.ts
//
// Phase 9 Task 3 — routes an armed neighbour pick (state/neighbourCaptureStore
// `pending`, set by ui/NeighbourCapture.tsx) to the workflow that asked for
// it. Like every other pick in this app (ToolManager, marginEditor), the
// point is the Float64 intersection of the click ray with the arch scan's
// master mesh (the `raycastMesh` worker job) — never the Float32 render copy.
// A miss leaves the pick armed; a hit disarms it and runs the capture, whose
// errors the workflow surfaces in its own store.
import type { Vec3 } from '@dqcad/shared-types';
import { useNeighbourPickStore } from '../state/neighbourCaptureStore';
import { caseStore } from './caseStore';
import { cavityDesignEngine } from './cavityDesign';
import { crownDesignEngine } from './crownDesign';
import { ensureBvhBuilt, getPool } from './workers';

export async function handleNeighbourPick(ray: {
  rayOrigin: Vec3;
  rayDirection: Vec3;
}): Promise<void> {
  const pending = useNeighbourPickStore.getState().pending;
  if (!pending) return;
  const engine = pending.workflow === 'crown' ? crownDesignEngine : cavityDesignEngine;
  const nodeId = engine.captureScanNodeId();
  const node = caseStore.getDocument().scene.find((n) => n.id === nodeId);
  const record = node ? caseStore.getMeshRecord(node.meshId) : undefined;
  if (!node || !record) {
    useNeighbourPickStore.getState().setPending(null);
    return;
  }
  await ensureBvhBuilt(record.contentHash, record.positions, record.indices);
  const hit = await getPool().run(
    'raycastMesh',
    { contentHash: record.contentHash, origin: ray.rayOrigin, direction: ray.rayDirection },
    { affinityKey: record.contentHash },
  );
  if (!hit.hit) return;
  useNeighbourPickStore.getState().setPending(null);
  await engine
    .captureNeighbour(pending.side, [hit.point[0], hit.point[1], hit.point[2]])
    .catch(() => {
      // Surfaced by the workflow (its store's `error`) — nothing to add here.
    });
}
