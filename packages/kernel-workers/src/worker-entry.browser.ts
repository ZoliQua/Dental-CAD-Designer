// Runs inside the browser Web Worker spawned by WorkerPool (pool.ts), via
// `new Worker(new URL('./worker-entry.browser.ts', import.meta.url), {
// type: 'module' })`. That exact literal expression lives in pool.ts, not
// here — Vite statically detects the `new Worker(new URL(...))` pattern
// wherever it appears in the module graph (including workspace-package
// source, not just app-local files) and bundles this file as a separate
// worker chunk; see pool.ts for the detection point and docs/plans/
// phase-0-foundation.md Task 4 notes for the verified `vite build` output.
//
// A Web Worker's global scope IS a valid Comlink endpoint on its own
// (`self` implements postMessage/addEventListener), so `Comlink.expose`
// needs no explicit endpoint argument here — contrast worker-entry.node.ts,
// which must wrap `parentPort` first.
import * as Comlink from 'comlink';
import { runJob } from './jobs/registry.js';

Comlink.expose(runJob);
