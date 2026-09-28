import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAuth, refreshAuth } from './engine/apiAuth';
import { startServerMonitor } from './engine/serverStatus';
import { installTestHooksIfDev } from './engine/testHooks';
import './i18n';
import './index.css';
import { App } from './ui/App';

// Task 12: dev/test-only window hooks for e2e/phase1.spec.ts — see
// engine/testHooks.ts's module doc. No-ops (does nothing) in a production
// build.
installTestHooksIfDev();

// Phase 8 Task 6: obtain the local single-user auth token once at startup
// (ADR-020 §3), so mutating requests carry it. Fire-and-forget — `authHeaders()`
// awaits this same bootstrap, so an early mutation still waits for the token; a
// disabled-gate/dev server just yields no token and everything still works.
void initAuth();

// Detect a static client-only deploy (no server behind /api — e.g. Vercel) so
// the UI can say so up front; keeps re-probing while offline, and re-runs the
// auth bootstrap if the server only came up after page load
// (engine/serverStatus.ts).
startServerMonitor({ onRecovered: () => void refreshAuth() });

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
