// apps/client/src/state/errorReportStore.ts
//
// Phase 8 Task 5 — UI-facing state for the non-blocking ERROR SURFACE (zustand).
// Same "state" layering as recoveryStore.ts / persistenceStore.ts: pure state,
// depends on nothing but plain local types (no engine/, no ui/). The engine
// (engine/errorCapture.ts) publishes a captured error here; ui/ErrorReportSurface
// only reads it and calls back into errorCapture.ts's actions.
//
// The stored shape is technical + PHI-free by construction: an error's name,
// message, stack, capture source, and a display timestamp — never case content.
// (An error MESSAGE is developer/technical text; it is shown framed by
// translated labels and offered for the local, user-controlled bundle only.)
import { create } from 'zustand';

/** Where the error was captured — a fixed code label, not user data. */
export type ErrorCaptureSource = 'react' | 'window.onerror' | 'unhandledrejection' | 'manual';

/** The technical, PHI-free description of a captured error surfaced to the user. */
export interface ErrorReportInfo {
  name: string;
  message: string;
  stack: string | null;
  source: ErrorCaptureSource;
  /** ISO-8601 — display only. */
  at: string;
}

interface ErrorReportState {
  /** `hidden` — nothing to show; `active` — an error surface is visible. */
  kind: 'hidden' | 'active';
  /** The most recent captured error (the one the surface + bundle describe). */
  current: ErrorReportInfo | null;
  /** True while a diagnostic bundle download is being assembled (button state). */
  downloading: boolean;
  /** A localized-key marker set when a download attempt failed (rare). */
  downloadError: boolean;
  reportError: (info: ErrorReportInfo) => void;
  setDownloading: (downloading: boolean) => void;
  setDownloadError: (downloadError: boolean) => void;
  dismiss: () => void;
}

export const useErrorReportStore = create<ErrorReportState>((set) => ({
  kind: 'hidden',
  current: null,
  downloading: false,
  downloadError: false,
  reportError: (info) => set({ kind: 'active', current: info, downloadError: false }),
  setDownloading: (downloading) => set({ downloading }),
  setDownloadError: (downloadError) => set({ downloadError }),
  dismiss: () => set({ kind: 'hidden', downloading: false, downloadError: false }),
}));
