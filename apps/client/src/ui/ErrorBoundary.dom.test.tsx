// apps/client/src/ui/ErrorBoundary.dom.test.tsx
//
// Phase 8 Task 5 — graceful degradation: a render error in a wrapped subtree is
// caught and replaced by a localized fallback (WITH a download action), instead
// of propagating and white-screening the app. The error is routed through the
// single capture path (→ the error-report store).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { ErrorBoundary } from './ErrorBoundary';
import { useErrorReportStore } from '../state/errorReportStore';

function Boom(): never {
  throw new Error('panel exploded');
}

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
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary regionLabelKey="errorReport.regionSidebar">
        <div data-testid="ok-child">ok</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok-child')).toBeTruthy();
  });

  it('catches a render error, shows the localized fallback + download action, and reports it', () => {
    // Silence React's expected error logging for this intentional throw.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary regionLabelKey="errorReport.regionViewport">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
    expect(screen.getByTestId('error-boundary-download')).toBeTruthy();
    // The failed subtree did NOT render.
    // Capture path fired: the error reached the report store.
    expect(useErrorReportStore.getState().kind).toBe('active');
    expect(useErrorReportStore.getState().current?.message).toBe('panel exploded');
    expect(useErrorReportStore.getState().current?.source).toBe('react');
  });
});
