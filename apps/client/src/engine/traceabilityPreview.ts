// apps/client/src/engine/traceabilityPreview.ts
//
// Phase 7 Task 5 — the THIN client-side traceability preview: builds a
// `documentKind: 'preview'` QcTraceabilityDocument from the client's OWN
// pre-export QC report and renders it through the SAME shared render
// function the server uses for release documents (`@dqcad/traceability` —
// the "no divergent render logic" requirement; the renderer watermarks
// every preview with the localized PREVIEW label).
//
// A preview is NOT a release document: it carries no export-file hashes, no
// journal binding, no re-import verification, no error bounds and no
// manifold-version claim (the browser has no authoritative constant for the
// installed manifold-3d build — see shared-types/src/traceability.ts). The
// schema's conditional branch enforces exactly that shape.
//
// Pure, side-effect-free (no worker, no store) — node-lane testable like
// exportWorkflow.ts. Layer rule: engine → traceability/shared-types is an
// allowed edge (eslint.config.js).
import type { CaseDocument, QcTraceabilityDocument } from '@dqcad/shared-types';
import {
  buildPreviewTraceabilityDocument,
  renderTraceabilityHtml,
  type TraceabilityLocale,
} from '@dqcad/traceability';
import { collectAcknowledgments } from './exportWorkflow';
import { resolveMaterialProfile } from './exportFlow';

/** Thrown when no preview can honestly be built: unknown restoration, or a
 * restoration whose QC has never run (there is no report to preview) — a
 * typed, visible refusal (the 19b lesson), never a blank document. */
export class TraceabilityPreviewUnavailableError extends Error {
  readonly restorationId: string;

  constructor(restorationId: string, reason: string) {
    super(`no traceability preview for restoration ${restorationId}: ${reason}`);
    this.name = 'TraceabilityPreviewUnavailableError';
    this.restorationId = restorationId;
  }
}

/**
 * Builds the PREVIEW document from the current case-document snapshot:
 * identity from the restoration, the client's current `qc` report verbatim,
 * acknowledgments with their journal refs (`collectAcknowledgments` — the
 * same collection the export request ships), and the SAME profile-identity
 * resolution as the export request (`resolveMaterialProfile`).
 *
 * @throws {TraceabilityPreviewUnavailableError} unknown restoration / no QC
 *   report.
 */
export function buildTraceabilityPreviewDocument(
  document: CaseDocument,
  restorationId: string,
): QcTraceabilityDocument {
  const restoration = document.restorations.find((r) => r.id === restorationId);
  if (!restoration) {
    throw new TraceabilityPreviewUnavailableError(
      restorationId,
      'the case has no such restoration',
    );
  }
  if (restoration.qc === null) {
    throw new TraceabilityPreviewUnavailableError(
      restorationId,
      'QC has not run for the current design — there is no report to preview',
    );
  }
  return buildPreviewTraceabilityDocument({
    identity: {
      caseId: document.id,
      restorationId: restoration.id,
      restorationType: restoration.type,
      teeth: restoration.teeth,
    },
    report: restoration.qc,
    acknowledgments: collectAcknowledgments(restoration, document.history),
    materialProfile: resolveMaterialProfile(document),
    manifoldVersion: null,
  });
}

/** Builds + renders the watermarked preview HTML in one step — the shape
 * the Task 7 export panel mounts (locale from the UI's current language,
 * always explicit). */
export function renderTraceabilityPreviewHtml(
  document: CaseDocument,
  restorationId: string,
  locale: TraceabilityLocale,
): string {
  return renderTraceabilityHtml(buildTraceabilityPreviewDocument(document, restorationId), {
    locale,
  });
}
