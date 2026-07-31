// Phase 8 Task 1 — F1 regression lock (review fix round).
//
// The hardcoded-string SCANNER has an admitted structural blind spot: a raw
// engine `error.message` reaches the DOM through a *variable* (state setter →
// `{startError}` / a store value → `{error}`), never as a JSX string literal,
// so the static guard is incapable of seeing it. Four render paths used to dump
// that raw (developer-facing English) message straight to the user — a HU/DE/ES
// dentist saw untranslated text. They now wrap it in a translated frame
// (`*.startErrorOther` / `measure.toolError`), mirroring the sibling panels
// (Alignment/Axis/Margin).
//
// A static scan cannot prove that wiring, so THIS behavioral test is the
// regression lock: it drives each of the four surfaces into its error path with
// the locale switched to Hungarian and asserts the rendered text is the
// LOCALIZED frame (which a bare `error.message` could never be). Revert any of
// the four wrappers and the rendered text collapses to raw English → this test
// fails. Real components, real store, real engines, no mocks.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FdiTooth } from '@dqcad/shared-types';
import i18n from '../i18n';
import { caseStore } from '../engine/caseStore';
import { cavityDesignEngine } from '../engine/cavityDesign';
import { crownDesignEngine } from '../engine/crownDesign';
import { bridgeDesignEngine } from '../engine/bridgeDesign';
import { createRestoration } from '../engine/restorations';
import { useToolStore } from '../state/toolStore';
import { CavityDesignPanel } from './CavityDesignPanel';
import { CrownDesignPanel } from './CrownDesignPanel';
import { BridgeDesignPanel } from './BridgeDesignPanel';
import { MeasureToolbar } from './MeasureToolbar';

// A restoration with NO target scan (targetNodeId: null) is listed/selectable
// in its panel but makes `<engine>.start()` throw a *StageOrderError before any
// mesh work — the exact guard-path error class the review flagged.
function seedRestorationMissingPrereq(type: 'inlay' | 'crown' | 'bridge'): string {
  const teeth: readonly FdiTooth[] = type === 'bridge' ? [14, 15, 16] : [16];
  return createRestoration({ type, teeth, targetNodeId: null }).id;
}

async function selectAndStart(selectTestId: string, startTestId: string, restorationId: string): Promise<void> {
  fireEvent.change(screen.getByTestId(selectTestId), { target: { value: restorationId } });
  fireEvent.click(screen.getByTestId(startTestId));
}

beforeEach(async () => {
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
  crownDesignEngine.resetForTests();
  bridgeDesignEngine.resetForTests();
  useToolStore.getState().setError(null);
  await i18n.changeLanguage('hu');
});

afterEach(async () => {
  cleanup();
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
  crownDesignEngine.resetForTests();
  bridgeDesignEngine.resetForTests();
  useToolStore.getState().setError(null);
  await i18n.changeLanguage('en');
});

describe('design-panel error renders are localized (F1 regression lock)', () => {
  it('CavityDesignPanel — a failed start renders the Hungarian frame, not raw English', async () => {
    const id = seedRestorationMissingPrereq('inlay');
    render(<CavityDesignPanel />);
    await selectAndStart('cavity-restoration-select', 'cavity-start-button', id);
    await waitFor(() => {
      expect(screen.getByTestId('cavity-start-error').textContent).toContain('A kavitástervezés nem indítható:');
    });
  });

  it('CrownDesignPanel — a failed start renders the Hungarian frame', async () => {
    const id = seedRestorationMissingPrereq('crown');
    render(<CrownDesignPanel />);
    await selectAndStart('crown-restoration-select', 'crown-start-button', id);
    await waitFor(() => {
      expect(screen.getByTestId('crown-start-error').textContent).toContain('A koronatervezés nem indítható:');
    });
  });

  it('BridgeDesignPanel — a failed start renders the Hungarian frame', async () => {
    const id = seedRestorationMissingPrereq('bridge');
    render(<BridgeDesignPanel />);
    await selectAndStart('bridge-restoration-select', 'bridge-start-button', id);
    await waitFor(() => {
      expect(screen.getByTestId('bridge-start-error').textContent).toContain('A hídtervezés nem indítható:');
    });
  });

  it('MeasureToolbar — a raw toolStore error is rendered inside the Hungarian frame', async () => {
    // ToolManager (engine, i18n-free by the layer rule) stores the raw message;
    // the UI wraps it. Assert BOTH the localized frame AND the technical detail.
    useToolStore.getState().setError('worker: measurePointToSurface failed');
    render(<MeasureToolbar />);
    await waitFor(() => {
      const text = screen.getByText(/A mérés sikertelen:/);
      expect(text.textContent).toContain('worker: measurePointToSurface failed');
    });
  });
});
