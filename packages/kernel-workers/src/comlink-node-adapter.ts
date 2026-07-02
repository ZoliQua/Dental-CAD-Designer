// Comlink 4.4.2 ships no "exports" map in its package.json, so the
// documented `comlink/node-adapter` subpath specifier doesn't resolve under
// Node/bundler ESM resolution (verified empirically) — only the concrete
// dist file does. That file ships a sibling `.d.ts`, but under
// `moduleResolution: "bundler"` TypeScript doesn't pair a `.d.ts` with a
// same-directory `.mjs` file (different extension), so the import below is
// implicitly `any`.
//
// This is deliberately a real module (not a `declare module` ambient
// augmentation) that re-exports a properly-typed wrapper: an ambient
// declaration would only be visible inside a tsc *program* that happens to
// include this file via its own "include" globs, which breaks the moment a
// different package (e.g. apps/client) transitively imports this one under
// its own tsconfig. A concrete typed export works everywhere it's imported,
// regardless of which tsconfig is doing the compiling.
import type { Endpoint } from 'comlink';
// @ts-expect-error — no declaration file ships for this subpath; see the
// module doc above. Typed via the wrapper below.
import nodeEndpointUntyped from 'comlink/dist/esm/node-adapter.mjs';

export interface NodeEndpoint {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(type: string, listener: (...args: unknown[]) => void, options?: object): void;
  off(type: string, listener: (...args: unknown[]) => void, options?: object): void;
  start?: () => void;
}

const nodeEndpoint = nodeEndpointUntyped as (nep: NodeEndpoint) => Endpoint;

export default nodeEndpoint;
