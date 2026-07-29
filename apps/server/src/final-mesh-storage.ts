// apps/server/src/final-mesh-storage.ts
//
// Phase 7 Task 6 (Part A — the T4-F2 closure) — content-addressed storage for
// restoration FINAL-MESH bytes (the lossless `@dqcad/io` container). A sibling
// of mesh-storage.ts with ONE decisive difference: the store is keyed by the
// mesh CONTENT hash (`Restoration.stages.finalMesh` = sha256(positions ‖
// indices)), not by the file-bytes hash. That is what lets the export endpoint
// resolve `stages.finalMesh` straight to the exact Float64 design solid and
// certify the delivered outer envelope against it.
//
// The store VERIFIES the mapping on both write and read (the "impossible by
// construction, assert anyway" discipline mesh-storage.ts established): a
// container is only stored under `<contentHash>` after its decoded mesh is
// confirmed to hash to that exact value, and a read re-decodes + re-hashes and
// refuses to return bytes whose content no longer matches their address —
// tamper-on-disk is a loud typed error, never silently served.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexedMesh } from '@dqcad/kernel';
import { decodeFinalMeshContainer, FinalMeshContainerError } from '@dqcad/io';
import { SHA256_HEX_PATTERN } from './mesh-storage.js';
import { hashMesh } from './journal-replay.js';

/** Thrown when an uploaded container's decoded mesh does not hash to the
 * content hash it would be stored under (a corrupt/tampered upload), or when
 * the container bytes are malformed. 400-class at the route boundary. */
export class FinalMeshContentMismatchError extends Error {
  readonly claimedHash: string;
  readonly actualHash: string;
  constructor(claimedHash: string, actualHash: string) {
    super(
      `final-mesh container content hash ${actualHash} does not match the requested address ${claimedHash} ` +
        '— the upload is corrupt or tampered; refusing to store',
    );
    this.name = 'FinalMeshContentMismatchError';
    this.claimedHash = claimedHash;
    this.actualHash = actualHash;
  }
}

/** Thrown when stored final-mesh bytes no longer hash to their own address —
 * tamper/corruption on disk. 500-class; corrupt geometry is never served. */
export class FinalMeshStorageIntegrityError extends Error {
  constructor(contentHash: string, actualHash: string) {
    super(
      `final-mesh storage integrity violation: bytes stored under ${contentHash} decode to a mesh hashing ` +
        `to ${actualHash} — tampered/corrupted store; refusing to serve`,
    );
    this.name = 'FinalMeshStorageIntegrityError';
  }
}

function assertValidHash(hash: string): void {
  if (!SHA256_HEX_PATTERN.test(hash)) {
    throw new FinalMeshContentMismatchError(hash, '<invalid-hash-shape>');
  }
}

function finalMeshFilePath(dataDir: string, contentHash: string): string {
  assertValidHash(contentHash);
  return join(dataDir, contentHash);
}

/** Decodes a container's bytes back into an `IndexedMesh` (typed rejection on
 * malformed bytes). Shared by the store + the export-endpoint certification. */
export function decodeFinalMeshBytes(bytes: Uint8Array): IndexedMesh {
  return decodeFinalMeshContainer(bytes);
}

/**
 * Stores a final-mesh container under its own CONTENT hash (verified from the
 * decoded mesh, never trusted from the caller). Idempotent + write-once +
 * size-asserted (same temp-file-then-rename discipline as mesh-storage.ts).
 *
 * @throws {FinalMeshContainerError} malformed container bytes.
 * @throws {FinalMeshContentMismatchError} the decoded mesh hashes to a
 *   different value than `expectedContentHash` (when provided).
 */
export async function storeFinalMeshContainer(
  dataDir: string,
  bytes: Buffer,
  expectedContentHash?: string,
): Promise<{ contentHash: string; byteLength: number; alreadyExisted: boolean }> {
  const mesh = decodeFinalMeshContainer(bytes);
  const contentHash = hashMesh(mesh);
  if (expectedContentHash !== undefined && expectedContentHash !== contentHash) {
    throw new FinalMeshContentMismatchError(expectedContentHash, contentHash);
  }
  const filePath = finalMeshFilePath(dataDir, contentHash);
  const existing = await stat(filePath).catch(() => null);
  if (existing) {
    if (existing.size !== bytes.byteLength) {
      // Same content hash, different byte length is a hash collision or a
      // corrupt store — never overwrite.
      throw new FinalMeshStorageIntegrityError(contentHash, contentHash);
    }
    return { contentHash, byteLength: bytes.byteLength, alreadyExisted: true };
  }
  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, filePath);
  return { contentHash, byteLength: bytes.byteLength, alreadyExisted: false };
}

/** Whether a final mesh is stored under `contentHash` (existence check). */
export async function statFinalMesh(dataDir: string, contentHash: string): Promise<number | null> {
  const filePath = finalMeshFilePath(dataDir, contentHash);
  const info = await stat(filePath).catch(() => null);
  return info ? info.size : null;
}

/** Raw stored container bytes, or `null` if none stored under `contentHash`. */
export async function readFinalMeshBytes(dataDir: string, contentHash: string): Promise<Buffer | null> {
  const filePath = finalMeshFilePath(dataDir, contentHash);
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Resolves `contentHash` (a restoration's `stages.finalMesh`) to the exact
 * Float64 design solid, re-verifying the content→address mapping on read.
 * Returns `null` when no bytes are stored (the honest "finalMesh not persisted"
 * signal the export endpoint discloses).
 *
 * @throws {FinalMeshStorageIntegrityError} stored bytes no longer hash to their
 *   address (tamper/corruption on disk).
 * @throws {FinalMeshContainerError} stored bytes are not a valid container.
 */
export async function readFinalMesh(dataDir: string, contentHash: string): Promise<IndexedMesh | null> {
  const bytes = await readFinalMeshBytes(dataDir, contentHash);
  if (!bytes) return null;
  let mesh: IndexedMesh;
  try {
    mesh = decodeFinalMeshContainer(bytes);
  } catch (error) {
    if (error instanceof FinalMeshContainerError) {
      throw new FinalMeshStorageIntegrityError(contentHash, '<undecodable>');
    }
    throw error;
  }
  const actual = hashMesh(mesh);
  if (actual !== contentHash) {
    throw new FinalMeshStorageIntegrityError(contentHash, actual);
  }
  return mesh;
}
