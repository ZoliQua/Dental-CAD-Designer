// Results panel: lists every measurement in the current case, µm-resolution
// formatted (formatMm.ts), deletable. Reads the published CaseDocument
// snapshot (state/caseStore.ts); deletion goes back through
// engine/caseStore.ts's imperative `removeMeasurement` (ui never mutates the
// snapshot directly — same rule as ui/Sidebar.tsx's scene tree).
import { useTranslation } from 'react-i18next';
import type { Measurement } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import { formatMeasurementValueText } from '../engine/measurementValueText';
import { useCaseStore } from '../state/caseStore';

export function MeasurementPanel() {
  const { t } = useTranslation();
  const measurements = useCaseStore((state) => state.document.measurements);

  return (
    <section className="measurement-panel">
      <h2 className="measurement-panel__title">{t('measure.panelTitle')}</h2>
      {measurements.length === 0 ? (
        <p className="measurement-panel__empty">{t('measure.empty')}</p>
      ) : (
        <ul className="measurement-list">
          {measurements.map((measurement) => (
            <MeasurementRow key={measurement.id} measurement={measurement} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MeasurementRow({ measurement }: { measurement: Measurement }) {
  const { t } = useTranslation();
  const valueText = formatMeasurementValueText(measurement, (degreesValue) =>
    t('measure.angleValue', { degrees: degreesValue.toFixed(1) }),
  );

  return (
    <li className="measurement-list__row" data-testid="measurement-row">
      <span className="measurement-list__kind">{t(`measure.kind.${measurement.kind}`)}</span>
      <span className="measurement-list__value">{valueText}</span>
      <button
        type="button"
        className="measurement-list__remove"
        onClick={() => caseStore.removeMeasurement(measurement.id)}
        aria-label={t('measure.deleteButton')}
        data-testid="measurement-delete-button"
      >
        ×
      </button>
    </li>
  );
}
