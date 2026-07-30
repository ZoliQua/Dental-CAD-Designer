// apps/client/src/ui/ErrorReportSurface.dom.test.tsx
//
// Phase 8 Task 5 — the non-blocking error surface, in the browser lane. Real
// component, real i18n, real events.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { ErrorReportSurface } from './ErrorReportSurface';
import { useErrorReportStore } from '../state/errorReportStore';

function reset(): void {
  useErrorReportStore.setState({
    kind: 'hidden',
    current: null,
    downloading: false,
    downloadError: false,
  });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function activeError(): void {
  useErrorReportStore.getState().reportError({
    name: 'TypeError',
    message: 'cannot read x',
    stack: 'at foo',
    source: 'window.onerror',
    at: '2026-07-22T12:00:00.000Z',
  });
}

describe('ErrorReportSurface', () => {
  it('renders nothing when hidden', () => {
    render(<ErrorReportSurface />);
    expect(screen.queryByTestId('error-report-surface')).toBeNull();
  });

  it('shows the localized surface with the technical error text and both actions', () => {
    activeError();
    render(<ErrorReportSurface />);
    expect(screen.getByTestId('error-report-surface')).toBeTruthy();
    expect(screen.getByTestId('error-report-detail').textContent).toContain('TypeError');
    expect(screen.getByTestId('error-report-detail').textContent).toContain('cannot read x');
    expect(screen.getByTestId('error-report-download')).toBeTruthy();
    expect(screen.getByTestId('error-report-dismiss')).toBeTruthy();
  });

  it('Dismiss hides the surface', async () => {
    const user = userEvent.setup();
    activeError();
    render(<ErrorReportSurface />);
    await user.click(screen.getByTestId('error-report-dismiss'));
    await waitFor(() => expect(useErrorReportStore.getState().kind).toBe('hidden'));
    expect(screen.queryByTestId('error-report-surface')).toBeNull();
  });

  it('shows the downloading label while a bundle is being prepared', () => {
    activeError();
    useErrorReportStore.setState({ downloading: true });
    render(<ErrorReportSurface />);
    const button = screen.getByTestId('error-report-download') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows the download-failed message when a build failed', () => {
    activeError();
    useErrorReportStore.setState({ downloadError: true });
    render(<ErrorReportSurface />);
    expect(screen.getByTestId('error-report-download-error')).toBeTruthy();
  });
});
