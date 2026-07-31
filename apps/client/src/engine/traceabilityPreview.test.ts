// apps/client/src/engine/traceabilityPreview.test.ts
//
// Phase 7 Task 5 — the THIN client-side preview: the SAME shared builder +
// render function as the server release document (`@dqcad/traceability`),
// fed from the client's own pre-export QC report, watermarked PREVIEW.
// Node-lane pure tests (no worker, no DOM) — the P5-T8 engine-test pattern.
import { describe, expect, it } from 'vitest';
import type {
  CaseDocument,
  Operation,
  QcGateResult,
  QcReport,
  Restoration,
} from '@dqcad/shared-types';
import { validateTraceabilityDocument } from '@dqcad/traceability/validate';
import {
  STANDARD_ZIRCONIA_PROFILE,
  EMAX_LITHIUM_DISILICATE_PROFILE,
} from '@dqcad/clinical-profiles';
import { TRACEABILITY_LOCALES } from '@dqcad/traceability';
import {
  buildTraceabilityPreviewDocument,
  renderTraceabilityPreviewHtml,
  TraceabilityPreviewUnavailableError,
} from './traceabilityPreview';

const FINAL_MESH_HASH = 'a1'.repeat(32);

function gate(overrides: Partial<QcGateResult> & { gate: string }): QcGateResult {
  return {
    passed: true,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message: 'ok',
    ...overrides,
  };
}

function report(gates: QcGateResult[]): QcReport {
  return {
    gates,
    passed: gates.every((g) => g.passed || g.acknowledged),
    kernelVersion: '0.26.0',
    profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    journalHash: FINAL_MESH_HASH,
  };
}

function restoration(qc: QcReport | null): Restoration {
  return {
    id: 'resto-1',
    type: 'crown',
    teeth: [16],
    pontics: [],
    targetNodeId: null,
    marginLines: {},
    insertionAxis: [0, 0, 1],
    params: {
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.8,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    },
    stages: { finalMesh: FINAL_MESH_HASH },
    qc,
  };
}

function caseDocument(
  resto: Restoration,
  history: Operation[] = [],
  profileId?: string,
): CaseDocument {
  return {
    id: 'case-1',
    schemaVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    meshes: [],
    scene: [],
    restorations: [resto],
    measurements: [],
    history,
    settings: {
      materialProfileId: profileId ?? STANDARD_ZIRCONIA_PROFILE.id,
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    },
  };
}

const ackOp: Operation = {
  id: 'ack-op-1',
  name: 'crown-qc-ack',
  params: { restorationId: 'resto-1', acknowledgedGate: 'seating', acknowledgedGates: ['seating'] },
  inputHashes: [FINAL_MESH_HASH],
  outputHashes: [],
  kernelVersion: '0.26.0',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('buildTraceabilityPreviewDocument', () => {
  it('builds a schema-valid PREVIEW document from the restoration snapshot', () => {
    const qc = report([gate({ gate: 'watertight' })]);
    const doc = buildTraceabilityPreviewDocument(caseDocument(restoration(qc)), 'resto-1');
    expect(validateTraceabilityDocument(doc)).toEqual({ valid: true });
    expect(doc.documentKind).toBe('preview');
    expect(doc.identity).toEqual({
      caseId: 'case-1',
      restorationId: 'resto-1',
      restorationType: 'crown',
      teeth: [16],
    });
    expect(doc.qc.gates).toEqual(qc.gates);
    expect(doc.qc.finalMeshContentHash).toBe(FINAL_MESH_HASH);
    // No release evidence exists pre-export — all four sections null, no
    // client-side manifold claim.
    expect(doc.exportFile).toBeNull();
    expect(doc.journal).toBeNull();
    expect(doc.reimportVerification).toBeNull();
    expect(doc.errorBounds).toBeNull();
    expect(doc.versions.manifoldVersion).toBeNull();
    // Safe-by-construction invariant (the reason the client preview renders
    // WITHOUT an ajv schema check — see traceabilityPreview.ts's module doc): a
    // preview certifies NOTHING and always carries the outer-envelope
    // disclosure. The builder hardcodes these, so no invariant-violating preview
    // shape is reachable to render.
    expect(doc.certification.outerEnvelopeCertified).toBe(false);
    expect(doc.certification.limitations.map((l) => l.code)).toContain(
      'outer-envelope-not-certified',
    );
  });

  it('resolves the material profile identity like the export request does (settings id, zirconia fallback)', () => {
    const qc = report([gate({ gate: 'watertight' })]);
    const emax = buildTraceabilityPreviewDocument(
      caseDocument(restoration(qc), [], EMAX_LITHIUM_DISILICATE_PROFILE.id),
      'resto-1',
    );
    expect(emax.materialProfile.id).toBe(EMAX_LITHIUM_DISILICATE_PROFILE.id);
    expect(emax.materialProfile.checksum).toBe(EMAX_LITHIUM_DISILICATE_PROFILE.checksum);
    const fallback = buildTraceabilityPreviewDocument(
      caseDocument(restoration(qc), [], 'unknown-profile'),
      'resto-1',
    );
    expect(fallback.materialProfile.id).toBe(STANDARD_ZIRCONIA_PROFILE.id);
  });

  it('carries acknowledged gates with their journal refs (collectAcknowledgments)', () => {
    const qc = report([
      gate({ gate: 'watertight' }),
      gate({
        gate: 'seating',
        passed: false,
        acknowledged: true,
        value: 0.002,
        threshold: 0.001,
        unit: 'mm³',
        message: 'interference',
      }),
    ]);
    const doc = buildTraceabilityPreviewDocument(caseDocument(restoration(qc), [ackOp]), 'resto-1');
    expect(doc.acknowledgments).toHaveLength(1);
    expect(doc.acknowledgments[0]).toMatchObject({ gate: 'seating', operationId: 'ack-op-1' });
  });

  it('refuses (typed) when the restoration is missing or has no QC report', () => {
    const qc = report([gate({ gate: 'watertight' })]);
    expect(() => buildTraceabilityPreviewDocument(caseDocument(restoration(qc)), 'nope')).toThrow(
      TraceabilityPreviewUnavailableError,
    );
    expect(() =>
      buildTraceabilityPreviewDocument(caseDocument(restoration(null)), 'resto-1'),
    ).toThrow(TraceabilityPreviewUnavailableError);
  });
});

describe('renderTraceabilityPreviewHtml', () => {
  it('renders the SAME shared HTML with the PREVIEW watermark, all four locales', () => {
    const qc = report([
      gate({ gate: 'minWallThickness', value: 0.612, threshold: 0.5, unit: 'mm' }),
    ]);
    const doc = caseDocument(restoration(qc));
    for (const locale of TRACEABILITY_LOCALES) {
      const html = renderTraceabilityPreviewHtml(doc, 'resto-1', locale);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain('preview-watermark');
      // The shared renderer's µm display convention rides through.
      expect(html).toContain('0.612 mm (612 µm)');
    }
    // The watermark label itself is localized (EN vs HU differ).
    expect(renderTraceabilityPreviewHtml(doc, 'resto-1', 'en')).toContain('PREVIEW');
    expect(renderTraceabilityPreviewHtml(doc, 'resto-1', 'hu')).toContain('ELŐNÉZET');
  });
});
