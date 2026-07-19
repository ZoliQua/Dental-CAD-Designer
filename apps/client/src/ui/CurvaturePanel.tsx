// Curvature overlay panel (Phase 2 Task 3) — pick a mesh from the scene
// tree, choose H (mean) or K (Gaussian) curvature, run the computeCurvature
// worker job with a progress bar, show min/max/mean stats + a legend, and
// toggle the overlay on/off in the viewport. Pure React/DOM — all
// computation lives in engine/curvature.ts; this component only calls its
// exported actions and reads state/curvatureStore.ts (same "ui never
// mutates the snapshot directly" rule as every other panel — mirrors
// ui/SurfaceDistancePanel.tsx's structure).
//
// Scaffolding for Phase 3's margin-ridge detection — kept minimal per this
// task's brief.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneNode } from '@dqcad/shared-types';
import { colorForValue } from '../engine/colormap';
import { curvatureEngine } from '../engine/curvature';
import { useCaseStore } from '../state/caseStore';
import { useCurvatureStore, type CurvatureField, type CurvatureRange, type CurvatureStats } from '../state/curvatureStore';

export function CurvaturePanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const status = useCurvatureStore((state) => state.status);
  const progress = useCurvatureStore((state) => state.progress);
  const error = useCurvatureStore((state) => state.error);
  const stats = useCurvatureStore((state) => state.stats);
  const range = useCurvatureStore((state) => state.range);
  const autoRange = useCurvatureStore((state) => state.autoRange);
  const visible = useCurvatureStore((state) => state.visible);

  const [nodeId, setNodeId] = useState('');
  const [field, setField] = useState<CurvatureField>('H');

  const running = status === 'running';
  const hasResult = stats !== null && range !== null;

  function meshName(node: SceneNode): string {
    return document.meshes.find((mesh) => mesh.id === node.meshId)?.name ?? node.meshId;
  }

  function handleRun(): void {
    if (!nodeId || running) return;
    void curvatureEngine.run(nodeId, field);
  }

  if (document.scene.length === 0) {
    return (
      <section className="curvature-panel" data-testid="curvature-panel">
        <h2 className="curvature-panel__title">{t('curvature.panelTitle')}</h2>
        <p className="curvature-panel__empty">{t('curvature.needsMesh')}</p>
      </section>
    );
  }

  return (
    <section className="curvature-panel" data-testid="curvature-panel">
      <h2 className="curvature-panel__title">{t('curvature.panelTitle')}</h2>
      <div className="curvature-panel__selectors">
        <label className="curvature-panel__field">
          {t('curvature.meshLabel')}
          <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} data-testid="curvature-mesh-select">
            <option value="">{t('curvature.selectPlaceholder')}</option>
            {document.scene.map((node) => (
              <option key={node.id} value={node.id}>
                {meshName(node)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="curvature-panel__field-choice" data-testid="curvature-field-choice">
          <legend>{t('curvature.fieldLabel')}</legend>
          <label>
            <input
              type="radio"
              name="curvature-field"
              value="H"
              checked={field === 'H'}
              onChange={() => setField('H')}
              data-testid="curvature-field-h"
            />
            {t('curvature.fieldMean')}
          </label>
          <label>
            <input
              type="radio"
              name="curvature-field"
              value="K"
              checked={field === 'K'}
              onChange={() => setField('K')}
              data-testid="curvature-field-k"
            />
            {t('curvature.fieldGaussian')}
          </label>
        </fieldset>
        <button
          type="button"
          className="curvature-panel__run-button"
          onClick={handleRun}
          disabled={!nodeId || running}
          data-testid="curvature-run-button"
        >
          {running ? t('curvature.running') : t('curvature.runButton')}
        </button>
      </div>

      {running && (
        <div
          className="curvature-panel__progress"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="curvature-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      {status === 'error' && error && <p className="curvature-panel__error">{t('curvature.errorLabel', { message: error })}</p>}

      {hasResult && <CurvatureResultView stats={stats} range={range} visible={visible} autoRange={autoRange} field={field} />}
    </section>
  );
}

function CurvatureResultView({
  stats,
  range,
  visible,
  autoRange,
  field,
}: {
  stats: CurvatureStats;
  range: CurvatureRange;
  visible: boolean;
  autoRange: boolean;
  field: CurvatureField;
}) {
  const { t } = useTranslation();

  return (
    <div className="curvature-panel__result">
      <table className="curvature-panel__stats" data-testid="curvature-stats">
        <tbody>
          <tr>
            <th>{t('curvature.statsMin')}</th>
            <td>{stats.min.toFixed(3)}</td>
          </tr>
          <tr>
            <th>{t('curvature.statsMax')}</th>
            <td>{stats.max.toFixed(3)}</td>
          </tr>
          <tr>
            <th>{t('curvature.statsMean')}</th>
            <td>{stats.mean.toFixed(3)}</td>
          </tr>
        </tbody>
      </table>

      <label className="curvature-panel__checkbox">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => curvatureEngine.setVisible(event.target.checked)}
          data-testid="curvature-visible-toggle"
        />
        {t('curvature.showToggle')}
      </label>

      <CurvatureLegend range={range} field={field} />

      {!autoRange && (
        <button type="button" onClick={() => curvatureEngine.setRange(null)} data-testid="curvature-range-auto">
          {t('curvature.rangeAuto')}
        </button>
      )}
    </div>
  );
}

/** Same "sample colorForValue across the range" legend construction as
 * ui/SurfaceDistancePanel.tsx's `HeatmapLegend` — plain min/max ticks (no
 * µm rounding: curvature is mm^-1/mm^-2, not a mm distance, so heatmap's
 * "1 µm display resolution" convention doesn't apply here). */
function CurvatureLegend({ range, field }: { range: CurvatureRange; field: CurvatureField }) {
  const { t } = useTranslation();
  const stopCount = 9;
  const stops: string[] = [];
  for (let i = 0; i <= stopCount; i++) {
    const t2 = i / stopCount;
    const value = range.min + (range.max - range.min) * t2;
    const [r, g, b] = colorForValue(value, range);
    stops.push(`rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}) ${t2 * 100}%`);
  }
  const unit = field === 'H' ? t('curvature.unitPerMm') : t('curvature.unitPerMm2');
  return (
    <div className="curvature-legend" data-testid="curvature-legend">
      <p className="curvature-legend__title">
        {t('curvature.legendTitle')} ({unit})
      </p>
      <div className="curvature-legend__bar" style={{ background: `linear-gradient(to right, ${stops.join(', ')})` }} />
      <div className="curvature-legend__ticks">
        <span>{range.min.toFixed(2)}</span>
        <span>{range.max.toFixed(2)}</span>
      </div>
    </div>
  );
}
