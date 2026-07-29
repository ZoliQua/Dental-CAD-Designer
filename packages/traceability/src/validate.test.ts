// packages/traceability/src/validate.test.ts
//
// Phase 7 Task 5 — the schema validator over shared-types'
// QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA (the acceptance criterion:
// "generation validates against it"). Positive cases for both document
// kinds, then FALSIFIABLE negatives: every rejection is proven by mutating
// a valid document one field at a time.
import { describe, expect, it } from 'vitest';
import type { QcTraceabilityDocument } from '@dqcad/shared-types';
import { buildPreviewTraceabilityDocument, buildReleaseTraceabilityDocument } from './document.ts';
import { previewInputFixture, releaseInputFixture } from './fixtures.testutil.ts';
import {
  TraceabilityDocumentValidationError,
  assertValidTraceabilityDocument,
  validateTraceabilityDocument,
} from './validate.ts';

function releaseDoc(): QcTraceabilityDocument {
  return buildReleaseTraceabilityDocument(releaseInputFixture());
}

/** A structurally-mutable deep copy (tests only). */
function mutable(doc: QcTraceabilityDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

describe('validateTraceabilityDocument — positives', () => {
  it('accepts a built release document', () => {
    expect(validateTraceabilityDocument(releaseDoc())).toEqual({ valid: true });
  });

  it('accepts a built preview document', () => {
    expect(
      validateTraceabilityDocument(buildPreviewTraceabilityDocument(previewInputFixture())),
    ).toEqual({
      valid: true,
    });
  });

  it('assertValidTraceabilityDocument returns silently on a valid document', () => {
    expect(() => assertValidTraceabilityDocument(releaseDoc())).not.toThrow();
  });
});

describe('validateTraceabilityDocument — falsifiable negatives', () => {
  function expectInvalid(doc: unknown, why: string): void {
    const result = validateTraceabilityDocument(doc);
    expect(result.valid, why).toBe(false);
    if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
  }

  it('rejects a wrong schemaVersion', () => {
    const doc = mutable(releaseDoc());
    doc['schemaVersion'] = 3;
    expectInvalid(doc, 'schemaVersion 3 is not this schema (current is 2)');
  });

  it('rejects an unknown extra field (a regulatory record carries no unaudited fields)', () => {
    const doc = mutable(releaseDoc());
    doc['smuggled'] = 'x';
    expectInvalid(doc, 'additionalProperties must be rejected');
  });

  it('rejects a RELEASE document missing its evidence sections (null exportFile/journal/…)', () => {
    for (const section of [
      'exportFile',
      'journal',
      'reimportVerification',
      'errorBounds',
    ] as const) {
      const doc = mutable(releaseDoc());
      doc[section] = null;
      expectInvalid(doc, `release with null ${section}`);
    }
  });

  it('rejects a RELEASE document with a null manifoldVersion', () => {
    const doc = mutable(releaseDoc());
    (doc['versions'] as Record<string, unknown>)['manifoldVersion'] = null;
    expectInvalid(doc, 'release must carry the installed manifold-3d version');
  });

  it('rejects a PREVIEW document carrying release evidence', () => {
    const release = mutable(releaseDoc());
    release['documentKind'] = 'preview';
    // Still carries exportFile/journal/... objects — forbidden for a preview.
    expectInvalid(release, 'preview must not carry release evidence');
  });

  it('schemaVersion 2: a RELEASE must certify the outer envelope (const true) — false is schema-invalid', () => {
    // The T4-F2 closure: a release document can only exist after the step-10.5
    // assertion passes, so the schema pins `outerEnvelopeCertified: const true`
    // for a release. Un-certifying it (back to false) is now schema-invalid —
    // the mirror of the old schemaVersion-1 `const false` discipline.
    const doc = mutable(releaseDoc());
    (doc['certification'] as Record<string, unknown>)['outerEnvelopeCertified'] = false;
    expectInvalid(doc, 'a release cannot be uncertified within schemaVersion 2');
  });

  it('schemaVersion 2: a PREVIEW must NOT certify the outer envelope (const false) — true is schema-invalid', () => {
    const preview = mutable(
      buildPreviewTraceabilityDocument(previewInputFixture()) as QcTraceabilityDocument,
    );
    (preview['certification'] as Record<string, unknown>)['outerEnvelopeCertified'] = true;
    expectInvalid(preview, 'a preview certifies nothing — it cannot claim the outer envelope');
  });

  it('S2 (preview): a preview whose limitations DROP the outer-envelope disclosure is schema-invalid', () => {
    // The S2 discipline moves to the PREVIEW branch at schemaVersion 2: a
    // preview must carry the disclosure (it certifies nothing). A RELEASE,
    // which certifies the envelope, legitimately carries an EMPTY limitations
    // list — asserted valid alongside.
    const releaseEmpty = mutable(releaseDoc());
    (releaseEmpty['certification'] as Record<string, unknown>)['limitations'] = [];
    expect(validateTraceabilityDocument(releaseEmpty)).toEqual({ valid: true });

    const previewEmpty = mutable(
      buildPreviewTraceabilityDocument(previewInputFixture()) as QcTraceabilityDocument,
    );
    (previewEmpty['certification'] as Record<string, unknown>)['limitations'] = [];
    expectInvalid(previewEmpty, 'a preview without the disclosure is invalid');
    // A preview that SWAPS the disclosure for something else is equally invalid.
    const previewSwapped = mutable(
      buildPreviewTraceabilityDocument(previewInputFixture()) as QcTraceabilityDocument,
    );
    (previewSwapped['certification'] as Record<string, unknown>)['limitations'] = [
      { code: 'some-other-limitation', statement: 'anything but the outer-envelope disclosure' },
    ];
    expectInvalid(previewSwapped, 'the outer-envelope-not-certified code is required on a preview');
  });

  it('rejects malformed hashes, empty gate lists, and non-FDI teeth', () => {
    const badHash = mutable(releaseDoc());
    (badHash['exportFile'] as Record<string, unknown>)['bytesSha256'] = 'not-a-hash';
    expectInvalid(badHash, 'bytesSha256 must be 64-hex');

    const noGates = mutable(releaseDoc());
    (noGates['qc'] as Record<string, unknown>)['gates'] = [];
    expectInvalid(noGates, 'a report with zero gates is not a QC record');

    const badTooth = mutable(releaseDoc());
    (badTooth['identity'] as Record<string, unknown>)['teeth'] = [19];
    expectInvalid(badTooth, '19 is not an FDI code');
  });

  it('rejects non-object junk', () => {
    expectInvalid(null, 'null');
    expectInvalid('{}', 'a string is not a document');
    expectInvalid(42, 'a number is not a document');
  });

  it('assertValidTraceabilityDocument throws the typed error with the ajv paths', () => {
    const doc = mutable(releaseDoc());
    doc['exportFile'] = null;
    try {
      assertValidTraceabilityDocument(doc);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TraceabilityDocumentValidationError);
      expect((error as TraceabilityDocumentValidationError).errors.join('\n')).toContain(
        'exportFile',
      );
    }
  });
});
