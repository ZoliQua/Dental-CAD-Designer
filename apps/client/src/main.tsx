import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestHooksIfDev } from './engine/testHooks';
import './i18n';
import './index.css';
import { App } from './ui/App';

// Task 12: dev/test-only window hooks for e2e/phase1.spec.ts — see
// engine/testHooks.ts's module doc. No-ops (does nothing) in a production
// build.
installTestHooksIfDev();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
