// apps/client/src/ui/AxisPanel.tsx
//
// Insertion-axis tool panel (Phase 3 Task 9): pick a restoration (must have
// a target scan + at least one confirmed margin line), auto-suggest an
// axis, manually adjust via two angle sliders (azimuth/elevation — see
// engine/axis.ts's `sphericalToDirection` doc for why this parameterization,
// not section.ts's yaw/pitch), a "try next-best" ranked-candidate list, a
// live undercut heatmap toggle, a per-abutment undercut readout table, and
// confirm. Pure React/DOM — all computation lives in engine/axis.ts; this
// component only calls its exported actions and reads state/axisStore.ts
// (same "ui never mutates the snapshot directly" rule as every other panel
// — e.g. ui/MarginPanel.tsx/ui/SectionPanel.tsx).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { axisEngine } from '../engine/axis';
import { useCaseStore } from '../state/caseStore';
import { useAxisStore } from '../state/axisStore';

const AZIMUTH_RANGE_DEG = 180;
const ELEVATION_MIN_DEG = -90;
const ELEVATION_MAX_DEG = 90;

export function AxisPanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const status = useAxisStore((state) => state.status);
  const busy = useAxisStore((state) => state.busy);
  const progress = useAxisStore((state) => state.progress);
  const error = useAxisStore((state) => state.error);
  const azimuthDeg = useAxisStore((state) => state.azimuthDeg);
  const elevationDeg = useAxisStore((state) => state.elevationDeg);
  const source = useAxisStore((state) => state.source);
  const ranked = useAxisStore((state) => state.ranked);
  const perAbutment = useAxisStore((state) => state.perAbutment);
  const heatmapVisible = useAxisStore((state) => state.heatmapVisible);
  const heatmapBusy = useAxisStore((state) => state.heatmapBusy);
  const confirmed = useAxisStore((state) => state.confirmed);

  const [pendingRestorationId, setPendingRestorationId] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const restorations = document.restorations;
  const selectedRestoration = restorations.find((r) => r.id === pendingRestorationId);

  function handleStart(): void {
    if (!pendingRestorationId) return;
    setStartError(null);
    try {
      axisEngine.start(pendingRestorationId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleCancel(): void {
    axisEngine.clear();
    setPendingRestorationId('');
    setStartError(null);
  }

  async function handleSuggest(): Promise<void> {
    setSuggestError(null);
    try {
      await axisEngine.runSuggest();
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    }
  }

  if (status === 'idle') {
    return (
      <section className="axis-panel" data-testid="axis-panel">
        <h2 className="axis-panel__title">{t('axis.panelTitle')}</h2>
        {restorations.length === 0 ? (
          <p className="axis-panel__empty">{t('axis.needsRestoration')}</p>
        ) : (
          <div className="axis-panel__selectors">
            <label className="axis-panel__field">
              {t('axis.restorationLabel')}
              <select
                value={pendingRestorationId}
                onChange={(event) => setPendingRestorationId(event.target.value)}
                data-testid="axis-restoration-select"
              >
                <option value="">{t('axis.selectPlaceholder')}</option>
                {restorations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t(`restoration.type.${r.type}`)} ({r.teeth.join(', ')})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="axis-panel__start-button"
              onClick={handleStart}
              disabled={!pendingRestorationId}
              data-testid="axis-start-button"
            >
              {t('axis.startButton')}
            </button>
            {selectedRestoration && !selectedRestoration.targetNodeId && (
              <p className="axis-panel__error">{t('axis.needsTargetScan')}</p>
            )}
            {startError && <p className="axis-panel__error">{startError}</p>}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="axis-panel" data-testid="axis-panel">
      <h2 className="axis-panel__title">{t('axis.panelTitle')}</h2>

      <button
        type="button"
        className="axis-panel__suggest-button"
        onClick={() => void handleSuggest()}
        disabled={busy}
        data-testid="axis-suggest-button"
      >
        {t('axis.suggestButton')}
      </button>

      {status === 'suggesting' && (
        <div
          className="axis-panel__progress"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="axis-progress"
        >
          <div className="axis-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{t('axis.suggesting')}</span>
        </div>
      )}

      {(error || suggestError) && (
        <p className="axis-panel__error" data-testid="axis-error">
          {t('axis.errorLabel', { message: error ?? suggestError })}
        </p>
      )}

      <p className="axis-panel__source" data-testid="axis-source">
        {t(source === 'suggested' ? 'axis.sourceSuggested' : 'axis.sourceManual')}
      </p>

      <label className="axis-panel__field">
        {t('axis.azimuthLabel')}
        <input
          type="range"
          min={-AZIMUTH_RANGE_DEG}
          max={AZIMUTH_RANGE_DEG}
          step={1}
          value={azimuthDeg}
          onChange={(event) => axisEngine.setAzimuthDeg(Number(event.target.value))}
          data-testid="axis-azimuth-slider"
        />
        <span className="axis-panel__field-value">{azimuthDeg.toFixed(0)}°</span>
      </label>

      <label className="axis-panel__field">
        {t('axis.elevationLabel')}
        <input
          type="range"
          min={ELEVATION_MIN_DEG}
          max={ELEVATION_MAX_DEG}
          step={1}
          value={elevationDeg}
          onChange={(event) => axisEngine.setElevationDeg(Number(event.target.value))}
          data-testid="axis-elevation-slider"
        />
        <span className="axis-panel__field-value">{elevationDeg.toFixed(0)}°</span>
      </label>

      <label className="axis-panel__checkbox">
        <input
          type="checkbox"
          checked={heatmapVisible}
          onChange={(event) => axisEngine.setHeatmapVisible(event.target.checked)}
          data-testid="axis-heatmap-toggle"
        />
        {t('axis.heatmapToggle')}
        {heatmapBusy && <span className="axis-panel__heatmap-busy" data-testid="axis-heatmap-busy">{t('axis.heatmapUpdating')}</span>}
      </label>

      {ranked.length > 1 && (
        <div className="axis-panel__ranked" data-testid="axis-ranked-list">
          <p className="axis-panel__ranked-title">{t('axis.rankedTitle')}</p>
          <ul>
            {ranked.slice(0, 5).map((candidate, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => void axisEngine.applyCandidate(candidate)}
                  data-testid={`axis-candidate-${index}`}
                >
                  {t('axis.candidateEntry', {
                    index: index + 1,
                    area: candidate.undercutAreaMm2.toFixed(2),
                    depth: (candidate.maxDepthMm * 1000).toFixed(0),
                  })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {perAbutment.length > 0 && (
        <table className="axis-panel__abutments" data-testid="axis-abutment-table">
          <thead>
            <tr>
              <th>{t('axis.abutmentTooth')}</th>
              <th>{t('axis.abutmentUndercutArea')}</th>
              <th>{t('axis.abutmentMaxDepth')}</th>
            </tr>
          </thead>
          <tbody>
            {perAbutment.map((readout) => (
              <tr key={readout.tooth} data-testid={`axis-abutment-row-${readout.tooth}`}>
                <td>{readout.tooth}</td>
                <td>{readout.undercutAreaMm2.toFixed(2)} mm²</td>
                <td>{(readout.maxDepthMm * 1000).toFixed(0)} µm</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmed && (
        <p className="axis-panel__confirmed" data-testid="axis-confirmed-indicator">
          {t('axis.confirmedLabel')}
        </p>
      )}

      <button
        type="button"
        className="axis-panel__confirm-button"
        onClick={() => axisEngine.confirmAxis()}
        data-testid="axis-confirm-button"
      >
        {t('axis.confirmButton')}
      </button>

      <button type="button" className="axis-panel__cancel-button" onClick={handleCancel} data-testid="axis-cancel-button">
        {t('axis.cancelButton')}
      </button>
    </section>
  );
}
