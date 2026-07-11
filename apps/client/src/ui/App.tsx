import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { saveActiveCase } from '../engine/persistence';
import { useAppStore } from '../state/appStore';
import { CasePicker } from './CasePicker';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Viewport } from './Viewport';

/** True for the platform's "save" chord: Cmd+S on macOS, Ctrl+S elsewhere —
 * `event.metaKey` is the Command key on macOS (and never set on
 * Windows/Linux keyboards, where Ctrl is what's pressed instead). */
function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's';
}

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

  // Task 11: manual save (Cmd/Ctrl+S) — prevents the browser's own
  // "save page" dialog and calls the same `save()` engine/persistence.ts
  // uses for autosave (see that module's doc for why they're one function).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      void saveActiveCase();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
    </div>
  );
}
