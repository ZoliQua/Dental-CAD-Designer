// Surface-distance heatmap panel (Task 9) — pick mesh A and B from the scene
// tree, run the distanceHeatmap worker job with a progress bar, show
// min/max/mean/RMS stats + a µm-ticked legend, and toggle the heatmap
// on/off in the viewport. Pure React/DOM — all computation lives in
// engine/heatmap.ts; this component only calls its exported actions and
// reads state/heatmapStore.ts (same "ui never mutates the snapshot
// directly" rule as every other panel in this file).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneNode } from '@dqcad/shared-types';
import { colorForValue } from '../engine/colormap';
import { heatmapEngine } from '../engine/heatmap';
import { useCaseStore } from '../state/caseStore';
import { useHeatmapStore, type HeatmapRange, type HeatmapStats } from '../state/heatmapStore';

const MM_TO_UM = 1000;

function mmToUm(mm: number): number {
  return Math.round(mm * MM_TO_UM);
}

function formatUm(mm: number): string {
  return `${mmToUm(mm)} µm`;
}

export function SurfaceDistancePanel() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const status = useHeatmapStore((state) => state.status);
  const progress = useHeatmapStore((state) => state.progress);
  const error = useHeatmapStore((state) => state.error);
  const stats = useHeatmapStore((state) => state.stats);
  const range = useHeatmapStore((state) => state.range);
  const autoRange = useHeatmapStore((state) => state.autoRange);
  const visible = useHeatmapStore((state) => state.visible);

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [signed, setSigned] = useState(false);

  const running = status === 'running';
  const hasResult = stats !== null && range !== null;

  function meshName(node: SceneNode): string {
    return document.meshes.find((mesh) => mesh.id === node.meshId)?.name ?? node.meshId;
  }

  function handleRun(): void {
    if (!sourceId || !targetId || running) return;
    void heatmapEngine.run(sourceId, targetId, signed);
  }

  if (document.scene.length < 2) {
    return (
      <section className="surface-distance-panel" data-testid="surface-distance-panel">
        <h2 className="surface-distance-panel__title">{t('heatmap.panelTitle')}</h2>
        <p className="surface-distance-panel__empty">{t('heatmap.needsTwoMeshes')}</p>
      </section>
    );
  }

  return (
    <section className="surface-distance-panel" data-testid="surface-distance-panel">
      <h2 className="surface-distance-panel__title">{t('heatmap.panelTitle')}</h2>
      <div className="surface-distance-panel__selectors">
        <label className="surface-distance-panel__field">
          {t('heatmap.meshALabel')}
          <select
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            data-testid="heatmap-mesh-a-select"
          >
            <option value="">{t('heatmap.selectPlaceholder')}</option>
            {document.scene.map((node) => (
              <option key={node.id} value={node.id}>
                {meshName(node)}
              </option>
            ))}
          </select>
        </label>
        <label className="surface-distance-panel__field">
          {t('heatmap.meshBLabel')}
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            data-testid="heatmap-mesh-b-select"
          >
            <option value="">{t('heatmap.selectPlaceholder')}</option>
            {document.scene.map((node) => (
              <option key={node.id} value={node.id}>
                {meshName(node)}
              </option>
            ))}
          </select>
        </label>
        <label className="surface-distance-panel__checkbox">
          <input type="checkbox" checked={signed} onChange={(event) => setSigned(event.target.checked)} />
          {t('heatmap.signedLabel')}
        </label>
        <button
          type="button"
          className="surface-distance-panel__run-button"
          onClick={handleRun}
          disabled={!sourceId || !targetId || running}
          data-testid="heatmap-run-button"
        >
          {running ? t('heatmap.running') : t('heatmap.runButton')}
        </button>
      </div>

      {running && (
        <div
          className="surface-distance-panel__progress"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="surface-distance-panel__progress-bar"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {status === 'error' && error && (
        <p className="surface-distance-panel__error">{t('heatmap.errorLabel', { message: error })}</p>
      )}

      {hasResult && (
        <SurfaceDistanceResult stats={stats} range={range} visible={visible} autoRange={autoRange} />
      )}
    </section>
  );
}

function SurfaceDistanceResult({
  stats,
  range,
  visible,
  autoRange,
}: {
  stats: HeatmapStats;
  range: HeatmapRange;
  visible: boolean;
  autoRange: boolean;
}) {
  const { t } = useTranslation();
  const [minUm, setMinUm] = useState(mmToUm(range.min));
  const [maxUm, setMaxUm] = useState(mmToUm(range.max));

  // Track the auto-computed range as it updates (a fresh run, or the
  // percentile recomputed) — but only while the panel is still in "auto"
  // mode; once the user applies a manual override this effect stops firing
  // (autoRange flips to false), so their typed values are never clobbered.
  useEffect(() => {
    if (autoRange) {
      setMinUm(mmToUm(range.min));
      setMaxUm(mmToUm(range.max));
    }
  }, [range, autoRange]);

  function applyManualRange(): void {
    heatmapEngine.setRange({ min: minUm / MM_TO_UM, max: maxUm / MM_TO_UM });
  }

  function resetToAuto(): void {
    heatmapEngine.setRange(null);
  }

  return (
    <div className="surface-distance-panel__result">
      <table className="surface-distance-panel__stats" data-testid="heatmap-stats">
        <tbody>
          <tr>
            <th>{t('heatmap.statsMin')}</th>
            <td>{formatUm(stats.min)}</td>
          </tr>
          <tr>
            <th>{t('heatmap.statsMax')}</th>
            <td>{formatUm(stats.max)}</td>
          </tr>
          <tr>
            <th>{t('heatmap.statsMean')}</th>
            <td>{formatUm(stats.mean)}</td>
          </tr>
          <tr>
            <th>{t('heatmap.statsRms')}</th>
            <td>{formatUm(stats.rms)}</td>
          </tr>
        </tbody>
      </table>

      <label className="surface-distance-panel__checkbox">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => heatmapEngine.setVisible(event.target.checked)}
          data-testid="heatmap-visible-toggle"
        />
        {t('heatmap.showToggle')}
      </label>

      <HeatmapLegend range={range} />

      <div className="surface-distance-panel__range-controls">
        <label className="surface-distance-panel__field">
          {t('heatmap.rangeMinLabel')}
          <input
            type="number"
            step={1}
            value={minUm}
            onChange={(event) => setMinUm(Number(event.target.value))}
          />
        </label>
        <label className="surface-distance-panel__field">
          {t('heatmap.rangeMaxLabel')}
          <input
            type="number"
            step={1}
            value={maxUm}
            onChange={(event) => setMaxUm(Number(event.target.value))}
          />
        </label>
        <button type="button" onClick={applyManualRange}>
          {t('heatmap.rangeManual')}
        </button>
        <button type="button" onClick={resetToAuto} disabled={autoRange}>
          {t('heatmap.rangeAuto')}
        </button>
      </div>
    </div>
  );
}

/** µm-ticked legend (Task 9's brief: "legend UI with µm tick labels (1 µm
 * resolution)") — a horizontal blue->white->red gradient bar (sampled from
 * the SAME `colorForValue` the actual heatmap colors come from, so the
 * legend can never visually disagree with the mesh) plus 5 evenly-spaced
 * tick labels, each rounded to the nearest whole µm (this project's
 * measurement display resolution — CLAUDE.md Global Constraints). */
function HeatmapLegend({ range }: { range: HeatmapRange }) {
  const { t } = useTranslation();
  const stopCount = 9;
  const stops: string[] = [];
  for (let i = 0; i <= stopCount; i++) {
    const t2 = i / stopCount;
    const value = range.min + (range.max - range.min) * t2;
    const [r, g, b] = colorForValue(value, range);
    stops.push(`rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}) ${t2 * 100}%`);
  }
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const t2 = i / (tickCount - 1);
    return range.min + (range.max - range.min) * t2;
  });

  return (
    <div className="heatmap-legend" data-testid="heatmap-legend">
      <p className="heatmap-legend__title">{t('heatmap.legendTitle')}</p>
      <div className="heatmap-legend__bar" style={{ background: `linear-gradient(to right, ${stops.join(', ')})` }} />
      <div className="heatmap-legend__ticks">
        {ticks.map((value, i) => (
          <span key={i} className="heatmap-legend__tick">
            {mmToUm(value)}
          </span>
        ))}
      </div>
    </div>
  );
}
