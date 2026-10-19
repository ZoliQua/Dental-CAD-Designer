// apps/client/src/ui/NeighbourCapture.tsx
//
// Phase 9 Task 3 (ADR-022 Decision 3) — the panel section that captures the
// restoration's proximal neighbours (and, for a crown, the antagonist) from
// the case's own scans. A side's "Pick" arms a viewport pick
// (state/neighbourCaptureStore's `pending`); ui/Viewport.tsx routes the next
// click on the arch scan to the engine, which captures and journals it. The
// opposite-arch antagonist is used only after the explicit confirm button.
// Pure renderer over the engine's capture snapshot — no geometry here.
import { useTranslation } from 'react-i18next';
import { useNeighbourPickStore, type CaptureState } from '../state/neighbourCaptureStore';

function um(mm: number): string {
  return (mm * 1000).toFixed(0);
}

export function NeighbourCapture({
  workflow,
  capture,
  disabled,
  onConfirmOppositeArch,
}: {
  workflow: 'crown' | 'cavity';
  capture: CaptureState;
  disabled: boolean;
  /** Crown only: confirm the opposite-arch scan as the antagonist. */
  onConfirmOppositeArch?: () => void;
}) {
  const { t } = useTranslation();
  const pending = useNeighbourPickStore((state) => state.pending);
  const setPending = useNeighbourPickStore((state) => state.setPending);
  const prefix = `${workflow}-capture`;

  return (
    <section className="neighbour-capture" data-testid={prefix}>
      <h4 className="neighbour-capture__title">{t('capture.title')}</h4>
      {!capture.archScanAvailable ? (
        <p className="neighbour-capture__note" data-testid={`${prefix}-no-arch`}>
          {t('capture.noArchScan')}
        </p>
      ) : (
        (['mesial', 'distal'] as const).map((side) => {
          const summary = capture[side];
          const tooth = capture.neighbourTeeth[side];
          const armed = pending?.workflow === workflow && pending.side === side;
          return (
            <div className="neighbour-capture__row" key={side} data-testid={`${prefix}-${side}`}>
              <span className="neighbour-capture__label">
                {t(`capture.side.${side}`, { tooth: tooth ?? '—' })}
              </span>
              {capture.busy === side ? (
                <span className="neighbour-capture__status">{t('capture.busy')}</span>
              ) : summary ? (
                <span
                  className="neighbour-capture__status"
                  data-testid={`${prefix}-${side}-captured`}
                >
                  {t('capture.captured', { band: um(summary.windowBoundaryBandMm) })}
                </span>
              ) : (
                <span className="neighbour-capture__status neighbour-capture__status--missing">
                  {t('capture.notCaptured')}
                </span>
              )}
              {armed ? (
                <>
                  <span className="neighbour-capture__hint" data-testid={`${prefix}-${side}-hint`}>
                    {t('capture.picking')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    data-testid={`${prefix}-${side}-cancel`}
                  >
                    {t('capture.cancel')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={disabled || capture.busy !== null}
                  onClick={() => setPending({ workflow, side })}
                  data-testid={`${prefix}-${side}-pick`}
                >
                  {summary ? t('capture.repick') : t('capture.pick')}
                </button>
              )}
            </div>
          );
        })
      )}
      {workflow === 'crown' && (
        <div className="neighbour-capture__row" data-testid={`${prefix}-antagonist`}>
          <span className="neighbour-capture__label">{t('capture.antagonistTitle')}</span>
          {capture.busy === 'antagonist' ? (
            <span className="neighbour-capture__status">{t('capture.busy')}</span>
          ) : capture.antagonistSource === 'antagonistScan' ? (
            <span className="neighbour-capture__status">{t('capture.antagonistScan')}</span>
          ) : capture.antagonistSource === 'oppositeArch' && capture.antagonist ? (
            <span
              className="neighbour-capture__status"
              data-testid={`${prefix}-antagonist-captured`}
            >
              {t('capture.antagonistOpposite', {
                band: um(capture.antagonist.windowBoundaryBandMm),
              })}
            </span>
          ) : capture.oppositeArchAvailable ? (
            <button
              type="button"
              disabled={disabled || capture.busy !== null}
              onClick={onConfirmOppositeArch}
              data-testid={`${prefix}-antagonist-confirm`}
            >
              {t('capture.useOppositeArch')}
            </button>
          ) : (
            <span className="neighbour-capture__status neighbour-capture__status--missing">
              {t('capture.noAntagonist')}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
