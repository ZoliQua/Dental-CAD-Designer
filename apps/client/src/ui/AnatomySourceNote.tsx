// apps/client/src/ui/AnatomySourceNote.tsx
//
// Phase 9 Task 4 (ADR-022 Decision 5) — where the crown's anatomy template
// came from: a verified tooth-library asset (FDI, version, how it was
// produced, its provenance verbatim) or the built-in parametric placeholder
// and why. A template that is not anatomical data (a generated or
// unstated-origin asset, or the built-in tooth) is disclosed with the
// stand-in pattern; it does not fail a gate (every gate measures the shell).
import { useTranslation } from 'react-i18next';
import type { AnatomySourceSummary } from '../state/crownStore';

export function AnatomySourceNote({ source }: { source: AnatomySourceSummary }) {
  const { t } = useTranslation();
  if (source.origin === 'library') {
    const placeholder = source.assetKind === 'generator' || source.assetKind === 'unspecified';
    return (
      <>
        <p
          className="crown-stage__readout"
          data-testid="crown-anatomy-source"
          data-origin="library"
        >
          {t('anatomySource.libraryLine', {
            fdi: source.fdi,
            version: source.version,
            kind: t(`anatomySource.kind.${source.assetKind}`),
          })}{' '}
          <span className="crown-stage__note">
            {t('anatomySource.provenanceLabel')} {source.provenance}
          </span>
        </p>
        {placeholder && (
          <div className="stand-in-disclosure" role="note" data-testid="crown-anatomy-placeholder">
            <strong className="stand-in-disclosure__title">{t('provenance.title')}</strong>{' '}
            <span>{t('anatomySource.placeholderLibrary')}</span>
          </div>
        )}
      </>
    );
  }
  return (
    <div
      className="stand-in-disclosure"
      role="note"
      data-testid="crown-anatomy-placeholder"
      data-origin="builtin"
    >
      <strong className="stand-in-disclosure__title">{t('provenance.title')}</strong>{' '}
      <span data-testid="crown-anatomy-source" data-origin="builtin">
        {t('anatomySource.builtinLine', {
          reason: t(`anatomySource.reason.${source.reason}`, { detail: source.detail ?? '' }),
        })}
      </span>
    </div>
  );
}
