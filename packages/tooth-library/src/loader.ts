// packages/tooth-library/src/loader.ts
//
// Loads a tooth asset (metadata + mesh) for the anatomy-placement stage
// (Task 5) to consume — the ONLY module downstream pipeline code should
// import from this package (never `assets.ts`/`generate/*` directly,
// which are this package's own internals for building the starter set).
//
// Two entry points, per this task's brief ("Works in-process (Node) — the
// generated assets can be loaded directly OR fetched from the server"):
//   - `loadToothAssetInProcess` — the STARTER set, already in memory
//     (`assets.ts`), zero I/O.
//   - `loadToothAssetFromBytes` — the GENERIC, format-only path: any
//     metadata JSON + mesh bytes satisfying `schema.ts`'s shape, whether
//     fetched over HTTP (`loadToothAssetFromServer`, below) or supplied by
//     a third-party import script. This is the path the format doc
//     (README.md) points a third-party technician at.
// Both paths funnel through `finishLoading`, which re-verifies BOTH
// checksums (metadata content AND mesh bytes) and returns the identical
// `ToothAsset` shape — CLAUDE.md invariant 4/5's "corrupt -> loud typed
// error", enforced uniformly regardless of source.
import { intake } from '@dqcad/kernel';
import type { IndexedMesh } from '@dqcad/kernel';
import { parseStl } from '@dqcad/io';
import type { FdiTooth } from '@dqcad/shared-types';
import { STARTER_TOOTH_ASSETS } from './assets.ts';
import {
  computeMeshChecksum,
  loadToothAssetMetadata,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
  type CanonicalFrame,
  type MorphTarget,
  type ToothAssetMetadata,
  type ToothLandmarks,
} from './schema.ts';

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

export class ToothLibraryFdiNotFoundError extends Error {
  constructor(fdi: number) {
    super(
      `ToothLibraryFdiNotFoundError: no starter tooth asset for FDI ${fdi} — this package ships ` +
        '12/11/21/22 (incisors) and 16 (first molar) only; see generate/README.md for how to add more.',
    );
    this.name = 'ToothLibraryFdiNotFoundError';
  }
}

function toAsset(metadata: ToothAssetMetadata, mesh: IndexedMesh): ToothAsset {
  return {
    metadata,
    mesh,
    landmarks: metadata.landmarks,
    canonicalFrame: metadata.canonicalFrame,
    morphTargets: metadata.morphTargets,
  };
}

/**
 * Loads a starter asset (this package's own generated set) entirely
 * in-process — no filesystem, no network. Still re-derives the mesh from
 * the SAME stored `meshBytes` `assets.ts` computed `morphTargets` against
 * (rather than trusting a cached `IndexedMesh` object identity), and
 * re-verifies both checksums, so this path exercises the exact same
 * "loud error on corruption" contract as `loadToothAssetFromBytes` — the
 * only difference is where the bytes come from.
 *
 * @throws {ToothLibraryFdiNotFoundError} if `fdi` has no starter asset.
 * @throws {ToothAssetMetadataChecksumError} / {ToothMeshChecksumError} if
 *   the in-memory starter set is somehow internally inconsistent (should
 *   be unreachable — `assets.ts` already validates this at import time —
 *   defensive, not load-bearing for normal operation).
 */
export function loadToothAssetInProcess(fdi: FdiTooth): ToothAsset {
  const starter = STARTER_TOOTH_ASSETS.get(fdi);
  if (!starter) {
    throw new ToothLibraryFdiNotFoundError(fdi);
  }
  return loadToothAssetFromBytes(starter.metadata, starter.meshBytes);
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
 */
export function loadToothAssetFromBytes(rawMetadataJson: unknown, meshBytes: Uint8Array): ToothAsset {
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

  return toAsset(metadata, mesh);
}

/**
 * Convenience wrapper for the "fetched from the server" half of this
 * task's brief: fetches `GET {baseUrl}/api/tooth-library/{fdi}` for
 * metadata, then `GET {baseUrl}/api/meshes/{meshChecksum}` (P1's existing
 * content-addressed mesh store — see apps/server/src/tooth-library-
 * storage.ts's module doc for why tooth-library mesh bytes live in that
 * SAME store) for the mesh bytes, and delegates to
 * `loadToothAssetFromBytes` for validation. Uses the global `fetch` (Node
 * 23.6+ ships it natively — see this repo's `engines.node` — no extra
 * dependency).
 */
export async function loadToothAssetFromServer(baseUrl: string, fdi: FdiTooth): Promise<ToothAsset> {
  const metadataResponse = await fetch(`${baseUrl}/api/tooth-library/${fdi}`);
  if (!metadataResponse.ok) {
    throw new Error(
      `loadToothAssetFromServer: GET /api/tooth-library/${fdi} failed with status ${metadataResponse.status}`,
    );
  }
  const rawMetadataJson: unknown = await metadataResponse.json();
  const shapeOnly = loadToothAssetMetadata(rawMetadataJson, null);

  const meshResponse = await fetch(`${baseUrl}/api/meshes/${shapeOnly.meshChecksum}`);
  if (!meshResponse.ok) {
    throw new Error(
      `loadToothAssetFromServer: GET /api/meshes/${shapeOnly.meshChecksum} failed with status ${meshResponse.status}`,
    );
  }
  const meshBytes = new Uint8Array(await meshResponse.arrayBuffer());

  return loadToothAssetFromBytes(rawMetadataJson, meshBytes);
}
