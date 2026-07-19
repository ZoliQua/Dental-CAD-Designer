// apps/client/src/ui/CasePicker.dom.test.tsx
//
// Phase 2 Task 12: real-DOM `client-dom` project test (browser mode — see
// README.md in this directory). Targets CasePicker's error paths, one of
// the exact gaps prior per-task reviews kept flagging (see
// .superpowers/sdd/progress.md's P1 Task 11 review note about persistence
// error handling being covered only at the engine layer, never the
// component layer).
//
// No mocking of `fetch`: this repo's "no-mock philosophy" extends here too
// — the client-dom project's browser page is served by Vitest's own Vite
// dev server, which has no `/api/*` routes, so `engine/persistence.ts`'s
// relative `fetch('/api/...')` calls genuinely fail (a real network/HTTP
// error against a real server that just doesn't have that route) — a real
// error path, not a simulated one.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { CasePicker } from './CasePicker';
import { usePersistenceStore } from '../state/persistenceStore';

function resetPersistenceStoreForTest(): void {
  usePersistenceStore.setState({
    status: 'idle',
    errorMessage: null,
    activeCaseId: null,
    activeCaseName: null,
    lastSavedAt: null,
    cases: [],
    casesLoading: false,
    casesError: null,
    isPickerOpen: false,
  });
}

beforeEach(() => {
  resetPersistenceStoreForTest();
});

afterEach(() => {
  // Vitest browser mode does not auto-wire @testing-library/react's usual
  // implicit afterEach(cleanup) the way a jsdom project does (no jsdom
  // global `document` teardown hook it piggybacks on) — explicit cleanup
  // here is what keeps each test's render() from leaking into the next
  // test's real (single, shared) browser page.
  cleanup();
});

describe('CasePicker — rename error path', () => {
  it('a failed PATCH /api/cases/:id shows the inline rename error and reverts to the row view (real fetch, no /api route on the test server)', async () => {
    const user = userEvent.setup();
    usePersistenceStore.setState({
      isPickerOpen: true,
      cases: [
        {
          id: 'case-1',
          name: 'Original Name',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          schemaVersion: 2,
        },
      ],
    });

    render(<CasePicker />);

    expect(screen.getByTestId('case-picker')).toBeTruthy();
    // Enters rename mode (CasePicker.tsx's startRename — the row's second
    // button, since the first is "Open").
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    await user.click(renameButtons[0]!);

    const renameInput = screen.getByTestId('case-picker-rename-input');
    await user.clear(renameInput);
    await user.type(renameInput, 'New Name');
    await user.keyboard('{Enter}');

    // renameCase's real PATCH genuinely fails (404/network error against
    // the test server, which has no /api routes) — CasePicker.submitRename
    // catches it and shows this inline error, then exits rename mode.
    const errorEl = await screen.findByTestId('case-picker-rename-error', {}, { timeout: 10_000 });
    expect(errorEl.textContent).toBeTruthy();

    // Reverted to the row view (rename form no longer shown) with the
    // ORIGINAL name intact — the failed rename never landed.
    expect(screen.queryByTestId('case-picker-rename-input')).toBeNull();
    expect(screen.getByText('Original Name')).toBeTruthy();
  });
});

describe('CasePicker — create-case error path', () => {
  it('a failed POST /api/cases leaves the picker open and the create form usable for a retry (real fetch failure)', async () => {
    const user = userEvent.setup();
    usePersistenceStore.setState({ isPickerOpen: true, cases: [] });

    render(<CasePicker />);

    const nameInput = screen.getByTestId('case-picker-new-case-name');
    await user.type(nameInput, 'A New Case');
    const createButton = screen.getByRole('button', { name: /create/i });
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(createButton);

    // createCase's real POST genuinely fails — CasePicker.handleCreate
    // catches it (console.error'd, per that handler's doc: the header's
    // status pill is the OTHER user-visible surface for this failure) and
    // does NOT close the picker, leaving the form in place for a retry.
    // usePersistenceStore's status flip to 'error' (engine/persistence.ts's
    // createCase) is the deterministic signal to wait on here, since the
    // picker itself shows no dedicated create-error text of its own.
    await waitFor(
      () => {
        expect(usePersistenceStore.getState().status).toBe('error');
      },
      { timeout: 10_000 },
    );

    expect(screen.getByTestId('case-picker')).toBeTruthy();
    expect(screen.getByTestId('case-picker-new-case-name')).toBeTruthy();
    // `creating` reverted to false in the `finally` block — the button is
    // enabled again (not stuck disabled), ready for a retry.
    expect((screen.getByRole('button', { name: /create/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
