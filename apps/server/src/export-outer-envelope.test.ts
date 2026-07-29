// apps/server/src/export-outer-envelope.test.ts
//
// Phase 7 Task 6 (Part A) — the T4-F2 CLOSURE regression suite. The T4 review's
// blocker-adjacent gap: a coordinated byte tamper that moves a welded vertex
// OUTWARD (away from the die), identically across its per-triangle soup
// occurrences, welds cleanly, stays watertight/manifold/single-component, and
// leaves EVERY gate value unchanged (thickness/marginFit measure RIDING
// surfaces; the solid-consuming gates are insensitive to an outward move on the
// occlusal apex, far from the die and margin) — so the server report matches the
// client report and the tampered geometry RELEASES. No gate measures the
// delivered solid's outer envelope against a reference.
//
// The closure: the endpoint resolves `stages.finalMesh` (journal-verified) to
// the persisted Float64 design solid and asserts the re-imported delivered
// geometry IS that solid up to the T2 narrowing. This suite proves:
//   1. a CLEAN export with the finalMesh persisted still RELEASES (the
//      certification passes on honest bytes), and
//   2. the reviewer's moved-vertex construction 409s
//      `export-outer-envelope-mismatch` with a persisted diagnostic — RELEASED
//      pre-fix (the assertion block is what flips it), 409 post-fix.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody, TOOTH } from './crown-qc-fixture.testutil.js';
import { buildExportHarness, toExportQcContext, type ExportHarness } from './export-request.testutil.js';
import { hashMesh } from './journal-replay.js';

const STL_HEADER_BYTES = 80;
const STL_COUNT_OFFSET = 80;
const STL_TRIANGLE_BYTES = 50;

/** Moves the single welded vertex with the maximum z-coordinate (the occlusal
 * apex — far above the die frustum and the margin, so every gate value is
 * invariant under the move) OUTWARD by +`deltaMm` in z, applied IDENTICALLY to
 * every per-triangle occurrence of that exact coordinate — the reviewer's
 * consistent-adversary construction. Operates on the delivered binary STL bytes
 * (length unchanged); stored facet normals are left stale (intake recomputes
 * them from winding and discards the stored fields, so the geometry — not the
 * normal field — is what the re-validation certifies). */
function moveApexOutward(bytes: Uint8Array, deltaMm: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const triangleCount = view.getUint32(STL_COUNT_OFFSET, true);
  const base = STL_HEADER_BYTES + 4;
  const vLocalOffsets = [12, 24, 36]; // v0, v1, v2 within a 50-byte triangle
  let maxZ = -Infinity;
  let apex: [number, number, number] | null = null;
  for (let t = 0; t < triangleCount; t++) {
    const tri = base + t * STL_TRIANGLE_BYTES;
    for (const v of vLocalOffsets) {
      const x = view.getFloat32(tri + v, true);
      const y = view.getFloat32(tri + v + 4, true);
      const z = view.getFloat32(tri + v + 8, true);
      if (z > maxZ) {
        maxZ = z;
        apex = [x, y, z];
      }
    }
  }
  if (!apex) throw new Error('moveApexOutward: no vertices');
  const [ax, ay, az] = apex;
  const newZ = Math.fround(az + deltaMm);
  let moved = 0;
  for (let t = 0; t < triangleCount; t++) {
    const tri = base + t * STL_TRIANGLE_BYTES;
    for (const v of vLocalOffsets) {
      const x = view.getFloat32(tri + v, true);
      const y = view.getFloat32(tri + v + 4, true);
      const z = view.getFloat32(tri + v + 8, true);
      if (x === ax && y === ay && z === az) {
        view.setFloat32(tri + v + 8, newZ, true);
        moved += 1;
      }
    }
  }
  if (moved === 0) throw new Error('moveApexOutward: apex not found on second pass');
  return out;
}

describe('POST /api/restorations/:id/export — outer-envelope certification (T4-F2 closure)', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let exportsDataDir: string;
  let finalMeshDataDir: string;

  let standinInput: RunCrownQcInput;
  let standinReport: QcReport;
  let standinContext: Record<string, unknown>;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-oe-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-oe-tooth-'));
    exportsDataDir = mkdtempSync(join(tmpdir(), 'dqcad-oe-store-'));
    finalMeshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-oe-final-'));
    prisma = new PrismaClient();
    app = await buildApp({ prisma, meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir });

    const base = await buildCrownQcInput('standin');
    standinInput = {
      ...base,
      journalHash: hashMesh(base.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };
    standinReport = await runCrownQc(standinInput);
    standinContext = toExportQcContext(toValidateQcBody(standinInput), 'crownSolid');
  }, 300_000);

  afterAll(async () => {
    await app.close();
    for (const d of [meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  const harnessFor = (overrides?: Partial<Parameters<typeof buildExportHarness>[0]>): Promise<ExportHarness> =>
    buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [TOOTH],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
      persistFinalMesh: true,
      ...overrides,
    });

  const post = (harness: ExportHarness) =>
    app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });

  it('a CLEAN export with the finalMesh persisted still RELEASES (certification passes)', async () => {
    const harness = await harnessFor();
    const res = await post(harness);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { released: boolean }).released).toBe(true);
  });

  it('the moved-vertex tamper (gate-invariant outward move) is REJECTED 409 export-outer-envelope-mismatch', async () => {
    const harness = await harnessFor({ mutateBytes: (b) => moveApexOutward(b, 0.5) });
    const res = await post(harness);
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: string;
      diagnosticId?: string;
      referenceHash?: string;
      reimportMeshHash?: string;
    };
    expect(body.error).toBe('export-outer-envelope-mismatch');
    expect(body.diagnosticId).toBeTruthy();
    expect(body.referenceHash).not.toBe(body.reimportMeshHash);

    const diag = await prisma.exportDiagnostic.findUnique({ where: { id: body.diagnosticId! } });
    expect(diag).not.toBeNull();
    expect(diag!.reason).toBe('outer-envelope-mismatch');

    // Nothing was released.
    const released = await prisma.export.findFirst({ where: { restorationId: harness.restorationId } });
    expect(released).toBeNull();
  });

  it('WITHOUT persisted finalMesh, the same case releases (F2 open, honestly disclosed)', async () => {
    // The certification is conditional on byte provenance being present; a
    // legacy/unpersisted finalMesh releases with outerEnvelopeCertified:false.
    const harness = await harnessFor({ persistFinalMesh: false });
    const res = await post(harness);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { released: boolean }).released).toBe(true);
  });
});
