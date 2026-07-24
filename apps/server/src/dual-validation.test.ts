// apps/server/src/dual-validation.test.ts
//
// THE dual-validation proof (CLAUDE.md invariant 6). Builds a genuine
// end-to-end synthetic crown (standin = all gates pass; thin = thickness
// fails), runs the client-side `runCrownQc` in-process, then POSTs the SAME
// inputs to `POST /api/restorations/:id/validate-qc` and asserts the server's
// independently-recomputed `QcReport` is BIT-IDENTICAL to the client's — for
// both fixtures. Also proves: determinism (two server runs agree), the
// optional client cross-check (matching → 200; tampered → 409 diagnostic, the
// server NEVER trusting the client report), and schema rejection of a
// malformed body.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody } from './crown-qc-fixture.testutil.js';

const RESTO_ID = 'restoration-under-test';

/** Stable, key-sorted JSON — a byte-level equality check independent of the
 * key ORDER fast-json-stringify (schema order) vs `runCrownQc` (insertion
 * order) happen to emit, so this asserts the VALUES are byte-identical. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

describe('POST /api/restorations/:id/validate-qc — dual validation (client/server bit-identical QcReport)', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;

  let standinInput: RunCrownQcInput;
  let standinClientReport: QcReport;
  let thinInput: RunCrownQcInput;
  let thinClientReport: QcReport;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-dualval-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-dualval-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });

    // The "client" side: build the crown + run runCrownQc in-process, exactly
    // as the client's runQc worker job does.
    standinInput = await buildCrownQcInput('standin');
    standinClientReport = await runCrownQc(standinInput);
    thinInput = await buildCrownQcInput('thin');
    thinClientReport = await runCrownQc(thinInput);
  }, 300_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  const post = (
    input: RunCrownQcInput,
    extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      payload: toValidateQcBody(input, extra),
    });

  it('standin crown: the server report is BIT-IDENTICAL to the client runCrownQc (ALL gates pass)', async () => {
    const res = await post(standinInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    // THE proof: exact deep-equal + byte-identical canonical JSON.
    expect(serverReport).toEqual(standinClientReport);
    expect(canonical(serverReport)).toBe(canonical(standinClientReport));

    expect(serverReport.passed).toBe(true);
    expect(serverReport.gates.every((g) => g.passed)).toBe(true);
    expect(serverReport.kernelVersion).toBe(standinClientReport.kernelVersion);
  }, 120_000);

  it('thin crown: the server report is BIT-IDENTICAL to the client runCrownQc (thickness FAILS)', async () => {
    const res = await post(thinInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    expect(serverReport).toEqual(thinClientReport);
    expect(canonical(serverReport)).toBe(canonical(thinClientReport));

    const thickness = serverReport.gates.find((g) => g.gate === 'minWallThickness');
    expect(thickness?.passed).toBe(false);
    expect(serverReport.passed).toBe(false);
  }, 120_000);

  it('is deterministic: two server re-validations of the same input yield identical reports', async () => {
    const a = (await post(standinInput)).json();
    const b = (await post(standinInput)).json();
    expect(canonical(a)).toBe(canonical(b));
  }, 120_000);

  it('accepts a MATCHING clientReport cross-check (200; still returns the server-computed report)', async () => {
    const res = await post(standinInput, { clientReport: standinClientReport });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(standinClientReport);
  }, 120_000);

  it('409s with a per-field diagnostic when a TAMPERED clientReport disagrees (never trusts the client — invariant 6)', async () => {
    const tampered: QcReport = { ...standinClientReport, passed: !standinClientReport.passed };
    const res = await post(standinInput, { clientReport: tampered });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string; differences: Array<{ path: string }> };
    expect(body.error).toBe('qc-client-server-mismatch');
    expect(body.differences.some((d) => d.path === 'passed')).toBe(true);
  }, 120_000);

  it('rejects a malformed validate-qc body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      payload: { crownSolid: { positions: [0, 0, 0] } },
    });
    expect(res.statusCode).toBe(400);
  });
});
