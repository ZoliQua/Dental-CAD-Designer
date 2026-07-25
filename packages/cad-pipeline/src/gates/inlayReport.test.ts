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
import { selectInlayMinThicknessMm, NonCavityRestorationTypeError } from './index.ts';

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
