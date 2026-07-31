// packages/cad-pipeline/src/gates/inlayReport.test.ts
//
// Phase 5 Task 6: the restoration-type-aware thickness-threshold SELECTION
// (`selectInlayMinThicknessMm`) — the NEW selection logic runInlayQc's min-wall
// gate rests on. The full coupled inlay QC run (all gates pass on the MOD
// fixture; seating clean; a shallow cavity BLOCKS) is exercised end-to-end on
// the canonical `modCavityMesh` in test/golden/inlay-shell-acceptance.test.ts
// (a cross-package import of @dqcad/kernel's own test fixture sits outside
// cad-pipeline's rootDir — the same constraint the cavity stage tests note).
import { describe, expect, it } from 'vitest';
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import { selectInlayMinThicknessMm, NonCavityRestorationTypeError, OnlayCoverageRequiredError, runInlayQc, type RunInlayQcInput } from './index.ts';

describe('selectInlayMinThicknessMm — restoration-type-aware threshold selection', () => {
  const mins = { inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.5 };
  it('selects the inlay minimum for an inlay', () => {
    expect(selectInlayMinThicknessMm('inlay', mins)).toBe(1.0);
  });
  it('selects the onlay minimum for an onlay', () => {
    expect(selectInlayMinThicknessMm('onlay', mins)).toBe(1.5);
  });
  it('throws NonCavityRestorationTypeError for a crown', () => {
    expect(() => selectInlayMinThicknessMm('crown', mins)).toThrow(NonCavityRestorationTypeError);
  });
  it('throws NonCavityRestorationTypeError for a bridge', () => {
    expect(() => selectInlayMinThicknessMm('bridge', mins)).toThrow(NonCavityRestorationTypeError);
  });
  it('throws TypeError for a missing/non-finite selected minimum', () => {
    expect(() => selectInlayMinThicknessMm('inlay', { inlayMinThicknessMm: NaN, onlayMinThicknessMm: 1 })).toThrow(TypeError);
    expect(() => selectInlayMinThicknessMm('onlay', { inlayMinThicknessMm: 1, onlayMinThicknessMm: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});

// MEDIUM (CONFIRMED): an onlay reaching runInlayQc WITHOUT its coverage input is
// a hard LOUD failure — the covered-cusp gate must NEVER be silently dropped
// (dual validation re-uses the client `coverage`, so both sides would omit the
// SAME gate and match). The guard runs BEFORE any measurement, so a dummy mesh
// suffices to prove the throw.
describe('runInlayQc — onlay without coverage is a LOUD failure (no silently-missing gate)', () => {
  const AXIS: Vec3 = [0, 0, 1];
  const dummyMesh: IndexedMesh = { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) };
  const baseInput = (restorationType: 'inlay' | 'onlay'): RunInlayQcInput => ({
    inlaySolid: dummyMesh,
    fitSurfaceMesh: dummyMesh,
    patchMesh: dummyMesh,
    toothWithCavitySolid: dummyMesh,
    cavityOutlineResampledPoints: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    insertionAxis: AXIS,
    restorationType,
    thicknessMinimums: { inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.5 },
    marginExclusionMm: 0.5,
    seamEdges: [],
    cavityTriangleIndices: new Set<number>(),
    contacts: [],
    contactClampWarning: false,
    kernelVersion: '9.9.9',
    profileVersion: '1.0.0',
    journalHash: 'deadbeef',
  });

  it('THROWS OnlayCoverageRequiredError for an onlay with no coverage (never a silent pass omitting the gate)', async () => {
    await expect(runInlayQc({ ...baseInput('onlay') /* coverage omitted */ })).rejects.toThrow(OnlayCoverageRequiredError);
  });

  it('an INLAY with no coverage does NOT hit the onlay coverage guard (it is onlay-scoped)', async () => {
    // An inlay legitimately omits coverage: the guard must not fire for it — the
    // QC run completes (produces a report) rather than throwing the onlay error.
    await expect(runInlayQc({ ...baseInput('inlay') })).resolves.toBeDefined();
  });
});
