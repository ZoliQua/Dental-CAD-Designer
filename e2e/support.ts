// e2e/support.ts — shared Playwright helpers.
import type { Page } from '@playwright/test';

/** The onboarding tour's persisted "seen" flag (state/uiOverlayStore.ts). */
const TOUR_SEEN_KEY = 'dqcad.tour.seen';

/**
 * Marks the first-run onboarding tour as seen before any page script runs,
 * so its backdrop never covers the workflow a spec drives. Since Phase 8 Task
 * 2 the tour auto-opens on a fresh profile; e2e/phase8.spec.ts is the spec
 * that tests the tour itself and does not call this.
 */
export async function skipOnboardingTour(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, 'true');
  }, TOUR_SEEN_KEY);
}
