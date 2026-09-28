// apps/client/src/ui/ServerStatusBanner.dom.test.tsx
//
// Real-DOM `client-dom` test for the client-only (no server) mode. No fetch
// mocking: the lane's page is served by Vitest's own Vite dev server, which has
// no `/api/*` routes — exactly the situation of the static Vercel deploy — so
// the REAL `probeServer()` genuinely settles to `offline` here.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { probeServer } from '../engine/serverStatus';
import { usePersistenceStore } from '../state/persistenceStore';
import { useServerStatusStore } from '../state/serverStatusStore';
import { CasePicker } from './CasePicker';
import { ExportPanel } from './ExportPanel';
import { ServerStatusBanner } from './ServerStatusBanner';

beforeEach(() => {
  useServerStatusStore.setState({ status: 'unknown', serverKernelVersion: null });
  usePersistenceStore.setState({
    cases: [],
    casesLoading: false,
    casesError: null,
    isPickerOpen: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('ServerStatusBanner', () => {
  it('the real probe against a host with no /api settles offline and shows the banner', async () => {
    render(<ServerStatusBanner />);
    expect(screen.queryByTestId('server-offline-banner')).toBeNull();

    await probeServer();

    await waitFor(() => {
      expect(screen.getByTestId('server-offline-banner')).toBeTruthy();
    });
    expect(screen.getByRole('status').textContent).toMatch(/client-only mode/i);
  });

  it('shows nothing while the probe is unsettled or when the server is online', () => {
    const { rerender } = render(<ServerStatusBanner />);
    expect(screen.queryByTestId('server-offline-banner')).toBeNull();

    useServerStatusStore.setState({ status: 'online', serverKernelVersion: '0.27.0' });
    rerender(<ServerStatusBanner />);
    expect(screen.queryByTestId('server-offline-banner')).toBeNull();
  });
});

describe('CasePicker — client-only mode', () => {
  it('offline: shows the localized notice instead of the create form / list, and never lists cases', () => {
    useServerStatusStore.setState({ status: 'offline' });
    usePersistenceStore.setState({ isPickerOpen: true });

    render(<CasePicker />);

    expect(screen.getByTestId('case-picker-offline').textContent).toMatch(
      /local DQ Dental CAD server/,
    );
    expect(screen.queryByTestId('case-picker-new-case-name')).toBeNull();
    // listCases() was never called — it would have flipped casesLoading on.
    expect(usePersistenceStore.getState().casesLoading).toBe(false);
    expect(usePersistenceStore.getState().casesError).toBeNull();
  });

  it('online/unknown: the create form is shown as before', () => {
    usePersistenceStore.setState({ isPickerOpen: true });
    render(<CasePicker />);
    expect(screen.getByTestId('case-picker-new-case-name')).toBeTruthy();
    expect(screen.queryByTestId('case-picker-offline')).toBeNull();
  });
});

describe('ExportPanel — client-only mode', () => {
  it('offline: case-archive export/import are disabled with a visible reason', () => {
    useServerStatusStore.setState({ status: 'offline' });
    render(<ExportPanel />);
    const exportButton = screen.getByTestId('archive-export-button') as HTMLButtonElement;
    const importInput = screen.getByTestId('archive-import-input') as HTMLInputElement;
    expect(exportButton.disabled).toBe(true);
    expect(importInput.disabled).toBe(true);
    expect(screen.getByTestId('archive-offline').textContent).toMatch(/local server/);
  });

  it('online/unknown: the archive controls stay enabled, no offline notice', () => {
    render(<ExportPanel />);
    expect((screen.getByTestId('archive-export-button') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('archive-import-input') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('archive-offline')).toBeNull();
  });
});
