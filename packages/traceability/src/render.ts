// packages/traceability/src/render.ts
//
// Phase 7 Task 5 — the PDF-ready HTML rendering of a QcTraceabilityDocument.
//
// PURITY CONTRACT: `renderTraceabilityHtml` is a pure function
// (document, options) → HTML string. No Date/Date.now, no Intl, no
// environment locale, no randomness — locale is an explicit parameter, and
// the ONLY way any timestamp can appear is the caller passing the Export
// row's `releasedAt` through `options.releasedAt`, which is rendered under
// an explicitly labeled "server record field — not part of the hashed
// document" line (the shared-types traceability.ts timestamp policy; a
// PREVIEW refuses the option entirely — a preview is not a release record).
//
// SELF-CONTAINED OUTPUT: a complete standalone HTML document — inline
// <style> only, no external assets, no scripts, no URLs of any kind (the
// lab may archive/print it offline; render.test.ts asserts the absence of
// src=/href=/url()/http(s) falsifiably). Print CSS included (@page +
// @media print) so "print to PDF" produces the handoff document.
//
// NO SECOND SOURCE OF TRUTH: everything rendered comes from the document
// JSON (or the explicit envelope option). No clinical value, threshold or
// version is produced here — clinical strings are labels only (strings.ts).
import type { QcGateResult, QcTraceabilityDocument } from '@dqcad/shared-types';
import { escapeHtml, formatGateValue, interpolate } from './format.ts';
import {
  TRACEABILITY_STRINGS,
  type TraceabilityLocale,
  type TraceabilityStringKey,
} from './strings.ts';

export interface RenderTraceabilityOptions {
  /** Explicit display locale — never read from the environment. */
  locale: TraceabilityLocale;
  /**
   * The Export ledger row's `releasedAt` (ISO 8601), rendered ONLY as the
   * labeled non-hashed record envelope. Allowed on `release` documents
   * only; passing it for a preview throws (a preview has no release
   * event to display).
   */
  releasedAt?: string;
}

/** Thrown when a releasedAt envelope is passed for a preview document. */
export class TraceabilityRenderError extends Error {
  constructor(message: string) {
    super(`renderTraceabilityHtml: ${message}`);
    this.name = 'TraceabilityRenderError';
  }
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 system-ui, sans-serif; color: #1a1a1a; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 1.4rem 0 0.4rem; border-bottom: 1px solid #999; padding-bottom: 0.15rem; }
  .kind { margin: 0 0 0.2rem; font-weight: 600; }
  .meta { margin: 0; color: #444; font-size: 0.85rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1rem; margin: 0.4rem 0; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  dd.plain { font-family: inherit; font-size: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { border: 1px solid #bbb; padding: 0.3rem 0.45rem; text-align: left; vertical-align: top; }
  th { background: #efefef; }
  td.num { white-space: nowrap; }
  tr.fail td { background: #fdeaea; }
  tr.ack td { background: #fff4dd; }
  .status-pass { color: #1b6e1b; font-weight: 600; }
  .status-fail { color: #a11212; font-weight: 700; }
  .status-ack { color: #9a6200; font-weight: 700; }
  .summary-pass { color: #1b6e1b; font-weight: 600; }
  .summary-fail { color: #a11212; font-weight: 700; }
  .ack-section { border: 2px solid #d99a00; background: #fff8e8; padding: 0.6rem 0.8rem; margin: 1rem 0; }
  .ack-section h2 { border-bottom: none; margin-top: 0; }
  .cert-section { border: 2px solid #a11212; background: #fdf2f2; padding: 0.6rem 0.8rem; margin: 1rem 0; }
  .cert-section h2 { border-bottom: none; margin-top: 0; }
  .cert-section.cert-ok-section { border-color: #1b6e1b; background: #f2faf2; }
  .cert-ok { color: #1b6e1b; font-weight: 600; }
  .record-text { color: #555; font-size: 0.8rem; font-style: italic; }
  .released-at { margin-top: 1.2rem; padding-top: 0.4rem; border-top: 1px dashed #999; color: #444; font-size: 0.85rem; }
  .preview-banner { border: 3px solid #b30000; color: #b30000; font-weight: 800; text-align: center; padding: 0.5rem; margin: 0 0 1rem; letter-spacing: 0.06em; }
  .preview-watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 10; }
  .preview-watermark span { transform: rotate(-28deg); font-size: 4rem; font-weight: 800; color: rgba(179, 0, 0, 0.14); text-align: center; }
  @page { margin: 14mm; }
  @media print {
    body { margin: 0; max-width: none; }
    section, .ack-section, .cert-section, table { break-inside: avoid; }
  }
`;

function gateStatus(gate: QcGateResult): {
  key: TraceabilityStringKey;
  rowClass: string;
  cellClass: string;
} {
  if (gate.passed) return { key: 'gateStatus.pass', rowClass: '', cellClass: 'status-pass' };
  if (gate.acknowledged)
    return { key: 'gateStatus.acknowledged', rowClass: 'ack', cellClass: 'status-ack' };
  return { key: 'gateStatus.fail', rowClass: 'fail', cellClass: 'status-fail' };
}

/**
 * Renders the document — see this file's module doc for the purity,
 * self-containment and timestamp-envelope contracts.
 *
 * @throws {TraceabilityRenderError} when `releasedAt` is passed for a
 *   preview document.
 */
export function renderTraceabilityHtml(
  document: QcTraceabilityDocument,
  options: RenderTraceabilityOptions,
): string {
  const t = (key: TraceabilityStringKey): string => TRACEABILITY_STRINGS[options.locale][key];
  const isPreview = document.documentKind === 'preview';
  if (isPreview && options.releasedAt !== undefined) {
    throw new TraceabilityRenderError(
      'releasedAt was passed for a PREVIEW document — a preview is not a release record and carries no release event',
    );
  }
  const notAvailable = t('notAvailable');
  const gateLabel = (id: string): string => {
    const table = TRACEABILITY_STRINGS[options.locale] as Record<string, string>;
    return table[`gate.${id}`] ?? id;
  };
  const typeLabel = (): string => {
    const table = TRACEABILITY_STRINGS[options.locale] as Record<string, string>;
    return table[`type.${document.identity.restorationType}`] ?? document.identity.restorationType;
  };

  const row = (label: string, value: string, mono = true): string =>
    `<dt>${escapeHtml(label)}</dt><dd${mono ? '' : ' class="plain"'}>${escapeHtml(value)}</dd>`;

  const gateRows = document.qc.gates
    .map((gate) => {
      const status = gateStatus(gate);
      return (
        `<tr${status.rowClass ? ` class="${status.rowClass}"` : ''}>` +
        `<td>${escapeHtml(gateLabel(gate.gate))}</td>` +
        `<td class="num">${escapeHtml(formatGateValue(gate.value, gate.unit, notAvailable))}</td>` +
        `<td class="num">${escapeHtml(formatGateValue(gate.threshold, gate.unit, notAvailable))}</td>` +
        `<td class="${status.cellClass}">${escapeHtml(t(status.key))}</td>` +
        `<td>${escapeHtml(gate.message)}</td>` +
        `</tr>`
      );
    })
    .join('');

  const ackSection =
    document.acknowledgments.length === 0
      ? ''
      : `<section class="ack-section"><h2>${escapeHtml(t('ackHeading'))}</h2>` +
        `<p>${escapeHtml(t('ackNotice'))}</p><dl>` +
        document.acknowledgments
          .map(
            (ack) =>
              row(gateLabel(ack.gate), ack.message, false) +
              row(
                t('ackOperationLabel'),
                ack.operationId === null ? t('ackUnjournaledLabel') : ack.operationId,
              ),
          )
          .join('') +
        `</dl></section>`;

  const fileSection =
    document.exportFile === null
      ? ''
      : `<section><h2>${escapeHtml(t('fileHeading'))}</h2><dl>` +
        row(t('formatLabel'), document.exportFile.format.toUpperCase()) +
        row(t('bytesHashLabel'), document.exportFile.bytesSha256) +
        row(t('byteLengthLabel'), String(document.exportFile.byteLength)) +
        row(t('meshContentHashLabel'), document.exportFile.meshContentHash) +
        (document.exportFile.headerText === null
          ? ''
          : row(t('headerTextLabel'), document.exportFile.headerText)) +
        `</dl></section>`;

  const journalSection =
    document.journal === null
      ? ''
      : `<section><h2>${escapeHtml(t('journalHeading'))}</h2><dl>` +
        row(t('journalHashLabel'), document.journal.caseJournalHash) +
        row(t('journalOpCountLabel'), String(document.journal.journalOperationCount)) +
        row(t('exportOperationLabel'), document.journal.exportOperationId) +
        `</dl></section>`;

  const reimportSection =
    document.reimportVerification === null
      ? ''
      : `<section><h2>${escapeHtml(t('reimportHeading'))}</h2><dl>` +
        row(t('reimportHashLabel'), document.reimportVerification.reimportMeshHash) +
        `</dl>` +
        `<p>${escapeHtml(
          (TRACEABILITY_STRINGS[options.locale] as Record<string, string>)[
            `relation.${document.reimportVerification.meshHashRelation}`
          ] ?? document.reimportVerification.meshHashRelation,
        )}</p>` +
        `<p>${escapeHtml(t('gateIdentityLine'))}</p></section>`;

  const boundsSection =
    document.errorBounds === null
      ? ''
      : `<section><h2>${escapeHtml(t('boundsHeading'))}</h2>` +
        (document.errorBounds.f32Narrowing === null
          ? ''
          : `<p>${escapeHtml(
              interpolate(t('boundsStlLine'), {
                bound: String(document.errorBounds.f32Narrowing.halfUlpBoundMm),
                maxCoord: `${document.errorBounds.f32Narrowing.maxAbsCoordinateMm.toFixed(3)} mm`,
              }),
            )}</p>`) +
        `<p>${escapeHtml(t('boundsGateNote'))}</p></section>`;

  // schemaVersion 2: a certified release states the positive certification;
  // a preview (or any document that did not certify the envelope) renders the
  // limitation disclosure(s). Both may co-exist if a future release carries
  // other limitations while still certifying the outer envelope.
  const certifiedLine = document.certification.outerEnvelopeCertified
    ? `<p class="cert-ok">${escapeHtml(t('certOuterEnvelopeCertified'))}</p>`
    : '';
  const limitationList =
    certifiedLine +
    document.certification.limitations
      .map((limitation) => {
        const table = TRACEABILITY_STRINGS[options.locale] as Record<string, string>;
        const translated = table[`limitation.${limitation.code}`] ?? limitation.statement;
        return (
          `<p>${escapeHtml(translated)}</p>` +
          `<p class="record-text">${escapeHtml(t('certRecordText'))}: ${escapeHtml(limitation.statement)}</p>`
        );
      })
      .join('');

  const releasedAtLine =
    options.releasedAt === undefined
      ? ''
      : `<p class="released-at">${escapeHtml(t('releasedAtLabel'))}: ${escapeHtml(options.releasedAt)}</p>`;

  const summaryClass = document.qc.passed ? 'summary-pass' : 'summary-fail';
  const summaryText = document.qc.passed ? t('qcPassed') : t('qcFailed');

  // Defense-in-depth: EVERY interpolation in this regulatory renderer is
  // uniformly escaped. `locale` is a typed union sanitized at the call sites
  // and `schemaVersion` is a numeric const, so neither is attacker-reachable
  // today — but a future caller forwarding an unsanitized value must never be
  // able to break out of the `lang` attribute or the schema-version text.
  // `schemaVersion` is additionally coerced through `Number(...)` so any
  // non-numeric injection collapses to `NaN` before escaping.
  const localeAttr = escapeHtml(options.locale);
  const schemaVersionText = escapeHtml(String(Number(document.schemaVersion)));

  return (
    `<!doctype html>` +
    `<html lang="${localeAttr}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(t('title'))}</title>` +
    `<style>${STYLE}</style></head>` +
    `<body class="${isPreview ? 'kind-preview' : 'kind-release'}">` +
    (isPreview
      ? `<div class="preview-watermark"><span>${escapeHtml(t('previewWatermark'))}</span></div>` +
        `<div class="preview-banner">${escapeHtml(t('previewWatermark'))}</div>`
      : '') +
    `<header><h1>${escapeHtml(t('title'))}</h1>` +
    `<p class="kind">${escapeHtml(isPreview ? t('kindPreview') : t('kindRelease'))}</p>` +
    `<p class="meta">${escapeHtml(t('schemaVersionLabel'))}: ${schemaVersionText}</p></header>` +
    `<section><h2>${escapeHtml(t('identityHeading'))}</h2><dl>` +
    row(t('caseLabel'), document.identity.caseId) +
    row(t('restorationLabel'), document.identity.restorationId) +
    row(t('typeLabel'), typeLabel(), false) +
    row(t('teethLabel'), document.identity.teeth.join(', '), false) +
    `</dl></section>` +
    `<section><h2>${escapeHtml(t('qcHeading'))}</h2>` +
    `<p class="${summaryClass}">${escapeHtml(summaryText)}</p>` +
    `<table><thead><tr>` +
    `<th>${escapeHtml(t('gateColumn'))}</th><th>${escapeHtml(t('measuredColumn'))}</th>` +
    `<th>${escapeHtml(t('thresholdColumn'))}</th><th>${escapeHtml(t('statusColumn'))}</th>` +
    `<th>${escapeHtml(t('messageColumn'))}</th>` +
    `</tr></thead><tbody>${gateRows}</tbody></table></section>` +
    ackSection +
    fileSection +
    journalSection +
    reimportSection +
    boundsSection +
    `<section><h2>${escapeHtml(t('profileHeading'))}</h2><dl>` +
    row(t('profileIdLabel'), document.materialProfile.id) +
    row(t('profileVersionLabel'), document.materialProfile.version) +
    row(t('profileChecksumLabel'), document.materialProfile.checksum) +
    `</dl></section>` +
    `<section><h2>${escapeHtml(t('versionsHeading'))}</h2><dl>` +
    row(t('kernelVersionLabel'), document.versions.kernelVersion) +
    row(t('manifoldVersionLabel'), document.versions.manifoldVersion ?? notAvailable) +
    `</dl></section>` +
    `<section class="cert-section${
      document.certification.outerEnvelopeCertified ? ' cert-ok-section' : ''
    }"><h2>${escapeHtml(t('certHeading'))}</h2>${limitationList}</section>` +
    releasedAtLine +
    `</body></html>`
  );
}
