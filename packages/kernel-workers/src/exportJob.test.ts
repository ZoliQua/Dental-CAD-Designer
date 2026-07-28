// packages/kernel-workers/src/exportJob.test.ts
//
// Phase 7 Task 3 — the `exportRestorationMesh` worker job (jobs/export.ts):
// serializes a final restoration solid to manufacturing bytes IN THE WORKER
// (composing the Task 2 io export layer unchanged) and hashes the exact
// bytes worker-side. The replay contract under test: same mesh + same
// journaled params (format, headerText) ⇒ BIT-IDENTICAL bytes and the same
// SHA-256 — the export `Operation.outputHashes[0]` is reproducible.
// Falsifiable both ways: determinism asserted byte-for-byte, and every
// reject path (invalid solid, bad payload shapes, headerText misuse) is
// demonstrated to throw typed errors, never to silently no-op.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { exportRestorationMesh } from './jobs/export.ts';
import type { JobContext } from './jobs/context.ts';

const ctx: JobContext = { progress: () => {}, cancelled: () => false };

/** Unit cube — watertight, 2-manifold, consistently wound, outward (the
 * same closed-form solid the io export goldens pin). */
function cube(): { positions: Float64Array; indices: Uint32Array } {
  const positions = Float64Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const indices = Uint32Array.from([
    0, 3, 2, 0, 2, 1, // z=0 (down)
    4, 5, 6, 4, 6, 7, // z=1 (up)
    0, 1, 5, 0, 5, 4, // y=0
    3, 7, 6, 3, 6, 2, // y=1
    0, 4, 7, 0, 7, 3, // x=0
    1, 2, 6, 1, 6, 5, // x=1
  ]);
  return { positions, indices };
}

/** The reversed (inward) cube — Task 2's typed reject case. */
function inwardCube(): { positions: Float64Array; indices: Uint32Array } {
  const { positions, indices } = cube();
  const reversed = new Uint32Array(indices.length);
  for (let t = 0; t < indices.length / 3; t++) {
    reversed[t * 3] = indices[t * 3]!;
    reversed[t * 3 + 1] = indices[t * 3 + 2]!;
    reversed[t * 3 + 2] = indices[t * 3 + 1]!;
  }
  return { positions, indices: reversed };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('exportRestorationMesh — determinism (the replay contract)', () => {
  it('stl: two runs over the same inputs produce BIT-IDENTICAL bytes and the same worker-side hash', async () => {
    const mesh = cube();
    const a = await exportRestorationMesh({ ...mesh, format: 'stl' }, ctx);
    const b = await exportRestorationMesh({ ...cube(), format: 'stl' }, ctx);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.bytesSha256).toBe(b.bytesSha256);
    expect(a.bytesSha256).toBe(sha256(a.bytes));
    expect(a.byteLength).toBe(a.bytes.byteLength);
    expect(a.triangleCount).toBe(12);
  });

  it('ply: same determinism + worker-side hash contract', async () => {
    const a = await exportRestorationMesh({ ...cube(), format: 'ply' }, ctx);
    const b = await exportRestorationMesh({ ...cube(), format: 'ply' }, ctx);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.bytesSha256).toBe(sha256(a.bytes));
  });

  it('a journaled headerText is byte-honoured (different header ⇒ different bytes, same header ⇒ identical)', async () => {
    const headerText = 'DQ-Dental-CAD; units=mm; crown 11';
    const a = await exportRestorationMesh({ ...cube(), format: 'stl', headerText }, ctx);
    const b = await exportRestorationMesh({ ...cube(), format: 'stl', headerText }, ctx);
    const other = await exportRestorationMesh({ ...cube(), format: 'stl' }, ctx);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(other.bytes))).toBe(false);
    // The header text actually lands in the 80-byte header field.
    expect(Buffer.from(a.bytes.subarray(0, 80)).toString('latin1')).toContain('crown 11');
  });

  it('the exported STL re-parses with the exact triangle count (sanity: real bytes, not a stub)', async () => {
    const { bytes } = await exportRestorationMesh({ ...cube(), format: 'stl' }, ctx);
    const { soup } = parseStl(bytes);
    expect(soup.triangleCount).toBe(12);
  });
});

describe('exportRestorationMesh — typed rejects (no silent no-op path)', () => {
  it('rejects an inward-oriented solid with the io layer typed error (reject, never repair)', async () => {
    await expect(exportRestorationMesh({ ...inwardCube(), format: 'stl' }, ctx)).rejects.toMatchObject({
      name: 'ExportMeshInvalidError',
      reason: 'inward-orientation',
    });
  });

  it('rejects an open (non-watertight) mesh', async () => {
    const { positions, indices } = cube();
    await expect(
      exportRestorationMesh({ positions, indices: indices.subarray(3), format: 'stl' }, ctx),
    ).rejects.toMatchObject({ name: 'ExportMeshInvalidError', reason: 'boundary-edge' });
  });

  it('rejects an over-long headerText (the T2 no-silent-truncation bound)', async () => {
    await expect(
      exportRestorationMesh({ ...cube(), format: 'stl', headerText: 'x'.repeat(81) }, ctx),
    ).rejects.toThrow(/80/);
  });

  it('rejects headerText passed with format ply (a caller bug must surface, not silently drop the header)', async () => {
    await expect(
      exportRestorationMesh({ ...cube(), format: 'ply', headerText: 'DQ' }, ctx),
    ).rejects.toThrow(/headerText/);
  });

  it('rejects non-Float64/Uint32 payload buffers (kernel Float64 rule) and an unknown format', async () => {
    const mesh = cube();
    await expect(
      exportRestorationMesh(
        { positions: new Float32Array(3) as unknown as Float64Array, indices: mesh.indices, format: 'stl' },
        ctx,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      exportRestorationMesh(
        { positions: mesh.positions, indices: mesh.indices, format: 'obj' as 'stl' },
        ctx,
      ),
    ).rejects.toThrow(TypeError);
  });

  it('honours cancellation before serializing', async () => {
    const cancelledCtx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(exportRestorationMesh({ ...cube(), format: 'stl' }, cancelledCtx)).rejects.toMatchObject({
      name: 'JobCancelledError',
    });
  });
});
