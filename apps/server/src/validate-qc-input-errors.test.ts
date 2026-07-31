// apps/server/src/validate-qc-input-errors.test.ts
//
// Phase 7 Task 1 — the P6-T8 carry-in: INPUT-SHAPED errors on
// `POST /api/restorations/:id/validate-qc` must map to 400 (with the typed
// error's diagnostic message), never escape to a 500, on ALL THREE branches of
// the discriminated body union (crown / inlay-onlay / bridge).
//
// Each test posts a body that is GENUINELY SCHEMA-VALID (it passes the AJV
// `oneOf` — no schema weakening anywhere) but semantically invalid for the QC
// pipeline, so the typed input error (`BridgeQcInputError` /
// `MarginFitInputError`) is thrown during the server's independent recompute:
//   - bridge: an abutment unit WITHOUT `fitRegion` — schema-optional by
//     design (the AJV schema cannot express "required iff kind==='abutment'";
//     the pipeline is the gate — the P6-T8 reviewer note that motivated this);
//   - crown: `marginResampledPoints: []` — a valid array per schema, but the
//     margin-fit gate requires >= 3 dense on-surface points;
//   - inlay/onlay: `cavityOutlineResampledPoints: []` — same shape on the
//     cavity branch.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody } from './crown-qc-fixture.testutil.js';
import { buildInlay, toValidateInlayQcBody } from './inlay-qc-fixture.testutil.js';
import { buildBridge, toValidateBridgeQcBody } from './bridge-qc-fixture.testutil.js';

const RESTO_ID = 'restoration-input-error-test';

describe('POST /api/restorations/:id/validate-qc — input-shaped errors map to 400, never 500', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let crownBody: Record<string, unknown>;
  let inlayBody: Record<string, unknown>;
  let bridgeBody: Record<string, unknown>;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-inputerr-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-inputerr-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
    crownBody = toValidateQcBody(await buildCrownQcInput('standin'));
    inlayBody = toValidateInlayQcBody((await buildInlay()).qcInput);
    bridgeBody = toValidateBridgeQcBody((await buildBridge()).qcInput);
  }, 300_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  async function post(body: Record<string, unknown>): Promise<{ statusCode: number; json: Record<string, unknown> }> {
    const res = await app.inject({ method: 'POST', url: `/api/restorations/${RESTO_ID}/validate-qc`, payload: body });
    return { statusCode: res.statusCode, json: res.json() as Record<string, unknown> };
  }

  it('bridge branch: an abutment without fitRegion (schema-valid) → 400 with the BridgeQcInputError message', async () => {
    const units = (bridgeBody.units as Record<string, unknown>[]).map((u) => {
      if (u.kind !== 'abutment') return u;
      const rest: Record<string, unknown> = { ...u };
      delete rest.fitRegion;
      return rest;
    });
    const { statusCode, json } = await post({ ...bridgeBody, units });

    expect(statusCode).toBe(400);
    expect(json.error).toBe('qc-invalid-input');
    expect(json.errorName).toBe('BridgeQcInputError');
    expect(String(json.message)).toContain('has no fitRegion');
  }, 120_000);

  it('crown branch: marginResampledPoints: [] (schema-valid) → 400 with the MarginFitInputError message', async () => {
    const { statusCode, json } = await post({ ...crownBody, marginResampledPoints: [] });

    expect(statusCode).toBe(400);
    expect(json.error).toBe('qc-invalid-input');
    expect(json.errorName).toBe('MarginFitInputError');
    expect(String(json.message)).toContain('marginFitGate');
  }, 120_000);

  it('inlay branch: cavityOutlineResampledPoints: [] (schema-valid) → 400 with the MarginFitInputError message', async () => {
    const { statusCode, json } = await post({ ...inlayBody, cavityOutlineResampledPoints: [] });

    expect(statusCode).toBe(400);
    expect(json.error).toBe('qc-invalid-input');
    expect(json.errorName).toBe('MarginFitInputError');
    expect(String(json.message)).toContain('marginFitGate');
  }, 120_000);

  it('crown branch: an out-of-range triangle index (schema-valid) → 400, never 500 (bounds-check)', async () => {
    // The `indices` schema pins non-negative integers but CANNOT express the
    // cross-field upper bound (index < positions.length/3). An out-of-range
    // index would otherwise reach the kernel gates as an OOB typed-array read
    // (NaN gate values / uncaught throw → 500). `toIndexedMesh` now refuses it.
    const solid = crownBody.crownSolid as { positions: number[]; indices: number[] };
    const vertexCount = Math.floor(solid.positions.length / 3);
    const poisoned = {
      ...crownBody,
      crownSolid: { positions: solid.positions, indices: [...solid.indices, vertexCount + 1000] },
    };
    const { statusCode, json } = await post(poisoned);
    expect(statusCode).toBe(400);
    expect(json.error).toBe('qc-invalid-input');
    expect(json.errorName).toBe('MeshIndexOutOfBoundsError');
    expect(String(json.message)).toContain('out of bounds');
  }, 120_000);

  it('a schema-INVALID body still gets the plain AJV 400 (the oneOf rejection is untouched)', async () => {
    const { statusCode, json } = await post({ restorationType: 'bridge' });
    expect(statusCode).toBe(400);
    // Fastify's own validation error body survives the added 400 response schema.
    expect(String(json.message)).toContain('oneOf');
  });

  it('a genuinely valid bridge body still returns the 200 QcReport (no over-catch)', async () => {
    const { statusCode, json } = await post(bridgeBody);
    expect(statusCode).toBe(200);
    expect(Array.isArray(json.gates)).toBe(true);
  }, 120_000);
});
