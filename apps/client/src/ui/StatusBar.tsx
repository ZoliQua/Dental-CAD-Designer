import { useTranslation } from 'react-i18next';
// engine/workers.ts, not @dqcad/kernel-workers directly — ui may not import
// kernel-workers (lint-enforced boundaries policy). The pool instance and
// its result both live outside ui/; this button only triggers the run and
// reads the outcome back from the store.
import { runManifoldSmokeTest, runWorkerSmokeTest } from '../engine/workers';
import { useAppStore } from '../state/appStore';

export function StatusBar() {
  const { t } = useTranslation();
  const engineReady = useAppStore((state) => state.engineReady);
  const workerSmokeTestStatus = useAppStore((state) => state.workerSmokeTestStatus);
  const workerSmokeTestTriangleCount = useAppStore((state) => state.workerSmokeTestTriangleCount);
  const manifoldSmokeTestStatus = useAppStore((state) => state.manifoldSmokeTestStatus);
  const manifoldSmokeTestVolume = useAppStore((state) => state.manifoldSmokeTestVolume);

  const workerStatusLabel = (() => {
    switch (workerSmokeTestStatus) {
      case 'running':
        return t('statusBar.workerSmokeTestRunning');
      case 'success':
        return t('statusBar.workerSmokeTestSuccess', {
          count: workerSmokeTestTriangleCount ?? 0,
        });
      case 'failure':
        return t('statusBar.workerSmokeTestFailure');
      case 'idle':
      default:
        return t('statusBar.workerSmokeTestPending');
    }
  })();

  const manifoldStatusLabel = (() => {
    switch (manifoldSmokeTestStatus) {
      case 'running':
        return t('statusBar.manifoldSmokeTestRunning');
      case 'success':
        return t('statusBar.manifoldSmokeTestSuccess', {
          volume: manifoldSmokeTestVolume?.toFixed(3) ?? '0',
        });
      case 'failure':
        return t('statusBar.manifoldSmokeTestFailure');
      case 'idle':
      default:
        return t('statusBar.manifoldSmokeTestPending');
    }
  })();

  return (
    <footer className="status-bar">
      <span className="status-bar__engine">
        {engineReady ? t('statusBar.engineReady') : t('statusBar.engineInitializing')}
      </span>
      <span className="status-bar__worker">
        <button
          type="button"
          className="status-bar__worker-button"
          data-testid="worker-smoke-test-button"
          disabled={workerSmokeTestStatus === 'running'}
          onClick={() => void runWorkerSmokeTest()}
        >
          {t('statusBar.workerSmokeTestButton')}
        </button>
        <span data-testid="worker-smoke-test-status">{workerStatusLabel}</span>
      </span>
      <span className="status-bar__manifold">
        <button
          type="button"
          className="status-bar__manifold-button"
          data-testid="manifold-smoke-test-button"
          disabled={manifoldSmokeTestStatus === 'running'}
          onClick={() => void runManifoldSmokeTest()}
        >
          {t('statusBar.manifoldSmokeTestButton')}
        </button>
        <span data-testid="manifold-smoke-test-status">{manifoldStatusLabel}</span>
      </span>
    </footer>
  );
}
