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
    doc['schemaVersion'] = 2;
    expectInvalid(doc, 'schemaVersion 2 is not this schema');
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

  it('rejects a flipped outer-envelope certification (schema-pinned false)', () => {
    const doc = mutable(releaseDoc());
    (doc['certification'] as Record<string, unknown>)['outerEnvelopeCertified'] = true;
    expectInvalid(doc, 'outerEnvelopeCertified cannot flip to true within schemaVersion 1');
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
