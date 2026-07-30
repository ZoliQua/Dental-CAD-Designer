// apps/client/src/ui/ErrorBoundary.tsx
//
// Phase 8 Task 5 — React render-error boundary for GRACEFUL DEGRADATION.
//
// A render error thrown inside a wrapped subtree is caught here instead of
// white-screening the whole app: the boundary reports the error through the
// single capture path (engine/errorCapture.ts → the non-blocking surface + the
// diagnostic bundle) and renders a small localized fallback IN PLACE OF the
// failed subtree only. Wrapping the Sidebar and the Viewport separately (see
// ui/App.tsx) means a crash in one panel leaves the rest of the app usable.
//
// React error boundaries MUST be class components (getDerivedStateFromError /
// componentDidCatch have no hook equivalent). The class stays presentation-free:
// all user copy lives in the functional `ErrorBoundaryFallback`, which uses the
// i18n hook — so the hardcoded-string guard (i18n/scanHardcodedStrings) sees no
// bare strings here.
import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { captureError, downloadDiagnosticBundleNow } from '../engine/errorCapture';

interface ErrorBoundaryProps {
  /** A short i18n key naming the region (e.g. `errorReport.regionSidebar`),
   * shown in the fallback so the user knows WHAT failed. */
  regionLabelKey: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    // Route through the single capture path — raises the surface + arms the
    // local diagnostic bundle. Never re-throws. (React also passes an
    // ErrorInfo second arg with the component stack; we intentionally do not
    // capture it — the error's own stack is enough and the component tree is
    // not needed in the PHI-free bundle.)
    captureError(error, 'react');
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorBoundaryFallback regionLabelKey={this.props.regionLabelKey} />;
    }
    return this.props.children;
  }
}

function ErrorBoundaryFallback({ regionLabelKey }: { regionLabelKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="error-boundary" role="alert" data-testid="error-boundary-fallback">
      <p className="error-boundary__title">{t('errorReport.boundaryTitle')}</p>
      <p className="error-boundary__body">
        {t('errorReport.boundaryBody', { region: t(regionLabelKey) })}
      </p>
      <button
        type="button"
        className="error-boundary__button"
        data-testid="error-boundary-download"
        onClick={() => void downloadDiagnosticBundleNow()}
      >
        {t('errorReport.downloadButton')}
      </button>
    </div>
  );
}
