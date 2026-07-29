// apps/client/src/ui/ExportPanel.dom.test.tsx
//
// Phase 7 Task 7 — the export & handoff panel critical paths, driven through
// the REAL panel + the REAL handoff controller + the REAL T3 export flow (fake
// export pool + injected final-mesh/qcContext seams so no design session or
// kernel worker is needed). The ONE boundary stubbed is HTTP `fetch`: the
// panel is a server-driven surface, so each server response CLASS (200
// released, 409 QC-mismatch, 409 archive-conflict, 201 imported, archive-bytes
// stream) is canned here to prove the panel renders it HONESTLY. The true
// client↔server byte round-trip (qcContext byte-parity, real re-validation) is
// proven against the REAL server by the T8 full-loop harness + the T9 e2e — no
// ported constructions here (the P5-T8 lesson).
//
// The disciplines asserted: failing unacknowledged gates BLOCK export (the
// list is shown, the button is disabled); a released export shows the download
// + both traceability links; a server mismatch renders the diagnostic (WHAT
// diverged) with NO retry-to-green affordance; archive export streams down;
// archive import surfaces the overwrite CONFLICT as a real confirm; the
// imported-release provenance (importedUnverified) is shown; the ADR-014
// synthetic-data disclosure rides over the panel.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { QcGateResult, QcReport, Restoration, RestorationType } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import { createRestoration } from '../engine/restorations';
import { exportFlowEngine } from '../engine/exportFlow';
import { type RunnablePool } from '../engine/crownDesign';
import { handoffController } from '../engine/handoff';
import type { CrownExportQcContext } from '../engine/exportContext';
import { ExportPanel } from './ExportPanel';

// --- fixtures --------------------------------------------------------------

const FINAL = {
  positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  contentHash: 'final-hash',
};

function gate(overrides: Partial<QcGateResult> & { gate: string }): QcGateResult {
  return { passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok', ...overrides };
}

function qcReport(gates: QcGateResult[]): QcReport {
  return {
    gates,
    passed: gates.every((g) => g.passed || g.acknowledged),
    kernelVersion: '0.26.0',
    profileVersion: '1.4.0',
    journalHash: FINAL.contentHash,
  };
}

const CROWN_CTX: CrownExportQcContext = {
  innerSurfaceMesh: { positions: [0, 0, 0], indices: [0] },
  outerSurfaceMesh: { positions: [0, 0, 0], indices: [0] },
  dieSolid: { positions: [0, 0, 0], indices: [0] },
  marginResampledPoints: [[0, 0, 0]],
  insertionAxis: [0, 0, 1],
  minWallThicknessMm: 0.5,
  occlusalMinWallThicknessMm: 0.7,
  connectorAreaTargetMm2: 4,
  contacts: [],
  contactClampWarning: false,
  marginExclusionMm: 0.2,
};

function seedCrown(qc: QcReport | null): string {
  const restoration = createRestoration({ type: 'crown' as RestorationType, teeth: [16], targetNodeId: null });
  caseStore.updateRestoration(
    { ...restoration, stages: { finalMesh: FINAL.contentHash }, qc } as Restoration,
    {
      id: `seed-${restoration.id}`,
      name: 'test-seed',
      params: { restorationId: restoration.id },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: '0.26.0',
      timestamp: new Date(0).toISOString(),
    },
  );
  return restoration.id;
}

/** Deterministic fake export pool (bytes from the payload) — the SAME shape as
 * exportFlow.test.ts's, so `exportRestoration` reaches `done` with held bytes. */
class FakeExportPool {
  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    if (job !== 'exportRestorationMesh') throw new Error(`FakeExportPool: unexpected job ${job}`);
    const p = payload as { positions: Float64Array; format: string; headerText?: string };
    const bytes = new Uint8Array(p.positions.buffer.slice(0));
    // A stable 64-hex sha is all buildExportRequest needs downstream.
    const bytesSha256 = 'a'.repeat(64);
    return {
      bytes,
      bytesSha256,
      bytesBase64: 'AAAA',
      byteLength: bytes.byteLength,
      triangleCount: p.positions.length / 9,
    };
  }) as RunnablePool['run'];
}

// --- fetch stub (the only mocked boundary) ---------------------------------

interface StubResponse {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
}
let route: (url: string, init: RequestInit | undefined) => StubResponse;
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    const r = route(url, init);
    if (r.bytes) {
      return new Response(r.bytes as unknown as BodyInit, { status: r.status });
    }
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  caseStore.resetForTests();
  exportFlowEngine.resetForTests();
  handoffController.resetForTests();
  exportFlowEngine.__setPoolForTests(new FakeExportPool());
  exportFlowEngine.__setFinalMeshSourceForTests(() => FINAL);
  handoffController.__setQcContextSourceForTests(() => CROWN_CTX);
  handoffController.__setPersistForTests(async () => {});
  fetchCalls.length = 0;
  route = () => ({ status: 500, json: { error: 'unrouted' } });
  installFetchStub();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  handoffController.resetForTests();
  exportFlowEngine.resetForTests();
  caseStore.resetForTests();
});

async function selectRestoration(id: string): Promise<void> {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByTestId('export-restoration-select'), id);
}

describe('ExportPanel — export gate recap + server release', () => {
  it('rides the ADR-014 synthetic-data disclosure over the panel', () => {
    render(<ExportPanel />);
    expect(screen.getByTestId('export-disclosure')).toBeTruthy();
  });

  it('BLOCKS export on a failing unacknowledged gate: shows the failing-gate list, disables the button, sends nothing', async () => {
    const id = seedCrown(qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness', passed: false })]));
    render(<ExportPanel />);
    await selectRestoration(id);

    const block = screen.getByTestId('export-gate-block');
    expect(block.textContent).toContain('minWallThickness');
    expect((screen.getByTestId('export-run-button') as HTMLButtonElement).disabled).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes('/export'))).toBe(false);
    expect(screen.queryByTestId('export-released')).toBeNull();
  });

  it('a passing export RELEASES: POSTs {request, qcContext}, then shows the download + both traceability links', async () => {
    const id = seedCrown(qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    route = (url) => {
      if (url.includes('/export')) {
        return {
          status: 200,
          json: {
            released: true,
            exportId: 'exp-1',
            format: 'stl',
            bytesSha256: 'b'.repeat(64),
            reimportMeshHash: 'c'.repeat(64),
            byteLength: 84,
            downloadPath: '/api/exports/bbb/download',
            traceabilityJsonPath: '/api/exports/exp-1/traceability.json',
            traceabilityHtmlPath: '/api/exports/exp-1/traceability.html',
            releasedAt: '2026-07-20T00:00:00.000Z',
            alreadyStored: false,
          },
        };
      }
      return { status: 500, json: {} };
    };
    render(<ExportPanel />);
    await selectRestoration(id);

    await userEvent.setup().click(screen.getByTestId('export-run-button'));
    await waitFor(() => expect(screen.getByTestId('export-released')).toBeTruthy());

    const exportCall = fetchCalls.find((c) => c.url.includes('/api/restorations/') && c.url.endsWith('/export'));
    expect(exportCall).toBeTruthy();
    const body = JSON.parse(String(exportCall!.init!.body));
    expect(body.request.restorationId).toBe(id);
    expect(body.qcContext.dieSolid).toBeTruthy(); // the crown qcContext rode along
    expect(body.qcContext.crownSolid).toBeUndefined(); // the solid is byte-derived, never in the context

    const released = screen.getByTestId('export-released');
    expect(within(released).getByTestId('export-download-link').getAttribute('href')).toBe('/api/exports/bbb/download');
    expect(within(released).getByTestId('export-traceability-html').getAttribute('href')).toContain(
      '/api/exports/exp-1/traceability.html?lang=',
    );
    expect(within(released).getByTestId('export-traceability-json').getAttribute('href')).toBe(
      '/api/exports/exp-1/traceability.json',
    );
    expect(screen.queryByTestId('export-mismatch')).toBeNull();
  });

  it('a 409 QC-mismatch renders the HONEST diagnostic (what diverged + bundle id) with NO retry-to-green affordance', async () => {
    const id = seedCrown(qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    route = (url) => {
      if (url.includes('/export')) {
        return {
          status: 409,
          json: {
            error: 'export-qc-mismatch',
            message: 'client/server QcReport disagreement on 1 field(s) over the RE-IMPORTED export bytes',
            diagnosticId: 'diag-9',
            differences: [{ path: 'gates.0.value', server: 0.42, client: 0.5 }],
          },
        };
      }
      return { status: 500, json: {} };
    };
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    await waitFor(() => expect(screen.getByTestId('export-mismatch')).toBeTruthy());
    const mismatch = screen.getByTestId('export-mismatch');
    expect(within(mismatch).getByTestId('export-mismatch-message').textContent).toContain('disagreement');
    expect(within(mismatch).getAllByTestId('export-mismatch-diff-row')).toHaveLength(1);
    expect(within(mismatch).getByTestId('export-diagnostic-id').textContent).toContain('diag-9');
    // No released file, and the mismatch surface offers no "retry until green"
    // button — only the (honest) diagnostic. The one button on the panel is the
    // export action itself; the mismatch block contains no button.
    expect(screen.queryByTestId('export-released')).toBeNull();
    expect(mismatch.querySelector('button')).toBeNull();
  });
});

describe('ExportPanel — case archive export/import', () => {
  it('exports the .dqca archive (streams the bytes to the download sink)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    const captured: Array<{ bytes: Uint8Array; filename: string }> = [];
    handoffController.__setDownloadSinkForTests((bytes, filename) => captured.push({ bytes, filename }));
    route = (url) => (url.includes('/archive') ? { status: 200, bytes: Uint8Array.from([1, 2, 3, 4]) } : { status: 500, json: {} });

    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.filename).toMatch(/\.dqca$/);
    expect(Array.from(captured[0]!.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('import surfaces the overwrite CONFLICT as a real confirm; confirming re-posts with ?overwrite=true and shows the imported provenance', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    let overwriteSeen = false;
    route = (url) => {
      if (url.includes('/archives/import')) {
        if (url.includes('overwrite=true')) {
          overwriteSeen = true;
          return {
            status: 200,
            json: {
              imported: true,
              caseId: 'case-x',
              overwritten: true,
              counts: { scans: 1, finalMeshes: 1, exportRows: 2, exportBytes: 1 },
            },
          };
        }
        return { status: 409, json: { error: 'archive-import-conflict', message: 'exists', caseId: 'case-x' } };
      }
      if (url.endsWith('/cases')) return { status: 200, json: [] };
      return { status: 500, json: {} };
    };

    render(<ExportPanel />);
    const user = userEvent.setup();
    const file = new File([Uint8Array.from([9, 9, 9])], 'case-x.dqca');
    await user.upload(screen.getByTestId('archive-import-input'), file);

    // The conflict is surfaced — NOT a silent overwrite.
    await waitFor(() => expect(screen.getByTestId('archive-conflict')).toBeTruthy());
    expect(overwriteSeen).toBe(false);

    // Confirming performs the overwrite import.
    await user.click(screen.getByTestId('archive-conflict-confirm'));
    await waitFor(() => expect(screen.getByTestId('archive-imported')).toBeTruthy());
    expect(overwriteSeen).toBe(true);

    // The imported-release provenance (importedUnverified) is shown honestly.
    const provenance = screen.getByTestId('archive-imported-provenance');
    expect(provenance.textContent).toContain('2');
    expect(provenance.textContent?.toLowerCase()).toContain('unverified');
  });
});
