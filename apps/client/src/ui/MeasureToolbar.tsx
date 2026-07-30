// Measurement tool launcher: one button per measurement kind, a "picked N
// of M" instructional hint while a tool is active, and a cancel button.
// Pure React/DOM — all pick handling lives in engine/ToolManager.ts; this
// component only calls its exported actions and reads state/toolStore.ts.
import { useTranslation } from 'react-i18next';
import type { MeasurementKind } from '@dqcad/shared-types';
import { REQUIRED_POINT_COUNT, toolManager } from '../engine/ToolManager';
import { useToolStore } from '../state/toolStore';

const TOOL_KINDS: readonly MeasurementKind[] = ['pointToPoint', 'pointToSurface', 'angle'];

export function MeasureToolbar() {
  const { t } = useTranslation();
  const activeTool = useToolStore((state) => state.activeTool);
  const pendingPointCount = useToolStore((state) => state.pendingPointCount);
  const busy = useToolStore((state) => state.busy);
  const error = useToolStore((state) => state.error);

  return (
    <div className="measure-toolbar" data-testid="measure-toolbar">
      <div className="measure-toolbar__group" role="group" aria-label={t('measure.toolGroupLabel')}>
        {TOOL_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="measure-toolbar__button"
            aria-pressed={activeTool === kind}
            onClick={() => toolManager.startTool(kind)}
            data-testid={`measure-tool-${kind}`}
          >
            {t(`measure.${kind}`)}
          </button>
        ))}
        {activeTool && (
          <button
            type="button"
            className="measure-toolbar__cancel"
            onClick={() => toolManager.cancelTool()}
            data-testid="measure-cancel-button"
          >
            {t('measure.cancelButton')}
          </button>
        )}
      </div>
      {activeTool && (
        <p className="measure-toolbar__hint" data-testid="measure-hint">
          {t('measure.instruction', {
            picked: pendingPointCount,
            required: REQUIRED_POINT_COUNT[activeTool],
          })}
          {busy ? '…' : ''}
        </p>
      )}
      {error && (
        // `toolStore.error` is the RAW engine/worker message (ToolManager stays
        // i18n-free per the layer rule) — wrap it in a translated frame here, at
        // the UI boundary, so non-EN dentists never see bare English.
        <p className="measure-toolbar__error">{t('measure.toolError', { message: error })}</p>
      )}
    </div>
  );
}
