// Offline banner: shown only when the startup probe (engine/serverStatus.ts)
// found no server behind `/api` — i.e. the static client-only deploy. States
// honestly which features need the local server instead of letting the case
// picker / export release fail with raw HTTP errors later.
import { useTranslation } from 'react-i18next';
import { useServerStatusStore } from '../state/serverStatusStore';

export function ServerStatusBanner() {
  const { t } = useTranslation();
  const status = useServerStatusStore((state) => state.status);

  // The live region is ALWAYS mounted (it is also the app-shell's second grid
  // row, 0 px tall when empty) so assistive tech announces the banner when the
  // probe settles to offline; only its content is conditional.
  return (
    <div className="server-status-region" role="status">
      {status === 'offline' ? (
        <div className="server-status-banner" data-testid="server-offline-banner">
          <strong className="server-status-banner__title">{t('serverStatus.offlineTitle')}</strong>
          <span className="server-status-banner__body">{t('serverStatus.offlineBody')}</span>
        </div>
      ) : null}
    </div>
  );
}
