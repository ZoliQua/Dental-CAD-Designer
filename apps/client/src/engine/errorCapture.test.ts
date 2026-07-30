// apps/client/src/engine/errorCapture.test.ts
//
// Phase 8 Task 5 — the global capture path + the bundle orchestrator.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCaseStore } from '../state/caseStore';
import { useErrorReportStore } from '../state/errorReportStore';
import { diagnosticLogSnapshot, resetDiagnosticLogForTests } from './diagnosticLog';
import {
  captureError,
  dismissErrorReport,
  downloadDiagnosticBundleNow,
  resetErrorCaptureForTests,
  toDiagnosticError,
} from './errorCapture';
import * as bundleModule from './diagnosticBundle';

beforeEach(() => {
  resetDiagnosticLogForTests(() => '2026-07-22T00:00:00.000Z');
  useErrorReportStore.getState().dismiss();
  resetErrorCaptureForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetErrorCaptureForTests();
});

describe('toDiagnosticError', () => {
  it('reduces an Error to name/message/stack', () => {
    const e = new RangeError('bad index');
    const d = toDiagnosticError(e);
    expect(d.name).toBe('RangeError');
    expect(d.message).toBe('bad index');
    expect(typeof d.stack === 'string' || d.stack === null).toBe(true);
  });

  it('reduces a non-Error thrown value to a String() message (never its structure)', () => {
    const d = toDiagnosticError({ patient: 'Jane Doe' });
    expect(d.name).toBe('UnknownError');
    expect(d.stack).toBeNull();
    // The message is the String() form — not a structural dump; assert it does
    // not carry the object's PHI-shaped property value verbatim.
    expect(d.message).not.toContain('Jane Doe');
  });
});

describe('captureError', () => {
  it('publishes a PHI-free error to the store and logs a breadcrumb', () => {
    captureError(new TypeError('boom'), 'window.onerror');
    const state = useErrorReportStore.getState();
    expect(state.kind).toBe('active');
    expect(state.current).toMatchObject({ name: 'TypeError', message: 'boom', source: 'window.onerror' });
    // The log breadcrumb carries only the event + source + name (no message body).
    const entry = diagnosticLogSnapshot().find((e) => e.event === 'error.captured');
    expect(entry?.fields).toEqual({ source: 'window.onerror', name: 'TypeError' });
  });
});

describe('downloadDiagnosticBundleNow', () => {
  it('builds the bundle for the current error + case and reports success', async () => {
    useCaseStore.getState().setDocument({
      id: 'case-777',
      schemaVersion: 2,
      createdAt: '2026-07-22T00:00:00.000Z',
      meshes: [],
      scene: [],
      restorations: [],
      measurements: [],
      history: [],
      settings: { materialProfileId: '', profileVersion: '' },
    });
    captureError(new Error('kaput'), 'react');

    // Stub only the DOM-touching download (no DOM in the node lane); the build +
    // serialize path runs for real.
    const dl = vi.spyOn(bundleModule, 'downloadDiagnosticBundle').mockReturnValue(true);
    const ok = await downloadDiagnosticBundleNow();
    expect(ok).toBe(true);
    expect(dl).toHaveBeenCalledTimes(1);
    const [json] = dl.mock.calls[0]!;
    expect(json).toContain('case-777');
    expect(json).toContain('"kernelVersion": "0.26.0"');
    // Not left in a stuck "downloading" state.
    expect(useErrorReportStore.getState().downloading).toBe(false);
  });

  it('sets downloadError (never throws) when the build fails', async () => {
    vi.spyOn(bundleModule, 'buildDiagnosticBundle').mockRejectedValue(new Error('nope'));
    const ok = await downloadDiagnosticBundleNow();
    expect(ok).toBe(false);
    expect(useErrorReportStore.getState().downloadError).toBe(true);
    expect(useErrorReportStore.getState().downloading).toBe(false);
  });
});

describe('dismissErrorReport', () => {
  it('hides the surface', () => {
    captureError(new Error('x'), 'manual');
    expect(useErrorReportStore.getState().kind).toBe('active');
    dismissErrorReport();
    expect(useErrorReportStore.getState().kind).toBe('hidden');
  });
});
