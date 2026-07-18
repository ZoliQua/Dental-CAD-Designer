// apps/client/src/engine/repair.ts
//
// Orchestrates the repair operations (Task 8: removeComponents,
// splitNonManifoldEdges, fillSmallHoles; Task 11: splitNonManifoldVertices —
// "bowtie" split) as a PREVIEW/APPLY pair, mirroring
// importer.ts's "compute first, journal only on explicit user action"
// pattern (see importer.ts's unit-rescale confirmation flow) — but simpler,
// since a repair never needs a confirmation DIALOG mid-pipeline: the repair
// itself IS the preview (cheap enough on an already-loaded, already-intake'd
// mesh to just run eagerly — same reasoning kernel-workers/src/jobs/repair.ts's
// repair-job doc gives for their single-checkpoint cancellation), and
// `applyRepairPreview` below is the only thing gated behind the UI's
// explicit per-repair "Apply" button (CLAUDE.md invariant 5: "No silent data
// mutation... repair... require[s] explicit user confirmation and append[s]
// a journal Operation").
//
// preview* functions never touch the case journal or the scene — they only
// run a worker job against a COPY of the target mesh's buffers (`.slice()`,
// same "never transfer the live master buffer" convention
// engine/workers.ts's `ensureBvhBuilt` documents) and return the result for
// the UI to render as preview stats. Only `applyRepairPreview` mutates
// anything (via `caseStore.applyRepair`).
import {
  KERNEL_VERSION,
  type FillSmallHolesOptions,
  type MeshStats,
  type RemoveComponentsReport,
  type RemoveComponentsSelector,
  type FillSmallHolesReport,
  type SplitNonManifoldEdgesReport,
  type SplitNonManifoldVerticesReport,
} from '@dqcad/kernel-workers';

// Re-exported so apps/client/src/ui/RepairPanel.tsx — which may depend on
// engine/ but NOT directly on kernel-workers (eslint boundaries policy: ui
// -> engine|state|shared-types) — can name `MeshStats` for its before/after
// stats table without a `RepairPreviewBase['statsAfter']` indexing
// workaround. Same convention as kernel-workers/src/index.ts's own
// re-export doc for why MeshStats is surfaced at each layer boundary.
export type { MeshStats };
import type { Operation } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import type { EngineMeshRecord } from './meshStore';
import { getPool } from './workers';

export type RepairKind = 'removeComponents' | 'splitNonManifoldEdges' | 'splitNonManifoldVertices' | 'fillSmallHoles';

/** Journal `Operation.name` per repair kind — matches this task's brief
 * verbatim ("repair-remove-components" etc.; Task 11 adds
 * "repair-split-non-manifold-vertices"). */
const OPERATION_NAME: Record<RepairKind, string> = {
  removeComponents: 'repair-remove-components',
  splitNonManifoldEdges: 'repair-split-non-manifold-edges',
  splitNonManifoldVertices: 'repair-split-non-manifold-vertices',
  fillSmallHoles: 'repair-fill-small-holes',
};

interface RepairPreviewBase {
  /** contentHash of the mesh this preview was computed FROM — becomes
   * `applyRepairPreview`'s journaled `inputHashes[0]` and the SceneNode
   * repointing key (`caseStore.applyRepair`'s `previousContentHash`). */
  contentHashBefore: string;
  positions: Float64Array;
  indices: Uint32Array;
  statsBefore: MeshStats;
  statsAfter: MeshStats;
}

export interface RemoveComponentsPreview extends RepairPreviewBase {
  kind: 'removeComponents';
  selector: RemoveComponentsSelector;
  report: RemoveComponentsReport;
}

export interface SplitNonManifoldEdgesPreview extends RepairPreviewBase {
  kind: 'splitNonManifoldEdges';
  report: SplitNonManifoldEdgesReport;
}

export interface SplitNonManifoldVerticesPreview extends RepairPreviewBase {
  kind: 'splitNonManifoldVertices';
  report: SplitNonManifoldVerticesReport;
}

export interface FillSmallHolesPreview extends RepairPreviewBase {
  kind: 'fillSmallHoles';
  options: FillSmallHolesOptions;
  report: FillSmallHolesReport;
}

export type RepairPreview =
  | RemoveComponentsPreview
  | SplitNonManifoldEdgesPreview
  | SplitNonManifoldVerticesPreview
  | FillSmallHolesPreview;

/** Runs `removeComponents` (packages/kernel/src/repair/removeComponents.ts)
 * as a worker job against a COPY of `record`'s master buffers — safe to call
 * repeatedly (e.g. the UI re-previewing after the user tweaks `selector`)
 * without touching the live mesh or the case journal. */
export async function previewRemoveComponents(
  record: EngineMeshRecord,
  selector: RemoveComponentsSelector,
): Promise<RemoveComponentsPreview> {
  const positions = record.positions.slice();
  const indices = record.indices.slice();
  const result = await getPool().run(
    'repairRemoveComponents',
    { positions, indices, selector },
    { transfer: [positions.buffer, indices.buffer] },
  );
  return {
    kind: 'removeComponents',
    contentHashBefore: record.contentHash,
    positions: result.positions,
    indices: result.indices,
    statsBefore: result.statsBefore,
    statsAfter: result.statsAfter,
    selector,
    report: result.report,
  };
}

/** Runs `splitNonManifoldEdges`
 * (packages/kernel/src/repair/splitNonManifoldEdges.ts) as a worker job — see
 * `previewRemoveComponents`'s doc for the copy-buffer/no-side-effect
 * contract. */
export async function previewSplitNonManifoldEdges(record: EngineMeshRecord): Promise<SplitNonManifoldEdgesPreview> {
  const positions = record.positions.slice();
  const indices = record.indices.slice();
  const result = await getPool().run(
    'repairSplitNonManifoldEdges',
    { positions, indices },
    { transfer: [positions.buffer, indices.buffer] },
  );
  return {
    kind: 'splitNonManifoldEdges',
    contentHashBefore: record.contentHash,
    positions: result.positions,
    indices: result.indices,
    statsBefore: result.statsBefore,
    statsAfter: result.statsAfter,
    report: result.report,
  };
}

/** Runs `splitNonManifoldVertices`
 * (packages/kernel/src/repair/splitNonManifoldVertices.ts, Task 11 —
 * "bowtie" split) as a worker job — see `previewRemoveComponents`'s doc for
 * the copy-buffer/no-side-effect contract. */
export async function previewSplitNonManifoldVertices(record: EngineMeshRecord): Promise<SplitNonManifoldVerticesPreview> {
  const positions = record.positions.slice();
  const indices = record.indices.slice();
  const result = await getPool().run(
    'repairSplitNonManifoldVertices',
    { positions, indices },
    { transfer: [positions.buffer, indices.buffer] },
  );
  return {
    kind: 'splitNonManifoldVertices',
    contentHashBefore: record.contentHash,
    positions: result.positions,
    indices: result.indices,
    statsBefore: result.statsBefore,
    statsAfter: result.statsAfter,
    report: result.report,
  };
}

/** Runs `fillSmallHoles` (packages/kernel/src/repair/fillSmallHoles.ts) as a
 * worker job — see `previewRemoveComponents`'s doc for the copy-buffer/
 * no-side-effect contract. `options` defaults to `{}` (kernel defaults:
 * `maxBoundaryEdges` 32, no area limit — see FillSmallHolesOptions' doc). */
export async function previewFillSmallHoles(
  record: EngineMeshRecord,
  options: FillSmallHolesOptions = {},
): Promise<FillSmallHolesPreview> {
  const positions = record.positions.slice();
  const indices = record.indices.slice();
  const result = await getPool().run(
    'repairFillSmallHoles',
    { positions, indices, options },
    { transfer: [positions.buffer, indices.buffer] },
  );
  return {
    kind: 'fillSmallHoles',
    contentHashBefore: record.contentHash,
    positions: result.positions,
    indices: result.indices,
    statsBefore: result.statsBefore,
    statsAfter: result.statsAfter,
    options,
    report: result.report,
  };
}

/** Journal `params` per repair kind — deliberately captures both the
 * REQUEST (selector/options the user picked) and a few headline result
 * counts, so an audit trail reader never has to cross-reference a separate
 * report artifact to see roughly what a repair did. */
function paramsFor(preview: RepairPreview): Record<string, unknown> {
  switch (preview.kind) {
    case 'removeComponents':
      return {
        selector: preview.selector,
        removedComponentIds: preview.report.removedComponentIds,
        keptComponentIds: preview.report.keptComponentIds,
      };
    case 'splitNonManifoldEdges':
      return {
        nonManifoldEdgeCountBefore: preview.report.nonManifoldEdgeCountBefore,
        duplicatedVertexCount: preview.report.duplicatedVertexCount,
      };
    case 'splitNonManifoldVertices':
      return {
        nonManifoldVertexCountBefore: preview.report.nonManifoldVertexCountBefore,
        duplicatedVertexCount: preview.report.duplicatedVertexCount,
      };
    case 'fillSmallHoles':
      return {
        maxBoundaryEdges: preview.report.maxBoundaryEdges,
        maxAreaMm2: preview.report.maxAreaMm2,
        loopsFilled: preview.report.loopsFilled,
        loopsSkipped: preview.report.loopsSkipped.length,
      };
  }
}

/**
 * Commits an already-computed `preview` (from one of the `preview*`
 * functions above): hashes the result mesh, appends a journal `Operation`
 * (`repair-remove-components` / `repair-split-non-manifold-edges` /
 * `repair-split-non-manifold-vertices` / `repair-fill-small-holes`, per
 * `OPERATION_NAME`), and replaces the scene
 * mesh via `caseStore.applyRepair` (render copy refreshed, old buffers/BVH
 * released if unreferenced — see that method's doc). This is the ONLY
 * function in this module that mutates the case — the UI's per-repair
 * "Apply" button is the sole caller (NO auto-apply, NO bulk-apply-all — see
 * this task's brief).
 *
 * `outputHash` is computed via kernel-workers' standalone `hashMesh` job
 * (worker-side, off the UI thread — Phase 2 Task 1 debt fix; see
 * kernel-workers/src/jobs/misc.ts's "hashMesh" module doc for why this is
 * deferred to apply-time rather than computed eagerly on every preview) —
 * replaces the old main-thread `hashMeshContent(preview.positions,
 * preview.indices)` call. `preview.positions`/`preview.indices` are passed
 * as PRIVATE copies (`.slice()`) into the job's transfer list, never the
 * preview's own buffers — those are still needed intact right below, for
 * `caseStore.applyRepair`.
 */
export async function applyRepairPreview(preview: RepairPreview): Promise<EngineMeshRecord> {
  const positionsCopy = preview.positions.slice();
  const indicesCopy = preview.indices.slice();
  const { contentHash: outputHash } = await getPool().run(
    'hashMesh',
    { positions: positionsCopy, indices: indicesCopy },
    { transfer: [positionsCopy.buffer, indicesCopy.buffer] },
  );
  const operation: Operation = {
    id: crypto.randomUUID(),
    name: OPERATION_NAME[preview.kind],
    params: paramsFor(preview),
    inputHashes: [preview.contentHashBefore],
    outputHashes: [outputHash],
    kernelVersion: KERNEL_VERSION,
    timestamp: new Date().toISOString(),
  };
  return caseStore.applyRepair({
    previousContentHash: preview.contentHashBefore,
    positions: preview.positions,
    indices: preview.indices,
    stats: preview.statsAfter,
    operation,
  });
}
