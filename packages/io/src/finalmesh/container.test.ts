import { describe, expect, it } from 'vitest';
import {
  decodeFinalMeshContainer,
  encodeFinalMeshContainer,
  FinalMeshContainerError,
  FINAL_MESH_MAGIC,
} from './container.ts';

/** A tiny tetrahedron (4 verts, 4 faces) — smallest closed mesh. */
function tetra(): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

describe('final-mesh container', () => {
  it('round-trips positions + indices byte-identically', () => {
    const mesh = tetra();
    const bytes = encodeFinalMeshContainer(mesh);
    const back = decodeFinalMeshContainer(bytes);
    expect(Array.from(back.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(back.indices)).toEqual(Array.from(mesh.indices));
    // The raw regions equal the source buffers → the same content hash by
    // construction (sha256(positions ‖ indices)).
    expect(new Uint8Array(back.positions.buffer)).toEqual(new Uint8Array(mesh.positions.buffer));
    expect(new Uint8Array(back.indices.buffer)).toEqual(new Uint8Array(mesh.indices.buffer));
  });

  it('is deterministic: same mesh ⇒ bit-identical bytes', () => {
    const a = encodeFinalMeshContainer(tetra());
    const b = encodeFinalMeshContainer(tetra());
    expect(a).toEqual(b);
  });

  it('decodes through a byte-offset (subarray) source', () => {
    const bytes = encodeFinalMeshContainer(tetra());
    const framed = new Uint8Array(bytes.byteLength + 7);
    framed.set(bytes, 7);
    const back = decodeFinalMeshContainer(framed.subarray(7));
    expect(Array.from(back.indices)).toEqual([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  });

  it('rejects a bad magic', () => {
    const bytes = encodeFinalMeshContainer(tetra());
    bytes[0] = 0;
    expect(() => decodeFinalMeshContainer(bytes)).toThrow(FinalMeshContainerError);
  });

  it('rejects truncation', () => {
    const bytes = encodeFinalMeshContainer(tetra());
    expect(() => decodeFinalMeshContainer(bytes.subarray(0, bytes.length - 4))).toThrow(
      /length .* != expected/,
    );
    expect(() => decodeFinalMeshContainer(new Uint8Array(4))).toThrow(/shorter than/);
  });

  it('rejects an out-of-range index', () => {
    const mesh = tetra();
    mesh.indices[0] = 99;
    const bytes = encodeFinalMeshContainer(mesh);
    expect(() => decodeFinalMeshContainer(bytes)).toThrow(/out of range/);
  });

  it('rejects non-triangular buffers on encode', () => {
    expect(() =>
      encodeFinalMeshContainer({ positions: new Float64Array(4), indices: new Uint32Array(3) }),
    ).toThrow(/not a multiple of 3/);
  });

  it('exposes the DQFM magic as little-endian uint32', () => {
    // 'D'=0x44 'Q'=0x51 'F'=0x46 'M'=0x4d, read LE => 0x4d465144
    expect(FINAL_MESH_MAGIC).toBe(0x4d465144);
  });
});
