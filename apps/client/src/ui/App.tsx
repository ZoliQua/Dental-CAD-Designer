import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/appStore';
import { Header } from './Header';
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

  return (
    <div className="app-shell">
      <Header />
      <div className="app-body">
        <Sidebar />
        <Viewport />
      </div>
      <StatusBar />
    </div>
  );
}
