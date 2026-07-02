// Placeholder scene tree — populated once cases can load meshes (Phase 1).
import { useTranslation } from 'react-i18next';

export function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside className="sidebar">
      <h2 className="sidebar__title">{t('sidebar.sceneTreeTitle')}</h2>
      <p className="sidebar__empty">{t('sidebar.empty')}</p>
    </aside>
  );
}
