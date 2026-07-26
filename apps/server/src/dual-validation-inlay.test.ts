// apps/server/src/dual-validation-inlay.test.ts
//
// THE dual-validation proof EXTENDED to the cavity (inlay/onlay) pipeline
// (CLAUDE.md invariant 6, Phase 5 Task 9). Builds a genuine end-to-end synthetic
// inlay/onlay via the SAME public kernel + cad-pipeline pipeline the client's
// cavity worker jobs use, runs the client-side `runInlayQc` in-process, then
// POSTs the SAME inputs to `POST /api/restorations/:id/validate-qc` and asserts
// the server's independently-recomputed `QcReport` is BIT-IDENTICAL to the
// client's — for the all-pass inlay, the shallow (thickness-FAIL) inlay, AND the
// onlay whose seating gate is ACKNOWLEDGED (the acknowledgment must round-trip
// byte-for-byte). Also proves: determinism, the optional client cross-check
// (matching → 200; tampered → 409 diagnostic — the server NEVER trusting the
// client report), schema rejection of a malformed cavity body, and that the
// WASM gates (seating / selfIntersection) run server-side on the inlay path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runInlayQc, type RunInlayQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import { buildInlay, buildOnlay, toValidateInlayQcBody, type BuiltCavityRestoration } from './inlay-qc-fixture.testutil.js';

const RESTO_ID = 'cavity-restoration-under-test';

/** Stable, key-sorted JSON — a byte-level equality check independent of the key
 * ORDER fast-json-stringify (schema order) vs `runInlayQc` (insertion order)
 * happen to emit, so this asserts the VALUES are byte-identical. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

describe('POST /api/restorations/:id/validate-qc — inlay/onlay dual validation (client/server bit-identical QcReport)', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;

  let inlay: BuiltCavityRestoration;
  let inlayClientReport: QcReport;
  let shallow: BuiltCavityRestoration;
  let shallowClientReport: QcReport;
  let onlay: BuiltCavityRestoration;
  let onlayClientReport: QcReport;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-inlay-dualval-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-inlay-dualval-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });

    // The "client" side: build the inlay/onlay + run runInlayQc in-process,
    // exactly as the client's runInlayQc worker job does.
    inlay = await buildInlay('inlay');
    inlayClientReport = await runInlayQc(inlay.qcInput);
    shallow = await buildInlay('inlay-shallow');
    shallowClientReport = await runInlayQc(shallow.qcInput);
    onlay = await buildOnlay();
    onlayClientReport = await runInlayQc(onlay.qcInput);
  }, 600_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  const post = (
    input: RunInlayQcInput,
    extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      payload: toValidateInlayQcBody(input, extra),
    });

  it('MOD inlay: the server report is BIT-IDENTICAL to the client runInlayQc (ALL gates pass)', async () => {
    const res = await post(inlay.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    // THE proof: exact deep-equal + byte-identical canonical JSON.
    expect(serverReport).toEqual(inlayClientReport);
    expect(canonical(serverReport)).toBe(canonical(inlayClientReport));

    expect(serverReport.passed).toBe(true);
    expect(serverReport.gates.every((g) => g.passed)).toBe(true);
    expect(serverReport.gates.map((g) => g.gate)).toEqual([
      'watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seamDihedral', 'seating', 'contact',
    ]);
    expect(serverReport.kernelVersion).toBe(inlayClientReport.kernelVersion);
  }, 120_000);

  it('the WASM gates (seating + selfIntersection) run server-side on the inlay path', async () => {
    const serverReport = (await post(inlay.qcInput)).json() as QcReport;
    const seating = serverReport.gates.find((g) => g.gate === 'seating');
    const selfInt = serverReport.gates.find((g) => g.gate === 'selfIntersection');
    // seating carries a REAL server-measured interference volume (manifold-3d
    // boolean) — a finite number ≤ its tolerance, and byte-identical to the client.
    expect(seating).toBeDefined();
    expect(typeof seating!.value).toBe('number');
    expect(Number.isFinite(seating!.value as number)).toBe(true);
    expect(seating!.value).toBe(inlayClientReport.gates.find((g) => g.gate === 'seating')!.value);
    // selfIntersection ran (manifold-3d proxy) and agrees byte-for-byte.
    expect(selfInt).toBeDefined();
    expect(selfInt!.passed).toBe(inlayClientReport.gates.find((g) => g.gate === 'selfIntersection')!.passed);
  }, 120_000);

  it('shallow inlay: the server report is BIT-IDENTICAL to the client runInlayQc (thickness FAILS)', async () => {
    const res = await post(shallow.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    expect(serverReport).toEqual(shallowClientReport);
    expect(canonical(serverReport)).toBe(canonical(shallowClientReport));

    const thickness = serverReport.gates.find((g) => g.gate === 'minWallThickness');
    expect(thickness?.passed).toBe(false);
    expect(serverReport.passed).toBe(false);
  }, 120_000);

  it('ONLAY: the ACKNOWLEDGED-seating round-trip is BIT-IDENTICAL (passed/acknowledged flags byte-for-byte)', async () => {
    const res = await post(onlay.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    // The whole report — including the acknowledgment flags — is byte-identical.
    expect(serverReport).toEqual(onlayClientReport);
    expect(canonical(serverReport)).toBe(canonical(onlayClientReport));

    // The onlay gate set includes the region-scoped cuspCoverage gate.
    expect(serverReport.gates.map((g) => g.gate)).toEqual([
      'watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'cuspCoverageThickness', 'marginFit', 'seamDihedral', 'seating', 'contact',
    ]);

    // The seating gate is UNWEAKENED (measured fail) but ACKNOWLEDGED — and the
    // server re-applied the acknowledgment from the request, so passed=false &
    // acknowledged=true & report.passed=true agree byte-for-byte with the client.
    const seating = serverReport.gates.find((g) => g.gate === 'seating')!;
    const clientSeating = onlayClientReport.gates.find((g) => g.gate === 'seating')!;
    expect(seating.passed).toBe(false);
    expect(seating.acknowledged).toBe(true);
    expect(seating.passed).toBe(clientSeating.passed);
    expect(seating.acknowledged).toBe(clientSeating.acknowledged);
    expect(serverReport.passed).toBe(true);
    expect(serverReport.passed).toBe(onlayClientReport.passed);
  }, 180_000);

  it('is deterministic: two server re-validations of the same inlay input yield identical reports', async () => {
    const a = (await post(inlay.qcInput)).json();
    const b = (await post(inlay.qcInput)).json();
    expect(canonical(a)).toBe(canonical(b));
  }, 120_000);

  it('accepts a MATCHING clientReport cross-check (200; still returns the server-computed report)', async () => {
    const res = await post(inlay.qcInput, { clientReport: inlayClientReport });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(inlayClientReport);
  }, 120_000);

  it('409s with a per-field diagnostic when a TAMPERED clientReport disagrees (never trusts the client — invariant 6)', async () => {
    const tampered: QcReport = { ...inlayClientReport, passed: !inlayClientReport.passed };
    const res = await post(inlay.qcInput, { clientReport: tampered });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string; differences: Array<{ path: string }> };
    expect(body.error).toBe('qc-client-server-mismatch');
    expect(body.differences.some((d) => d.path === 'passed')).toBe(true);
  }, 120_000);

  it('detects an acknowledgment-flag divergence: a clientReport that pretends seating passed cleanly → 409', async () => {
    // A tampered onlay report claiming the seating gate PASSED (not merely
    // acknowledged) must be caught — the server re-applies the acknowledgment
    // from the request but re-measures the gate as a fail.
    const clean = onlayClientReport.gates.map((g) =>
      g.gate === 'seating' ? { ...g, passed: true, acknowledged: false } : g,
    );
    const tampered: QcReport = { ...onlayClientReport, gates: clean };
    const res = await post(onlay.qcInput, { clientReport: tampered });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { differences: Array<{ path: string }> };
    // the seating gate's passed AND acknowledged fields both diverge
    expect(body.differences.some((d) => d.path.includes('seating') || d.path.includes('passed') || d.path.includes('acknowledged'))).toBe(true);
  }, 180_000);

  it('rejects a malformed cavity validate-qc body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      // restorationType present but the cavity mesh set is absent → matches
      // neither oneOf branch.
      payload: { restorationType: 'inlay', inlaySolid: { positions: [0, 0, 0] } },
    });
    expect(res.statusCode).toBe(400);
  });
});
