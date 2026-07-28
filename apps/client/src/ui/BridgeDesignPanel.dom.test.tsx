// apps/client/src/ui/BridgeDesignPanel.dom.test.tsx
//
// Phase 6 Task 7 — browser-lane (`client-dom`, real Chromium + real
// kernel-workers Web Worker pool incl. the manifold-3d WASM) CRITICAL PATH for
// the bridge design workflow. Drives the full pipeline (margins → abutment
// surfaces → pontic → connectors → framework → assembly → whole-bridge QC)
// through the actual UI on the analytic 3-unit bridge fixture — the EXACT kernel
// `bridgeAssemblyFixture` output (+ T3 relief measurements + T4 connector frames),
// loaded from the committed serialized asset via engine/bridgeGeometry.ts
// (byte-guarded against kernel drift by
// packages/kernel/src/bridge/bridge.fixture-asset.test.ts) — asserting:
//   - the shared-axis verdict + per-abutment margin-fit readouts render;
//   - the pontic relief readout renders within the ±20 µm tolerance;
//   - the CONNECTOR EDITOR live min-area readout renders with a per-connector
//     gate verdict (the T4 measurement wired live);
//   - the whole-bridge QC table renders WITH per-unit thickness rows +
//     per-connector + pontic-relief rows, all passing;
//   - editing a connector to ~5 mm² (the live editor) invalidates the downstream
//     assembly + QC (the stale-QC guard: a stale report NEVER keeps displaying),
//     the re-run QC BLOCKS on the connector gate, and ACKNOWLEDGE journals it.
// Same no-mock philosophy + fixture-per-file convention as the cavity dom test.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { bridgeDesignEngine } from '../engine/bridgeDesign';
import { buildBridgeFixture } from '../engine/bridgeGeometry';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import type { FdiTooth, MarginLine, Vec3 } from '@dqcad/shared-types';
import { BridgeDesignPanel } from './BridgeDesignPanel';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-10, -5, 0], max: [10, 5, 8] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const RING: Vec3[] = Array.from({ length: 8 }, (_, i) => {
  const th = (2 * Math.PI * i) / 8;
  return [Math.cos(th), Math.sin(th), 0] as Vec3;
});
function marginLine(): MarginLine {
  return { anchors: [], closed: true, resampledPoints: RING };
}

function setupBridgeCase(teeth: FdiTooth[] = [14, 15, 16] as FdiTooth[], pontics: FdiTooth[] = [15] as FdiTooth[]): string {
  // A dummy target arch mesh + node — the bridge controller requires a target
  // node id + confirmed abutment margins to start (the geometry currency comes
  // from the serialized fixture asset via the panel's buildBridgeFixture()).
  caseStore.registerImportedMesh({
    contentHash: 'bridge-arch',
    name: 'arch.stl',
    format: 'stl',
    positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('bridge-arch', 'prepDie');
  const restoration = createRestoration({ type: 'bridge', teeth, pontics, targetNodeId: node.id });
  const ponticSet = new Set(pontics);
  const marginLines = Object.fromEntries(teeth.filter((t) => !ponticSet.has(t)).map((t) => [t, marginLine()]));
  caseStore.updateRestoration(
    { ...restoration, marginLines },
    { id: 'op-margins', name: 'margin-edit', params: {}, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString() },
  );
  return restoration.id;
}

function historyNames(): string[] {
  return caseStore.getDocument().history.map((o) => o.name);
}
function restoration(id: string) {
  return caseStore.getDocument().restorations.find((r) => r.id === id)!;
}

beforeEach(() => {
  caseStore.resetForTests();
  bridgeDesignEngine.resetForTests();
});
afterEach(() => {
  cleanup();
  bridgeDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('BridgeDesignPanel — browser-lane critical path (real WorkerPool, 3-unit bridge fixture)', () => {
  it('sanity: the serialized asset carries 3 units, 2 connectors, 3 pontic styles', () => {
    const fx = buildBridgeFixture();
    expect(fx.units.map((u) => `${u.label}:${u.kind}`)).toEqual(['14:abutment', '15:pontic', '16:abutment']);
    expect(fx.connectors.map((c) => c.label)).toEqual(['14–15', '15–16']);
    expect(Object.keys(fx.ponticReliefByStyle).sort()).toEqual(['hygienic', 'ovate', 'ridgeLap']);
  });

  it('a real case whose teeth ≠ the fixture (24-25-26) starts WITH an explicit teeth-mismatch disclosure', async () => {
    const user = userEvent.setup();
    const id = setupBridgeCase([24, 25, 26] as FdiTooth[], [25] as FdiTooth[]);

    render(<BridgeDesignPanel />);
    await user.selectOptions(screen.getByTestId('bridge-restoration-select'), id);
    await user.click(screen.getByTestId('bridge-start-button'));

    // Start is ALLOWED (the phase is fixture-driven) but the mismatch is surfaced
    // LOUDLY: the case (24-25-26) does not match the demo fixture (14-15-16).
    expect(screen.getByTestId('bridge-synthetic-notice')).toBeTruthy();
    const mismatch = screen.getByTestId('bridge-synthetic-mismatch');
    expect(mismatch.textContent).toContain('24-25-26');
    expect(mismatch.textContent).toContain('14-15-16');
  }, 30_000);

  it('drives margins → abutments → pontic → connectors → framework → assembly → QC, then edits a connector to BLOCK + acknowledge', async () => {
    const user = userEvent.setup();
    const id = setupBridgeCase();

    render(<BridgeDesignPanel />);
    // The synthetic-data disclosure is present BEFORE start (the picker view).
    expect(screen.getByTestId('bridge-synthetic-start-note')).toBeTruthy();
    await user.selectOptions(screen.getByTestId('bridge-restoration-select'), id);
    await user.click(screen.getByTestId('bridge-start-button'));

    // The UN-MISSABLE synthetic-data banner renders over the active workflow; the
    // 14-15-16 case MATCHES the fixture, so no mismatch line.
    expect(screen.getByTestId('bridge-synthetic-notice')).toBeTruthy();
    expect(screen.queryByTestId('bridge-synthetic-mismatch')).toBeNull();

    // Margins already confirmed (14 & 16) + the shared-axis verdict renders.
    expect(screen.getByTestId('bridge-stage-margins').getAttribute('data-complete')).toBe('true');
    expect(screen.getByTestId('bridge-shared-axis')).toBeTruthy();

    // Stage: abutment surfaces → per-abutment margin-fit readouts.
    await user.click(screen.getByTestId('bridge-abutment-surfaces-run'));
    await waitFor(() => expect(screen.getByTestId('bridge-abutment-fit-table')).toBeTruthy(), { timeout: 60_000 });
    expect(screen.getByTestId('bridge-abutment-fit-14')).toBeTruthy();
    expect(screen.getByTestId('bridge-abutment-fit-16')).toBeTruthy();
    expect(restoration(id).stages.bridgeAbutmentSurfaces).toBeTypeOf('string');
    expect(historyNames()).toContain('bridge-abutment-surfaces');

    // Stage: pontic (hygienic default) → measured relief within ±20 µm.
    await user.click(screen.getByTestId('bridge-pontic-commit'));
    await waitFor(() => expect(screen.getByTestId('bridge-pontic-readout')).toBeTruthy(), { timeout: 60_000 });
    expect(restoration(id).stages.bridgePontic).toBeTypeOf('string');
    expect(historyNames()).toContain('bridge-pontic');
    expect(screen.getByTestId('bridge-pontic-readout').className).toContain('bridge-relief--ok');

    // Stage: connectors — the LIVE editor preview (min-area readout + verdict).
    await user.click(screen.getByTestId('bridge-connectors-preview'));
    await waitFor(() => expect(screen.getByTestId('bridge-connectors-table')).toBeTruthy(), { timeout: 60_000 });
    expect(screen.getByTestId('bridge-connector-area-14–15').textContent).toMatch(/mm²/);
    expect(screen.getByTestId('bridge-connector-verdict-14–15').className).toContain('bridge-connector--ok');
    // Commit the (healthy) connectors.
    await user.click(screen.getByTestId('bridge-connectors-commit'));
    await waitFor(() => expect(restoration(id).stages.bridgeConnectors).toBeTypeOf('string'), { timeout: 60_000 });
    expect(historyNames()).toContain('bridge-connectors');

    // Stage: framework mode (full-contour) — a journaled design decision.
    await user.click(screen.getByTestId('bridge-framework-select'));
    await waitFor(() => expect(screen.getByTestId('bridge-framework-readout')).toBeTruthy(), { timeout: 30_000 });
    expect(restoration(id).stages.bridgeFramework).toBe('framework:fullContour');
    expect(historyNames()).toContain('bridge-framework');

    // Stage: assembly → one watertight solid.
    await user.click(screen.getByTestId('bridge-assembly-run'));
    await waitFor(
      () => {
        const readout = screen.queryByTestId('bridge-assembly-readout');
        const error = screen.queryByTestId('bridge-error');
        expect(readout || error).toBeTruthy();
      },
      { timeout: 90_000 },
    );
    expect(screen.queryByTestId('bridge-error')).toBeNull();
    expect(screen.getByTestId('bridge-assembly-readout').textContent).toContain('✓');
    expect(restoration(id).stages.finalMesh).toBeTypeOf('string');
    expect(historyNames()).toContain('bridge-assembly');

    // Stage: QC — the whole-bridge table renders per-unit + connector + relief rows, all pass.
    await user.click(screen.getByTestId('bridge-qc-run'));
    await waitFor(() => expect(screen.getByTestId('bridge-qc-table')).toBeTruthy(), { timeout: 120_000 });
    expect(restoration(id).qc).not.toBeNull();
    expect(historyNames()).toContain('bridge-qc');
    expect(screen.getByTestId('bridge-qc-gate-minWallThickness:14')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-gate-minWallThickness:15')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-gate-minWallThickness:16')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-gate-connectorCrossSection')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-gate-ponticRelief')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-passed')).toBeTruthy();
    expect(screen.getByTestId('bridge-qc-scope-note')).toBeTruthy();
    // The synthetic-data disclosure is REPEATED in the QC results.
    expect(screen.getByTestId('bridge-qc-synthetic-note')).toBeTruthy();

    // --- The connector editor drives a BLOCK + the stale-QC guard ---
    // Edit connector 14–15 to ~5 mm² (semi-axis 1.2) and re-commit.
    fireEvent.change(screen.getByTestId('bridge-connector-semi-14–15'), { target: { value: '1.2' } });
    await user.click(screen.getByTestId('bridge-connectors-commit'));
    // The cascade cleared the downstream assembly + QC — QC is re-BLOCKED and NO
    // stale pass/fail banner survives (a report can never outlive its geometry).
    await waitFor(() => expect(screen.getByTestId('bridge-qc-blocked')).toBeTruthy(), { timeout: 60_000 });
    expect(screen.queryByTestId('bridge-qc-passed')).toBeNull();
    expect(screen.queryByTestId('bridge-qc-failed')).toBeNull();
    expect(screen.queryByTestId('bridge-qc-stale')).toBeNull();
    expect(restoration(id).qc).toBeNull();
    expect(restoration(id).stages.finalMesh).toBeUndefined();

    // Re-run framework → assembly → QC on the thin bridge → connector gate BLOCKS.
    await user.click(screen.getByTestId('bridge-framework-select'));
    await waitFor(() => expect(screen.getByTestId('bridge-framework-readout')).toBeTruthy(), { timeout: 30_000 });
    await user.click(screen.getByTestId('bridge-assembly-run'));
    await waitFor(() => expect(screen.getByTestId('bridge-assembly-readout')).toBeTruthy(), { timeout: 90_000 });
    await user.click(screen.getByTestId('bridge-qc-run'));
    await waitFor(() => expect(screen.getByTestId('bridge-qc-failed')).toBeTruthy(), { timeout: 120_000 });
    const connectorGate = screen.getByTestId('bridge-qc-gate-connectorCrossSection');
    expect(connectorGate.getAttribute('data-passed')).toBe('false');

    // Acknowledge the failing connector gate (journaled — invariant 4).
    await user.click(screen.getByTestId('bridge-qc-ack-connectorCrossSection'));
    await waitFor(
      () => expect(screen.getByTestId('bridge-qc-gate-connectorCrossSection').textContent).toMatch(/acknowledged/i),
      { timeout: 120_000 },
    );
    expect(historyNames()).toContain('bridge-qc-ack');
    expect(restoration(id).qc!.gates.find((g) => g.gate === 'connectorCrossSection')!.acknowledged).toBe(true);
  }, 600_000);
});
