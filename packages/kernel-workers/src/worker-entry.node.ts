// Runs inside the Node worker_threads Worker spawned by WorkerPool
// (pool.ts), via `new Worker(new URL('./worker-entry.node.ts',
// import.meta.url))`. Node ≥23.6 (we target Node 25) strips TypeScript
// syntax natively when loading a `.ts` file — including inside a
// worker_threads Worker, which loads this file through Node's own module
// loader, not through Vite/vitest's transform pipeline — so no build step
// or loader registration is needed for this to work under `npm test`.
//
// worker_threads' `parentPort` is a MessagePort with an `on`/`off`
// (EventEmitter-style) API, not the DOM `addEventListener`/`postMessage`
// shape Comlink expects, so it must be wrapped with Comlink's official Node
// adapter first (see comlink-node-adapter.ts for why it's imported from a
// small local wrapper rather than straight from comlink's dist file).
import { parentPort } from 'node:worker_threads';
import * as Comlink from 'comlink';
// `.ts` extensions: this file is loaded natively by Node (see the module
// doc comment above) — see tsconfig.base.json's allowImportingTsExtensions
// comment for why.
import nodeEndpoint from './comlink-node-adapter.ts';
import { runJob } from './jobs/registry.ts';

if (!parentPort) {
  throw new Error(
    'worker-entry.node.ts must run inside a worker_threads Worker (no parentPort found)',
  );
}

Comlink.expose(runJob, nodeEndpoint(parentPort));
