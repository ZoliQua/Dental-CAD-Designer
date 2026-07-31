// apps/client/src/engine/diagnosticBundle.no-phi.test.ts
//
// Phase 8 Task 5 — THE NO-PHI ACCEPTANCE (falsifiable).
//
// Build a diagnostic bundle for a case seeded with synthetic patient-identifying
// data + scan-content markers, and assert NONE of those markers appear anywhere
// in the SERIALIZED bundle bytes (assert on the output, not the intent). The
// allowlist builder copies only `id` + journal HASH + counts, so a PHI field is
// excluded BY CONSTRUCTION — not scrubbed.
//
// Falsifiability (proves the detector is not vacuous): the SAME marker placed
// into an allowlisted path (the error message) IS found by the same substring
// scan — so the "absent" assertions above are meaningful.
import { describe, expect, it } from 'vitest';
import type { CaseDocument, Operation } from '@dqcad/shared-types';
import {
  buildDiagnosticBundle,
  serializeDiagnosticBundle,
  type DiagnosticBundleEnvironment,
} from './diagnosticBundle';

// Distinctive synthetic PHI markers — none of these may ever reach the bundle.
const PHI_PATIENT_REF = 'PATIENT-Jane-Doe-SSN-123-45-6789';
const PHI_MESH_NAME = 'jane-doe-mandible-scan.stl';
const PHI_CASE_NAME = 'Jane Doe — molar 26';
const PHI_JOURNAL_PARAM = 'Jane-Doe-birthdate-1985-01-01';
const PHI_SCAN_VERTEX_MARKER = 'VERTEX-BLOB-9e8d7c6b5a';

const ENV: DiagnosticBundleEnvironment = {
  userAgent: 'Mozilla/5.0 (Test)',
  language: 'en-US',
  platform: 'TestOS',
};

function phiCaseDocument(): CaseDocument {
  const op: Operation = {
    id: 'op-1',
    name: 'crown-inner-surface',
    // Even if a journal param carried PHI, only the HASH of the journal is
    // emitted — this marker must not survive into the bundle.
    params: { note: PHI_JOURNAL_PARAM, gapMm: 0.03 },
    inputHashes: ['aa'],
    outputHashes: ['bb'],
    kernelVersion: '0.26.0',
    timestamp: '2026-07-22T00:00:00.000Z',
  };
  return {
    id: 'c0ffee00-1111-2222-3333-444455556666',
    schemaVersion: 2,
    createdAt: '2026-07-22T00:00:00.000Z',
    // A patient-identifying external ref — PHI-class, must never be included.
    patientRef: PHI_PATIENT_REF,
    meshes: [
      {
        id: 'm1',
        contentHash: 'deadbeef',
        // Scanner filenames routinely carry patient names — PHI-class.
        name: PHI_MESH_NAME,
        unit: 'mm',
        triangleCount: 1234,
        fileHash: 'f00d',
        // A synthetic "scan geometry" marker stashed on the asset — a naive
        // whole-document serializer would leak it; the allowlist never reads it.
        ...({ scanBlob: PHI_SCAN_VERTEX_MARKER } as Record<string, unknown>),
      },
    ],
    scene: [],
    restorations: [
      {
        id: 'r1',
        type: 'crown',
        teeth: [26],
        pontics: [],
        targetNodeId: null,
        marginLines: {},
        insertionAxis: [0, 0, 1],
        params: {
          cementGapMm: 0.03,
          marginalGapMm: 0.01,
          spacerStartMm: 0.5,
          minWallThicknessMm: 0.5,
          proximalContactPenetrationMm: 0.05,
          occlusalContactMm: 0.02,
        },
        stages: {},
        qc: null,
      },
    ],
    measurements: [],
    history: [op],
    // A case NAME sometimes carries patient identity — stashed here to prove the
    // builder never reaches settings content either.
    settings: {
      materialProfileId: 'zirconia',
      profileVersion: '1.4.0',
      ...({ caseName: PHI_CASE_NAME } as Record<string, unknown>),
    },
  };
}

const ALL_PHI_MARKERS = [
  PHI_PATIENT_REF,
  PHI_MESH_NAME,
  PHI_CASE_NAME,
  PHI_JOURNAL_PARAM,
  PHI_SCAN_VERTEX_MARKER,
];

describe('diagnosticBundle — NO PHI (acceptance)', () => {
  it('the serialized bundle contains none of the seeded PHI markers', async () => {
    const bundle = await buildDiagnosticBundle({
      error: { name: 'RangeError', message: 'index out of range', stack: 'at foo (x.ts:1:1)' },
      caseDocument: phiCaseDocument(),
      environment: ENV,
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    });
    const serialized = serializeDiagnosticBundle(bundle);
    for (const marker of ALL_PHI_MARKERS) {
      expect(serialized, `PHI marker leaked: ${marker}`).not.toContain(marker);
    }
    // What IS present: the case UUID, a journal hash, and sizes — never content.
    expect(bundle.case.id).toBe('c0ffee00-1111-2222-3333-444455556666');
    expect(bundle.case.journalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.case.journalOperationCount).toBe(1);
    expect(bundle.case.restorationCount).toBe(1);
  });

  it('falsifiability: PHI in an ALLOWLISTED path (error message) IS caught by the same scan', async () => {
    const bundle = await buildDiagnosticBundle({
      error: { name: 'Error', message: `failed near ${PHI_PATIENT_REF}`, stack: null },
      caseDocument: phiCaseDocument(),
      environment: ENV,
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    });
    const serialized = serializeDiagnosticBundle(bundle);
    // The substring scan really works — so the "absent" assertions above mean
    // something. (This is why the error message must itself be reviewed as
    // developer-technical text, never a place to echo raw case content.)
    expect(serialized).toContain(PHI_PATIENT_REF);
  });

  it('a null case yields a PHI-free, well-formed bundle (nothing to leak)', async () => {
    const bundle = await buildDiagnosticBundle({
      error: null,
      caseDocument: null,
      environment: ENV,
      now: () => '2026-07-22T12:00:00.000Z',
      log: [],
    });
    expect(bundle.case).toEqual({
      id: null,
      journalHash: null,
      journalOperationCount: 0,
      restorationCount: 0,
    });
  });
});
