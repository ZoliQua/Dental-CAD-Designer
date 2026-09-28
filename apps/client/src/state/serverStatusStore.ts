// UI-facing snapshot of the backend reachability probe (engine/serverStatus.ts)
// — same layering pattern as persistenceStore.ts: pure state, no engine/ or ui/
// dependency. The engine publishes here; ui/ only reads.
import { create } from 'zustand';

/**
 * `unknown` — the probe has not settled yet (or was never started, e.g. tests).
 *   The UI treats this exactly like before this store existed: no banner, no
 *   gating — so a slow server never flashes an "offline" warning.
 * `online` — `GET /api/health` answered with the server's typed health body.
 * `offline` — no server behind `/api` (e.g. the static-only Vercel deploy):
 *   cases, saving, server-validated export and archives are unavailable; import,
 *   viewing, analysis and design still run fully client-side in the workers.
 */
export type ServerStatus = 'unknown' | 'online' | 'offline';

interface ServerStatusState {
  status: ServerStatus;
  /** The server's KERNEL_VERSION when `online`, else `null`. */
  serverKernelVersion: string | null;
  setStatus: (status: ServerStatus, serverKernelVersion?: string | null) => void;
}

export const useServerStatusStore = create<ServerStatusState>((set) => ({
  status: 'unknown',
  serverKernelVersion: null,
  setStatus: (status, serverKernelVersion = null) => set({ status, serverKernelVersion }),
}));
