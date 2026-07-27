// Scene tree — one row per SceneNode: name (via its MeshAsset), role,
// visibility toggle, opacity slider, remove button. Reads the published
// CaseDocument snapshot (state/caseStore.ts); every mutation goes back
// through engine/caseStore.ts's imperative methods (ui never mutates the
// snapshot directly).
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshAsset, SceneNode } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import { AlignmentPanel } from './AlignmentPanel';
import { AxisPanel } from './AxisPanel';
import { CavityDesignPanel } from './CavityDesignPanel';
import { BridgeDesignPanel } from './BridgeDesignPanel';
import { CrownDesignPanel } from './CrownDesignPanel';
import { CurvaturePanel } from './CurvaturePanel';
import { ImportPanel } from './ImportPanel';
import { MarginPanel } from './MarginPanel';
import { MeasurementPanel } from './MeasurementPanel';
import { RepairPanel } from './RepairPanel';
import { RestorationWizard } from './RestorationWizard';
import { SectionPanel } from './SectionPanel';
import { SurfaceDistancePanel } from './SurfaceDistancePanel';
import { useCaseStore } from '../state/caseStore';

export function Sidebar() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);

  return (
    <aside className="sidebar">
      <ImportPanel />
      <h2 className="sidebar__title">{t('sidebar.sceneTreeTitle')}</h2>
      {document.scene.length === 0 ? (
        <p className="sidebar__empty">{t('sidebar.empty')}</p>
      ) : (
        <ul className="scene-tree">
          {document.scene.map((node) => (
            <SceneTreeRow
              key={node.id}
              node={node}
              meshName={findMeshName(document.meshes, node.meshId)}
            />
          ))}
        </ul>
      )}
      <RestorationWizard />
      <MarginPanel />
      <AxisPanel />
      <CrownDesignPanel />
      <CavityDesignPanel />
      <BridgeDesignPanel />
      <MeasurementPanel />
      <AlignmentPanel />
      <SurfaceDistancePanel />
      <CurvaturePanel />
      <SectionPanel />
    </aside>
  );
}

function findMeshName(meshes: readonly MeshAsset[], meshId: string): string {
  return meshes.find((mesh) => mesh.id === meshId)?.name ?? meshId;
}

function SceneTreeRow({ node, meshName }: { node: SceneNode; meshName: string }) {
  const { t } = useTranslation();

  function handleVisibilityToggle(): void {
    caseStore.setSceneNodeVisibility(node.id, !node.visible);
  }

  function handleOpacityChange(event: ChangeEvent<HTMLInputElement>): void {
    caseStore.setSceneNodeOpacity(node.id, Number(event.target.value));
  }

  function handleRemove(): void {
    caseStore.removeSceneNode(node.id);
  }

  return (
    <li className="scene-tree__row" data-testid="scene-tree-row">
      <label className="scene-tree__visibility" title={t('sidebar.visibilityToggle')}>
        <input type="checkbox" checked={node.visible} onChange={handleVisibilityToggle} />
      </label>
      <span className="scene-tree__name">{meshName}</span>
      <span className="scene-tree__role">{t(`role.${node.role}`)}</span>
      <input
        className="scene-tree__opacity"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={node.opacity}
        onChange={handleOpacityChange}
        title={t('sidebar.opacityLabel')}
        aria-label={t('sidebar.opacityLabel')}
      />
      <button
        type="button"
        className="scene-tree__remove"
        onClick={handleRemove}
        aria-label={t('sidebar.removeButton')}
      >
        ×
      </button>
      <div className="scene-tree__repair">
        <RepairPanel meshId={node.meshId} />
      </div>
    </li>
  );
}
