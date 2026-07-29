// apps/server/src/export-profile.test.ts
//
// Unit tests for the F1 fix-round profile pinning (export-profile.ts):
// registry resolution + checksum verification, and the per-branch
// threshold-authority map (crown params-authority, inlay/onlay type-branched
// bands, bridge positional connector targets + pontic-relief style map).
// The endpoint-level exploit regression (the reviewer's 295 µm / 0.05 attack)
// lives in export-endpoint.test.ts.
import { describe, expect, it } from 'vitest';
import {
  EMAX_LITHIUM_DISILICATE_PROFILE,
  STANDARD_ZIRCONIA_PROFILE,
} from '@dqcad/clinical-profiles';
import type { FdiTooth, Restoration, RestorationExportRequest } from '@dqcad/shared-types';
import {
  resolveExportMaterialProfile,
  verifyProfileThresholds,
  KNOWN_MATERIAL_PROFILES,
} from './export-profile.js';
import { ExportRejectionError } from './export-validation.js';
import type { BridgeExportQcContext, CrownExportQcContext, InlayExportQcContext } from './export-route.js';

const ZR = STANDARD_ZIRCONIA_PROFILE;

function rejectionOf(fn: () => unknown): ExportRejectionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExportRejectionError) return error;
    throw error;
  }
  throw new Error('expected an ExportRejectionError, nothing was thrown');
}

describe('resolveExportMaterialProfile', () => {
  it('resolves every shipped registry profile by its own identity', () => {
    for (const p of KNOWN_MATERIAL_PROFILES) {
      expect(resolveExportMaterialProfile({ id: p.id, version: p.version, checksum: p.checksum })).toBe(p);
    }
  });

  it('unknown id → export-material-profile-unknown with the known list', () => {
    const err = rejectionOf(() =>
      resolveExportMaterialProfile({ id: 'nope', version: '1.0.0', checksum: 'a'.repeat(64) }),
    );
    expect(err.code).toBe('export-material-profile-unknown');
    expect((err.details['known'] as unknown[]).length).toBe(KNOWN_MATERIAL_PROFILES.length);
  });

  it('unknown VERSION of a known id → export-material-profile-unknown', () => {
    const err = rejectionOf(() =>
      resolveExportMaterialProfile({ id: ZR.id, version: '0.0.1', checksum: ZR.checksum }),
    );
    expect(err.code).toBe('export-material-profile-unknown');
  });

  it('wrong checksum → export-material-profile-checksum-mismatch naming both checksums', () => {
    const err = rejectionOf(() =>
      resolveExportMaterialProfile({ id: ZR.id, version: ZR.version, checksum: 'b'.repeat(64) }),
    );
    expect(err.code).toBe('export-material-profile-checksum-mismatch');
    expect(err.details['resolvedChecksum']).toBe(ZR.checksum);
    expect(err.details['requestChecksum']).toBe('b'.repeat(64));
  });
});

// --- verifyProfileThresholds ------------------------------------------------

const RESTO: Restoration = {
  id: 'r1',
  type: 'crown',
  teeth: [11 as FdiTooth],
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
  stages: {},
  qc: null,
};

function req(restorationType: RestorationExportRequest['restorationType']): RestorationExportRequest {
  return { restorationType } as RestorationExportRequest;
}

const meshStub = { positions: [], indices: [] };

describe('verifyProfileThresholds — crown', () => {
  const ctx = (over?: Partial<CrownExportQcContext>): CrownExportQcContext => ({
    innerSurfaceMesh: meshStub,
    outerSurfaceMesh: meshStub,
    dieSolid: meshStub,
    marginResampledPoints: [],
    insertionAxis: [0, 0, 1],
    minWallThicknessMm: RESTO.params.minWallThicknessMm,
    occlusalMinWallThicknessMm: ZR.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: ZR.connectorAreaMm2.anteriorMm2,
    contacts: [],
    contactClampWarning: false,
    marginExclusionMm: ZR.marginExclusionMm,
    ...over,
  });

  it('accepts the client-rule values (params wall minimum + profile constants)', () => {
    expect(() => verifyProfileThresholds(req('crown'), ctx(), ZR, RESTO)).not.toThrow();
  });

  it('accepts an ABSENT optional marginExclusionMm (both sides use the gate default — never a loosening)', () => {
    expect(() =>
      verifyProfileThresholds(req('crown'), ctx({ marginExclusionMm: undefined }), ZR, RESTO),
    ).not.toThrow();
  });

  it('collects EVERY mismatching field with riding + resolved values', () => {
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('crown'),
        ctx({ minWallThicknessMm: 0.05, occlusalMinWallThicknessMm: 0.05, marginExclusionMm: 99 }),
        ZR,
        RESTO,
      ),
    );
    expect(err.code).toBe('export-profile-threshold-mismatch');
    const mismatches = err.details['mismatches'] as { field: string; riding: unknown; resolved: unknown }[];
    expect(mismatches.map((m) => m.field).sort()).toEqual([
      'marginExclusionMm',
      'minWallThicknessMm',
      'occlusalMinWallThicknessMm',
    ]);
    expect(mismatches.find((m) => m.field === 'minWallThicknessMm')).toEqual({
      field: 'minWallThicknessMm',
      riding: 0.05,
      resolved: 0.5,
    });
  });

  it('the crown wall authority is the SAVED restoration parameter, not the profile', () => {
    const customResto: Restoration = { ...RESTO, params: { ...RESTO.params, minWallThicknessMm: 0.7 } };
    expect(() =>
      verifyProfileThresholds(req('crown'), ctx({ minWallThicknessMm: 0.7 }), ZR, customResto),
    ).not.toThrow();
    const err = rejectionOf(() =>
      verifyProfileThresholds(req('crown'), ctx({ minWallThicknessMm: 0.5 }), ZR, customResto),
    );
    expect((err.details['mismatches'] as { field: string }[])[0]!.field).toBe('minWallThicknessMm');
  });
});

describe('verifyProfileThresholds — inlay/onlay', () => {
  const EX = EMAX_LITHIUM_DISILICATE_PROFILE;
  const ctx = (over?: Partial<InlayExportQcContext>): InlayExportQcContext => ({
    fitSurfaceMesh: meshStub,
    patchMesh: meshStub,
    toothWithCavitySolid: meshStub,
    cavityOutlineResampledPoints: [],
    insertionAxis: [0, 0, 1],
    thicknessMinimums: { inlayMinThicknessMm: EX.inlayMinThicknessMm, onlayMinThicknessMm: EX.onlayMinThicknessMm },
    marginExclusionMm: EX.inlayMarginExclusionMm,
    seamEdges: [],
    cavityTriangleIndices: [],
    contacts: [],
    contactClampWarning: false,
    ...over,
  });

  it('accepts the inlay band; the ONLAY band is type-branched', () => {
    expect(() => verifyProfileThresholds(req('inlay'), ctx(), EX, RESTO)).not.toThrow();
    expect(() =>
      verifyProfileThresholds(req('onlay'), ctx({ marginExclusionMm: EX.onlayMarginExclusionMm }), EX, RESTO),
    ).not.toThrow();
    // The INLAY band riding on an ONLAY request is a mismatch (1.3 ≠ 1.8).
    const err = rejectionOf(() => verifyProfileThresholds(req('onlay'), ctx(), EX, RESTO));
    expect((err.details['mismatches'] as { field: string }[])[0]!.field).toBe('marginExclusionMm');
  });

  it('rejects loosened thickness minimums and cusp-coverage minimum', () => {
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('onlay'),
        ctx({
          marginExclusionMm: EX.onlayMarginExclusionMm,
          thicknessMinimums: { inlayMinThicknessMm: 0.01, onlayMinThicknessMm: 0.01 },
          coverage: {
            coverageDivider: { pointMm: [0, 0, 0], normalMm: [0, 1, 0] },
            cuspCoverageMinThicknessMm: 0.01,
          },
        }),
        EX,
        RESTO,
      ),
    );
    const fields = (err.details['mismatches'] as { field: string }[]).map((m) => m.field);
    expect(fields).toContain('thicknessMinimums.inlayMinThicknessMm');
    expect(fields).toContain('thicknessMinimums.onlayMinThicknessMm');
    expect(fields).toContain('coverage.cuspCoverageMinThicknessMm');
  });
});

describe('verifyProfileThresholds — bridge', () => {
  const ctx = (over?: Partial<BridgeExportQcContext>): BridgeExportQcContext => ({
    units: [],
    dieSolids: [],
    connectors: [],
    minWallThicknessMm: ZR.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: ZR.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: ZR.connectorAreaMm2.posteriorMm2,
    frameworkMinThicknessMm: ZR.frameworkMinThicknessMm,
    ponticRelief: { maxAbsDeviationMm: 0.0002, style: 'hygienic', configuredReliefMm: ZR.ponticHygienicClearanceMm },
    ...over,
  });

  it('accepts the client-rule bridge values (posterior target, hygienic relief)', () => {
    expect(() => verifyProfileThresholds(req('bridge'), ctx(), ZR, RESTO)).not.toThrow();
  });

  it('verifies per-connector positional targets via the FDI rule', () => {
    // 14–15 is posterior (9 mm²); riding an anterior 7 mm² target is a mismatch.
    const good = ctx({
      connectors: [{ label: 'c', minAreaMm2: 12, teeth: [14, 15], targetMm2: ZR.connectorAreaMm2.posteriorMm2 }],
    });
    expect(() => verifyProfileThresholds(req('bridge'), good, ZR, RESTO)).not.toThrow();
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('bridge'),
        ctx({ connectors: [{ label: 'c', minAreaMm2: 12, teeth: [14, 15], targetMm2: 7 }] }),
        ZR,
        RESTO,
      ),
    );
    expect((err.details['mismatches'] as { field: string }[])[0]!.field).toBe('connectors[0].targetMm2');
  });

  it('a positional target WITHOUT its two teeth is unverifiable → mismatch', () => {
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('bridge'),
        ctx({ connectors: [{ label: 'c', minAreaMm2: 12, targetMm2: 9 }] }),
        ZR,
        RESTO,
      ),
    );
    expect((err.details['mismatches'] as { field: string; resolved: unknown }[])[0]).toEqual({
      field: 'connectors[0].targetMm2',
      riding: 9,
      resolved: null,
    });
  });

  it('a connector with NO riding target is fine (the gate falls back to the verified top-level target)', () => {
    expect(() =>
      verifyProfileThresholds(
        req('bridge'),
        ctx({ connectors: [{ label: 'c', minAreaMm2: 12, teeth: [14, 15] }] }),
        ZR,
        RESTO,
      ),
    ).not.toThrow();
  });

  it('maps every pontic-relief style to its profile field (ridgeLap/modifiedRidgeLap/ovate)', () => {
    for (const [style, resolved] of [
      ['ridgeLap', ZR.ponticRidgeLapReliefMm],
      ['modifiedRidgeLap', ZR.ponticRidgeLapReliefMm],
      ['ovate', ZR.ponticOvateDepthMm],
    ] as const) {
      expect(() =>
        verifyProfileThresholds(
          req('bridge'),
          ctx({ ponticRelief: { maxAbsDeviationMm: 0, style, configuredReliefMm: resolved } }),
          ZR,
          RESTO,
        ),
      ).not.toThrow();
      const err = rejectionOf(() =>
        verifyProfileThresholds(
          req('bridge'),
          ctx({ ponticRelief: { maxAbsDeviationMm: 0, style, configuredReliefMm: resolved + 1 } }),
          ZR,
          RESTO,
        ),
      );
      expect((err.details['mismatches'] as { field: string }[])[0]!.field).toBe('ponticRelief.configuredReliefMm');
    }
  });

  it('an UNKNOWN pontic style is unverifiable → mismatch naming the style', () => {
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('bridge'),
        ctx({ ponticRelief: { maxAbsDeviationMm: 0, style: 'floating', configuredReliefMm: 1 } }),
        ZR,
        RESTO,
      ),
    );
    expect((err.details['mismatches'] as { field: string; riding: unknown }[])[0]).toMatchObject({
      field: 'ponticRelief.style',
      riding: 'floating',
    });
  });

  it('rejects loosened bridge wall/connector/framework thresholds, all named', () => {
    const err = rejectionOf(() =>
      verifyProfileThresholds(
        req('bridge'),
        ctx({
          minWallThicknessMm: 0.01,
          occlusalMinWallThicknessMm: 0.01,
          connectorAreaTargetMm2: 0.01,
          frameworkMinThicknessMm: 0.01,
        }),
        ZR,
        RESTO,
      ),
    );
    const fields = (err.details['mismatches'] as { field: string }[]).map((m) => m.field).sort();
    expect(fields).toEqual([
      'connectorAreaTargetMm2',
      'frameworkMinThicknessMm',
      'minWallThicknessMm',
      'occlusalMinWallThicknessMm',
    ]);
  });
});
