// jobs/toothAsset.ts — the TOOTH-LIBRARY ASSET VERIFICATION job (Phase 9 Task
// 4, ADR-022 Decision 5). The client engine fetches an asset from the server
// (metadata JSON from `GET /api/tooth-library/:fdi`, mesh bytes from
// `GET /api/meshes/:meshChecksum`); this job runs `@dqcad/tooth-library`'s
// format-only loader on them OFF the UI thread: shape validation, the
// metadata checksum, the mesh-bytes checksum (before parsing), the STL parse
// + intake weld, and the watertight gate. Any failure is the loader's own
// loud typed error — the engine then falls back to its labelled placeholder
// and says why; a corrupted asset is never placed.
//
// The `/bytes` subpath keeps the starter-set generation (assets.ts) out of
// the worker. `.ts` extension: reachable from the Node worker entry's import
// closure — see CLAUDE.md's "Import extension convention".
import type { Vec3 } from '@dqcad/kernel';
import { loadToothAssetFromBytes, resolveToothAssetKind } from '@dqcad/tooth-library/bytes';
import { JobCancelledError, type JobContext } from './context.ts';

export interface LoadToothAssetPayload {
  /** The metadata exactly as fetched (parsed JSON, not yet trusted). */
  metadataJson: unknown;
  /** The mesh bytes exactly as fetched (binary STL). */
  meshBytes: Uint8Array;
}

export interface LoadToothAssetResult {
  /** The canonical (parsed + welded) mesh the morph targets index into. */
  positions: Float64Array;
  indices: Uint32Array;
  landmarks: Record<string, Vec3>;
  canonicalFrame: { origin: Vec3; mesialDistal: Vec3; buccoLingual: Vec3; occlusoGingival: Vec3 };
  /** The verified identity of the asset (journaled by the engine). */
  metadata: {
    fdi: number;
    version: string;
    toothType: string;
    provenance: string;
    /** Declared, or derived by `resolveToothAssetKind` (a placeholder
     * provenance ⇒ generator; otherwise never assumed). */
    assetKind: 'generator' | 'scanned' | 'licensed' | 'unspecified';
    meshChecksum: string;
    metadataChecksum: string;
  };
}

/**
 * `loadToothAsset` worker job.
 *
 * @throws {TypeError} when `meshBytes` is not a Uint8Array.
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates `@dqcad/tooth-library`'s typed errors
 * (`ToothAssetMetadataValidationError`, `ToothAssetMetadataChecksumError`,
 * `ToothMeshChecksumError`, `ToothMeshNotWatertightError`).
 */
export const loadToothAssetJob = async (
  payload: LoadToothAssetPayload,
  ctx: JobContext,
): Promise<LoadToothAssetResult> => {
  if (!(payload.meshBytes instanceof Uint8Array)) {
    throw new TypeError('loadToothAsset: meshBytes must be a Uint8Array');
  }
  ctx.progress(0);
  if (await ctx.cancelled()) throw new JobCancelledError();
  const asset = loadToothAssetFromBytes(payload.metadataJson, payload.meshBytes);
  ctx.progress(1);
  const m = asset.metadata;
  const landmarks: Record<string, Vec3> = {};
  for (const [name, p] of Object.entries(asset.landmarks)) landmarks[name] = [p[0], p[1], p[2]];
  const frame = asset.canonicalFrame;
  return {
    positions: asset.mesh.positions,
    indices: asset.mesh.indices,
    landmarks,
    canonicalFrame: {
      origin: [...frame.origin],
      mesialDistal: [...frame.mesialDistal],
      buccoLingual: [...frame.buccoLingual],
      occlusoGingival: [...frame.occlusoGingival],
    },
    metadata: {
      fdi: m.fdi,
      version: m.version,
      toothType: m.toothType,
      provenance: m.provenance,
      assetKind: resolveToothAssetKind(m),
      meshChecksum: m.meshChecksum,
      metadataChecksum: m.metadataChecksum,
    },
  };
};
