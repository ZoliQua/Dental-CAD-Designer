// apps/client/src/engine/diagnosticBundle.no-egress.test.ts
//
// Phase 8 Task 5 — THE NO-NETWORK-EGRESS ACCEPTANCE (falsifiable).
//
// Spy every network transport global (fetch / XMLHttpRequest / WebSocket /
// navigator.sendBeacon) and assert that building, serializing, AND downloading
// the bundle fires ZERO of them. The download path is exercised with injected
// fake DOM deps so the whole local Blob→object-URL→anchor-click flow runs under
// the Node lane (where URL.createObjectURL does not exist).
//
// Falsifiability (proves the spies are wired): a deliberately seeded `fetch(...)`
// IS caught by the same spy — so the "zero calls" assertions mean something.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import {
  buildDiagnosticBundle,
  diagnosticBundleFilename,
  downloadDiagnosticBundle,
  serializeDiagnosticBundle,
  type DiagnosticDownloadDeps,
} from './diagnosticBundle';

function tinyCase(): CaseDocument {
  return {
    id: 'case-1',
    schemaVersion: 2,
    createdAt: '2026-07-22T00:00:00.000Z',
    meshes: [],
    scene: [],
    restorations: [],
    measurements: [],
    history: [],
    settings: { materialProfileId: '', profileVersion: '' },
  };
}

// --- transport spies ---------------------------------------------------------
const fetchSpy = vi.fn();
const xhrOpenSpy = vi.fn();
const xhrSendSpy = vi.fn();
const wsSpy = vi.fn();
const beaconSpy = vi.fn();

beforeEach(() => {
  // `vi.stubGlobal` handles getter-only globals (e.g. Node's `navigator`) and
  // restores them via `unstubAllGlobals` — a plain assignment throws.
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      open(...args: unknown[]) {
        xhrOpenSpy(...args);
      }
      send(...args: unknown[]) {
        xhrSendSpy(...args);
      }
      setRequestHeader() {}
    },
  );
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(...args: unknown[]) {
        wsSpy(...args);
      }
    },
  );
  // A fake navigator carrying a sendBeacon spy.
  vi.stubGlobal('navigator', {
    sendBeacon: beaconSpy,
    userAgent: 'test',
    language: 'en',
    platform: 'test',
  });
  fetchSpy.mockReset();
  xhrOpenSpy.mockReset();
  xhrSendSpy.mockReset();
  wsSpy.mockReset();
  beaconSpy.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake DOM that records the anchor click but never touches the network. */
function fakeDownloadDeps(): { deps: DiagnosticDownloadDeps; clicked: () => number; url: () => string | null } {
  let clicks = 0;
  let objectUrl: string | null = null;
  const deps: DiagnosticDownloadDeps = {
    documentRef: {
      createElement: () =>
        ({
          href: '',
          download: '',
          rel: '',
          click: () => {
            clicks += 1;
          },
        }) as unknown as HTMLElement,
    } as Pick<Document, 'createElement'>,
    urlRef: {
      createObjectURL: () => {
        objectUrl = 'blob:fake-local-url';
        return objectUrl;
      },
      revokeObjectURL: () => {},
    },
  };
  return { deps, clicked: () => clicks, url: () => objectUrl };
}

function assertNoEgress(): void {
  expect(fetchSpy, 'fetch').not.toHaveBeenCalled();
  expect(xhrOpenSpy, 'XMLHttpRequest.open').not.toHaveBeenCalled();
  expect(xhrSendSpy, 'XMLHttpRequest.send').not.toHaveBeenCalled();
  expect(wsSpy, 'WebSocket').not.toHaveBeenCalled();
  expect(beaconSpy, 'navigator.sendBeacon').not.toHaveBeenCalled();
}

describe('diagnosticBundle — NO network egress (acceptance)', () => {
  it('build + serialize + download fire zero fetch/XHR/WebSocket/sendBeacon', async () => {
    const bundle = await buildDiagnosticBundle({
      error: { name: 'Error', message: 'boom', stack: null },
      caseDocument: tinyCase(),
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    });
    const json = serializeDiagnosticBundle(bundle);
    const { deps, clicked, url } = fakeDownloadDeps();
    const triggered = downloadDiagnosticBundle(json, diagnosticBundleFilename(bundle.generatedAt), deps);

    expect(triggered).toBe(true);
    // The download really ran locally: a Blob object URL was minted and clicked.
    expect(url()).toBe('blob:fake-local-url');
    expect(clicked()).toBe(1);
    assertNoEgress();
  });

  it('falsifiability: a seeded fetch IS caught by the same spy', () => {
    // If any code in the bundle path had called fetch, this is what would have
    // tripped the acceptance above.
    void (globalThis.fetch as typeof fetch)('https://example.test/telemetry');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
