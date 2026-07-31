// apps/client/src/ui/CavityDesignPanel.seam.dom.test.tsx
//
// Falsifiable regression for the seam-readout re-derivation fix (code-review
// CLIENT-UI finding 1): the patch-stage seam readout must READ the engine's
// authoritative `seamWithinBound` verdict, NOT re-derive `maxDeg < boundDeg` in
// the component. The lightweight seeding here (store snapshot + render, no
// worker pool) isolates the render decision — the heavy real-pipeline critical
// path lives in CavityDesignPanel.dom.test.tsx.
//
// The load-bearing case is the ZERO-SAMPLE seam: an empty/mis-partitioned seam
// reports `maxDeg === 0`, so the pre-fix `maxDeg < boundDeg` compare paints it
// GREEN (0 < 5) even though the gate treats a zero-sample seam as a hard
// FAILURE. With the fix the panel shows WARN because it reads `seamWithinBound`.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { cavityDesignEngine } from '../engine/cavityDesign';
import { useCavityStore, type CavityPatchSummary } from '../state/cavityStore';
import { CavityDesignPanel } from './CavityDesignPanel';

function seedActiveWorkflow(patch: CavityPatchSummary): void {
  useCavityStore.setState({
    active: true,
    restorationId: 'resto-seam-1',
    restorationType: 'inlay',
    gates: [],
    patch,
  });
}

beforeEach(() => {
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
});
afterEach(() => {
  cleanup();
  cavityDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('CavityDesignPanel — seam readout reads the store verdict (no UI re-derivation)', () => {
  it('paints WARN for the zero-sample seam EVEN THOUGH maxDeg (0) < bound (the pre-fix green trap)', () => {
    seedActiveWorkflow({
      seamDihedralMaxDeg: 0, // an empty seam reports 0 — numerically < bound
      seamDihedralMeanDeg: 0,
      seamDihedralBoundDeg: 5,
      seamWithinBound: false, // …but the gate FAILS a zero-sample seam
      patchTriangleCount: 120,
      proximalFaceCount: 2,
    });
    render(<CavityDesignPanel />);
    const seam = screen.getByTestId('cavity-patch-seam');
    expect(seam.className).toContain('cavity-seam--warn');
    expect(seam.className).not.toContain('cavity-seam--ok');
  });

  it('paints OK when the engine verdict is within bound', () => {
    seedActiveWorkflow({
      seamDihedralMaxDeg: 1.7,
      seamDihedralMeanDeg: 0.9,
      seamDihedralBoundDeg: 5,
      seamWithinBound: true,
      patchTriangleCount: 120,
      proximalFaceCount: 2,
    });
    render(<CavityDesignPanel />);
    const seam = screen.getByTestId('cavity-patch-seam');
    expect(seam.className).toContain('cavity-seam--ok');
    expect(seam.className).not.toContain('cavity-seam--warn');
  });
});
