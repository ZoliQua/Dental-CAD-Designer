import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFinalMeshContainer } from '@dqcad/io';
import type { IndexedMesh } from '@dqcad/kernel';
import { hashMesh } from './journal-replay.js';
import {
  FinalMeshContentMismatchError,
  FinalMeshStorageIntegrityError,
  readFinalMesh,
  statFinalMesh,
  storeFinalMeshContainer,
} from './final-mesh-storage.js';

function tetra(): IndexedMesh {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

describe('final-mesh content-addressed storage', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dqcad-finalmesh-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores keyed by content hash and reads back the exact Float64 mesh', async () => {
    const mesh = tetra();
    const container = Buffer.from(encodeFinalMeshContainer(mesh));
    const contentHash = hashMesh(mesh);

    const stored = await storeFinalMeshContainer(dir, container);
    expect(stored.contentHash).toBe(contentHash);
    expect(stored.alreadyExisted).toBe(false);
    expect(await statFinalMesh(dir, contentHash)).toBe(container.byteLength);

    const back = await readFinalMesh(dir, contentHash);
    expect(back).not.toBeNull();
    expect(hashMesh(back!)).toBe(contentHash);
    expect(Array.from(back!.positions)).toEqual(Array.from(mesh.positions));
  });

  it('is idempotent on re-upload of identical bytes', async () => {
    const container = Buffer.from(encodeFinalMeshContainer(tetra()));
    const first = await storeFinalMeshContainer(dir, container);
    const second = await storeFinalMeshContainer(dir, container);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.alreadyExisted).toBe(true);
  });

  it('rejects an upload whose content does not match the expected address', async () => {
    const container = Buffer.from(encodeFinalMeshContainer(tetra()));
    await expect(
      storeFinalMeshContainer(dir, container, 'f'.repeat(64)),
    ).rejects.toBeInstanceOf(FinalMeshContentMismatchError);
  });

  it('returns null for an unknown content hash', async () => {
    expect(await readFinalMesh(dir, 'a'.repeat(64))).toBeNull();
    expect(await statFinalMesh(dir, 'a'.repeat(64))).toBeNull();
  });

  it('refuses to serve bytes tampered on disk (address no longer matches content)', async () => {
    const mesh = tetra();
    const container = Buffer.from(encodeFinalMeshContainer(mesh));
    const { contentHash } = await storeFinalMeshContainer(dir, container);
    // Corrupt a coordinate byte in-place under the same filename.
    const path = join(dir, contentHash);
    const onDisk = readFileSync(path);
    onDisk[onDisk.length - 20] = (onDisk[onDisk.length - 20]! ^ 0xff) & 0xff;
    writeFileSync(path, onDisk);
    await expect(readFinalMesh(dir, contentHash)).rejects.toBeInstanceOf(FinalMeshStorageIntegrityError);
  });
});
