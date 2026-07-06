// Viewport overlay toolbar: standard-view buttons (+ numeric-key hints),
// perspective/orthographic toggle, shading preset, wireframe toggle, and
// frame all/selection. Pure React/DOM — every action either writes to
// state/viewerStore.ts (reactive settings; ui/Viewport.tsx applies them to
// SceneManager) or calls a one-shot SceneManager method directly through
// engine/viewerController.ts's `getActiveSceneManager()` (view/frame
// actions — see that module's doc for why the split).
import { useTranslation } from 'react-i18next';
import { getActiveSceneManager } from '../engine/viewerController';
import { STANDARD_VIEW_KEY_ORDER, type StandardView } from '../engine/standardViews';
import { useCaseStore } from '../state/caseStore';
import { useViewerStore, type CameraProjection, type ShadingPreset } from '../state/viewerStore';

export function ViewerToolbar() {
  const { t } = useTranslation();
  const projection = useViewerStore((state) => state.projection);
  const shadingPreset = useViewerStore((state) => state.shadingPreset);
  const wireframeEnabled = useViewerStore((state) => state.wireframeEnabled);
  const setProjection = useViewerStore((state) => state.setProjection);
  const setShadingPreset = useViewerStore((state) => state.setShadingPreset);
  const setWireframeEnabled = useViewerStore((state) => state.setWireframeEnabled);
  const selectedNodeId = useCaseStore((state) => state.selectedNodeId);

  function handleStandardView(view: StandardView): void {
    getActiveSceneManager()?.setStandardView(view);
  }

  function handleProjectionToggle(): void {
    const next: CameraProjection = projection === 'perspective' ? 'orthographic' : 'perspective';
    setProjection(next);
  }

  function handleShadingChange(preset: ShadingPreset): void {
    setShadingPreset(preset);
  }

  return (
    <div className="viewer-toolbar" data-testid="viewer-toolbar">
      <div className="viewer-toolbar__group" role="group" aria-label={t('viewer.view.groupLabel')}>
        {STANDARD_VIEW_KEY_ORDER.map((view, index) => (
          <button
            key={view}
            type="button"
            className="viewer-toolbar__button"
            title={`${t(`viewer.view.${view}`)} (${index + 1})`}
            onClick={() => handleStandardView(view)}
            data-testid={`view-button-${view}`}
          >
            {t(`viewer.view.${view}`)}
          </button>
        ))}
      </div>

      <div className="viewer-toolbar__group">
        <button
          type="button"
          className="viewer-toolbar__button"
          onClick={handleProjectionToggle}
          data-testid="projection-toggle"
        >
          {projection === 'perspective' ? t('viewer.projection.perspective') : t('viewer.projection.orthographic')}
        </button>

        <select
          className="viewer-toolbar__select"
          value={shadingPreset}
          onChange={(event) => handleShadingChange(event.target.value as ShadingPreset)}
          aria-label={t('viewer.shading.label')}
          data-testid="shading-select"
        >
          <option value="clinical">{t('viewer.shading.clinical')}</option>
          <option value="matcap">{t('viewer.shading.matcap')}</option>
        </select>

        <label className="viewer-toolbar__checkbox">
          <input
            type="checkbox"
            checked={wireframeEnabled}
            onChange={(event) => setWireframeEnabled(event.target.checked)}
            data-testid="wireframe-toggle"
          />
          {t('viewer.wireframe.toggle')}
        </label>
      </div>

      <div className="viewer-toolbar__group">
        <button
          type="button"
          className="viewer-toolbar__button"
          onClick={() => getActiveSceneManager()?.frameAll()}
          data-testid="frame-all-button"
        >
          {t('viewer.frameAll')}
        </button>
        <button
          type="button"
          className="viewer-toolbar__button"
          onClick={() => getActiveSceneManager()?.frameSelection()}
          disabled={!selectedNodeId}
          data-testid="frame-selection-button"
        >
          {t('viewer.frameSelection')}
        </button>
      </div>
    </div>
  );
}
