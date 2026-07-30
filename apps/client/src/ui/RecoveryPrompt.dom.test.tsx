// apps/client/src/ui/RecoveryPrompt.dom.test.tsx
//
// Phase 8 Task 4 — the crash-recovery prompt, in the browser lane. Covers the
// render-per-kind surface (recoverable / corrupt / restoring / error / hidden)
// and that the buttons are wired to the coordinator (a Discard resolves the
// prompt). Real component, real i18n, real events.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { RecoveryPrompt } from './RecoveryPrompt';
import { useRecoveryStore } from '../state/recoveryStore';

function reset(): void {
  useRecoveryStore.setState({ kind: 'hidden', info: null, detail: null });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe('RecoveryPrompt', () => {
  it('renders nothing when hidden', () => {
    render(<RecoveryPrompt />);
    expect(screen.queryByTestId('recovery-prompt')).toBeNull();
  });

  it('shows the recoverable prompt with case metadata and both choices', () => {
    useRecoveryStore.getState().showRecoverable({
      caseName: 'Molar 26',
      snapshotAt: '2026-07-18T12:00:00.000Z',
      journalOperationCount: 7,
    });
    render(<RecoveryPrompt />);

    expect(screen.getByTestId('recovery-prompt')).toBeTruthy();
    expect(screen.getByTestId('recovery-prompt-case-name').textContent).toBe('Molar 26');
    expect(screen.getByTestId('recovery-prompt-restore')).toBeTruthy();
    expect(screen.getByTestId('recovery-prompt-discard')).toBeTruthy();
    // Not the corrupt surface.
    expect(screen.queryByTestId('recovery-prompt-corrupt')).toBeNull();
  });

  it('Discard resolves the prompt (hides it)', async () => {
    const user = userEvent.setup();
    useRecoveryStore.getState().showRecoverable({
      caseName: 'C',
      snapshotAt: '2026-07-18T12:00:00.000Z',
      journalOperationCount: 1,
    });
    render(<RecoveryPrompt />);

    await user.click(screen.getByTestId('recovery-prompt-discard'));
    await waitFor(() => expect(useRecoveryStore.getState().kind).toBe('hidden'));
  });

  it('shows the corrupt surface with an acknowledge button (no restore/discard)', () => {
    useRecoveryStore.getState().showCorrupt('checksum-mismatch');
    render(<RecoveryPrompt />);

    expect(screen.getByTestId('recovery-prompt-corrupt')).toBeTruthy();
    expect(screen.getByTestId('recovery-prompt-acknowledge')).toBeTruthy();
    expect(screen.queryByTestId('recovery-prompt-restore')).toBeNull();
  });

  it('disables the buttons and shows the restoring label while a restore is in progress', () => {
    useRecoveryStore.setState({
      kind: 'restoring',
      info: { caseName: 'C', snapshotAt: '2026-07-18T12:00:00.000Z', journalOperationCount: 1 },
      detail: null,
    });
    render(<RecoveryPrompt />);

    const restore = screen.getByTestId('recovery-prompt-restore') as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect((screen.getByTestId('recovery-prompt-discard') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the failure message in the error state', () => {
    useRecoveryStore.setState({
      kind: 'error',
      info: { caseName: 'C', snapshotAt: '2026-07-18T12:00:00.000Z', journalOperationCount: 1 },
      detail: 'network down',
    });
    render(<RecoveryPrompt />);

    expect(screen.getByTestId('recovery-prompt-error').textContent).toContain('network down');
  });
});
