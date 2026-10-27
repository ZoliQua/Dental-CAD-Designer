// apps/server/src/export-die.ts
//
// Phase 10 Task 2 (ADR-023 Decision 1, invariant 6) — the server half of the
// crown's prepared die. The crown designs on a closed prep die cut from the
// target scan, and the export's riding `qcContext.dieSolid` is that die: the
// seating gate measures `crown ∩ die` on it. A riding die is client-supplied,
// so the export route re-derives it from what the SAVED case records and
// refuses a release whose die differs:
//
//  1. the restoration's `stages.prepDie` is sealed by a `crown-die-extract`
//     op of this restoration, cut from the restoration's target scan (still
//     in the case, same mesh: `inputHashes[0]` = the node's mesh id), whose
//     persisted STL bytes are on this server (`MeshAsset.fileHash`) — else
//     409 `export-die-not-traceable`;
//  2. the stored STL is re-read exactly as a reopened case reads it (binary
//     STL parsed, re-welded at the intake epsilon — the scan's PERSISTED FORM,
//     kernel intake/persistedForm.ts, the form the client cut its die from)
//     and the die is re-extracted with the kernel defaults against the
//     restoration's confirmed margin (the client engine's `firstMarginLoop`
//     rule) and insertion axis;
//  3. the re-extracted die must hash to `stages.prepDie` AND to the riding
//     `dieSolid` — else 409 `export-die-mismatch` (with a persisted
//     diagnostic bundle, see export-route.ts). An extraction the server
//     cannot reproduce at all is the same mismatch.
//
// Cost: one STL parse + weld + extraction per crown export (well under a
// second on a full arch).
import { extractPrepDie, MESH_WELD_EPSILON_MM, weldVertices, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { parseStl } from '@dqcad/io';
import { CROWN_DIE_EXTRACT_OP, type CaseDocument, type Operation, type Restoration } from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';
import { hashMesh } from './journal-replay.js';
import { readMeshBytes } from './mesh-storage.js';

/** Minimum points of a usable margin loop (the client workflow's rule). */
const MIN_MARGIN_LOOP_POINTS = 3;

/** The restoration's confirmed margin loop exactly as the client crown
 * engine reads it (engine/crownWorkflow.ts `firstMarginLoop`): the first
 * tooth whose resampled points number ≥ 3, else its anchors. */
export function confirmedMarginLoop(restoration: Restoration): Vec3[] | null {
  for (const line of Object.values(restoration.marginLines)) {
    if (!line) continue;
    if (line.resampledPoints && line.resampledPoints.length >= MIN_MARGIN_LOOP_POINTS) {
      return line.resampledPoints.map((p): Vec3 => [p[0], p[1], p[2]]);
    }
    if (line.anchors.length >= MIN_MARGIN_LOOP_POINTS) {
      return line.anchors.map((a): Vec3 => [a.position[0], a.position[1], a.position[2]]);
    }
  }
  return null;
}

function notTraceable(reason: string, details: Record<string, unknown>): ExportRejectionError {
  return new ExportRejectionError(
    'export-die-not-traceable',
    409,
    `the crown's prepared die cannot be traced to the saved case: ${reason} — prepare the die in the crown ` +
      'panel and save the case before exporting (ADR-023). Nothing was released (invariant 6).',
    details,
  );
}

/** The op that sealed `stages.prepDie` for this restoration (the latest). */
function sealingDieOp(document: CaseDocument, restoration: Restoration): Operation | undefined {
  const hash = restoration.stages.prepDie;
  if (hash === undefined) return undefined;
  const history = document.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const op = history[i]!;
    if (op.name === CROWN_DIE_EXTRACT_OP && op.params['restorationId'] === restoration.id && op.outputHashes[0] === hash) {
      return op;
    }
  }
  return undefined;
}

/** What the re-derivation found (for the release and the diagnostics). */
export interface CrownDieVerification {
  dieHash: string;
  scanMeshId: string;
  scanFileHash: string;
}

/**
 * Re-derives the crown's prepared die from the saved case and checks it
 * against the riding `dieSolid` — see the module doc.
 *
 * @throws {ExportRejectionError} 409 `export-die-not-traceable` or
 * `export-die-mismatch` (`details` carries the hashes).
 */
export async function verifyCrownExportDie(
  document: CaseDocument,
  restoration: Restoration,
  ridingDie: IndexedMesh,
  meshDataDir: string,
): Promise<CrownDieVerification> {
  const journaledDieHash = restoration.stages.prepDie;
  if (journaledDieHash === undefined) {
    throw notTraceable('the restoration records no prepared die (stages.prepDie)', { restorationId: restoration.id });
  }
  const op = sealingDieOp(document, restoration);
  if (!op) {
    throw notTraceable('no crown-die-extract op of this restoration sealed stages.prepDie', { journaledDieHash });
  }
  const node = document.scene.find((n) => n.id === restoration.targetNodeId);
  if (!node || node.meshId !== op.inputHashes[0]) {
    throw notTraceable("the die was not cut from the restoration's target scan as it is in the case", {
      journaledDieHash,
      targetNodeId: restoration.targetNodeId,
      opScanMeshId: op.inputHashes[0] ?? null,
    });
  }
  const asset = (document.meshes ?? []).find((m) => m.contentHash === node.meshId);
  const bytes = asset?.fileHash ? await readMeshBytes(meshDataDir, asset.fileHash) : null;
  if (!asset?.fileHash || !bytes) {
    throw notTraceable("the target scan's bytes are not stored on this server", {
      journaledDieHash,
      scanMeshId: node.meshId,
      scanFileHash: asset?.fileHash ?? null,
    });
  }
  const loop = confirmedMarginLoop(restoration);
  if (!loop) {
    throw notTraceable('the restoration has no confirmed margin loop', { journaledDieHash });
  }

  const ridingDieHash = hashMesh(ridingDie);
  const base = { journaledDieHash, ridingDieHash, scanMeshId: node.meshId, scanFileHash: asset.fileHash, dieOperationId: op.id };
  let rederivedDieHash: string;
  try {
    const { soup } = parseStl(bytes);
    const scan = weldVertices(
      { positions: soup.positions, normals: null, triangleCount: soup.triangleCount },
      MESH_WELD_EPSILON_MM,
    );
    rederivedDieHash = hashMesh(extractPrepDie(scan, loop, restoration.insertionAxis).mesh);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new ExportRejectionError(
      'export-die-mismatch',
      409,
      `the server cannot re-extract the crown's die from the saved scan (${err.name}: ${err.message}) — ` +
        'the riding die is unverifiable, so nothing was released (invariant 6)',
      { ...base, rederivedDieHash: null, errorName: err.name },
    );
  }
  if (rederivedDieHash !== journaledDieHash || rederivedDieHash !== ridingDieHash) {
    throw new ExportRejectionError(
      'export-die-mismatch',
      409,
      `the crown's die re-extracted from the saved case (${rederivedDieHash}) does not match ` +
        (rederivedDieHash !== journaledDieHash
          ? `the journaled stages.prepDie (${journaledDieHash}) — the scan, margin or axis changed since the die was prepared`
          : `the riding qcContext.dieSolid (${ridingDieHash})`) +
        '; nothing was released (invariant 6)',
      { ...base, rederivedDieHash },
    );
  }
  return { dieHash: rederivedDieHash, scanMeshId: node.meshId, scanFileHash: asset.fileHash };
}
