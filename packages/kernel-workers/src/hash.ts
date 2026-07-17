// Worker-side SHA-256 hashing — the off-main-thread replacement for what
// apps/client/src/engine/hash.ts used to do on the UI thread (see
// docs/adr/003-import-extension-convention.md's sibling ADR-001 for the
// perf rationale, and jobs/io.ts's `parseMeshFile`, jobs/intake.ts's
// `intakeMesh`, and jobs/misc.ts's `rescaleMesh`/`serializeMeshStl`/
// `hashMesh` for the call sites). Every algorithm/encoding here is BYTE-FOR-
// BYTE identical to the old client-side implementation (same SHA-256,
// same lowercase-hex encoding, same "positions bytes then indices bytes"
// combined layout for `hashMeshContent`) — moving WHERE a hash is computed
// must never change WHAT value it produces, since persisted hashes
// (MeshAsset.contentHash/fileHash in saved cases) key existing dev-DB rows.
//
// ## Node vs. browser worker split
//
// This file is loaded inside BOTH worker environments (see
// worker-entry.node.ts / worker-entry.browser.ts), which offer different
// native hashing primitives:
//  - Node worker_threads workers are a real Node process — `process.versions
//    .node` is set — so they get `node:crypto`'s synchronous `createHash`,
//    which avoids the async SubtleCrypto postMessage/IPC round trip
//    entirely (dynamic `import('node:crypto')`, exactly mirroring pool.ts's
//    `spawnNodeWorker`'s dynamic `import('node:worker_threads')` — safe to
//    call unconditionally only inside the Node branch, and never eagerly
//    resolved by Vite's browser bundle since it's dynamic and behind this
//    runtime check).
//  - Browser Web Workers have no `process` global (this repo's Vite config
//    never polyfills one) and get the standard `crypto.subtle.digest`
//    (async, but off the UI thread regardless — this whole module only ever
//    runs inside a worker, never on the main thread).
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.node != null;
}

/** Lowercase hex SHA-256 digest of `bytes` — see this module's doc for the
 * Node/browser split. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (isNodeRuntime()) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  }
  // Same TS 5.7+ `ArrayBufferView<ArrayBuffer>`-vs-`ArrayBufferLike`
  // generic-typing gap the old engine/hash.ts documented — every buffer
  // here is a real, non-shared ArrayBuffer at runtime, so this cast is
  // safe, not a correctness workaround.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Content hash for a registered mesh: SHA-256 over the exact bytes of
 * `positions` (Float64) followed by `indices` (Uint32), in that order —
 * IDENTICAL byte layout to the old `apps/client/src/engine/hash.ts`'s
 * `hashMeshContent` it replaces (see `MeshAsset.contentHash`'s doc,
 * packages/shared-types, for the "identity for journaling/reproducibility"
 * contract this hash serves). Deliberately the hash of the PROCESSED
 * (post-intake, welded) mesh, not of raw uploaded file bytes — see
 * `sha256Hex` above for that separate hash.
 */
export async function hashMeshContent(positions: Float64Array, indices: Uint32Array): Promise<string> {
  const positionBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const indexBytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  const combined = new Uint8Array(positionBytes.byteLength + indexBytes.byteLength);
  combined.set(positionBytes, 0);
  combined.set(indexBytes, positionBytes.byteLength);
  return sha256Hex(combined);
}

/** SHA-256 of a Float64Array's raw bytes alone (no indices) — used for
 * `rescaleMesh`'s before/after journal hashes (importer.ts's unit-rescale
 * `Operation`), which only ever hash a positions buffer, never a full
 * indexed mesh. */
export async function hashFloat64(values: Float64Array): Promise<string> {
  return sha256Hex(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}
