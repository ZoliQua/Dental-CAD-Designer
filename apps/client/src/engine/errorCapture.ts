// apps/client/src/engine/errorCapture.ts
//
// Phase 8 Task 5 — GLOBAL ERROR CAPTURE + the local diagnostic-bundle orchestrator.
//
// Consolidates the previously scattered ad-hoc error handling behind ONE capture
// path: React render errors (ui/ErrorBoundary.tsx calls `captureError(e,
// 'react')`), plus the two global browser channels — `window.onerror` and
// `unhandledrejection`. A capture (1) records a PHI-free breadcrumb in the log
// ring and (2) publishes the error to state/errorReportStore.ts, which surfaces
// the non-blocking "something went wrong — download diagnostic bundle" banner
// (ui/ErrorReportSurface.tsx). It never blocks and never navigates.
//
// The bundle download is entirely LOCAL (engine/diagnosticBundle.ts): no network
// egress. This module imports no transport.
//
// Layer: engine/ — imports state/, shared-types (via caseStore), and the sibling
// diagnostic modules. No kernel geometry, no DOM math.
import { useCaseStore } from '../state/caseStore';
import { useErrorReportStore, type ErrorCaptureSource } from '../state/errorReportStore';
import {
  buildDiagnosticBundle,
  diagnosticBundleFilename,
  downloadDiagnosticBundle,
  serializeDiagnosticBundle,
  type DiagnosticBundleError,
} from './diagnosticBundle';
import { logDiagnostic } from './diagnosticLog';

/**
 * Reduce an arbitrary thrown value to the serializable, PHI-free error shape the
 * bundle carries. Never includes anything but `name`/`message`/`stack` — a
 * thrown value that happens to be a case object contributes only its `String()`
 * form as a message, never its structure.
 */
export function toDiagnosticError(error: unknown): DiagnosticBundleError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === 'string' ? error.stack : null,
    };
  }
  return { name: 'UnknownError', message: String(error), stack: null };
}

/**
 * Record a captured error: a PHI-free log breadcrumb (event + error name +
 * source — never the message body, which could in principle echo input) plus a
 * publish to the error-report store that raises the non-blocking surface. Never
 * throws (a handler that throws while handling an error would be a footgun).
 */
export function captureError(error: unknown, source: ErrorCaptureSource): void {
  try {
    const reduced = toDiagnosticError(error);
    logDiagnostic('error', 'error.captured', { source, name: reduced.name });
    useErrorReportStore.getState().reportError({
      name: reduced.name,
      message: reduced.message,
      stack: reduced.stack,
      source,
      at: new Date().toISOString(),
    });
  } catch {
    // Swallow — capturing an error must never itself crash the app.
  }
}

/**
 * Assemble the diagnostic bundle for the CURRENT error + active case and trigger
 * a local download. Returns `true` if the download was triggered. Reads the case
 * document through the allowlist only (buildDiagnosticBundle) — no PHI, no
 * network. Sets the store's `downloading`/`downloadError` flags for the button.
 */
export async function downloadDiagnosticBundleNow(): Promise<boolean> {
  const store = useErrorReportStore.getState();
  store.setDownloading(true);
  store.setDownloadError(false);
  try {
    const current = store.current;
    const error: DiagnosticBundleError | null =
      current !== null
        ? { name: current.name, message: current.message, stack: current.stack }
        : null;
    const bundle = await buildDiagnosticBundle({
      error,
      caseDocument: useCaseStore.getState().document,
    });
    const json = serializeDiagnosticBundle(bundle);
    const triggered = downloadDiagnosticBundle(json, diagnosticBundleFilename(bundle.generatedAt));
    logDiagnostic('info', 'diagnosticBundle.downloaded', { triggered });
    return triggered;
  } catch {
    useErrorReportStore.getState().setDownloadError(true);
    return false;
  } finally {
    useErrorReportStore.getState().setDownloading(false);
  }
}

/** Dismiss the error surface (user acknowledged). */
export function dismissErrorReport(): void {
  useErrorReportStore.getState().dismiss();
}

// ---------------------------------------------------------------------------
// Global browser handlers (window.onerror + unhandledrejection).
// ---------------------------------------------------------------------------

let installed = false;
let onErrorHandler: ((event: ErrorEvent) => void) | null = null;
let onRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

/**
 * Install the global error handlers (idempotent; a second call is a no-op).
 * Returns a disposer. Safe to call when there is no `window` (returns a no-op
 * disposer under the Node test env).
 */
export function installGlobalErrorHandlers(): () => void {
  if (installed) {
    return uninstallGlobalErrorHandlers;
  }
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  onErrorHandler = (event: ErrorEvent) => {
    // Prefer the real Error object; fall back to the message string.
    captureError(event.error ?? event.message, 'window.onerror');
  };
  onRejectionHandler = (event: PromiseRejectionEvent) => {
    captureError(event.reason, 'unhandledrejection');
  };
  window.addEventListener('error', onErrorHandler);
  window.addEventListener('unhandledrejection', onRejectionHandler);
  installed = true;
  return uninstallGlobalErrorHandlers;
}

function uninstallGlobalErrorHandlers(): void {
  if (typeof window !== 'undefined') {
    if (onErrorHandler !== null) {
      window.removeEventListener('error', onErrorHandler);
    }
    if (onRejectionHandler !== null) {
      window.removeEventListener('unhandledrejection', onRejectionHandler);
    }
  }
  onErrorHandler = null;
  onRejectionHandler = null;
  installed = false;
}

/** TEST-ONLY: reset the installed-handlers singleton. */
export function resetErrorCaptureForTests(): void {
  uninstallGlobalErrorHandlers();
}
