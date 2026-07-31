// apps/client/src/ui/ErrorReportSurface.tsx
//
// Phase 8 Task 5 — the NON-BLOCKING error surface. A dismissible banner shown
// when an unhandled error was captured (React render error, window.onerror, or
// an unhandled promise rejection — all via engine/errorCapture.ts). It offers a
// LOCAL "download diagnostic bundle" action and a dismiss; it never blocks the
// app (no backdrop, no focus trap — the app stays usable behind it).
//
// Pure presentation: reads state/errorReportStore.ts, calls errorCapture.ts's
// actions. All copy is i18n'd; the technical error text is shown as data (framed
// by translated labels), the same posture as the recovery prompt's failure line.
import { useTranslation } from 'react-i18next';
import { dismissErrorReport, downloadDiagnosticBundleNow } from '../engine/errorCapture';
import { useErrorReportStore } from '../state/errorReportStore';

export function ErrorReportSurface() {
  const { t } = useTranslation();
  const kind = useErrorReportStore((state) => state.kind);
  const current = useErrorReportStore((state) => state.current);
  const downloading = useErrorReportStore((state) => state.downloading);
  const downloadError = useErrorReportStore((state) => state.downloadError);

  if (kind === 'hidden' || current === null) {
    return null;
  }

  return (
    <div
      className="error-report"
      role="alert"
      aria-live="assertive"
      data-testid="error-report-surface"
    >
      <div className="error-report__content">
        <p className="error-report__title">{t('errorReport.title')}</p>
        <p className="error-report__body">{t('errorReport.body')}</p>
        <p className="error-report__detail" data-testid="error-report-detail">
          {current.name}: {current.message}
        </p>
        {downloadError ? (
          <p className="error-report__error" data-testid="error-report-download-error">
            {t('errorReport.downloadFailed')}
          </p>
        ) : null}
      </div>
      <div className="error-report__actions">
        <button
          type="button"
          className="error-report__button error-report__button--primary"
          data-testid="error-report-download"
          disabled={downloading}
          onClick={() => void downloadDiagnosticBundleNow()}
        >
          {downloading ? t('errorReport.downloadingButton') : t('errorReport.downloadButton')}
        </button>
        <button
          type="button"
          className="error-report__button"
          data-testid="error-report-dismiss"
          onClick={() => dismissErrorReport()}
        >
          {t('errorReport.dismissButton')}
        </button>
      </div>
    </div>
  );
}
