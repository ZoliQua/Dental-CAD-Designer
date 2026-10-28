// packages/tooth-library/src/bytes.ts
//
// The FORMAT-ONLY loader (`loadToothAssetFromBytes`), split out of loader.ts
// in Phase 9 Task 4 so a consumer that verifies fetched assets — the
// `loadToothAsset` worker job (kernel-workers) — can import it WITHOUT
// pulling in assets.ts, whose module body generates the whole starter set at
// import time. Subpath export `@dqcad/tooth-library/bytes`; loader.ts
// re-exports everything here, so the package's public surface is unchanged.
import { closedEdgeLoopProblem, intake } from '@dqcad/kernel';
import type { IndexedMesh } from '@dqcad/kernel';
import { parseStl } from '@dqcad/io';
import {
  computeMeshChecksum,
  loadToothAssetMetadata,
  ToothCervicalRingError,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
  type CanonicalFrame,
  type MorphTarget,
  type ToothAssetMetadata,
  type ToothLandmarks,
} from './schema.ts';

export { resolveToothAssetKind } from './schema.ts';

/** What the anatomy-placement stage (and any test/tool) actually consumes:
 * the full validated metadata, the mesh it describes, and the metadata's
 * own landmark/frame/morph-target fields hoisted to the top level for
 * convenient destructuring (they're also reachable via `metadata`, kept
 * here to avoid every call site writing `asset.metadata.landmarks`). */
export interface ToothAsset {
  metadata: ToothAssetMetadata;
  mesh: IndexedMesh;
  landmarks: ToothLandmarks;
  canonicalFrame: CanonicalFrame;
  morphTargets: readonly MorphTarget[];
}

export function toAsset(metadata: ToothAssetMetadata, mesh: IndexedMesh): ToothAsset {
  return {
    metadata,
    mesh,
    landmarks: metadata.landmarks,
    canonicalFrame: metadata.canonicalFrame,
    morphTargets: metadata.morphTargets,
  };
}

/**
 * The generic, format-only loader: validates `rawMetadataJson`'s shape,
 * verifies `meshBytes` actually hashes to `metadata.meshChecksum`, parses
 * and welds the mesh, and verifies `metadata.metadataChecksum`. Any
 * shape/checksum problem throws loudly (see schema.ts's error types) —
 * never a silent fallback. This is the entry point a third-party import
 * script (or `loadToothAssetFromServer`, below) uses.
 *
 * @throws {ToothAssetMetadataValidationError} on a malformed metadata shape.
 * @throws {ToothMeshChecksumError} if `meshBytes` doesn't hash to
 *   `metadata.meshChecksum` (checked BEFORE parsing, so a truncated/
 *   corrupted file never reaches the parser as "valid-looking" input).
 * @throws {ToothMeshNotWatertightError} if the bytes hash-verify but the
 *   parsed+welded mesh is not watertight.
 * @throws {ToothAssetMetadataChecksumError} if the metadata's own
 *   `metadataChecksum` doesn't match its content.
 * @throws {ToothCervicalRingError} if a declared `cervicalRing` is not a
 *   closed edge loop of the parsed mesh.
 */
export function loadToothAssetFromBytes(
  rawMetadataJson: unknown,
  meshBytes: Uint8Array,
): ToothAsset {
  // Shape-validate first (no vertex-count cross-check yet — we don't have
  // the mesh parsed until AFTER the byte-checksum gate below) so a
  // malformed `meshChecksum` field itself is reported as a shape error,
  // not confused with a byte-mismatch.
  const shapeOnly = loadToothAssetMetadata(rawMetadataJson, null);

  const recomputedMeshChecksum = computeMeshChecksum(meshBytes);
  if (recomputedMeshChecksum !== shapeOnly.meshChecksum) {
    throw new ToothMeshChecksumError(shapeOnly.fdi, shapeOnly.meshChecksum, recomputedMeshChecksum);
  }

  const { soup } = parseStl(meshBytes);
  const { mesh, stats } = intake({ kind: 'soup', soup });
  if (!stats.watertight) {
    throw new ToothMeshNotWatertightError(shapeOnly.fdi);
  }

  // Full validation, now WITH the real vertex count — catches a
  // vertexDeltas-length mismatch that a shape-only check couldn't.
  const metadata = loadToothAssetMetadata(rawMetadataJson, mesh.positions.length / 3);
  if (metadata.cervicalRing !== undefined) {
    const problem = closedEdgeLoopProblem(mesh, metadata.cervicalRing);
    if (problem !== null) throw new ToothCervicalRingError(metadata.fdi, problem);
  }

  return toAsset(metadata, mesh);
}
