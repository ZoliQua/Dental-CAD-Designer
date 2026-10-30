// apps/client/src/ui/StandInDisclosure.dom.test.tsx
//
// ADR-022 disclosure pattern — store-seeded render checks (no worker pool):
// each placeholder input is named in its stage, and a case-derived input is
// NOT flagged. The real-pipeline flows (CrownDesignPanel / CavityDesignPanel
// dom tests) assert the same testids end to end.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { cavityDesignEngine } from '../engine/cavityDesign';
import { crownDesignEngine } from '../engine/crownDesign';
import { useCavityStore, type CavityContactsSummary } from '../state/cavityStore';
import { useCrownStore, type AnatomySummary } from '../state/crownStore';
import { CavityDesignPanel } from './CavityDesignPanel';
import { CrownDesignPanel } from './CrownDesignPanel';

const CONTACTS: Omit<CavityContactsSummary, 'neighbourProvenance'> = {
  boxes: [
    {
      label: 'mesial',
      targetPenetrationMm: 0.02,
      achievedSignedDistanceMm: -0.02,
      contactResidualMm: 0.001,
      clampBound: false,
    },
  ],
  clampedBoxes: [],
  seamDihedralMaxBeforeDeg: 1,
  seamDihedralMaxAfterDeg: 1,
};

const ANATOMY: Omit<AnatomySummary, 'neighbourProvenance'> = {
  scaleMesialDistal: 1,
  scaleBuccoLingual: 1,
  scaleOcclusoGingival: 1,
  usedProximalGap: true,
  antagonistUsed: false,
  manual: false,
  anatomySource: null,
  cervicalFit: null,
};

beforeEach(() => {
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
  crownDesignEngine.resetForTests();
});
afterEach(() => {
  cleanup();
  cavityDesignEngine.resetForTests();
  crownDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('crown anatomy stage — neighbour provenance', () => {
  function seed(neighbourProvenance: AnatomySummary['neighbourProvenance']): void {
    useCrownStore.setState({
      active: true,
      restorationId: 'r-crown',
      gates: [],
      anatomy: { ...ANATOMY, neighbourProvenance },
    });
  }

  it('discloses placeholder neighbours — no arch scan: there is no neighbour geometry', () => {
    seed('placeholder');
    render(<CrownDesignPanel />);
    const note = screen.getByTestId('crown-neighbours-placeholder');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toMatch(/no arch scan, so there is no neighbour geometry/);
    expect(note.textContent).toMatch(/synthetic placeholder boxes/);
  });

  it('discloses placeholder neighbours — with an arch scan: capture them (Phase 9 Task 3)', () => {
    seed('placeholder');
    useCrownStore.setState({ capture: { ...useCrownStore.getState().capture, archScanAvailable: true } });
    render(<CrownDesignPanel />);
    expect(screen.getByTestId('crown-neighbours-placeholder').textContent).toMatch(/Capture it on the arch scan/);
  });

  it('shows an available library asset and the opt-in template switch (Phase 9 Task 4)', () => {
    seed('case');
    useCrownStore.setState({
      libraryAnatomy: {
        origin: 'library',
        fdi: 11,
        version: '1.1.0',
        toothType: 'incisor',
        assetKind: 'generator',
        provenance: 'PLACEHOLDER-ANATOMY: x',
        meshChecksum: 'c'.repeat(64),
        metadataChecksum: 'd'.repeat(64),
      },
      useLibraryAnatomy: false,
    });
    render(<CrownDesignPanel />);
    expect(screen.getByTestId('crown-anatomy-library-available').textContent).toMatch(/FDI 11, version 1\.1\.0/);
    expect((screen.getByTestId('crown-anatomy-use-library') as HTMLInputElement).checked).toBe(false);
  });

  it('says why the library is not available', () => {
    seed('case');
    useCrownStore.setState({ libraryAnatomy: { origin: 'builtin', reason: 'offline', detail: null } });
    render(<CrownDesignPanel />);
    expect(screen.getByTestId('crown-anatomy-library-unavailable').textContent).toMatch(/no server in this deployment/);
    expect(screen.queryByTestId('crown-anatomy-use-library')).toBeNull();
  });

  it('says nothing for case-derived neighbours', () => {
    seed('case');
    render(<CrownDesignPanel />);
    expect(screen.queryByTestId('crown-neighbours-placeholder')).toBeNull();
  });
});

describe('cavity stages — neighbour + coverage-divider provenance', () => {
  it('discloses the placeholder neighbours and the placeholder coverage divider (onlay)', () => {
    useCavityStore.setState({
      active: true,
      restorationId: 'r-onlay',
      restorationType: 'onlay',
      gates: [],
      contacts: { ...CONTACTS, neighbourProvenance: 'placeholder' },
      coverage: { pointMm: [0, -2, 0], normalMm: [0, -1, 0], provenance: 'placeholder' },
    });
    render(<CavityDesignPanel />);
    expect(screen.getByTestId('cavity-neighbours-placeholder').textContent).toMatch(
      /no neighbour geometry/,
    );
    expect(screen.getByTestId('cavity-coverage-placeholder').textContent).toMatch(/bounding box/);
  });

  it('says nothing for case-derived inputs', () => {
    useCavityStore.setState({
      active: true,
      restorationId: 'r-onlay',
      restorationType: 'onlay',
      gates: [],
      contacts: { ...CONTACTS, neighbourProvenance: 'case' },
      coverage: { pointMm: [0, -2, 0], normalMm: [0, -1, 0], provenance: 'case' },
    });
    render(<CavityDesignPanel />);
    expect(screen.queryByTestId('cavity-neighbours-placeholder')).toBeNull();
    expect(screen.queryByTestId('cavity-coverage-placeholder')).toBeNull();
  });
});
