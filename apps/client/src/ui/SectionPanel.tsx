// Cross-section tool panel (Task 10) — enable toggle, axis-aligned presets
// (X/Y/Z through the current scene bbox center) + arbitrary-plane sliders
// (position along the normal, two rotation angles), cap/clip toggles, a
// point-count/status readout, and an SVG download button. Pure React/DOM —
// all computation lives in engine/section.ts; this component only calls its
// exported actions and reads state/sectionStore.ts (same "ui never mutates
// the snapshot directly" rule as every other panel).
import { useTranslation } from 'react-i18next';
import { sectionEngine } from '../engine/section';
import { useCaseStore } from '../state/caseStore';
import { useSectionStore, type SectionAxis } from '../state/sectionStore';

const AXIS_PRESETS: ReadonlyArray<Exclude<SectionAxis, 'custom'>> = ['x', 'y', 'z'];
const OFFSET_RANGE_MM = 50;
const ANGLE_RANGE_DEG = 180;

export function SectionPanel() {
  const { t } = useTranslation();
  const sceneCount = useCaseStore((state) => state.document.scene.length);
  const enabled = useSectionStore((state) => state.enabled);
  const axis = useSectionStore((state) => state.axis);
  const offsetMm = useSectionStore((state) => state.offsetMm);
  const yawDeg = useSectionStore((state) => state.yawDeg);
  const pitchDeg = useSectionStore((state) => state.pitchDeg);
  const showCap = useSectionStore((state) => state.showCap);
  const clipEnabled = useSectionStore((state) => state.clipEnabled);
  const status = useSectionStore((state) => state.status);
  const error = useSectionStore((state) => state.error);
  const pointCount = useSectionStore((state) => state.pointCount);

  if (sceneCount === 0) {
    return (
      <section className="section-panel" data-testid="section-panel">
        <h2 className="section-panel__title">{t('section.panelTitle')}</h2>
        <p className="section-panel__empty">{t('section.needsMesh')}</p>
      </section>
    );
  }

  return (
    <section className="section-panel" data-testid="section-panel">
      <h2 className="section-panel__title">{t('section.panelTitle')}</h2>
      <label className="section-panel__checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => sectionEngine.setEnabled(event.target.checked)}
          data-testid="section-enabled-toggle"
        />
        {t('section.enableToggle')}
      </label>

      {enabled && (
        <>
          <div className="section-panel__axis-buttons" role="group" aria-label={t('section.axisGroupLabel')}>
            {AXIS_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={axis === preset ? 'section-panel__axis-button section-panel__axis-button--active' : 'section-panel__axis-button'}
                onClick={() => sectionEngine.setAxisPreset(preset)}
                data-testid={`section-axis-${preset}`}
              >
                {t(`section.axis.${preset}`)}
              </button>
            ))}
            <button
              key="custom"
              type="button"
              className={axis === 'custom' ? 'section-panel__axis-button section-panel__axis-button--active' : 'section-panel__axis-button'}
              onClick={() => sectionEngine.useCustomPlane()}
              data-testid="section-axis-custom"
            >
              {t('section.axis.custom')}
            </button>
          </div>

          <label className="section-panel__field">
            {t('section.offsetLabel')}
            <input
              type="range"
              min={-OFFSET_RANGE_MM}
              max={OFFSET_RANGE_MM}
              step={0.1}
              value={offsetMm}
              onChange={(event) => sectionEngine.setOffsetMm(Number(event.target.value))}
              data-testid="section-offset-slider"
            />
            <span className="section-panel__field-value">{offsetMm.toFixed(1)} mm</span>
          </label>

          <label className="section-panel__field">
            {t('section.yawLabel')}
            <input
              type="range"
              min={-ANGLE_RANGE_DEG}
              max={ANGLE_RANGE_DEG}
              step={1}
              value={yawDeg}
              onChange={(event) => sectionEngine.setYawDeg(Number(event.target.value))}
              data-testid="section-yaw-slider"
            />
            <span className="section-panel__field-value">{yawDeg.toFixed(0)}°</span>
          </label>

          <label className="section-panel__field">
            {t('section.pitchLabel')}
            <input
              type="range"
              min={-ANGLE_RANGE_DEG}
              max={ANGLE_RANGE_DEG}
              step={1}
              value={pitchDeg}
              onChange={(event) => sectionEngine.setPitchDeg(Number(event.target.value))}
              data-testid="section-pitch-slider"
            />
            <span className="section-panel__field-value">{pitchDeg.toFixed(0)}°</span>
          </label>
          <p className="section-panel__help" data-testid="section-pitch-help">
            {t('section.pitchHelp')}
          </p>

          <label className="section-panel__checkbox">
            <input
              type="checkbox"
              checked={showCap}
              onChange={(event) => sectionEngine.setShowCap(event.target.checked)}
              data-testid="section-cap-toggle"
            />
            {t('section.showCapToggle')}
          </label>

          <label className="section-panel__checkbox">
            <input
              type="checkbox"
              checked={clipEnabled}
              onChange={(event) => sectionEngine.setClipEnabled(event.target.checked)}
              data-testid="section-clip-toggle"
            />
            {t('section.clipToggle')}
          </label>

          {status === 'running' && <p className="section-panel__status">{t('section.running')}</p>}
          {status === 'error' && error && (
            <p className="section-panel__error">{t('section.errorLabel', { message: error })}</p>
          )}
          {status === 'idle' && (
            <p className="section-panel__status" data-testid="section-point-count">
              {t('section.pointCount', { count: pointCount })}
            </p>
          )}

          <button
            type="button"
            className="section-panel__export-button"
            onClick={() => sectionEngine.downloadSvg()}
            disabled={pointCount === 0}
            data-testid="section-export-svg-button"
          >
            {t('section.exportSvgButton')}
          </button>
        </>
      )}
    </section>
  );
}
