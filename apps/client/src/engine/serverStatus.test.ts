// Backend reachability probe (engine/serverStatus.ts). The fetch seam receives
// REAL `Response` objects shaped like each host the client can be deployed
// behind: the Fastify server, a static host's 404, an SPA fallback serving
// index.html, and an unreachable network.
import { beforeEach, describe, expect, it } from 'vitest';
import { useServerStatusStore } from '../state/serverStatusStore';
import {
  MONITOR_INITIAL_DELAY_MS,
  MONITOR_MAX_DELAY_MS,
  probeServer,
  startServerMonitor,
} from './serverStatus';

function respondWith(response: Response): typeof fetch {
  return () => Promise.resolve(response);
}

beforeEach(() => {
  useServerStatusStore.setState({ status: 'unknown', serverKernelVersion: null });
});

describe('probeServer', () => {
  it('online: the server health body publishes online + the server KERNEL_VERSION', async () => {
    let requestedUrl = '';
    const fetchImpl: typeof fetch = (input) => {
      requestedUrl = String(input);
      return Promise.resolve(
        Response.json({ status: 'ok', version: '0.0.0', kernelVersion: '0.27.0' }),
      );
    };
    await probeServer('/api', fetchImpl);
    expect(requestedUrl).toBe('/api/health');
    expect(useServerStatusStore.getState()).toMatchObject({
      status: 'online',
      serverKernelVersion: '0.27.0',
    });
  });

  it('offline: a static host 404 (no server behind /api)', async () => {
    await probeServer('/api', respondWith(new Response('Not Found', { status: 404 })));
    expect(useServerStatusStore.getState().status).toBe('offline');
  });

  it('offline: an SPA fallback answering 200 with index.html (non-JSON body)', async () => {
    const html = new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await probeServer('/api', respondWith(html));
    expect(useServerStatusStore.getState().status).toBe('offline');
  });

  it('offline: a 200 JSON body that is not the server health shape', async () => {
    await probeServer('/api', respondWith(Response.json({ status: 'ok' })));
    expect(useServerStatusStore.getState().status).toBe('offline');
    await probeServer('/api', respondWith(Response.json(null)));
    expect(useServerStatusStore.getState().status).toBe('offline');
  });

  it('offline: a network failure never throws out of the probe', async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(probeServer('/api', failing)).resolves.toBeUndefined();
    expect(useServerStatusStore.getState()).toMatchObject({
      status: 'offline',
      serverKernelVersion: null,
    });
  });
});

/** Manual timer seam: records scheduled re-probes; `fire()` runs the oldest. */
function manualTimers() {
  const pending: Array<{ callback: () => void; ms: number; handle: number }> = [];
  const delays: number[] = [];
  let next = 1;
  return {
    delays,
    pending,
    setTimer: (callback: () => void, ms: number) => {
      delays.push(ms);
      const handle = next++;
      pending.push({ callback, ms, handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const i = pending.findIndex((p) => p.handle === handle);
      if (i >= 0) pending.splice(i, 1);
    },
    fire: () => pending.shift()?.callback(),
  };
}

/** Lets the monitor's awaited probe settle (fetch + json microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const HEALTH_OK = () => Response.json({ status: 'ok', version: '0.0.0', kernelVersion: '0.27.0' });

describe('startServerMonitor', () => {
  it('server comes up after page load: re-probes with backoff, flips online, fires onRecovered once, then stops', async () => {
    const timers = manualTimers();
    const answers = [
      () => Promise.reject(new TypeError('ECONNREFUSED')),
      () => Promise.resolve(new Response('', { status: 502 })),
      () => Promise.resolve(HEALTH_OK()),
    ];
    let calls = 0;
    const fetchImpl: typeof fetch = () => answers[Math.min(calls++, answers.length - 1)]!();
    let recovered = 0;

    startServerMonitor({ fetchImpl, onRecovered: () => recovered++, ...timers });
    await settle();
    expect(useServerStatusStore.getState().status).toBe('offline');
    expect(timers.delays).toEqual([MONITOR_INITIAL_DELAY_MS]);

    timers.fire();
    await settle();
    expect(useServerStatusStore.getState().status).toBe('offline');
    expect(timers.delays).toEqual([MONITOR_INITIAL_DELAY_MS, MONITOR_INITIAL_DELAY_MS * 2]);

    timers.fire();
    await settle();
    expect(useServerStatusStore.getState()).toMatchObject({
      status: 'online',
      serverKernelVersion: '0.27.0',
    });
    expect(recovered).toBe(1);
    expect(timers.pending).toHaveLength(0);
    expect(calls).toBe(3);
  });

  it('server already up: one probe, no re-probe, no onRecovered', async () => {
    const timers = manualTimers();
    let recovered = 0;
    startServerMonitor({
      fetchImpl: () => Promise.resolve(HEALTH_OK()),
      onRecovered: () => recovered++,
      ...timers,
    });
    await settle();
    expect(useServerStatusStore.getState().status).toBe('online');
    expect(timers.delays).toEqual([]);
    expect(recovered).toBe(0);
  });

  it('static deploy (never a server): backoff doubles and caps', async () => {
    const timers = manualTimers();
    startServerMonitor({
      fetchImpl: () => Promise.resolve(new Response('Not Found', { status: 404 })),
      ...timers,
    });
    await settle();
    for (let i = 0; i < 6; i++) {
      timers.fire();
      await settle();
    }
    expect(timers.delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(Math.max(...timers.delays)).toBe(MONITOR_MAX_DELAY_MS);
  });

  it('the disposer cancels the pending re-probe', async () => {
    const timers = manualTimers();
    const stop = startServerMonitor({
      fetchImpl: () => Promise.resolve(new Response('', { status: 404 })),
      ...timers,
    });
    await settle();
    expect(timers.pending).toHaveLength(1);
    stop();
    expect(timers.pending).toHaveLength(0);
  });
});
