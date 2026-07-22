// Visual 2x16 FDI tooth chart (Phase 3 Task 2, docs/plans/phase-3-margin-axis.md)
// — quadrant-correct, React-Odontogram-Modul-style two-row grid. Purely
// presentational: layout/state-derivation logic lives in
// engine/fdiChart.ts's pure helpers (`fdiChartLayout`/`toothStateFor`) so it
// stays unit-testable without mounting this component; this component only
// renders those results and forwards clicks to `onToothClick`.
import { useTranslation } from 'react-i18next';
import type { FdiTooth } from '@dqcad/shared-types';
import { fdiChartLayout, toothStateFor, type ToothSelectionState } from '../engine/fdiChart';

export interface FdiToothChartProps {
  teeth: readonly FdiTooth[];
  /** Bridge-only — see `Restoration.pontics`' doc (shared-types). Pass `[]`
   * for non-bridge restoration types (no pontic concept there). */
  pontics: readonly FdiTooth[];
  onToothClick: (tooth: FdiTooth) => void;
}

const STATE_CLASS: Record<ToothSelectionState, string> = {
  none: 'fdi-tooth--none',
  abutment: 'fdi-tooth--abutment',
  pontic: 'fdi-tooth--pontic',
};

export function FdiToothChart({ teeth, pontics, onToothClick }: FdiToothChartProps) {
  const { t } = useTranslation();
  const { upperRow, lowerRow } = fdiChartLayout();

  return (
    <div className="fdi-chart" data-testid="fdi-chart">
      <div className="fdi-chart__row fdi-chart__row--upper" data-testid="fdi-chart-row-upper">
        {upperRow.map((tooth) => (
          <ToothButton
            key={tooth}
            tooth={tooth}
            teeth={teeth}
            pontics={pontics}
            onToothClick={onToothClick}
          />
        ))}
      </div>
      <div className="fdi-chart__row fdi-chart__row--lower" data-testid="fdi-chart-row-lower">
        {lowerRow.map((tooth) => (
          <ToothButton
            key={tooth}
            tooth={tooth}
            teeth={teeth}
            pontics={pontics}
            onToothClick={onToothClick}
          />
        ))}
      </div>
      <div className="fdi-chart__legend">
        <span className="fdi-chart__legend-item">
          <span className={`fdi-chart__swatch ${STATE_CLASS.abutment}`} />{' '}
          {t('restoration.chart.abutment')}
        </span>
        <span className="fdi-chart__legend-item">
          <span className={`fdi-chart__swatch ${STATE_CLASS.pontic}`} />{' '}
          {t('restoration.chart.pontic')}
        </span>
      </div>
    </div>
  );
}

function ToothButton({
  tooth,
  teeth,
  pontics,
  onToothClick,
}: {
  tooth: FdiTooth;
  teeth: readonly FdiTooth[];
  pontics: readonly FdiTooth[];
  onToothClick: (tooth: FdiTooth) => void;
}) {
  const state = toothStateFor(tooth, teeth, pontics);
  return (
    <button
      type="button"
      className={`fdi-tooth ${STATE_CLASS[state]}`}
      onClick={() => onToothClick(tooth)}
      aria-pressed={state !== 'none'}
      data-testid={`fdi-tooth-${tooth}`}
      data-state={state}
    >
      {tooth}
    </button>
  );
}
