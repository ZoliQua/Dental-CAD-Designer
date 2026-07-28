// Worker-side SHA-256 hashing — the off-main-thread replacement for what
// apps/client/src/engine/hash.ts used to do on the UI thread (see
// docs/adr/003-ts-extension-import-convention.md's sibling ADR-001 for the
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
//    (async either way).
//
// Runtime note (Phase 7 Task 3): originally this module only ever ran
// inside a worker. `journalHash.ts`'s `hashCaseJournal` now also calls
// `sha256Hex` on the MAIN thread (engine/exportFlow.ts's request assembly)
// — fine there because a case journal's canonical JSON is KB-scale and the
// digest is native/async; multi-MB inputs (files, meshes, export bytes)
// must still only be hashed via worker jobs.
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.node != null;
}

/** The browser (Web Worker) branch of `sha256Hex`, pulled out into its own
 * exported function as a deliberate, minimal test seam: `crypto.subtle` is
 * ALSO available in Node >=19 as `globalThis.crypto.subtle` (unrelated to
 * `isNodeRuntime()`'s `process.versions.node` check above), so hash.test.ts
 * can call this directly under vitest to exercise the SubtleCrypto path
 * byte-for-byte against `sha256Hex`'s node:crypto path, with no
 * `process`-global mocking required. Not meant to be called by job code —
 * `sha256Hex` below still owns runtime branch selection; this only exists
 * so the branch itself is independently testable. */
export async function sha256HexSubtle(bytes: Uint8Array): Promise<string> {
  // Same TS 5.7+ `ArrayBufferView<ArrayBuffer>`-vs-`ArrayBufferLike`
  // generic-typing gap the old engine/hash.ts documented — every buffer
  // here is a real, non-shared ArrayBuffer at runtime, so this cast is
  // safe, not a correctness workaround. Cast target is the concrete
  // `Uint8Array<ArrayBuffer>` (not the DOM-lib alias `BufferSource`) so this
  // file also typechecks in DOM-free programs — the server (deliberately no
  // "DOM" lib, see apps/server/tsconfig.json) compiles it since Phase 7
  // Task 4 via the `@dqcad/kernel-workers/journal-hash` subpath.
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Lowercase hex SHA-256 digest of `bytes` — see this module's doc for the
 * Node/browser split. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (isNodeRuntime()) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  }
  return sha256HexSubtle(bytes);
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
