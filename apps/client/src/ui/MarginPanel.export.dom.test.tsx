// apps/client/src/ui/MarginPanel.export.dom.test.tsx
//
// Phase 3 Task 7: real-DOM `client-dom` project test (browser mode) for the
// dev-only reference-margin export button
// (`engine/marginEditor.ts`'s `exportReferenceMargin()`,
// `data-testid="margin-export-reference-button"` in ui/MarginPanel.tsx).
// Same "synthetic icosahedron standin, no mounted Viewport" convention as
// MarginPanel.dom.test.tsx / MarginPanel.validation.dom.test.tsx (this
// file's die-standin + control-case perimeter-quad flow are the SAME
// construction as MarginPanel.validation.dom.test.tsx's "control case"
// scenario — confirm's own gating is already covered there; this file's
// job is the EXPORT step that follows a successful confirm).
//
// ## Intercepting the download (no real file download in a headless
// browser test)
//
// `exportReferenceMargin()` triggers a REAL browser download
// (`URL.createObjectURL` + a throwaway `<a download>` anchor's `.click()`,
// same pattern as `engine/section.ts`'s `downloadSvg`). Actually clicking
// that anchor in Vitest's real Playwright-chromium browser lane would
// attempt a real file download — undesirable side effect for a test, and
// nothing worth asserting on (a saved file on some CI runner's disk). This
// file instead mocks exactly the two browser APIs the download path calls
// through: `URL.createObjectURL` (captures the `Blob` it was given, so the
// JSON payload can be read back via `Blob.text()`) and
// `HTMLAnchorElement.prototype.click` (a no-op — prevents the real
// navigation/download from ever firing) — everything BEFORE that point
// (the real store, the real `confirmMargin()` round trip, the real
// `exportReferenceMargin()` method, the real `JSON.stringify` payload
// construction) runs unmocked.
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import '../i18n';
import type { MarginReferenceExport } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import { marginEditor } from '../engine/marginEditor';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import { useMarginStore } from '../state/marginStore';
import { MarginPanel } from './MarginPanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const ICOSA_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-2, -2, -2], max: [2, 2, 2] },
  surfaceAreaMm2: 40,
  signedVolumeMm3: 10,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

// Same raw vertex/face data as MarginPanel.dom.test.tsx's own
// `icosahedronBuffers` (duplicated per this repo's established test-fixture
// convention — see that file's module doc).
const T = (1 + Math.sqrt(5)) / 2;
const RAW_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  return { positions: new Float64Array(RAW_VERTICES.flat()), indices: Uint32Array.from(FACES.flat()) };
}

type Vec3 = readonly [number, number, number];

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

function rayAtVertex(vertex: Vec3): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const len = Math.hypot(vertex[0], vertex[1], vertex[2]) || 1;
  const dir: Vec3 = [-vertex[0] / len, -vertex[1] / len, -vertex[2] / len];
  const origin: Vec3 = [vertex[0] * 3, vertex[1] * 3, vertex[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

const DIE_CONTENT_HASH = 'margin-export-dom-die';

function registerDieStandin(): { nodeId: string; positions: Float64Array } {
  const { positions, indices } = icosahedronBuffers();
  caseStore.registerImportedMesh({
    contentHash: DIE_CONTENT_HASH,
    name: 'die-standin.stl',
    format: 'stl',
    positions,
    indices,
    stats: ICOSA_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(DIE_CONTENT_HASH, 'prepDie');
  return { nodeId: node.id, positions };
}

// Perimeter order of the icosahedron's own z=0 rectangle face (indices
// 0,1,3,2) — a simple, non-crossing, clean-confirming quad. Same
// construction as MarginPanel.validation.dom.test.tsx's `PERIMETER_ORDER`
// (documented there in full).
const PERIMETER_ORDER = [0, 1, 3, 2];

async function placeAndCloseManualLoop(positions: Float64Array): Promise<void> {
  act(() => {
    marginEditor.setMode('manual');
  });
  for (const vertexIndex of PERIMETER_ORDER) {
    await act(async () => {
      await marginEditor.handlePick(rayAtVertex(pointAt(positions, vertexIndex)));
    });
  }
  await waitFor(() => expect(useMarginStore.getState().anchors).toHaveLength(4));
  await act(async () => {
    await marginEditor.toggleClosed();
  });
  await waitFor(() => expect(useMarginStore.getState().closed).toBe(true));
}

// ---------------------------------------------------------------------------
// Download interception — see this file's module doc.
// ---------------------------------------------------------------------------
let capturedBlob: Blob | null = null;
let createObjectURLSpy: MockInstance<typeof URL.createObjectURL>;
let revokeObjectURLSpy: MockInstance<typeof URL.revokeObjectURL>;
let anchorClickSpy: MockInstance<() => void>;

beforeEach(() => {
  caseStore.resetForTests();
  marginEditor.resetForTests();
  capturedBlob = null;
  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    capturedBlob = obj as Blob;
    return 'blob:mock-url-for-test';
  });
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
  marginEditor.resetForTests();
  createObjectURLSpy.mockRestore();
  revokeObjectURLSpy.mockRestore();
  anchorClickSpy.mockRestore();
});

describe('MarginPanel — dev-only reference-margin export (Phase 3 Task 7)', () => {
  it('is disabled until the margin is confirmed, then downloads a schema-conformant, no-PHI JSON payload named <tooth>.reference.json', async () => {
    const { nodeId, positions } = registerDieStandin();
    const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: nodeId });
    const user = userEvent.setup();

    render(<MarginPanel />);
    await act(async () => {
      marginEditor.startForTooth(restoration.id, 11);
    });

    await placeAndCloseManualLoop(positions);

    // Dev-gated button is present (this test suite always runs with
    // `import.meta.env.DEV` true — Vitest's own dev-mode default, the same
    // convention `engine/testHooks.ts`'s installation relies on already)
    // but disabled: nothing has been confirmed yet. Real native
    // `disabled`-button semantics already mean a `user.click()` here would
    // be a browser-level no-op (never even reaching `onClick`) — the
    // engine-level guard is exercised directly instead (this method's own
    // "no-op unless confirmed" behavior is ALSO covered end-to-end by this
    // file's second `it`, which starts from a state with nothing confirmed
    // at all).
    const exportButton = await screen.findByTestId('margin-export-reference-button');
    expect((exportButton as HTMLButtonElement).disabled).toBe(true);
    expect(marginEditor.exportReferenceMargin()).toBe(false);
    expect(capturedBlob).toBeNull();

    // Confirm (control-case: clean perimeter quad, no hard failures).
    await waitFor(() => {
      expect(screen.getByTestId('margin-validation-badge').getAttribute('data-status')).toBe('valid');
    });
    const confirmButton = screen.getByTestId('margin-confirm-button') as HTMLButtonElement;
    await act(async () => {
      await user.click(confirmButton);
    });
    await waitFor(() => {
      expect(screen.getByTestId('margin-confirmed-indicator')).toBeTruthy();
    });

    expect((exportButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      await user.click(exportButton);
    });

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe('application/json');

    const text = await capturedBlob!.text();
    const payload = JSON.parse(text) as MarginReferenceExport;

    // Schema-allowed keys ONLY — the no-PHI check: nothing besides this
    // exact field set may ever appear in an exported reference.
    const EXPECTED_KEYS = [
      'tooth',
      'anchors',
      'closed',
      'resampledPoints',
      'meshContentHash',
      'traced',
      'appVersion',
      'kernelVersion',
      'exportedAt',
    ].sort();
    expect(Object.keys(payload).sort()).toEqual(EXPECTED_KEYS);

    expect(payload.tooth).toBe(11);
    expect(payload.closed).toBe(true);
    expect(payload.anchors).toHaveLength(4);
    expect(payload.resampledPoints.length).toBeGreaterThan(0);
    expect(payload.meshContentHash).toBe(DIE_CONTENT_HASH); // never a filename/patient identifier
    expect(payload.traced).toBe('human-reference');
    expect(typeof payload.appVersion).toBe('string');
    expect(payload.appVersion.length).toBeGreaterThan(0);
    expect(typeof payload.kernelVersion).toBe('string');
    expect(payload.kernelVersion.length).toBeGreaterThan(0);
    expect(() => new Date(payload.exportedAt).toISOString()).not.toThrow();
  }, 30_000);

  it('exportReferenceMargin() is a no-op (returns false, no download) before anything is confirmed', () => {
    registerDieStandin();
    marginEditor.resetForTests();
    let ok!: boolean;
    act(() => {
      ok = marginEditor.exportReferenceMargin();
    });
    expect(ok).toBe(false);
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });
});
