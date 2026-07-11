// apps/client/src/engine/hash.ts
//
// SHA-256 content hashing for the import pipeline — used both for
// `MeshAsset.contentHash` (shared-types) and for the `Operation.inputHashes`/
// `outputHashes` journaled by importer.ts. Uses the standard Web Crypto
// SubtleCrypto API (`crypto.subtle`), available as a global in both the
// browser and Node >= 19 (this repo requires Node >= 23.6 — see the root
// package.json `engines` field) — no extra dependency needed, and it works
// identically under Vitest's `node` test environment.

/** Lowercase hex SHA-256 digest of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS's DOM lib types `SubtleCrypto.digest`'s `data: BufferSource` against
  // `ArrayBufferView<ArrayBuffer>` (excluding the generic
  // `ArrayBufferLike`/`SharedArrayBuffer`-backed case) as of TS 5.7+'s typed
  // array generics — a plain `Uint8Array` parameter is structurally a valid
  // BufferSource at runtime (every buffer here is a real, non-shared
  // ArrayBuffer — nothing in this codebase ever uses SharedArrayBuffer), so
  // this cast is safe, not a correctness workaround.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Content hash for a registered mesh: SHA-256 over the exact bytes of its
 * final (post-intake) Float64 positions buffer followed by its Uint32
 * indices buffer, in that order. This is deliberately the hash of the
 * PROCESSED mesh (after weld/drop-degenerate/orient — see
 * docs/plans/phase-1-import-viewer.md's CaseStore note: "stored mesh is the
 * welded result"), not of the raw uploaded file bytes — two different source
 * files that happen to parse to byte-identical welded geometry are the same
 * mesh for journaling/dedup purposes, matching `MeshAsset.contentHash`'s
 * "identity for journaling/reproducibility" doc (packages/shared-types).
 */
export async function hashMeshContent(positions: Float64Array, indices: Uint32Array): Promise<string> {
  const positionBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const indexBytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  const combined = new Uint8Array(positionBytes.byteLength + indexBytes.byteLength);
  combined.set(positionBytes, 0);
  combined.set(indexBytes, positionBytes.byteLength);
  return sha256Hex(combined);
}
