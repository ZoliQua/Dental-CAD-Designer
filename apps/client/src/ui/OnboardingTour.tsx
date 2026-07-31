// Phase 8 Task 2 — first-run onboarding tour. Walks import → design → QC →
// export (TOUR_STEP_IDS). First run auto-opens (persisted seen flag is false);
// Skip/Done/Escape/backdrop dismiss it AND mark it seen (never re-nags). It is
// re-triggerable via the registered `tour.show` action (Command palette →
// "Show onboarding tour"). Never blocks the app — always skippable, purely a
// dismissible overlay. a11y: role=dialog + aria-modal, focus trap, Escape.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TOUR_STEP_COUNT,
  TOUR_STEP_IDS,
  useUiOverlayStore,
} from '../state/uiOverlayStore';
import { useFocusTrap } from './actions/useFocusTrap';

export function OnboardingTour() {
  const { t } = useTranslation();
  const tourOpen = useUiOverlayStore((state) => state.tourOpen);
  const tourStep = useUiOverlayStore((state) => state.tourStep);
  const startTour = useUiOverlayStore((state) => state.startTour);
  const nextTourStep = useUiOverlayStore((state) => state.nextTourStep);
  const prevTourStep = useUiOverlayStore((state) => state.prevTourStep);
  const finishTour = useUiOverlayStore((state) => state.finishTour);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, tourOpen, finishTour);

  // First-run auto-open: only when the user has never finished/dismissed it.
  // Reads the flag once on mount (getState, not a subscribed value) so a later
  // finishTour() → tourSeen:true never re-fires this effect within a session.
  useEffect(() => {
    const state = useUiOverlayStore.getState();
    if (!state.tourSeen && !state.tourOpen) {
      startTour();
    }
  }, [startTour]);

  if (!tourOpen) {
    return null;
  }

  const stepId = TOUR_STEP_IDS[tourStep] ?? TOUR_STEP_IDS[0]!;
  const isFirst = tourStep === 0;
  const isLast = tourStep === TOUR_STEP_COUNT - 1;

  return (
    <div
      className="onboarding-tour__backdrop"
      data-testid="onboarding-tour-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          finishTour();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="onboarding-tour"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        data-testid="onboarding-tour"
        tabIndex={-1}
      >
        <div className="onboarding-tour__header">
          <p className="onboarding-tour__progress" data-testid="onboarding-tour-progress">
            {t('tour.progress', { current: tourStep + 1, total: TOUR_STEP_COUNT })}
          </p>
          <button
            type="button"
            className="onboarding-tour__close"
            onClick={finishTour}
            aria-label={t('tour.closeLabel')}
            data-testid="onboarding-tour-close"
          >
            {t('tour.closeLabel')}
          </button>
        </div>

        <h2 id="onboarding-tour-title" className="onboarding-tour__title" data-testid="onboarding-tour-title">
          {t(`tour.steps.${stepId}.title`)}
        </h2>
        <p className="onboarding-tour__body" data-testid="onboarding-tour-body">
          {t(`tour.steps.${stepId}.body`)}
        </p>

        <div className="onboarding-tour__footer">
          <button
            type="button"
            className="onboarding-tour__skip"
            onClick={finishTour}
            data-testid="onboarding-tour-skip"
          >
            {t('tour.skip')}
          </button>
          <div className="onboarding-tour__nav">
            <button
              type="button"
              className="onboarding-tour__back"
              onClick={prevTourStep}
              disabled={isFirst}
              data-testid="onboarding-tour-back"
            >
              {t('tour.back')}
            </button>
            {isLast ? (
              <button
                type="button"
                className="onboarding-tour__done"
                onClick={finishTour}
                data-testid="onboarding-tour-done"
              >
                {t('tour.done')}
              </button>
            ) : (
              <button
                type="button"
                className="onboarding-tour__next"
                onClick={nextTourStep}
                data-testid="onboarding-tour-next"
              >
                {t('tour.next')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
