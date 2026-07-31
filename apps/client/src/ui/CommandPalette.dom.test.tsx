// Phase 8 Task 2 — command palette DOM tests (browser lane). Covers the
// critical paths from the brief: open, filter, run, close, and the 19b
// discipline (a disabled action never runs). Real component, real events, no
// mocks — the palette reads the real registry.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QcGateResult, QcReport, Restoration } from '@dqcad/shared-types';
import '../i18n';
import { CommandPalette } from './CommandPalette';
import { createEmptyCaseDocument, useCaseStore } from '../state/caseStore';
import { useUiOverlayStore } from '../state/uiOverlayStore';

// Minimal restoration fixture (mirrors engine/exportWorkflow.test.ts's builder):
// stages.finalMesh === qc.journalHash ⇒ NOT stale; gates all passed ⇒ allowed.
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

function restorationFixture(gates: QcGateResult[]): Restoration {
  const qc: QcReport = {
    gates,
    passed: gates.every((g) => g.passed || g.acknowledged),
    kernelVersion: '0.26.0',
    profileVersion: '1.4.0',
    journalHash: 'final-hash',
  };
  return {
    id: 'resto-1',
    type: 'crown',
    teeth: [16],
    pontics: [],
    targetNodeId: 'node-1',
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
    stages: { finalMesh: 'final-hash' },
    qc,
  };
}

function selectRestoration(gates: QcGateResult[]): void {
  useCaseStore.setState({
    document: { ...createEmptyCaseDocument(), restorations: [restorationFixture(gates)] },
    selectedRestorationId: 'resto-1',
  });
}

function resetOverlay(): void {
  useUiOverlayStore.setState({
    commandPaletteOpen: false,
    shortcutsHelpOpen: false,
    tourOpen: false,
    tourStep: 0,
  });
}

beforeEach(() => {
  resetOverlay();
  useCaseStore.setState({ document: createEmptyCaseDocument(), selectedRestorationId: null });
});

afterEach(() => {
  cleanup();
  resetOverlay();
});

describe('CommandPalette', () => {
  it('renders nothing when closed, and a modal dialog when open', () => {
    const { rerender } = render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).toBeNull();

    useUiOverlayStore.getState().openCommandPalette();
    rerender(<CommandPalette />);

    const dialog = screen.getByTestId('command-palette');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The listbox + at least the always-available help actions are present.
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByTestId('command-palette-option-help.shortcuts')).toBeTruthy();
  });

  it('filters the registry as the user types, and shows the empty state for no match', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    const input = screen.getByTestId('command-palette-input');
    await user.type(input, 'command');
    // The "Command palette" action survives the filter; a view action does not.
    expect(screen.getByTestId('command-palette-option-help.commandPalette')).toBeTruthy();
    expect(screen.queryByTestId('command-palette-option-view.front')).toBeNull();

    await user.clear(input);
    await user.type(input, 'zzzznotacommand');
    expect(screen.getByTestId('command-palette-empty')).toBeTruthy();
  });

  it('runs the highlighted action on Enter and closes (Cmd+K-free path)', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    const input = screen.getByTestId('command-palette-input');
    // Filter down to the "Keyboard shortcuts" action, then run it.
    await user.type(input, 'keyboard short');
    await user.keyboard('{Enter}');

    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(true);
  });

  it('closes on Escape without running anything', async () => {
    const user = userEvent.setup();
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);
    await user.keyboard('{Escape}');
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(false);
    expect(useUiOverlayStore.getState().shortcutsHelpOpen).toBe(false);
  });

  it('19b: a disabled action is greyed and does NOT run when clicked', async () => {
    const user = userEvent.setup();
    // No restoration selected ⇒ export action disabled.
    useCaseStore.setState({ selectedRestorationId: null });
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    await user.type(screen.getByTestId('command-palette-input'), 'export');
    const option = screen.getByTestId('command-palette-option-export.releaseSelected');
    expect(option.getAttribute('aria-disabled')).toBe('true');

    await user.click(option);
    // Running a disabled action is a no-op: the palette stays open (runAction
    // returned before close()), nothing was dispatched.
    expect(useUiOverlayStore.getState().commandPaletteOpen).toBe(true);
  });

  it('F2: export is ENABLED when the selected restoration passes the export gate', async () => {
    const user = userEvent.setup();
    selectRestoration([gate({ gate: 'watertight' }), gate({ gate: 'minWallThickness' })]); // allowed
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    await user.type(screen.getByTestId('command-palette-input'), 'export');
    expect(
      screen
        .getByTestId('command-palette-option-export.releaseSelected')
        .getAttribute('aria-disabled'),
    ).toBe('false');
  });

  it('F2: export is DISABLED when the gate would refuse (failing unacknowledged gate)', async () => {
    const user = userEvent.setup();
    // A hard-failing, unacknowledged gate ⇒ exportGateVerdict refuses
    // (gatesFailing) ⇒ the palette must mirror the ExportPanel and grey it out.
    selectRestoration([gate({ gate: 'minWallThickness', passed: false, message: 'wall too thin' })]);
    useUiOverlayStore.getState().openCommandPalette();
    render(<CommandPalette />);

    await user.type(screen.getByTestId('command-palette-input'), 'export');
    expect(
      screen
        .getByTestId('command-palette-option-export.releaseSelected')
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });
});
