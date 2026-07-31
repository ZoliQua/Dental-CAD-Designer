// packages/traceability/src/render.test.ts
//
// Phase 7 Task 5 — the PDF-ready HTML renderer: a PURE function of
// (document, options) — deterministic, locale as an explicit parameter,
// self-contained output (no external assets), print CSS, the acknowledgment
// section prominently flagged, the PREVIEW watermark, and the non-hashed
// releasedAt envelope handling per the timestamp policy.
import { describe, expect, it } from 'vitest';
import { buildPreviewTraceabilityDocument, buildReleaseTraceabilityDocument } from './document.ts';
import { fakeHash, previewInputFixture, releaseInputFixture } from './fixtures.testutil.ts';
import { renderTraceabilityHtml } from './render.ts';
import { TRACEABILITY_LOCALES } from './strings.ts';

const releaseDoc = () => buildReleaseTraceabilityDocument(releaseInputFixture());
const previewDoc = () => buildPreviewTraceabilityDocument(previewInputFixture());

describe('renderTraceabilityHtml — purity + self-containment', () => {
  it('is deterministic: same document + options ⇒ identical string', () => {
    const a = renderTraceabilityHtml(releaseDoc(), { locale: 'en' });
    const b = renderTraceabilityHtml(releaseDoc(), { locale: 'en' });
    expect(a).toBe(b);
  });

  it('is a complete, self-contained HTML document with print CSS and NO external references', () => {
    const html = renderTraceabilityHtml(releaseDoc(), { locale: 'en' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html).toContain('lang="en"');
    // Self-contained: no external fetches of any kind.
    expect(html).not.toMatch(/src\s*=|href\s*=|url\(|https?:\/\//);
  });

  it('escapes HTML in document strings (a gate message cannot inject markup)', () => {
    const input = releaseInputFixture();
    const gates = input.serverReport.gates.map((g, i) =>
      i === 0 ? { ...g, message: '<script>alert(1)</script> & "quotes"' } : g,
    );
    const doc = buildReleaseTraceabilityDocument({
      ...input,
      serverReport: { ...input.serverReport, gates },
    });
    const html = renderTraceabilityHtml(doc, { locale: 'en' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a hostile schemaVersion is coerced+escaped and cannot break out of the header', () => {
    // schemaVersion is a numeric const today, not attacker-reachable — but a
    // forged/corrupted value must never inject. It is coerced through
    // `Number(...)` (any non-numeric injection collapses to NaN) and escaped.
    const hostile = {
      ...releaseDoc(),
      schemaVersion: '2"><script>alert(1)</script>' as unknown as 2,
    };
    const html = renderTraceabilityHtml(hostile, { locale: 'en' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('NaN');
  });

  it('an unsanitized locale fails safe — it never renders an unescaped lang attribute', () => {
    // `locale` doubles as the strings-table key, so a non-locale value fails
    // safe by THROWING before any HTML is produced (no partial injected output
    // escapes). The `lang` attribute is escaped regardless (defense-in-depth).
    expect(() =>
      renderTraceabilityHtml(releaseDoc(), {
        locale: 'en"><script>alert(2)</script>' as never,
      }),
    ).toThrow();
  });
});

describe('renderTraceabilityHtml — release content', () => {
  const html = () => renderTraceabilityHtml(releaseDoc(), { locale: 'en' });

  it('renders the identity block (case, restoration, type, FDI teeth)', () => {
    const h = html();
    expect(h).toContain('case-fixture-1');
    expect(h).toContain('resto-fixture-1');
    expect(h).toContain('Crown');
    expect(h).toContain('16');
  });

  it('renders every gate with measured value vs threshold and its status', () => {
    const h = html();
    // Gate labels (translated) present.
    expect(h).toContain('Watertight');
    expect(h).toContain('Minimum wall thickness');
    expect(h).toContain('Seating');
    // mm values follow the display convention: 3 decimals + µm parenthetical
    // below 1 mm (1 µm display resolution).
    expect(h).toContain('0.612 mm (612 µm)');
    expect(h).toContain('0.500 mm (500 µm)');
    // Statuses.
    expect(h).toMatch(/pass/i);
    expect(h).toMatch(/acknowledged/i);
  });

  it('renders the hashes block (the lab verification anchors) and versions', () => {
    const h = html();
    expect(h).toContain(fakeHash('bb')); // bytesSha256
    expect(h).toContain(fakeHash('dd')); // caseJournalHash
    expect(h).toContain(fakeHash('aa')); // meshContentHash
    expect(h).toContain(fakeHash('ee')); // reimportMeshHash
    expect(h).toContain('0.26.0');
    expect(h).toContain('3.5.1');
    expect(h).toContain('standard-zirconia');
  });

  it('renders the error-bounds block with the f32 narrowing bound', () => {
    const h = html();
    expect(h).toContain('4.76837158203125e-7');
    expect(h).toContain('12.500 mm');
  });

  it('prominently flags the acknowledgment section with the journal ref', () => {
    const h = html();
    expect(h).toContain('ack-op-7');
    expect(h).toMatch(/class="[^"]*ack-section/);
  });

  it('states the outer-envelope CERTIFICATION (schemaVersion 2 — the T4-F2 closure)', () => {
    // A release document now certifies the outer envelope; the renderer shows
    // the positive certification (green section), not the old disclosure.
    expect(html()).toContain('outer'); // the certification text names the outer envelope
    expect(html()).toMatch(/CERTIFIED/);
    expect(html()).toMatch(/class="[^"]*cert-ok-section/);
    expect(html()).not.toMatch(/NOT\s+CERTIFIED/i);
  });

  it('a PREVIEW still renders the honest non-certification disclosure', () => {
    const h = renderTraceabilityHtml(previewDoc(), { locale: 'en' });
    expect(h).toContain('outer');
    expect(h).toMatch(/not\s+certif/i);
  });

  it('has NO watermark and NO releasedAt line unless the envelope is passed', () => {
    const h = html();
    expect(h).not.toMatch(/PREVIEW/);
    expect(h).not.toContain('2026-');
  });

  it('renders a passed releasedAt ONLY as the labeled non-hashed record envelope', () => {
    const h = renderTraceabilityHtml(releaseDoc(), {
      locale: 'en',
      releasedAt: '2026-07-19T10:00:00.000Z',
    });
    expect(h).toContain('2026-07-19T10:00:00.000Z');
    expect(h).toMatch(/not part of the hashed document/i);
  });
});

describe('renderTraceabilityHtml — fallbacks and failing reports', () => {
  it('a failing UNACKNOWLEDGED gate renders the fail status + failing summary (preview of a failing report)', () => {
    const input = previewInputFixture();
    const doc = buildPreviewTraceabilityDocument({
      ...input,
      report: {
        ...input.report,
        passed: false,
        gates: [
          ...input.report.gates,
          {
            gate: 'marginFit',
            passed: false,
            acknowledged: false,
            value: 0.12,
            threshold: 0.05,
            unit: 'mm',
            message: 'margin gap too large',
          },
        ],
      },
    });
    const html = renderTraceabilityHtml(doc, { locale: 'en' });
    expect(html).toContain('summary-fail');
    expect(html).toContain('status-fail');
    expect(html).toContain('0.120 mm (120 µm)');
  });

  it('an unknown gate id falls back to the raw id; an unknown limitation code falls back to its statement', () => {
    const input = releaseInputFixture();
    const doc = {
      ...buildReleaseTraceabilityDocument({
        ...input,
        serverReport: {
          ...input.serverReport,
          gates: [
            { ...input.serverReport.gates[0]!, gate: 'someFutureGate' },
            ...input.serverReport.gates.slice(1),
          ],
        },
      }),
      certification: {
        outerEnvelopeCertified: false as const,
        limitations: [{ code: 'some-future-limitation', statement: 'future statement text' }],
      },
    };
    const html = renderTraceabilityHtml(doc, { locale: 'en' });
    expect(html).toContain('someFutureGate');
    expect(html).toContain('future statement text');
  });
});

describe('renderTraceabilityHtml — preview', () => {
  it('watermarks the preview and renders no release-evidence hashes', () => {
    const h = renderTraceabilityHtml(previewDoc(), { locale: 'en' });
    expect(h).toContain('PREVIEW');
    expect(h).not.toContain(fakeHash('bb'));
  });

  it('refuses a releasedAt envelope on a preview (a preview is not a release record)', () => {
    expect(() =>
      renderTraceabilityHtml(previewDoc(), {
        locale: 'en',
        releasedAt: '2026-07-19T10:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('renderTraceabilityHtml — i18n ×4', () => {
  it('renders all four locales with their own localized title + watermark', () => {
    const titles = new Map<string, string>();
    for (const locale of TRACEABILITY_LOCALES) {
      const release = renderTraceabilityHtml(releaseDoc(), { locale });
      expect(release).toContain(`lang="${locale}"`);
      const match = release.match(/<title>([^<]+)<\/title>/);
      expect(match, `title in ${locale}`).not.toBeNull();
      titles.set(locale, match![1]!);
      const preview = renderTraceabilityHtml(previewDoc(), { locale });
      expect(preview.length).toBeGreaterThan(0);
    }
    // The four titles are genuinely translated (pairwise distinct).
    expect(new Set(titles.values()).size).toBe(4);
  });

  it('uses the established Hungarian clinical terminology', () => {
    const h = renderTraceabilityHtml(releaseDoc(), { locale: 'hu' });
    expect(h).toContain('Minőségellenőrzés'); // QC (the established client term)
    expect(h).toContain('Vízzáró'); // watertight
    expect(h).toContain('falvastagság'); // wall thickness
    expect(h).toContain('Tudomásul'); // acknowledged family
  });
});
