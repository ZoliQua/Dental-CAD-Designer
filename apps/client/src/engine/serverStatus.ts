// apps/client/src/engine/serverStatus.ts
//
// Backend reachability probe. The client can be deployed as a static SPA with
// NO server behind `/api` (the Vercel deploy — see README "Deployment"). The
// server is deliberately a loopback-bound, local single-user service (ADR-020)
// and must not be exposed publicly as-is, so the static deploy is a
// client-only mode rather than a broken one: this probe detects it at startup
// so the UI can say so up front instead of surfacing raw 404s from the case
// picker or the export release.
//
// "No answer" is NOT final: under `npm run dev` Vite serves the page before
// Fastify is listening (migrate + tsx watch start slower), and a tsx-watch
// restart can race a reload. `startServerMonitor` therefore keeps re-probing
// with capped backoff while offline and flips to `online` as soon as the server
// answers (then stops — a server that dies mid-session is surfaced by the
// existing save/export error paths, not by this monitor).
//
// Same opt-in shape as apiAuth.ts: only the real app entry (`main.tsx`) starts
// the monitor, so test harnesses keep the store at `unknown` (no banner, no
// gating — unchanged behavior).
import { useServerStatusStore } from '../state/serverStatusStore';

const HEALTH_PATH = '/health';

/** Narrows the server's typed health body (apps/server/src/schemas.ts
 * `healthResponseSchema`). A static host answers `/api/health` with a 404 or,
 * behind an SPA fallback, with `index.html` — neither passes this check. */
function isHealthBody(value: unknown): value is { status: 'ok'; kernelVersion: string } {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return body.status === 'ok' && typeof body.kernelVersion === 'string';
}

/**
 * Probes `GET {apiBase}/health` once and publishes `online` / `offline` to
 * `useServerStatusStore`. Never throws: any network error, non-2xx status, or
 * non-health body resolves to `offline`.
 */
export async function probeServer(
  apiBase = '/api',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { setStatus } = useServerStatusStore.getState();
  try {
    const response = await fetchImpl(`${apiBase}${HEALTH_PATH}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      setStatus('offline');
      return;
    }
    const body: unknown = await response.json();
    if (isHealthBody(body)) {
      setStatus('online', body.kernelVersion);
    } else {
      setStatus('offline');
    }
  } catch {
    setStatus('offline');
  }
}

/** First re-probe delay after an offline result; doubles up to the cap. */
export const MONITOR_INITIAL_DELAY_MS = 2_000;
export const MONITOR_MAX_DELAY_MS = 30_000;

export interface ServerMonitorOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Called once when the status transitions to `online` after having been
   * `offline` — e.g. to re-run the auth bootstrap, which found no server at
   * startup and would otherwise leave every mutation unauthenticated (401). */
  onRecovered?: () => void;
  /** Timer seam (tests). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Probes now, then — while the result is `offline` — re-probes with capped
 * exponential backoff until the server answers. Returns a disposer that stops
 * any pending re-probe. Idempotent per call site (main.tsx calls it once).
 */
export function startServerMonitor(options: ServerMonitorOptions = {}): () => void {
  const {
    apiBase = '/api',
    fetchImpl = fetch,
    onRecovered,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;
  let delayMs = MONITOR_INITIAL_DELAY_MS;
  let handle: unknown = null;
  let stopped = false;
  let wasOffline = false;

  const tick = async (): Promise<void> => {
    handle = null;
    await probeServer(apiBase, fetchImpl);
    if (stopped) return;
    const { status } = useServerStatusStore.getState();
    if (status === 'offline') {
      wasOffline = true;
      handle = setTimer(() => void tick(), delayMs);
      delayMs = Math.min(delayMs * 2, MONITOR_MAX_DELAY_MS);
    } else if (status === 'online' && wasOffline) {
      onRecovered?.();
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (handle !== null) clearTimer(handle);
  };
}
