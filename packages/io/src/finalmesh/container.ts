// packages/io/src/finalmesh/container.ts
//
// Phase 7 Task 6 (Part A — the T4-F2 closure) — the LOSSLESS, self-describing
// binary container for a restoration's FINAL MESH (`Restoration.stages.finalMesh`).
//
// ## Why this exists
//
// The T4 export re-validation certifies the delivered bytes' GATE RESULTS but
// not the delivered solid's OUTER ENVELOPE against a reference (export-route.ts's
// F2 KNOWN LIMITATION): thickness/marginFit measure RIDING inner/outer surfaces,
// and the solid-consuming gates are insensitive to an outward vertex move. To
// close it the server must be able to resolve `stages.finalMesh` to the EXACT
// Float64 design solid and assert the delivered geometry equals it (up to the
// T2 f32 narrowing). Binary STL is a lossy f32 boundary, so the persisted mesh
// STL bytes cannot reproduce the Float64 `stages.finalMesh` content hash — this
// container stores the raw Float64 positions + Uint32 indices verbatim, so the
// reconstructed mesh's `hashMeshContent` is BYTE-IDENTICAL to the stored
// `stages.finalMesh`.
//
// ## Byte layout (normative; deterministic)
//
//   bytes  0..3   magic ASCII 'DQFM'
//   bytes  4..7   uint32 LE format version (1)
//   bytes  8..11  uint32 LE vertexCount   V  (positions.length / 3)
//   bytes 12..15  uint32 LE triangleCount T  (indices.length / 3)
//   bytes 16..    V*3 float64 LE positions   (verbatim positions.buffer)
//   then          T*3 uint32  LE indices     (verbatim indices.buffer)
//
// Header is 16 bytes so the float64 region starts 8-aligned and the uint32
// region (at 16 + 24V, itself 8-aligned) is 4-aligned — decode can view both
// regions in place with no per-element copy. Endianness is the platform's
// native little-endian, the SAME assumption `@dqcad/kernel-workers`'
// `hashMeshContent`/`journal-replay`'s `hashMesh` already make when they hash
// `positions.buffer ‖ indices.buffer` (this repo is LE-only, like the mesh
// content hash itself), so `sha256(positions ‖ indices)` over the container's
// two regions equals the mesh content hash exactly.
//
// Determinism: a pure function of (positions, indices) — no timestamps, no
// environment reads. Same mesh ⇒ bit-identical container bytes.

/** 4-byte ASCII container magic (`DQFM` = DQ Final Mesh). */
export const FINAL_MESH_MAGIC = 0x4d465144; // 'D','Q','F','M' read LE as uint32
export const FINAL_MESH_CONTAINER_VERSION = 1;
const HEADER_BYTES = 16;

/** Raised by `decodeFinalMeshContainer` for a byte payload that is not a
 * well-formed final-mesh container (bad magic/version, truncated, or
 * inconsistent counts). Typed so callers reject loudly, never guess. */
export class FinalMeshContainerError extends Error {
  constructor(message: string) {
    super(`final-mesh container: ${message}`);
    this.name = 'FinalMeshContainerError';
  }
}

export interface FinalMeshContainerMesh {
  positions: Float64Array;
  indices: Uint32Array;
}

/**
 * Serializes a final-mesh's Float64 positions + Uint32 indices into the
 * self-describing container (see this module's byte-layout doc). The positions
 * length must be a multiple of 3 and the indices length a multiple of 3 (whole
 * triangles); every index must be < vertexCount.
 */
export function encodeFinalMeshContainer(mesh: FinalMeshContainerMesh): Uint8Array {
  const { positions, indices } = mesh;
  if (positions.length % 3 !== 0) {
    throw new FinalMeshContainerError(`positions.length (${positions.length}) is not a multiple of 3`);
  }
  if (indices.length % 3 !== 0) {
    throw new FinalMeshContainerError(`indices.length (${indices.length}) is not a multiple of 3`);
  }
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  const total = HEADER_BYTES + positions.byteLength + indices.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, FINAL_MESH_MAGIC, true);
  view.setUint32(4, FINAL_MESH_CONTAINER_VERSION, true);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, triangleCount, true);
  // Verbatim buffer copies (native LE, matching the mesh content-hash layout).
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), HEADER_BYTES);
  out.set(
    new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
    HEADER_BYTES + positions.byteLength,
  );
  return out;
}

/**
 * Parses a final-mesh container back into fresh Float64 positions + Uint32
 * indices — the exact buffers `encodeFinalMeshContainer` was given, so the
 * result hashes (via `hashMeshContent`/`hashMesh`) to the SAME content hash.
 *
 * @throws {FinalMeshContainerError} bad magic/version, truncation, or an index
 *   that is out of range for the declared vertex count.
 */
export function decodeFinalMeshContainer(bytes: Uint8Array): FinalMeshContainerMesh {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new FinalMeshContainerError(
      `truncated: ${bytes.byteLength} bytes is shorter than the ${HEADER_BYTES}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== FINAL_MESH_MAGIC) {
    throw new FinalMeshContainerError(`bad magic 0x${magic.toString(16)} (expected DQFM)`);
  }
  const version = view.getUint32(4, true);
  if (version !== FINAL_MESH_CONTAINER_VERSION) {
    throw new FinalMeshContainerError(
      `unsupported version ${version} (this build reads ${FINAL_MESH_CONTAINER_VERSION})`,
    );
  }
  const vertexCount = view.getUint32(8, true);
  const triangleCount = view.getUint32(12, true);
  const positionsBytes = vertexCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  const indicesBytes = triangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  const expected = HEADER_BYTES + positionsBytes + indicesBytes;
  if (bytes.byteLength !== expected) {
    throw new FinalMeshContainerError(
      `length ${bytes.byteLength} != expected ${expected} for V=${vertexCount} T=${triangleCount}`,
    );
  }
  // Copy out of the (possibly shared/offset) source into fresh, 8-aligned
  // buffers so the typed-array views are always valid regardless of the input
  // Uint8Array's byteOffset.
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  new Uint8Array(positions.buffer).set(
    bytes.subarray(HEADER_BYTES, HEADER_BYTES + positionsBytes),
  );
  new Uint8Array(indices.buffer).set(
    bytes.subarray(HEADER_BYTES + positionsBytes, expected),
  );
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]! >= vertexCount) {
      throw new FinalMeshContainerError(
        `indices[${i}] (${indices[i]}) is out of range for vertexCount ${vertexCount}`,
      );
    }
  }
  return { positions, indices };
}
