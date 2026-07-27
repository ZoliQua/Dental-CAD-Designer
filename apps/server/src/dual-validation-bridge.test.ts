// apps/server/src/dual-validation-bridge.test.ts
//
// THE dual-validation proof EXTENDED to the BRIDGE (multi-unit) pipeline
// (CLAUDE.md invariant 6, Phase 6 Task 8). Builds a genuine 3-unit posterior
// bridge via the SAME public kernel + cad-pipeline pipeline the client's bridge
// worker jobs use (the analytic `bridgeAssemblyFixture` → the journaled
// `runBridgeAssemblyStage` fuse → `runBridgeQc`), runs the client-side
// `runBridgeQc` in-process, then POSTs the SAME inputs to
// `POST /api/restorations/:id/validate-qc` and asserts the server's
// independently-recomputed `QcReport` is BIT-IDENTICAL to the client's — for the
// all-pass 3-unit bridge, the FAILING 5 mm² connector variant, AND the thin-unit
// bridge whose thickness gate is ACKNOWLEDGED (the acknowledgment must round-trip
// byte-for-byte). Also proves: determinism, the optional client cross-check
// (matching → 200; tampered → 409 diagnostic — the server NEVER trusting the
// client report), schema rejection of a malformed bridge body, and that the WASM
// gates (seating / selfIntersection / union-dependent) run server-side on the
// bridge path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { QcReport } from '@dqcad/shared-types';
import { runBridgeQc, type RunBridgeQcInput } from '@dqcad/cad-pipeline';
import { buildApp } from './app.js';
import { buildBridge, toValidateBridgeQcBody, type BuiltBridgeRestoration } from './bridge-qc-fixture.testutil.js';

const RESTO_ID = 'bridge-restoration-under-test';

// The thin-unit block lands on the pontic (tooth 15) — the acknowledged gate.
const THIN_UNIT_GATE = 'minWallThickness:15';

/** Stable, key-sorted JSON — a byte-level equality check independent of the key
 * ORDER fast-json-stringify (schema order) vs `runBridgeQc` (insertion order)
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

describe('POST /api/restorations/:id/validate-qc — bridge dual validation (client/server bit-identical QcReport)', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;

  let pass: BuiltBridgeRestoration;
  let passClientReport: QcReport;
  let thinConnector: BuiltBridgeRestoration;
  let thinConnectorClientReport: QcReport;
  let acked: BuiltBridgeRestoration;
  let ackedClientReport: QcReport;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-bridge-dualval-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-bridge-dualval-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });

    // The "client" side: build each bridge + run runBridgeQc in-process, exactly
    // as the client's runBridgeQc worker job does.
    pass = await buildBridge({ journalHash: 'bridge-pass' });
    passClientReport = await runBridgeQc(pass.qcInput);

    // The FALSIFIABLE 5 mm² posterior connector variant (the connectorCrossSection
    // gate BLOCKS — the phase acceptance's falsifiable pair).
    thinConnector = await buildBridge({ fixture: { connectorSemiAxisMm: 1.2633 }, journalHash: 'bridge-5mm2' });
    thinConnectorClientReport = await runBridgeQc(thinConnector.qcInput);

    // The ACKNOWLEDGED round-trip: a thin pontic wall (0.4 mm < 0.5) BLOCKS
    // `minWallThickness:15`, ACKNOWLEDGED (journaled warning, never a bypass) →
    // the gate stays passed=false but the report passes; the flags must survive
    // the round-trip byte-for-byte.
    acked = await buildBridge({
      fixture: { thinPonticInnerRadiusMm: 2.6 },
      acknowledgedGates: [THIN_UNIT_GATE],
      journalHash: 'bridge-acked',
    });
    ackedClientReport = await runBridgeQc(acked.qcInput);
  }, 600_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  const post = (
    input: RunBridgeQcInput,
    extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      payload: toValidateBridgeQcBody(input, extra),
    });

  it('3-unit bridge: the server report is BIT-IDENTICAL to the client runBridgeQc (ALL 11 gates pass)', async () => {
    const res = await post(pass.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    // THE proof: exact deep-equal + byte-identical canonical JSON.
    expect(serverReport).toEqual(passClientReport);
    expect(canonical(serverReport)).toBe(canonical(passClientReport));

    expect(serverReport.passed).toBe(true);
    expect(serverReport.gates.every((g) => g.passed)).toBe(true);
    expect(serverReport.gates.map((g) => g.gate)).toEqual([
      'watertight',
      'manifold',
      'selfIntersection',
      'minWallThickness:14',
      'minWallThickness:15',
      'minWallThickness:16',
      'connectorCrossSection',
      'marginFit:14',
      'marginFit:16',
      'ponticRelief',
      'seating',
    ]);
    expect(serverReport.kernelVersion).toBe(passClientReport.kernelVersion);
  }, 180_000);

  it('the WASM gates (seating + selfIntersection) run server-side on the bridge path and agree byte-for-byte', async () => {
    const serverReport = (await post(pass.qcInput)).json() as QcReport;
    const seating = serverReport.gates.find((g) => g.gate === 'seating');
    const selfInt = serverReport.gates.find((g) => g.gate === 'selfIntersection');
    // seating carries a REAL server-measured interference volume (manifold-3d
    // boolean of the whole bridge onto the fused dies) — byte-identical to client.
    expect(seating).toBeDefined();
    expect(seating!.passed).toBe(true);
    expect(seating!.value).toBe(passClientReport.gates.find((g) => g.gate === 'seating')!.value);
    // selfIntersection ran (manifold-3d proxy) and agrees byte-for-byte.
    expect(selfInt).toBeDefined();
    expect(selfInt!.passed).toBe(passClientReport.gates.find((g) => g.gate === 'selfIntersection')!.passed);
  }, 180_000);

  it('5 mm² connector bridge: the server report is BIT-IDENTICAL to the client (connectorCrossSection FAILS)', async () => {
    const res = await post(thinConnector.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    expect(serverReport).toEqual(thinConnectorClientReport);
    expect(canonical(serverReport)).toBe(canonical(thinConnectorClientReport));

    const connector = serverReport.gates.find((g) => g.gate === 'connectorCrossSection')!;
    expect(connector.passed).toBe(false);
    expect(connector.value).toBeLessThan(9);
    expect(serverReport.passed).toBe(false);
  }, 180_000);

  it('ACKNOWLEDGED-thickness round-trip: BIT-IDENTICAL (passed/acknowledged flags byte-for-byte)', async () => {
    const res = await post(acked.qcInput);
    expect(res.statusCode).toBe(200);
    const serverReport = res.json() as QcReport;

    // The whole report — including the acknowledgment flags — is byte-identical.
    expect(serverReport).toEqual(ackedClientReport);
    expect(canonical(serverReport)).toBe(canonical(ackedClientReport));

    // The thin-unit thickness gate is UNWEAKENED (measured fail) but ACKNOWLEDGED
    // — and the server re-applied the acknowledgment from the request, so
    // passed=false & acknowledged=true & report.passed=true agree byte-for-byte.
    const thin = serverReport.gates.find((g) => g.gate === THIN_UNIT_GATE)!;
    const clientThin = ackedClientReport.gates.find((g) => g.gate === THIN_UNIT_GATE)!;
    expect(thin.passed).toBe(false);
    expect(thin.acknowledged).toBe(true);
    expect(thin.passed).toBe(clientThin.passed);
    expect(thin.acknowledged).toBe(clientThin.acknowledged);
    // the sibling abutment thickness gates still pass cleanly (block LOCALIZED).
    expect(serverReport.gates.find((g) => g.gate === 'minWallThickness:14')!.passed).toBe(true);
    expect(serverReport.gates.find((g) => g.gate === 'minWallThickness:16')!.passed).toBe(true);
    expect(serverReport.passed).toBe(true);
    expect(serverReport.passed).toBe(ackedClientReport.passed);
  }, 180_000);

  it('is deterministic: two server re-validations of the same bridge input yield identical reports', async () => {
    const a = (await post(pass.qcInput)).json();
    const b = (await post(pass.qcInput)).json();
    expect(canonical(a)).toBe(canonical(b));
  }, 180_000);

  it('accepts a MATCHING clientReport cross-check (200; still returns the server-computed report)', async () => {
    const res = await post(pass.qcInput, { clientReport: passClientReport });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(passClientReport);
  }, 180_000);

  it('409s with a per-field diagnostic when a TAMPERED clientReport disagrees (never trusts the client — invariant 6)', async () => {
    const tampered: QcReport = { ...passClientReport, passed: !passClientReport.passed };
    const res = await post(pass.qcInput, { clientReport: tampered });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string; differences: Array<{ path: string }> };
    expect(body.error).toBe('qc-client-server-mismatch');
    expect(body.differences.some((d) => d.path === 'passed')).toBe(true);
  }, 180_000);

  it('detects an acknowledgment-flag divergence: a clientReport that pretends the thin gate passed cleanly → 409', async () => {
    // A tampered acked report claiming the thin-unit gate PASSED (not merely
    // acknowledged) must be caught — the server re-applies the acknowledgment
    // from the request but re-measures the gate as a fail.
    const clean = ackedClientReport.gates.map((g) =>
      g.gate === THIN_UNIT_GATE ? { ...g, passed: true, acknowledged: false } : g,
    );
    const tampered: QcReport = { ...ackedClientReport, gates: clean };
    const res = await post(acked.qcInput, { clientReport: tampered });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { differences: Array<{ path: string }> };
    expect(body.differences.some((d) => d.path.includes('passed') || d.path.includes('acknowledged'))).toBe(true);
  }, 180_000);

  it('rejects a malformed bridge validate-qc body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${RESTO_ID}/validate-qc`,
      // restorationType present but the bridge unit/die/connector set is absent →
      // matches neither oneOf branch.
      payload: { restorationType: 'bridge', assembledSolid: { positions: [0, 0, 0], indices: [0] } },
    });
    expect(res.statusCode).toBe(400);
  });
});
