// UI-facing snapshot state (zustand). This is the "state" layer: it may
// depend on @dqcad/shared-types but never on engine/ (Three.js) or ui/
// (React) — the engine publishes into this store, ui/ only subscribes.
import { create } from 'zustand';

export type Theme = 'dark' | 'light';
export type Language = 'en' | 'hu' | 'de' | 'es';
/** Dev worker smoke-test panel (StatusBar) — see engine/workers.ts, which
 * owns the WorkerPool and is the only place in the client allowed to import
 * @dqcad/kernel-workers (lint-enforced). UI only reads this via the store. */
export type WorkerSmokeTestStatus = 'idle' | 'running' | 'success' | 'failure';
/** Dev manifold-3d smoke-test panel (StatusBar) — proves the manifoldSmoke
 * job (packages/kernel-workers/src/jobs/misc.ts) runs manifold-3d's WASM inside
 * the browser worker. Same idle/running/success/failure shape as
 * WorkerSmokeTestStatus, kept as a distinct type since the two tests are
 * independent and can be in different states simultaneously. */
export type ManifoldSmokeTestStatus = 'idle' | 'running' | 'success' | 'failure';

const THEME_STORAGE_KEY = 'dqcad.theme';
const LANGUAGE_STORAGE_KEY = 'dqcad.language';

// Guard on `window` rather than the bare `localStorage` global: Node 22+
// ships a global `localStorage` stub (`typeof localStorage === 'object'`)
// that throws on every method call unless explicitly enabled via a CLI
// flag, and merely *accessing* one of its methods prints a stderr warning
// ("--localstorage-file was provided without a valid path"). Gating on
// `window` means we never touch that global under Vitest's `node` test
// environment (no `window`), keeping test output clean, while still working
// correctly in a real browser.
function hasWorkingLocalStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const storage = window.localStorage;
    return typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
  } catch {
    return false;
  }
}

function readStoredTheme(): Theme {
  if (!hasWorkingLocalStorage()) {
    return 'dark';
  }
  return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

function readStoredLanguage(): Language {
  const stored = hasWorkingLocalStorage()
    ? window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    : null;
  return stored === 'hu' || stored === 'de' || stored === 'es' ? stored : 'en';
}

interface AppState {
  /** Dark/light theme, persisted in localStorage. Default: dark. */
  theme: Theme;
  /** Active UI language, persisted in localStorage. Default: en. */
  language: Language;
  /** Published by the engine (Viewport) once SceneManager has mounted. */
  engineReady: boolean;
  /** Published by the engine (engine/workers.ts) as the worker mesh
   * round-trip smoke test runs. */
  workerSmokeTestStatus: WorkerSmokeTestStatus;
  /** Triangle count from the last successful (or attempted) smoke test run;
   * null before the first run. */
  workerSmokeTestTriangleCount: number | null;
  /** Published by the engine (engine/workers.ts) as the manifold-3d WASM
   * smoke test runs. */
  manifoldSmokeTestStatus: ManifoldSmokeTestStatus;
  /** Union volume from the last successful (or attempted) manifold smoke
   * test run; null before the first run. */
  manifoldSmokeTestVolume: number | null;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: Language) => void;
  setEngineReady: (engineReady: boolean) => void;
  setWorkerSmokeTestResult: (result: {
    status: WorkerSmokeTestStatus;
    triangleCount: number | null;
  }) => void;
  setManifoldSmokeTestResult: (result: {
    status: ManifoldSmokeTestStatus;
    volume: number | null;
  }) => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: readStoredTheme(),
  language: readStoredLanguage(),
  engineReady: false,
  workerSmokeTestStatus: 'idle',
  workerSmokeTestTriangleCount: null,
  manifoldSmokeTestStatus: 'idle',
  manifoldSmokeTestVolume: null,
  setTheme: (theme) => {
    if (hasWorkingLocalStorage()) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
    set({ theme });
  },
  setLanguage: (language) => {
    if (hasWorkingLocalStorage()) {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    }
    set({ language });
  },
  setEngineReady: (engineReady) => set({ engineReady }),
  setWorkerSmokeTestResult: ({ status, triangleCount }) =>
    set({ workerSmokeTestStatus: status, workerSmokeTestTriangleCount: triangleCount }),
  setManifoldSmokeTestResult: ({ status, volume }) =>
    set({ manifoldSmokeTestStatus: status, manifoldSmokeTestVolume: volume }),
}));
