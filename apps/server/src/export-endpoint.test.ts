// apps/server/src/export-endpoint.test.ts
//
// Phase 7 Task 4 — POST /api/restorations/:id/export + GET
// /api/exports/:hash/download, driven by the REAL P4 crown fixture (standin =
// all-pass; thin = thickness-fail):
//
//  - the full pass loop (request build → endpoint → release → download →
//    downloaded bytes BYTE-IDENTICAL to the request bytes), STL and PLY;
//  - the narrowing/re-index boundary made explicit (STL reimportMeshHash ≠
//    meshContentHash, PLY reimportMeshHash === meshContentHash — while the
//    recomputed report is bit-identical either way);
//  - release semantics (append-only ledger, content-addressed idempotency);
//  - the FALSIFIABLE rejections (phase acceptance 3): (a) a geometry
//    byte-flip with fully CONSISTENT bookkeeping → caught by the
//    re-validation itself; (b) truncated bytes → parse rejection; (c) a
//    header byte-flip withOUT hash bookkeeping → the bytes-integrity gate;
//  - the verification ladder rejections: journal-hash (N5), journal
//    verification (consistent-adversary op tamper), kernel version, null-ack
//    (N4), ack tampering (P6-T8), gates-failing authorization, and the
//    qc-mismatch 409 with the PERSISTED diagnostic bundle;
//  - download integrity: unknown hash → 404; tamper-on-disk → 500, corrupt
//    bytes never served.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody, TOOTH } from './crown-qc-fixture.testutil.js';
import {
  buildExportHarness,
  cloneBody,
  toExportQcContext,
  type ExportHarness,
} from './export-request.testutil.js';
import { hashMesh } from './journal-replay.js';
import { sha256HexOf } from './mesh-storage.js';

/** Stable, key-sorted JSON — byte-level value equality independent of key
 * order (the dual-validation suites' established canonical compare). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

interface ExportOkBody {
  released: true;
  exportId: string;
  bytesSha256: string;
  byteLength: number;
  meshContentHash: string;
  reimportMeshHash: string;
  downloadPath: string;
  releasedAt: string;
  alreadyStored: boolean;
  qcReport: QcReport;
  clientAttestedGates: string[];
}

describe('POST /api/restorations/:id/export — crown fixture (pass loop + falsifiable rejections)', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let exportsDataDir: string;
  let finalMeshDataDir: string;

  let standinInput: RunCrownQcInput;
  let standinReport: QcReport;
  let standinContext: Record<string, unknown>;
  let thinInput: RunCrownQcInput;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-export-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-export-tooth-'));
    exportsDataDir = mkdtempSync(join(tmpdir(), 'dqcad-export-store-'));
    finalMeshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-export-final-'));
    prisma = new PrismaClient();
    app = await buildApp({ prisma, meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir });

    // The "client" side, freshness + profile identity included: the report's
    // journalHash IS the finalMesh content hash (the P4 convention the real
    // export flow guarantees before a request can exist) and its
    // profileVersion IS the registry profile's real version (the F1 fix
    // round: the server resolves the profile by id+version and stamps its
    // recomputed report from the verified identity).
    const base = await buildCrownQcInput('standin');
    standinInput = {
      ...base,
      journalHash: hashMesh(base.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };
    standinReport = await runCrownQc(standinInput);
    standinContext = toExportQcContext(toValidateQcBody(standinInput), 'crownSolid');
    const thinBase = await buildCrownQcInput('thin');
    thinInput = {
      ...thinBase,
      journalHash: hashMesh(thinBase.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };
  }, 300_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
    rmSync(exportsDataDir, { recursive: true, force: true });
    rmSync(finalMeshDataDir, { recursive: true, force: true });
  });

  const standinHarness = (overrides?: Partial<Parameters<typeof buildExportHarness>[0]>): Promise<ExportHarness> =>
    buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [TOOTH],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
      ...overrides,
    });

  const post = (harness: ExportHarness, body?: ExportHarness['body']) =>
    app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: body ?? harness.body,
    });

  it('releases a passing STL export: bit-identical download loop + boundary evidence + ledger row', async () => {
    const harness = await standinHarness();
    const res = await post(harness);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;

    expect(body.released).toBe(true);
    expect(body.bytesSha256).toBe(harness.request.bytesSha256);
    expect(body.byteLength).toBe(harness.bytes.byteLength);
    expect(body.alreadyStored).toBe(false);

    // The server-recomputed report over the RE-IMPORTED bytes is
    // BIT-IDENTICAL to the client report over the f64 finalMesh — the
    // measured narrowing/re-index equivalence (see export-route.ts).
    expect(canonical(body.qcReport)).toBe(canonical(standinReport));

    // The boundary, explicit: STL re-import is the f32-narrowed CANONICAL
    // RE-INDEX of the source solid — a DIFFERENT mesh value (hash), same
    // gate results.
    expect(body.meshContentHash).toBe(harness.finalMeshHash);
    expect(body.reimportMeshHash).not.toBe(harness.finalMeshHash);

    // Ledger row persisted with the release record fields.
    const row = await prisma.export.findUniqueOrThrow({ where: { id: body.exportId } });
    expect(row.bytesSha256).toBe(harness.request.bytesSha256);
    expect(row.caseId).toBe(harness.caseId);
    expect(row.exportOperationId).toBe(harness.exportOp.id);
    expect(row.kernelVersion).toBe(KERNEL_VERSION);
    expect(JSON.parse(row.qcReportJson)).toEqual(JSON.parse(JSON.stringify(standinReport)));

    // H1 fix (server code-review): a crown's `contact` gate consumes the client
    // morph residuals (design-time context, not recoverable from the mill
    // bytes), so the release RECORD discloses it as client-attested rather than
    // presenting a full-authority server-verified pass. The connector gate is
    // the single-crown N/A stub (trusts no client scalar) → NOT attested.
    expect(body.clientAttestedGates).toEqual(['contact']);
    expect(body.clientAttestedGates).not.toContain('connectorCrossSection');
    expect(JSON.parse(row.attestedGatesJson ?? 'null')).toEqual(['contact']);

    // Download: the EXACT stored bytes, byte-identical to the request bytes.
    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('model/stl');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
    expect(sha256HexOf(dl.rawPayload)).toBe(harness.request.bytesSha256);
  }, 120_000);

  it('re-exporting identical bytes is idempotent: same stored object, NEW ledger row', async () => {
    const harness = await standinHarness();
    const first = (await post(harness)).json() as ExportOkBody;
    const before = readdirSync(exportsDataDir).length;
    const second = (await post(harness)).json() as ExportOkBody;
    expect(second.released).toBe(true);
    expect(second.alreadyStored).toBe(true);
    expect(second.bytesSha256).toBe(first.bytesSha256);
    expect(second.exportId).not.toBe(first.exportId);
    // Content-addressed: no second object appeared.
    expect(readdirSync(exportsDataDir).length).toBe(before);
    const rows = await prisma.export.findMany({ where: { caseId: harness.caseId } });
    expect(rows.length).toBe(2);
  }, 120_000);

  it('releases a passing PLY export — lossless: reimportMeshHash === meshContentHash', async () => {
    const harness = await standinHarness({ format: 'ply' });
    const res = await post(harness);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;
    expect(body.reimportMeshHash).toBe(body.meshContentHash);
    expect(canonical(body.qcReport)).toBe(canonical(standinReport));
    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/octet-stream');
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
  }, 120_000);

  // --- the falsifiable rejection triple (phase acceptance 3) ---------------

  it('(a) GEOMETRY byte-flip with fully consistent bookkeeping → the re-validation itself rejects; nothing released', async () => {
    // Flip one byte inside a vertex coordinate of triangle 100 (offset 84 +
    // 100*50 + 12 skips header+count+normal). The adversary is CONSISTENT:
    // bytesSha256, byteLength, the journaled export op, and caseJournalHash
    // are all recomputed over the tampered bytes — every bookkeeping gate
    // passes, so ONLY the geometric re-validation stands between the
    // tampered bytes and release.
    const harness = await standinHarness({
      mutateBytes: (bytes) => {
        const tampered = bytes.slice();
        const offset = 84 + 100 * 50 + 12;
        tampered[offset + 3] = tampered[offset + 3]! ^ 0x01; // exponent-byte flip: a large coordinate change
        return tampered;
      },
    });
    const res = await post(harness);
    // WHICH rejection and WHY (measured, asserted): the flipped vertex
    // occurrence no longer welds with its co-incident duplicates in
    // neighboring triangles, so the re-imported surface has boundary edges —
    // an OPEN component whose outward orientation intake cannot certify
    // (`ambiguousComponentCount: 1`). That trips the re-import cleanliness
    // gate (the T2 equivalence conditions asserted server-side) BEFORE any
    // QC gate runs: the bytes are provably not the clean output of the
    // export writers → 400 export-reimport-integrity, nothing repaired,
    // nothing released.
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      details: { violations: Record<string, number>; intakeSteps: unknown[] };
    };
    expect(body.error).toBe('export-reimport-integrity');
    expect(body.details.violations['ambiguousComponentCount']).toBe(1);
    expect(body.details.intakeSteps.length).toBeGreaterThan(0);

    // Nothing released: no ledger row, download 404.
    expect(await prisma.export.findFirst({ where: { bytesSha256: harness.request.bytesSha256 } })).toBeNull();
    const dl = await app.inject({ method: 'GET', url: `/api/exports/${harness.request.bytesSha256}/download` });
    expect(dl.statusCode).toBe(404);
  }, 120_000);

  it('(a2) COORDINATED geometry tamper (welds cleanly, penetrates the die) → 409 export-outer-envelope-mismatch + persisted bundle', async () => {
    // The strongest byte adversary the QC gate set can see: ONE welded
    // vertex is moved IDENTICALLY across every per-triangle occurrence
    // (byte-identical 12-byte triple match), so the re-import welds cleanly
    // and stays watertight/manifold/single-component — the cleanliness gate
    // passes. As of Task 8 (mandatory finalMesh persistence), the delivered
    // geometry is FIRST checked against the persisted design solid at step
    // 10.5: the tampered re-import hash no longer matches the reference, so
    // this is caught as an OUTER-ENVELOPE mismatch (a stronger, earlier gate
    // than the QC-value diff — it catches ANY delivered-geometry deviation,
    // die-penetrating or not, before the QC recompute even runs). The
    // qc-mismatch path is still exercised by the "tampered clientReport" test
    // below (clean bytes, tampered report field). Diagnostic persisted,
    // nothing released.
    const harness = await standinHarness({
      mutateBytes: (bytes) => {
        const tampered = bytes.slice();
        const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);
        const triCount = view.getUint32(80, true);
        const refOff = 84 + 100 * 50 + 12;
        const ref = [
          view.getFloat32(refOff, true),
          view.getFloat32(refOff + 4, true),
          view.getFloat32(refOff + 8, true),
        ];
        let patched = 0;
        for (let i = 0; i < triCount; i++) {
          for (let v = 0; v < 3; v++) {
            const off = 84 + i * 50 + 12 + v * 12;
            if (
              view.getFloat32(off, true) === ref[0] &&
              view.getFloat32(off + 4, true) === ref[1] &&
              view.getFloat32(off + 8, true) === ref[2]
            ) {
              view.setFloat32(off, 0, true);
              view.setFloat32(off + 4, 0, true);
              view.setFloat32(off + 8, 1.2, true);
              patched++;
            }
          }
        }
        expect(patched).toBeGreaterThan(2); // the vertex really is shared
        return tampered;
      },
    });
    const res = await post(harness);
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: string;
      diagnosticId: string;
      referenceHash: string;
      reimportMeshHash: string;
    };
    expect(body.error).toBe('export-outer-envelope-mismatch');
    // The delivered geometry deviates from the persisted design solid.
    expect(body.referenceHash).not.toBe(body.reimportMeshHash);

    // The bundle is PERSISTED (the bug-report payload).
    const diagnostic = await prisma.exportDiagnostic.findUniqueOrThrow({ where: { id: body.diagnosticId } });
    expect(diagnostic.reason).toBe('outer-envelope-mismatch');
    expect(diagnostic.bytesSha256).toBe(harness.request.bytesSha256);
    const bundle = JSON.parse(diagnostic.bundleJson) as Record<string, unknown>;
    expect(bundle['reimportMeshHash']).toBeDefined();
    expect(bundle['referenceHash']).toBeDefined();

    // Nothing released.
    expect(await prisma.export.findFirst({ where: { bytesSha256: harness.request.bytesSha256 } })).toBeNull();
  }, 120_000);

  it('(b) TRUNCATED bytes with consistent bookkeeping → parse rejection (TruncatedFileError), nothing released', async () => {
    const harness = await standinHarness({
      mutateBytes: (bytes) => bytes.slice(0, bytes.byteLength - 13),
    });
    const res = await post(harness);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details: { errorName: string } };
    expect(body.error).toBe('export-bytes-parse-failed');
    expect(body.details.errorName).toBe('TruncatedFileError');
    expect(await prisma.export.findFirst({ where: { bytesSha256: harness.request.bytesSha256 } })).toBeNull();
  }, 120_000);

  it('(c) HEADER byte-flip withOUT hash bookkeeping → the bytes-integrity gate catches it FIRST', async () => {
    const harness = await standinHarness();
    const body = cloneBody(harness.body);
    // Tamper a header byte in the base64 payload but keep the DECLARED
    // bytesSha256 — the transport-integrity scenario.
    const bytes = Buffer.from(body.request.bytesBase64, 'base64');
    bytes[10] = bytes[10]! ^ 0xff; // inside the 80-byte header — non-geometry
    body.request.bytesBase64 = bytes.toString('base64');
    const res = await post(harness, body);
    expect(res.statusCode).toBe(400);
    const parsed = res.json() as { error: string; details: { actualSha256: string } };
    expect(parsed.error).toBe('export-bytes-integrity');
    expect(parsed.details.actualSha256).not.toBe(body.request.bytesSha256);
  }, 120_000);

  // --- verification-ladder rejections --------------------------------------

  it('N5: case not saved before the export request → 409 export-journal-hash-mismatch', async () => {
    const harness = await standinHarness({ skipPersistExportOp: true });
    const res = await post(harness);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; details: Record<string, unknown> };
    expect(body.error).toBe('export-journal-hash-mismatch');
    expect(body.details['savedOperationCount']).toBe(0);
    expect(body.details['requestOperationCount']).toBe(1);
  }, 120_000);

  it('consistent-adversary journal tamper (export-op bytes hash) → 409 export-journal-verification-failed', async () => {
    // The persisted export op's outputHashes[0] is tampered AND the request
    // caseJournalHash is recomputed over the tampered journal — the hash
    // gate passes; the op-binding verification is what must catch it.
    const harness = await standinHarness({
      mutateHistory: (history) =>
        history.map((op) => (op.name === 'restoration-export' ? { ...op, outputHashes: ['0'.repeat(64)] } : op)),
    });
    const res = await post(harness);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; details: { reason: string } };
    expect(body.error).toBe('export-journal-verification-failed');
    expect(body.details.reason).toBe('export-operation-bytes-hash-mismatch');
  }, 120_000);

  it('kernel-version mismatch → 409 export-kernel-version-mismatch (no QC run on an incomparable kernel)', async () => {
    const harness = await standinHarness();
    const body = cloneBody(harness.body);
    body.request.kernelVersion = '0.0.1';
    const res = await post(harness, body);
    expect(res.statusCode).toBe(409);
    const parsed = res.json() as { error: string; details: Record<string, unknown> };
    expect(parsed.error).toBe('export-kernel-version-mismatch');
    expect(parsed.details['serverKernelVersion']).toBe(KERNEL_VERSION);
  }, 120_000);

  it('tampered clientReport → 409 export-qc-mismatch with per-field diff + persisted bundle', async () => {
    const harness = await standinHarness();
    const body = cloneBody(harness.body);
    body.request.qcReport = { ...body.request.qcReport, passed: !body.request.qcReport.passed };
    const res = await post(harness, body);
    expect(res.statusCode).toBe(409);
    const parsed = res.json() as { error: string; diagnosticId: string; differences: { path: string }[] };
    expect(parsed.error).toBe('export-qc-mismatch');
    expect(parsed.differences.some((d) => d.path === 'passed')).toBe(true);
    expect((await prisma.exportDiagnostic.findUnique({ where: { id: parsed.diagnosticId } }))?.reason).toBe(
      'qc-mismatch',
    );
  }, 120_000);

  it('URL :id vs request.restorationId mismatch → 400', async () => {
    const harness = await standinHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/restorations/some-other-restoration/export',
      payload: harness.body,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('export-request-id-mismatch');
  }, 120_000);

  it('unknown caseId → 404 export-case-not-found', async () => {
    const harness = await standinHarness();
    const body = cloneBody(harness.body);
    body.request.caseId = 'no-such-case';
    const res = await post(harness, body);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('export-case-not-found');
  }, 120_000);

  it('malformed body (missing qcContext) → Fastify AJV 400', async () => {
    const harness = await standinHarness();
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: { request: harness.request },
    });
    expect(res.statusCode).toBe(400);
  }, 120_000);

  // --- F1 fix round: server-side material-profile pinning ------------------

  describe('material-profile pinning (F1 — the reviewer-demonstrated exploit)', () => {
    it('EXPLOIT regression: a loosened riding threshold (295 µm wall vs qcContext 0.05 mm minimum) is REFUSED, never released', async () => {
      // The reviewer's exact exploit, red pre-fix (it RELEASED with 200 and
      // recorded threshold 0.05/passed:true in the "authoritative" ledger
      // report): the thin crown's real wall is 295 µm — clinically BELOW the
      // profile's 500 µm minimum — but the attacker ships
      // qcContext.minWallThicknessMm = 0.05 (+ occlusal) and a matching
      // client report, so the gate "passes" unacknowledged on both sides and
      // the diff is empty. The fix pins thresholds to the server-resolved
      // profile (and, for the crown wall minimum, the saved schema-bounded
      // restoration parameter): any divergence is a typed 409 naming the
      // field and both values — the client LEARNS its thresholds were wrong.
      const attackInput: RunCrownQcInput = {
        ...thinInput,
        minWallThicknessMm: 0.05,
        occlusalMinWallThicknessMm: 0.05,
      };
      const attackReport = await runCrownQc(attackInput);
      expect(attackReport.passed).toBe(true); // the loosened gate "passes"
      expect(attackReport.gates.find((g) => g.gate === 'minWallThickness')?.acknowledged).toBe(false);

      const harness = await buildExportHarness({
        app,
        restorationType: 'crown',
        teeth: [TOOTH],
        finalMesh: thinInput.crownSolid,
        clientReport: attackReport,
        qcContext: toExportQcContext(toValidateQcBody(attackInput), 'crownSolid'),
        format: 'stl',
      });
      const res = await post(harness);
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        error: string;
        details: { mismatches: { field: string; riding: unknown; resolved: unknown }[] };
      };
      expect(body.error).toBe('export-profile-threshold-mismatch');
      const fields = body.details.mismatches.map((m) => m.field);
      expect(fields).toContain('minWallThicknessMm');
      expect(fields).toContain('occlusalMinWallThicknessMm');
      const wall = body.details.mismatches.find((m) => m.field === 'minWallThicknessMm')!;
      expect(wall.riding).toBe(0.05);
      expect(wall.resolved).toBe(0.5);
      // Nothing released.
      expect(await prisma.export.findFirst({ where: { bytesSha256: harness.request.bytesSha256 } })).toBeNull();
    }, 300_000);

    it('a FABRICATED materialProfile.checksum → 409 export-material-profile-checksum-mismatch (the checksum is no longer inert)', async () => {
      const harness = await standinHarness();
      const body = cloneBody(harness.body);
      body.request.materialProfile = { ...body.request.materialProfile, checksum: 'a'.repeat(64) };
      const res = await post(harness, body);
      expect(res.statusCode).toBe(409);
      const parsed = res.json() as { error: string; details: Record<string, unknown> };
      expect(parsed.error).toBe('export-material-profile-checksum-mismatch');
      expect(parsed.details['resolvedChecksum']).toBe(STANDARD_ZIRCONIA_PROFILE.checksum);
    }, 120_000);

    it('an UNKNOWN profile version → 409 export-material-profile-unknown', async () => {
      const harness = await standinHarness();
      const body = cloneBody(harness.body);
      body.request.materialProfile = { ...body.request.materialProfile, version: '9.9.9' };
      const res = await post(harness, body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('export-material-profile-unknown');
    }, 120_000);

    it('an UNKNOWN profile id → 409 export-material-profile-unknown', async () => {
      const harness = await standinHarness();
      const body = cloneBody(harness.body);
      body.request.materialProfile = { ...body.request.materialProfile, id: 'nonexistent-material' };
      const res = await post(harness, body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('export-material-profile-unknown');
    }, 120_000);

    it('a free tolerance knob in qcContext (seatingInterferenceVolumeToleranceMm3) is schema-FORBIDDEN → 400', async () => {
      const harness = await standinHarness();
      const body = cloneBody(harness.body);
      (body.qcContext as Record<string, unknown>)['seatingInterferenceVolumeToleranceMm3'] = 1e9;
      const res = await post(harness, body);
      expect(res.statusCode).toBe(400);
    }, 120_000);
  });

  // --- N1: delivered header verified against the journaled headerText ------

  it('N1: a consistent-adversary HEADER tamper is refused (delivered header must equal the journaled headerText)', async () => {
    // Pre-fix this RELEASED (the STL header is a comment intake ignores; the
    // adversary recomputed every hash so the bookkeeping gates all passed).
    // Now the delivered 80-byte header region must be byte-identical to the
    // writer's rendering of the JOURNALED headerText.
    const harness = await standinHarness({
      mutateBytes: (bytes) => {
        const tampered = bytes.slice();
        tampered[10] = tampered[10]! ^ 0xff; // inside the 80-byte header
        return tampered;
      },
    });
    const res = await post(harness);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('export-header-mismatch');
    expect(await prisma.export.findFirst({ where: { bytesSha256: harness.request.bytesSha256 } })).toBeNull();
  }, 120_000);

  // --- acknowledged-gate enforcement (thin crown: thickness fails) ---------

  describe('acknowledgment enforcement (thin crown)', () => {
    let thinAckedReport: QcReport;
    let thinContext: Record<string, unknown>;

    beforeAll(async () => {
      const acked: RunCrownQcInput = { ...thinInput, acknowledgedGates: ['minWallThickness'] };
      thinAckedReport = await runCrownQc(acked);
      expect(thinAckedReport.passed).toBe(true); // acknowledged failure
      thinContext = toExportQcContext(toValidateQcBody(thinInput), 'crownSolid');
    }, 300_000);

    const thinHarness = (report: QcReport): Promise<ExportHarness> =>
      buildExportHarness({
        app,
        restorationType: 'crown',
        teeth: [TOOTH],
        finalMesh: thinInput.crownSolid,
        clientReport: report,
        qcContext: thinContext,
        format: 'stl',
      });

    it('an acknowledged-with-warning export RELEASES, the acknowledgment journal-verified + recorded', async () => {
      const harness = await thinHarness(thinAckedReport);
      expect(harness.request.acknowledgments.length).toBe(1);
      expect(harness.request.acknowledgments[0]!.operationId).toBe(harness.ackOps[0]!.id);
      const res = await post(harness);
      expect(res.statusCode).toBe(200);
      const body = res.json() as ExportOkBody;
      const gate = body.qcReport.gates.find((g) => g.gate === 'minWallThickness');
      expect(gate?.passed).toBe(false);
      expect(gate?.acknowledged).toBe(true);
      const row = await prisma.export.findUniqueOrThrow({ where: { id: body.exportId } });
      const acks = JSON.parse(row.acknowledgmentsJson) as { gate: string; operationId: string }[];
      expect(acks).toEqual([
        expect.objectContaining({ gate: 'minWallThickness', operationId: harness.ackOps[0]!.id }),
      ]);
    }, 120_000);

    it('N4: acknowledgment with operationId null → 409 export-unjournaled-acknowledgment', async () => {
      const harness = await thinHarness(thinAckedReport);
      const body = cloneBody(harness.body);
      body.request.acknowledgments = body.request.acknowledgments.map((a) => ({ ...a, operationId: null }));
      const res = await post(harness, body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('export-unjournaled-acknowledgment');
    }, 120_000);

    it('P6-T8: acknowledgment ref tampered to a non-ack op → 409 export-acknowledgment-invalid', async () => {
      const harness = await thinHarness(thinAckedReport);
      const body = cloneBody(harness.body);
      body.request.acknowledgments = body.request.acknowledgments.map((a) => ({
        ...a,
        operationId: harness.exportOp.id,
      }));
      const res = await post(harness, body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('export-acknowledgment-invalid');
    }, 120_000);

    it('a hand-built request shipping a matching-but-FAILING unacknowledged report → 409 export-gates-failing', async () => {
      const thinUnackedReport = await runCrownQc(thinInput);
      expect(thinUnackedReport.passed).toBe(false);
      const harness = await thinHarness(thinUnackedReport);
      const res = await post(harness);
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; failingGates: string[] };
      expect(body.error).toBe('export-gates-failing');
      expect(body.failingGates).toContain('minWallThickness');
      // Nothing released FROM THIS CASE (the same bytes were legitimately
      // released by the acknowledged-flow test above — content addressing
      // dedupes across cases, so the row check must be case-scoped).
      expect(await prisma.export.findFirst({ where: { caseId: harness.caseId } })).toBeNull();
    }, 300_000);
  });

  // --- download integrity ---------------------------------------------------

  describe('GET /api/exports/:hash/download integrity', () => {
    it('404s for a hash never released', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/exports/${'e'.repeat(64)}/download` });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('export-not-found');
    });

    it('rejects a malformed hash param', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/exports/../../etc/passwd/download' });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    });

    it('stored object MISSING behind an existing ledger row → 500 export-storage-integrity', async () => {
      const harness = await standinHarness({ format: 'ply' });
      const ok = (await post(harness)).json() as ExportOkBody;
      const storedPath = join(exportsDataDir, ok.bytesSha256);
      rmSync(storedPath);
      const res = await app.inject({ method: 'GET', url: ok.downloadPath });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe('export-storage-integrity');
      // Restore the object (other tests may share the content address).
      writeFileSync(storedPath, Buffer.from(harness.bytes));
    }, 120_000);

    it('tamper-on-disk → 500 export-storage-integrity; corrupt bytes are NEVER served', async () => {
      const harness = await standinHarness();
      const ok = (await post(harness)).json() as ExportOkBody;
      // Corrupt the stored object in place (simulated disk tampering).
      const storedPath = join(exportsDataDir, ok.bytesSha256);
      const tampered = Buffer.from(harness.bytes);
      tampered[200] = tampered[200]! ^ 0xff;
      writeFileSync(storedPath, tampered);
      const res = await app.inject({ method: 'GET', url: ok.downloadPath });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toBe('export-storage-integrity');
      // Restore for any later test using the same content.
      writeFileSync(storedPath, Buffer.from(harness.bytes));
    }, 120_000);
  });
});
