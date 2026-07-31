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
import { selectRelease, useHandoffStore } from '../state/handoffStore';
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

function seedRestoration(type: RestorationType, qc: QcReport | null): string {
  const restoration = createRestoration({
    type,
    teeth: type === 'bridge' ? [14, 15, 16] : [16],
    ...(type === 'bridge' ? { pontics: [15] } : {}),
    targetNodeId: null,
  });
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

function seedCrown(qc: QcReport | null): string {
  return seedRestoration('crown', qc);
}

/** Deterministic fake export pool (bytes from the payload) — the SAME shape as
 * exportFlow.test.ts's, so `exportRestoration` reaches `done` with held bytes. */
class FakeExportPool {
  failNext: Error | null = null;
  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    if (job !== 'exportRestorationMesh') throw new Error(`FakeExportPool: unexpected job ${job}`);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
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
let pool: FakeExportPool;

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
  pool = new FakeExportPool();
  exportFlowEngine.__setPoolForTests(pool);
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

  it('an archive-export server error surfaces a visible archive-error state', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => (url.includes('/archive') ? { status: 500, json: { message: 'scan mesh missing' } } : { status: 500, json: {} });
    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('scan mesh missing');
  });

  it('an archive-import server error (non-conflict) surfaces a visible archive-error state', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) =>
      url.includes('/archives/import') ? { status: 400, json: { error: 'archive-invalid', message: 'bad manifest' } } : { status: 500, json: {} };
    render(<ExportPanel />);
    const file = new File([Uint8Array.from([1])], 'bad.dqca');
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), file);
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('bad manifest');
  });
});

// The local pre-flight ladder — every refusal a VISIBLE, i18n'd, BUTTONLESS
// state (no retry-to-green), matching the tested server-mismatch discipline.
describe('ExportPanel — the local honest-failure ladder', () => {
  function passingCrown(): string {
    return seedCrown(qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
  }

  it('no live qcContext (post-reload) → a visible, buttonless no-live-context error, nothing released', async () => {
    const id = passingCrown();
    handoffController.__setQcContextSourceForTests(() => null);
    route = (url) => (url.includes('/export') ? { status: 200, json: { released: true } } : { status: 500, json: {} });
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    await waitFor(() => expect(screen.getByTestId('export-release-error')).toBeTruthy());
    const err = screen.getByTestId('export-release-error');
    expect(within(err).getByTestId('export-release-error-message').textContent?.toLowerCase()).toContain('design session');
    expect(err.querySelector('button')).toBeNull(); // no retry affordance
    expect(screen.queryByTestId('export-released')).toBeNull();
    expect(fetchCalls.some((c) => c.url.includes('/export'))).toBe(false); // never reached the server
  });

  it('a fetch failure reaching the server → a visible, buttonless network error', async () => {
    const id = passingCrown();
    render(<ExportPanel />);
    await selectRestoration(id);
    // Re-stub fetch to throw ONLY for the export POST (the client export used
    // the fake pool, not fetch, so it still reaches `done`).
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/export')) throw new Error('connection refused');
      return new Response('{}', { status: 200 });
    });
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    await waitFor(() => expect(screen.getByTestId('export-release-error')).toBeTruthy());
    const err = screen.getByTestId('export-release-error');
    expect(within(err).getByTestId('export-release-error-message').textContent).toContain('connection refused');
    expect(err.querySelector('button')).toBeNull();
  });

  it('releasing with no fresh held export → a visible request-unavailable error', async () => {
    const id = passingCrown();
    render(<ExportPanel />);
    await selectRestoration(id);
    // Drive the SERVER step alone with nothing exported → buildExportRequest
    // refuses (ExportRequestUnavailableError) → request-unavailable.
    await handoffController.releaseToServer(id);

    await waitFor(() => expect(screen.getByTestId('export-release-error')).toBeTruthy());
    expect(screen.getByTestId('export-release-error-message').textContent?.toLowerCase()).toContain('re-export');
  });

  it('a client-side finalMeshUnavailable refusal is visible (buttonless) and leaves nothing released', async () => {
    const id = passingCrown();
    exportFlowEngine.__setFinalMeshSourceForTests(() => null); // no live buffers (post-reload)
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    await waitFor(() => expect(screen.getByTestId('export-client-refused')).toBeTruthy());
    expect(screen.getByTestId('export-client-refused').querySelector('button')).toBeNull();
    expect(screen.queryByTestId('export-released')).toBeNull();
  });

  it('a client-side export worker failure is a visible client error', async () => {
    const id = passingCrown();
    pool.failNext = new Error('worker boom');
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    await waitFor(() => expect(screen.getByTestId('export-client-error')).toBeTruthy());
    expect(screen.getByTestId('export-client-error').textContent).toContain('worker boom');
  });
});

// SHOULD-FIX-2: the released-file card itself is marked SUPERSEDED after a
// design edit — not just adjacently — so a user cannot mistake a stale
// download for the current design.
describe('ExportPanel — stale released-file card', () => {
  const releasedRoute = (url: string): StubResponse =>
    url.includes('/export')
      ? {
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
            alreadyStored: true,
          },
        }
      : { status: 500, json: {} };

  it('a fresh release card has live links and NO stale marker; a design edit flips it to superseded', async () => {
    const id = seedCrown(qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    route = releasedRoute;
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));

    // Fresh: released card, live links, alreadyStored note, no stale marker.
    await waitFor(() => expect(screen.getByTestId('export-released')).toBeTruthy());
    expect(screen.getByTestId('export-released').getAttribute('data-stale')).toBe('false');
    expect(screen.queryByTestId('export-released-stale')).toBeNull();
    expect(screen.getByTestId('export-download-link')).toBeTruthy();

    // Edit the design out from under the export → the T3 cascade flips the
    // client export to `stale`, and the release card must reflect it.
    const current = caseStore.getDocument().restorations.find((r) => r.id === id)!;
    caseStore.updateRestoration(
      { ...current, stages: { finalMesh: 'edited-hash' } },
      {
        id: 'edit-op',
        name: 'margin-edit',
        params: { restorationId: id },
        inputHashes: [],
        outputHashes: [],
        kernelVersion: '0.26.0',
        timestamp: new Date(0).toISOString(),
      },
    );

    await waitFor(() => expect(screen.getByTestId('export-released-stale')).toBeTruthy());
    expect(screen.getByTestId('export-released').getAttribute('data-stale')).toBe('true');
    expect(screen.getByTestId('export-released-stale').textContent?.toUpperCase()).toContain('SUPERSEDED');
    // The links are still present (they point at real historical bytes) but the
    // card now loudly flags them as superseded.
    expect(screen.getByTestId('export-download-link')).toBeTruthy();
  });
});

// QC-recap render branches (the report is rendered, never re-derived).
describe('ExportPanel — QC recap rendering branches', () => {
  it('a restoration with no QC report shows the no-report note and a disabled export button', async () => {
    const id = seedRestoration('crown', null);
    render(<ExportPanel />);
    await selectRestoration(id);
    expect(screen.getByTestId('export-qc-noreport')).toBeTruthy();
    expect((screen.getByTestId('export-run-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('export-qc-recap')).toBeNull();
  });

  it('renders acknowledged + measured gate rows (pass/ack/fail labels + value·unit)', async () => {
    const id = seedRestoration(
      'crown',
      qcReport([
        gate({ gate: 'watertight' }),
        gate({ gate: 'minWallThickness', passed: false, acknowledged: true, value: 0.42, unit: 'mm' }),
      ]),
    );
    render(<ExportPanel />);
    await selectRestoration(id);
    const ack = screen.getByTestId('export-qc-gate-minWallThickness');
    expect(ack.getAttribute('data-acknowledged')).toBe('true');
    // The measured value·unit renders per the project mm+µm convention (1 µm
    // resolution): 0.42 mm → "0.420 mm (420 µm)", not a bare "0.420 mm".
    expect(ack.textContent).toContain('0.420 mm (420 µm)');
    // An all-acknowledged report authorizes export (verdict allowed).
    expect((screen.getByTestId('export-run-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a stale QC report (journalHash ≠ finalMesh) shows the stale note and blocks the button', async () => {
    const staleQc: QcReport = { ...qcReport([gate({ gate: 'watertight' })]), journalHash: 'a-different-hash' };
    const id = seedRestoration('crown', staleQc);
    render(<ExportPanel />);
    await selectRestoration(id);
    expect(screen.getByTestId('export-qc-stale')).toBeTruthy();
    expect((screen.getByTestId('export-run-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('selecting PLY hides the STL-only header-policy note', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })]));
    render(<ExportPanel />);
    const user = userEvent.setup();
    await selectRestoration(id);
    expect(screen.getByTestId('export-header-policy')).toBeTruthy();
    await user.selectOptions(screen.getByTestId('export-format-select'), 'ply');
    expect(screen.queryByTestId('export-header-policy')).toBeNull();
  });

  it('a 409 export-gates-failing renders the failing-gate list (no diff table) — honest, buttonless', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    route = (url) =>
      url.includes('/export')
        ? { status: 409, json: { error: 'export-gates-failing', message: 'server gates failed', failingGates: ['minWallThickness'] } }
        : { status: 500, json: {} };
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));
    await waitFor(() => expect(screen.getByTestId('export-mismatch')).toBeTruthy());
    expect(screen.getByTestId('export-mismatch-gates').textContent).toContain('minWallThickness');
    expect(screen.queryByTestId('export-mismatch-diff')).toBeNull();
    expect(screen.getByTestId('export-mismatch').querySelector('button')).toBeNull();
  });
});

// Engine-seam paths not reachable through the normal happy/refusal clicks
// (the qcContext dispatch, the no-restoration guard, the real download sink,
// the fetch-throw catches, clearArchive) — every one a visible store state.
describe('ExportPanel — handoff controller edge paths', () => {
  function status(id: string) {
    return selectRelease(useHandoffStore.getState(), id);
  }

  it('the real qcContext dispatch returns null with no live session for every restoration type → no-live-context', async () => {
    handoffController.__setQcContextSourceForTests(null); // use the REAL engine dispatch
    for (const type of ['crown', 'inlay', 'onlay', 'bridge'] as RestorationType[]) {
      const id = seedRestoration(type, qcReport([gate({ gate: 'watertight' })]));
      await handoffController.releaseToServer(id);
      expect(status(id).state).toBe('error');
      expect(status(id).failure?.code).toBe('no-live-context');
    }
  });

  it('releasing a restoration that no longer exists → a visible no-restoration error', async () => {
    await handoffController.releaseToServer('ghost-id');
    expect(status('ghost-id')).toMatchObject({ state: 'error', failure: { code: 'no-restoration' } });
  });

  it('the default download sink runs the real browser download path (no injected sink)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    // Do NOT inject a sink — exercise defaultDownloadSink against the real
    // browser URL/anchor machinery (headless, harmless).
    route = (url) => (url.includes('/archive') ? { status: 200, bytes: Uint8Array.from([5, 6]) } : { status: 500, json: {} });
    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));
    await waitFor(() => expect(useHandoffStore.getState().archive.state).toBe('idle'));
    expect(useHandoffStore.getState().archive.error).toBeNull();
  });

  it('an archive-export fetch throw is caught into a visible archive-error', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/archive')) throw new Error('socket hang up');
      return new Response('{}', { status: 200 });
    });
    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('socket hang up');
  });

  it('an archive-import fetch throw is caught into a visible archive-error, dismissible', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/archives/import')) throw new Error('import socket error');
      return new Response('{}', { status: 200 });
    });
    render(<ExportPanel />);
    const user = userEvent.setup();
    await user.upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'x.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    // Dismiss clears the snapshot back to idle (clearArchive).
    await user.click(within(screen.getByTestId('archive-error')).getByTestId('archive-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('archive-error')).toBeNull());
  });

  it('a malformed/empty non-OK export response still surfaces an honest (buttonless) mismatch with an http-status code', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    route = (url) => (url.includes('/export') ? { status: 500, json: {} } : { status: 500, json: {} });
    render(<ExportPanel />);
    await selectRestoration(id);
    await userEvent.setup().click(screen.getByTestId('export-run-button'));
    await waitFor(() => expect(screen.getByTestId('export-mismatch')).toBeTruthy());
    expect(screen.getByTestId('export-mismatch').querySelector('button')).toBeNull();
    expect(screen.queryByTestId('export-released')).toBeNull();
  });
});

// Remaining response-mapping branches (defensive JSON coercions on untrusted
// server payloads) — each still a visible, honest state.
describe('ExportPanel — response-mapping branches', () => {
  it('an archive-export 500 with an empty body falls back to an HTTP-status message', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => (url.includes('/archive') ? { status: 500, json: {} } : { status: 500, json: {} });
    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('500');
  });

  it('a new-case import (no overwrite) shows the imported result with no provenance line when it carries no releases', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => {
      if (url.includes('/archives/import')) {
        return {
          status: 201,
          json: { imported: true, caseId: 'fresh-case', overwritten: false, counts: { scans: 1, finalMeshes: 0, exportRows: 0, exportBytes: 0 } },
        };
      }
      if (url.endsWith('/cases')) return { status: 200, json: [] };
      return { status: 500, json: {} };
    };
    render(<ExportPanel />);
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'fresh.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-imported')).toBeTruthy());
    expect(screen.getByTestId('archive-imported').textContent).toContain('fresh-case');
    expect(screen.queryByTestId('archive-imported-provenance')).toBeNull(); // exportRows === 0
    expect(screen.queryByText(/overwritten/i)).toBeNull(); // overwritten === false
  });

  it('a 200 import whose body is not imported:true is treated as an error, not a success', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => (url.includes('/archives/import') ? { status: 200, json: { imported: false, message: 'nothing imported' } } : { status: 500, json: {} });
    render(<ExportPanel />);
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'x.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('nothing imported');
  });

  it('an import conflict without a caseId still surfaces the confirm (no silent overwrite)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => (url.includes('/archives/import') ? { status: 409, json: { error: 'archive-import-conflict', message: 'exists' } } : { status: 500, json: {} });
    render(<ExportPanel />);
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'x.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-conflict')).toBeTruthy());
    expect(screen.getByTestId('archive-conflict-confirm')).toBeTruthy();
  });

  it('a non-Error thrown while reaching the server still surfaces a visible network error (String coercion)', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]));
    render(<ExportPanel />);
    await selectRestoration(id);
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/export')) throw 'plain-string-failure';
      return new Response('{}', { status: 200 });
    });
    await userEvent.setup().click(screen.getByTestId('export-run-button'));
    await waitFor(() => expect(screen.getByTestId('export-release-error')).toBeTruthy());
    expect(screen.getByTestId('export-release-error-message').textContent).toContain('plain-string-failure');
  });
});

// The remaining catch/coercion branches — non-Error throws in the archive
// paths, and an import success payload missing its caseId — all still visible.
describe('ExportPanel — archive coercion branches', () => {
  it('a non-Error thrown during archive export surfaces a visible archive-error (String coercion)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/archive')) throw 'archive-plain-failure';
      return new Response('{}', { status: 200 });
    });
    render(<ExportPanel />);
    await userEvent.setup().click(screen.getByTestId('archive-export-button'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('archive-plain-failure');
  });

  it('a non-Error thrown during archive import surfaces a visible archive-error (String coercion)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('/archives/import')) throw 'import-plain-failure';
      return new Response('{}', { status: 200 });
    });
    render(<ExportPanel />);
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'x.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-error')).toBeTruthy());
    expect(screen.getByTestId('archive-error').textContent).toContain('import-plain-failure');
  });

  it('an import success missing its caseId still renders the imported result (null-caseId coercion)', async () => {
    seedCrown(qcReport([gate({ gate: 'watertight' })]));
    route = (url) => {
      if (url.includes('/archives/import')) {
        return { status: 201, json: { imported: true, overwritten: false, counts: { scans: 0, finalMeshes: 0, exportRows: 0, exportBytes: 0 } } };
      }
      if (url.endsWith('/cases')) return { status: 200, json: [] };
      return { status: 500, json: {} };
    };
    render(<ExportPanel />);
    await userEvent.setup().upload(screen.getByTestId('archive-import-input'), new File([Uint8Array.from([1])], 'x.dqca'));
    await waitFor(() => expect(screen.getByTestId('archive-imported')).toBeTruthy());
  });
});
