import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './appStore';

// Reset to the documented defaults before each test so tests don't leak
// state through the module-level store singleton.
beforeEach(() => {
  useAppStore.setState({
    theme: 'dark',
    language: 'en',
    engineReady: false,
    workerSmokeTestStatus: 'idle',
    workerSmokeTestTriangleCount: null,
    manifoldSmokeTestStatus: 'idle',
    manifoldSmokeTestVolume: null,
  });
});

describe('useAppStore', () => {
  it('defaults to dark theme, english, and engine not ready', () => {
    const state = useAppStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.language).toBe('en');
    expect(state.engineReady).toBe(false);
    expect(state.workerSmokeTestStatus).toBe('idle');
    expect(state.workerSmokeTestTriangleCount).toBeNull();
    expect(state.manifoldSmokeTestStatus).toBe('idle');
    expect(state.manifoldSmokeTestVolume).toBeNull();
  });

  it('setTheme updates the theme', () => {
    useAppStore.getState().setTheme('light');
    expect(useAppStore.getState().theme).toBe('light');
  });

  it('setLanguage updates the language', () => {
    useAppStore.getState().setLanguage('hu');
    expect(useAppStore.getState().language).toBe('hu');
  });

  it('setEngineReady flips the engineReady flag', () => {
    expect(useAppStore.getState().engineReady).toBe(false);
    useAppStore.getState().setEngineReady(true);
    expect(useAppStore.getState().engineReady).toBe(true);
    useAppStore.getState().setEngineReady(false);
    expect(useAppStore.getState().engineReady).toBe(false);
  });

  it('setWorkerSmokeTestResult updates status and triangle count', () => {
    useAppStore.getState().setWorkerSmokeTestResult({ status: 'running', triangleCount: null });
    expect(useAppStore.getState().workerSmokeTestStatus).toBe('running');
    expect(useAppStore.getState().workerSmokeTestTriangleCount).toBeNull();

    useAppStore.getState().setWorkerSmokeTestResult({ status: 'success', triangleCount: 1000 });
    expect(useAppStore.getState().workerSmokeTestStatus).toBe('success');
    expect(useAppStore.getState().workerSmokeTestTriangleCount).toBe(1000);
  });

  it('setManifoldSmokeTestResult updates status and volume', () => {
    useAppStore.getState().setManifoldSmokeTestResult({ status: 'running', volume: null });
    expect(useAppStore.getState().manifoldSmokeTestStatus).toBe('running');
    expect(useAppStore.getState().manifoldSmokeTestVolume).toBeNull();

    useAppStore.getState().setManifoldSmokeTestResult({ status: 'success', volume: 1.5 });
    expect(useAppStore.getState().manifoldSmokeTestStatus).toBe('success');
    expect(useAppStore.getState().manifoldSmokeTestVolume).toBe(1.5);
  });
});
