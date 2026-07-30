import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { initRecovery } from '../engine/recovery';
import { useAppStore } from '../state/appStore';
import { useGlobalShortcuts } from './actions/useGlobalShortcuts';
import { CasePicker } from './CasePicker';
import { CommandPalette } from './CommandPalette';
import { Header } from './Header';
import { OnboardingTour } from './OnboardingTour';
import { RecoveryPrompt } from './RecoveryPrompt';
import { ShortcutsHelpOverlay } from './ShortcutsHelpOverlay';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Viewport } from './Viewport';

export function App() {
  const theme = useAppStore((state) => state.theme);
  const language = useAppStore((state) => state.language);
  const { i18n } = useTranslation();

  // Theme is CSS-custom-property driven off a data-theme attribute on the
  // root element (see src/index.css) rather than React inline styles, so
  // it applies uniformly to elements React doesn't own (e.g. the Three.js
  // canvas background is set independently in SceneManager).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    void i18n.changeLanguage(language);
  }, [i18n, language]);

  // Phase 8 Task 2: the ONE app-wide keyboard-shortcut dispatcher. Replaces
  // the former inline Cmd/Ctrl+S handler here (now the registered `case.save`
  // action) and the SceneManager digit-key view handler — all read the single
  // action registry (ui/actions/registry.ts).
  useGlobalShortcuts();

  // Phase 8 Task 4: start the crash-safe local autosave and, if the previous
  // session ended uncleanly with un-synced edits, surface the recovery prompt.
  // Runs once at launch (StrictMode double-invokes effects in dev — initRecovery
  // and startLocalSnapshotTracking are both idempotent, so that is harmless).
  useEffect(() => {
    void initRecovery();
  }, []);

  return (
    <div className="app-shell">
      <Header />
      <div className="app-body">
        <Sidebar />
        <Viewport />
      </div>
      <StatusBar />
      <CasePicker />
      <CommandPalette />
      <ShortcutsHelpOverlay />
      <OnboardingTour />
      <RecoveryPrompt />
    </div>
  );
}
