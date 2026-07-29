// packages/traceability/src/document.test.ts
//
// Phase 7 Task 5 — the traceability document BUILDERS: pure functions from
// release/preview inputs to `QcTraceabilityDocument`, and the canonical
// byte-stable serialization (the determinism/timestamp policy of
// shared-types/src/traceability.ts's module doc, tested falsifiably).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OUTER_ENVELOPE_LIMITATION,
  ReleaseTraceabilityInputError,
  buildPreviewTraceabilityDocument,
  buildReleaseTraceabilityDocument,
  serializeTraceabilityDocument,
} from './document.ts';
import { fakeHash, previewInputFixture, releaseInputFixture } from './fixtures.testutil.ts';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('buildReleaseTraceabilityDocument', () => {
  it('assembles the release document from the server-side inputs', () => {
    const doc = buildReleaseTraceabilityDocument(releaseInputFixture());
    expect(doc.schemaVersion).toBe(1);
    expect(doc.documentKind).toBe('release');
    expect(doc.identity).toEqual({
      caseId: 'case-fixture-1',
      restorationId: 'resto-fixture-1',
      restorationType: 'crown',
      teeth: [16],
    });
    // The QC block is the SERVER report, gate results verbatim.
    expect(doc.qc.passed).toBe(true);
    expect(doc.qc.kernelVersion).toBe('0.26.0');
    expect(doc.qc.profileVersion).toBe('1.4.0');
    expect(doc.qc.finalMeshContentHash).toBe(fakeHash('aa'));
    expect(doc.qc.gates).toEqual(releaseInputFixture().serverReport.gates);
    expect(doc.acknowledgments).toHaveLength(1);
    expect(doc.acknowledgments[0]?.operationId).toBe('ack-op-7');
    expect(doc.materialProfile.checksum).toBe(fakeHash('cc'));
    expect(doc.versions).toEqual({ kernelVersion: '0.26.0', manifoldVersion: '3.5.1' });
    expect(doc.exportFile).toEqual({
      format: 'stl',
      bytesSha256: fakeHash('bb'),
      byteLength: 684,
      meshContentHash: fakeHash('aa'),
      headerText: 'DQ-Dental-CAD; units=mm; crown 16',
    });
    expect(doc.journal).toEqual({
      caseJournalHash: fakeHash('dd'),
      journalOperationCount: 12,
      exportOperationId: 'export-op-1',
    });
    expect(doc.reimportVerification).toEqual({
      reimportMeshHash: fakeHash('ee'),
      meshHashRelation: 'stl-canonical-reindex-f32-narrowing',
      gateResultIdentity: true,
    });
    expect(doc.errorBounds).toEqual({
      f32Narrowing: {
        basis: 'analytic-half-ulp-at-max-coordinate',
        maxAbsCoordinateMm: 12.5,
        halfUlpBoundMm: 4.76837158203125e-7,
      },
      gateBoundsCarriedInGateResults: true,
    });
    // The honest non-certification disclosure (T4 known limitation).
    expect(doc.certification.outerEnvelopeCertified).toBe(false);
    expect(doc.certification.limitations).toEqual([OUTER_ENVELOPE_LIMITATION]);
  });

  it('derives the PLY lossless relation and requires null narrowing/headerText for PLY', () => {
    const input = releaseInputFixture();
    const doc = buildReleaseTraceabilityDocument({
      ...input,
      exportFile: { ...input.exportFile, format: 'ply', headerText: null },
      f32Narrowing: null,
    });
    expect(doc.reimportVerification?.meshHashRelation).toBe('ply-lossless-identity');
    expect(doc.errorBounds?.f32Narrowing).toBeNull();
  });

  it('refuses inconsistent format/narrowing/header combinations (typed error)', () => {
    const input = releaseInputFixture();
    // STL without a narrowing bound: the format narrows — omitting the bound
    // would silently drop the documented precision floor.
    expect(() => buildReleaseTraceabilityDocument({ ...input, f32Narrowing: null })).toThrow(
      ReleaseTraceabilityInputError,
    );
    // STL without headerText (the journaled header is part of the record).
    expect(() =>
      buildReleaseTraceabilityDocument({
        ...input,
        exportFile: { ...input.exportFile, headerText: null },
      }),
    ).toThrow(ReleaseTraceabilityInputError);
    // PLY with a narrowing bound (the format is lossless — a bound would be a lie).
    expect(() =>
      buildReleaseTraceabilityDocument({
        ...input,
        exportFile: { ...input.exportFile, format: 'ply', headerText: null },
      }),
    ).toThrow(ReleaseTraceabilityInputError);
    // PLY with headerText (PLY has none).
    expect(() =>
      buildReleaseTraceabilityDocument({
        ...input,
        exportFile: { ...input.exportFile, format: 'ply' },
        f32Narrowing: null,
      }),
    ).toThrow(ReleaseTraceabilityInputError);
  });
});

describe('buildPreviewTraceabilityDocument', () => {
  it('assembles a preview with ALL release-evidence sections null', () => {
    const doc = buildPreviewTraceabilityDocument(previewInputFixture());
    expect(doc.documentKind).toBe('preview');
    expect(doc.exportFile).toBeNull();
    expect(doc.journal).toBeNull();
    expect(doc.reimportVerification).toBeNull();
    expect(doc.errorBounds).toBeNull();
    expect(doc.versions.manifoldVersion).toBeNull();
    expect(doc.qc.gates).toEqual(previewInputFixture().report.gates);
    expect(doc.certification.outerEnvelopeCertified).toBe(false);
  });
});

describe('serializeTraceabilityDocument — the deterministic core', () => {
  it('same release ⇒ bit-identical JSON (two independent builds)', () => {
    const a = serializeTraceabilityDocument(
      buildReleaseTraceabilityDocument(releaseInputFixture()),
    );
    const b = serializeTraceabilityDocument(
      buildReleaseTraceabilityDocument(releaseInputFixture()),
    );
    expect(a).toBe(b);
  });

  it('is key-order independent (canonical JSON)', () => {
    const doc = buildReleaseTraceabilityDocument(releaseInputFixture());
    // Rebuild the document with reversed key insertion order — the
    // serialization must not care.
    const reversed = Object.fromEntries(Object.entries(doc).reverse()) as typeof doc;
    expect(serializeTraceabilityDocument(reversed)).toBe(serializeTraceabilityDocument(doc));
  });

  it('carries ZERO timestamps — no ISO-8601 value anywhere in the serialized document', () => {
    // The falsifiable form of the timestamp policy: no field value looks
    // like a date/time. (A field NAMED like a timestamp would also be a
    // schema violation — additionalProperties: false — but this catches a
    // timestamp smuggled into any string field too.)
    const json = serializeTraceabilityDocument(
      buildReleaseTraceabilityDocument(releaseInputFixture()),
    );
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(json).not.toMatch(/releasedAt|createdAt|timestamp/i);
  });

  it('byte pin: the synthetic release document serializes to pinned bytes', () => {
    // The package-level determinism pin (kernel-independent: every input is
    // analytic). Moves ONLY with a deliberate TRACEABILITY_SCHEMA_VERSION
    // bump / documented builder change. Filled from the first green run.
    const json = serializeTraceabilityDocument(
      buildReleaseTraceabilityDocument(releaseInputFixture()),
    );
    expect(sha256Hex(json)).toBe(
      '7140f6d70a92821fcb0490e65d3ce5cdfc0ad1e511f08fe4d91a16d94d800d24',
    );
  });
});
