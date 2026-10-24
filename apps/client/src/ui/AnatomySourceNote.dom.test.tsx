// Phase 9 Task 4 — the crown panel says where the anatomy template came
// from, and discloses one that is not anatomical data.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import type { AnatomySourceSummary } from '../state/crownStore';
import { AnatomySourceNote } from './AnatomySourceNote';

const LIBRARY: AnatomySourceSummary = {
  origin: 'library',
  fdi: 11,
  version: '1.1.0',
  toothType: 'incisor',
  assetKind: 'generator',
  provenance: 'PLACEHOLDER-ANATOMY: procedurally generated incisor crown',
  meshChecksum: 'c'.repeat(64),
  metadataChecksum: 'd'.repeat(64),
};

afterEach(cleanup);

describe('AnatomySourceNote', () => {
  it('a generated library asset: FDI, version, kind and provenance verbatim, disclosed as not anatomical data', () => {
    render(<AnatomySourceNote source={LIBRARY} />);
    const line = screen.getByTestId('crown-anatomy-source');
    expect(line.textContent).toMatch(/FDI 11, version 1\.1\.0 \(procedurally generated\)/);
    expect(line.textContent).toContain('PLACEHOLDER-ANATOMY: procedurally generated incisor crown');
    expect(screen.getByTestId('crown-anatomy-placeholder').getAttribute('role')).toBe('note');
  });

  it('a licensed library asset is not flagged as a placeholder', () => {
    render(
      <AnatomySourceNote
        source={{ ...LIBRARY, assetKind: 'licensed', provenance: 'Atlas Z, tooth 11' }}
      />,
    );
    expect(screen.getByTestId('crown-anatomy-source').textContent).toMatch(/licensed library/);
    expect(screen.queryByTestId('crown-anatomy-placeholder')).toBeNull();
  });

  it('the built-in placeholder says why it is used', () => {
    render(
      <AnatomySourceNote
        source={{
          origin: 'builtin',
          reason: 'verificationFailed',
          detail: 'ToothMeshChecksumError: bytes changed',
        }}
      />,
    );
    const note = screen.getByTestId('crown-anatomy-placeholder');
    expect(note.textContent).toMatch(/built-in parametric placeholder/);
    expect(note.textContent).toMatch(
      /failed verification \(ToothMeshChecksumError: bytes changed\) and was not used/,
    );
  });
});
