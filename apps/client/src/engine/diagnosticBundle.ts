// apps/client/src/engine/diagnosticBundle.ts
//
// Phase 8 Task 5 — the TELEMETRY-FREE, LOCAL-ONLY, PHI-FREE diagnostic bundle.
//
// When the app hits an unhandled error, the user can download a diagnostic
// bundle: a local JSON file THEY choose whether to share with a maintainer.
// Nothing is ever sent anywhere. See docs/adr/019-telemetry-free-error-bundle.md
// for the "why no remote error reporting" decision (medical-data privacy).
//
// ## Two invariants, both by construction (and both falsifiably tested)
//
// 1. NO NETWORK EGRESS. This module imports and uses NO transport — no `fetch`,
//    no `XMLHttpRequest`, no `WebSocket`, no `navigator.sendBeacon`. Building,
//    serializing, and downloading the bundle are entirely local (the download
//    is a `Blob` + object URL + a synthetic `<a>` click). diagnosticBundle.no-
//    egress.test.ts spies all four network globals and asserts ZERO calls across
//    the whole build+serialize+download path.
//
// 2. NO PHI. The bundle is built from an explicit ALLOWLIST (below). It reads
//    ONLY: version strings, the browser environment (UA/language/platform), the
//    active case's `id` (a random UUID — not a patient identifier) + its journal
//    HASH + journal/restoration COUNTS, the error (name/message/stack), and the
//    PHI-free log ring. It NEVER touches `CaseDocument.patientRef`,
//    `.meshes` (scan geometry / scan filenames), `.scene`, the CONTENT of
//    `.restorations` / `.measurements` / `.settings`, nor any case NAME. A new
//    PHI-class field added to `CaseDocument` tomorrow is EXCLUDED by default,
//    because the builder copies only the named allowlisted fields — never the
//    document. diagnosticBundle.no-phi.test.ts seeds synthetic PHI (patientRef,
//    scan vertices, a patient-named case) into a document, builds the bundle,
//    and asserts none of it appears in the serialized bytes (and, to prove the
//    detector is not vacuous, that PHI placed into an allowlisted path WOULD be
//    caught).
//
// ## The allowlist — exactly what goes in, and why each item is PHI-safe
//
//   schemaVersion       constant           — bundle format version.
//   generatedAt         ISO timestamp      — metadata only (never hashed/computed on).
//   app.appVersion      APP_VERSION         — client build tag.
//   app.kernelVersion   KERNEL_VERSION      — kernel algorithm version.
//   app.manifoldVersion string | null       — boolean-engine build; null on the
//                                              client (no authoritative browser
//                                              constant — same honest posture as
//                                              engine/traceabilityPreview.ts).
//   environment.userAgent/language/platform — device/browser facts, not patient data.
//   case.id             CaseDocument.id     — a random UUID; identifies the case
//                                              record, carries no patient identity.
//   case.journalHash    hashCaseJournal()   — a SHA-256 over the journal's
//                                              reproducible view; a one-way hash,
//                                              never the journal content.
//   case.journalOperationCount / restorationCount — sizes, not content.
//   error.name/message/stack                — the failure itself (technical).
//   log                 diagnosticLogSnapshot() — the bounded PHI-free ring.
//
// Everything else about the case is excluded by NOT being read here.
//
// Layer: engine/ — imports @dqcad/kernel-workers (KERNEL_VERSION, hashCaseJournal)
// and @dqcad/shared-types (CaseDocument type) only; no DOM math, no kernel geometry.
import { hashCaseJournal, KERNEL_VERSION } from '@dqcad/kernel-workers';
import type { CaseDocument } from '@dqcad/shared-types';
import { APP_VERSION } from '../appVersion';
import { diagnosticLogSnapshot, type DiagnosticLogEntry } from './diagnosticLog';

/** Bump only on a breaking change to the bundle shape. */
export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;

/** The error, already reduced to serializable strings — never a live Error
 * instance (which could carry non-enumerable, non-PHI-audited properties). */
export interface DiagnosticBundleError {
  name: string;
  message: string;
  stack: string | null;
}

export interface DiagnosticBundleEnvironment {
  userAgent: string | null;
  language: string | null;
  platform: string | null;
}

/** The serialized bundle — the exact JSON shape written to disk. */
export interface DiagnosticBundle {
  schemaVersion: number;
  /** ISO-8601 — metadata only. */
  generatedAt: string;
  app: {
    appVersion: string;
    kernelVersion: string;
    manifoldVersion: string | null;
  };
  environment: DiagnosticBundleEnvironment;
  case: {
    id: string | null;
    journalHash: string | null;
    journalOperationCount: number;
    restorationCount: number;
  };
  error: DiagnosticBundleError | null;
  log: readonly DiagnosticLogEntry[];
}

export interface BuildDiagnosticBundleInput {
  /** The captured error, or null (a user-initiated bundle without an error). */
  error: DiagnosticBundleError | null;
  /** The active case document, or null (no case open). Read via the allowlist
   * ONLY — its content never enters the bundle. */
  caseDocument: CaseDocument | null;
  /** Browser environment; defaults to `collectEnvironment()`. Injectable for tests. */
  environment?: DiagnosticBundleEnvironment;
  /** Boolean-engine version if a source is available; defaults to null (see doc). */
  manifoldVersion?: string | null;
  /** Log ring snapshot; defaults to `diagnosticLogSnapshot()`. Injectable for tests. */
  log?: readonly DiagnosticLogEntry[];
  /** Timestamp source (metadata only); defaults to `Date.now`-based ISO. Injectable. */
  now?: () => string;
}

/**
 * Collect the browser environment, guarding every global so this is safe under
 * the Node test env (no `navigator`). No PHI: UA/language/platform are device
 * facts. Deliberately does NOT read screen size, timezone, or anything that
 * fingerprints beyond the browser build.
 */
export function collectEnvironment(): DiagnosticBundleEnvironment {
  if (typeof navigator === 'undefined') {
    return { userAgent: null, language: null, platform: null };
  }
  const nav = navigator as Navigator & { platform?: string };
  return {
    userAgent: typeof nav.userAgent === 'string' ? nav.userAgent : null,
    language: typeof nav.language === 'string' ? nav.language : null,
    platform: typeof nav.platform === 'string' ? nav.platform : null,
  };
}

/**
 * Build the diagnostic bundle from the allowlist. Async because the journal
 * hash is computed with WebCrypto (`hashCaseJournal`, local — no network).
 *
 * Reads from `caseDocument` ONLY: `id`, `history` (→ hash + count),
 * `restorations.length`. Never `patientRef`, `meshes`, `scene`, restoration/
 * measurement/settings content, or any case name. See this module's doc.
 */
export async function buildDiagnosticBundle(
  input: BuildDiagnosticBundleInput,
): Promise<DiagnosticBundle> {
  const now = input.now ?? (() => new Date().toISOString());
  const environment = input.environment ?? collectEnvironment();
  const log = input.log ?? diagnosticLogSnapshot();

  const doc = input.caseDocument;
  const journalHash = doc !== null ? await hashCaseJournal(doc.history) : null;

  return {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    generatedAt: now(),
    app: {
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
      manifoldVersion: input.manifoldVersion ?? null,
    },
    environment,
    case: {
      id: doc !== null ? doc.id : null,
      journalHash,
      journalOperationCount: doc !== null ? doc.history.length : 0,
      restorationCount: doc !== null ? doc.restorations.length : 0,
    },
    error: input.error,
    log,
  };
}

/** Serialize the bundle to the exact bytes written to disk (pretty-printed for
 * a human maintainer). Deterministic given the same bundle. */
export function serializeDiagnosticBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** A stable, PHI-free filename for the downloaded bundle. `at` is an ISO string;
 * the colons are replaced so it is filesystem-safe on every OS. */
export function diagnosticBundleFilename(at: string): string {
  const safe = at.replace(/[:.]/g, '-');
  return `dqcad-diagnostic-${safe}.json`;
}

/** DOM seams the local download needs — injectable so the no-egress test can
 * exercise the full download path with fakes under the Node lane (where
 * `URL.createObjectURL` does not exist). */
export interface DiagnosticDownloadDeps {
  documentRef: Pick<Document, 'createElement'>;
  urlRef: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
}

/**
 * Trigger a LOCAL download of the serialized bundle: a `Blob` → object URL → a
 * synthetic `<a download>` click → revoke. No network anywhere. Returns `true`
 * if the download was triggered, `false` if the DOM/URL APIs are unavailable
 * (e.g. the Node test env with no injected deps) — never throws.
 *
 * The `deps` seam defaults to the real `document`/`URL` when present.
 */
export function downloadDiagnosticBundle(
  json: string,
  filename: string,
  deps?: DiagnosticDownloadDeps,
): boolean {
  const resolved = deps ?? resolveDefaultDownloadDeps();
  if (resolved === null) {
    return false;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = resolved.urlRef.createObjectURL(blob);
  try {
    const anchor = resolved.documentRef.createElement('a') as HTMLAnchorElement;
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    resolved.urlRef.revokeObjectURL(url);
  }
  return true;
}

function resolveDefaultDownloadDeps(): DiagnosticDownloadDeps | null {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }
  return {
    documentRef: document,
    urlRef: { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL },
  };
}
