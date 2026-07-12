// apps/server/src/mesh-storage.ts
//
// Content-addressed mesh file storage for Task 11 (scene persistence) —
// see docs/plans/phase-1-import-viewer.md's Task 11 brief: "mesh files live
// on disk, not DB" (no Prisma migration needed; a Mesh table would only
// duplicate what the filesystem path itself already encodes).
//
// A mesh's uploaded bytes (binary STL — see apps/client/src/engine's
// persistence module doc for why STL, and packages/kernel-workers'
// `serializeMeshStl`/`weldMeshSoup` jobs for where the client builds/parses
// those bytes) are stored under `<dataDir>/<sha256-hex>`, where the hash is
// computed HERE, server-side, from the exact bytes received — never trusted
// from the client. This makes storage:
//   - content-addressed: the path IS the identity: `sha256(bytes)`.
//   - idempotent: uploading the same bytes twice is a no-op the second time.
//   - immutable/write-once: a file, once written, is never rewritten. Since
//     the path is the hash of the content, a "different bytes, same hash"
//     write is a SHA-256 collision — cryptographically negligible, but this
//     module asserts byte-length equality on every "already exists" hit
//     anyway (see `storeMeshBytes`), rather than silently trusting the path
//     match, per this task's brief: "impossible by construction, assert
//     anyway".
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Lowercase hex SHA-256 — same digest algorithm/encoding as the client's
 * worker-side `sha256Hex` (packages/kernel-workers/src/hash.ts), so a
 * client-computed hash and this function's output are always directly
 * comparable strings. */
export function sha256HexOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 64 lowercase hex characters — the exact shape a SHA-256 digest always
 * has. Used both to validate a `:hash` route param before ever touching the
 * filesystem (rejecting path-traversal-shaped input like `../../etc/passwd`
 * outright) and by schemas.ts's route param JSON Schema. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidMeshHashError extends Error {
  constructor(hash: string) {
    super(`mesh hash must be 64 lowercase hex characters, got ${JSON.stringify(hash)}`);
    this.name = 'InvalidMeshHashError';
  }
}

/** Thrown by `storeMeshBytes` if a file already exists at the content-derived
 * path but its size disagrees with the incoming bytes — see this module's
 * doc: should be unreachable outside a SHA-256 collision or a corrupted
 * store, and is asserted defensively rather than silently overwritten. */
export class MeshStorageIntegrityError extends Error {
  constructor(hash: string, existingSize: number, incomingSize: number) {
    super(
      `mesh storage integrity violation: existing file for hash ${hash} is ${existingSize} bytes, ` +
        `incoming upload is ${incomingSize} bytes — refusing to overwrite (SHA-256 collision or ` +
        'corrupted store; both should be virtually impossible)',
    );
    this.name = 'MeshStorageIntegrityError';
  }
}

function assertValidHash(hash: string): void {
  if (!SHA256_HEX_PATTERN.test(hash)) {
    throw new InvalidMeshHashError(hash);
  }
}

function meshFilePath(dataDir: string, hash: string): string {
  assertValidHash(hash);
  return join(dataDir, hash);
}

/**
 * Stores `bytes` under `<dataDir>/sha256(bytes)`, creating `dataDir` if
 * needed. Idempotent: if a file already exists at that path, this returns
 * immediately WITHOUT rewriting it (after asserting its size matches — see
 * `MeshStorageIntegrityError`). Writes via a temp-file-then-rename so a
 * concurrent identical upload can never observe a partially-written file at
 * the final path (`rename` is atomic on the same filesystem).
 */
export async function storeMeshBytes(
  dataDir: string,
  bytes: Buffer,
): Promise<{ hash: string; byteLength: number; alreadyExisted: boolean }> {
  const hash = sha256HexOf(bytes);
  const filePath = meshFilePath(dataDir, hash);

  const existing = await stat(filePath).catch(() => null);
  if (existing) {
    if (existing.size !== bytes.byteLength) {
      throw new MeshStorageIntegrityError(hash, existing.size, bytes.byteLength);
    }
    return { hash, byteLength: bytes.byteLength, alreadyExisted: true };
  }

  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, filePath);
  return { hash, byteLength: bytes.byteLength, alreadyExisted: false };
}

/** Returns the file's byte size, or `null` if no mesh is stored under `hash`
 * — used by both the `GET` (content-length header) and `HEAD` (existence
 * check) routes. */
export async function statMeshBytes(dataDir: string, hash: string): Promise<number | null> {
  const filePath = meshFilePath(dataDir, hash);
  const info = await stat(filePath).catch(() => null);
  return info ? info.size : null;
}

/** Reads a stored mesh's full bytes, or `null` if not found. */
export async function readMeshBytes(dataDir: string, hash: string): Promise<Buffer | null> {
  const filePath = meshFilePath(dataDir, hash);
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
