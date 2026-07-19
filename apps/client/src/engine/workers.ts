// Engine-owned worker pool. This is the ONLY file in apps/client allowed to
// import @dqcad/kernel-workers (lint-enforced: `ui -> engine -> state`, ui
// may not import kernel-workers directly — see eslint.config.js's
// boundaries policy). The dev smoke-test panel (ui/StatusBar.tsx) triggers
// runWorkerSmokeTest() and reads its outcome back from the zustand store
// (state/appStore.ts); it never touches the pool or @dqcad/kernel-workers
// types itself.
import { meshBuffers, WorkerPool } from '@dqcad/kernel-workers';
import { useAppStore } from '../state/appStore';

// Phase acceptance criterion (docs/plans/phase-0-foundation.md): "a worker
// round-trips a mesh buffer". 1k triangles is an arbitrary but representative
// size for the smoke test — not tied to any real case geometry.
const SMOKE_TEST_TRIANGLE_COUNT = 1000;

let pool: WorkerPool | null = null;

/**
 * The single shared WorkerPool for the whole client — smoke tests below and
 * engine/importer.ts (parseMeshFile/intakeMesh/rescaleMesh jobs) all reuse
 * this one instance rather than each spinning up their own pool of
 * (expensive to spawn) workers.
 */
export function getPool(): WorkerPool {
  pool ??= new WorkerPool();
  return pool;
}

// ---------------------------------------------------------------------------
// BVH-cache affinity — buildBvh / releaseBvh / measurePointToSurface /
// raycastMesh / distanceHeatmap (Task 7 + Task 9).
//
// Phase 2 Task 12: this used to be a dedicated, SEPARATE `size: 1`
// "measurement pool" (kept apart from `getPool()`'s general multi-worker
// geometry pool) — kernel-workers' `buildBvh`/`measurePointToSurface`/
// `raycastMesh`/`distanceHeatmap` jobs cache a mesh's BVH in THAT WORKER's
// own memory, keyed by contentHash (see jobs/bvh.ts's "Per-worker BVH
// cache" doc), and `WorkerPool.run()` used to have no notion of per-job
// worker affinity — so on a multi-worker pool a `buildBvh` call and a later
// `measurePointToSurface` call for the same mesh were not guaranteed to
// reuse the same cache. Pinning every BVH-related job to a pool that only
// ever had ONE worker made "build once, query many times" hold by
// construction, at the cost of serializing EVERY measurement/heatmap job
// (even ones for unrelated meshes) behind that single worker.
//
// Now that `WorkerPool.run()` supports `RunJobOptions.affinityKey`
// (hash-routed slot selection — see pool.ts's class doc), these jobs run on
// the SAME shared `getPool()` as every other geometry job, passing
// `affinityKey: contentHash`: a `buildBvh` call and a later
// `measurePointToSurface`/`raycastMesh`/`releaseBvh`/`distanceHeatmap` call
// for the SAME contentHash are routed to the SAME worker (queueing for that
// specific worker if it's busy, never silently falling back to a different
// one — see RunJobOptions.affinityKey's "queue, not steal" doc), while
// DIFFERENT contentHashes can now run their BVH work on DIFFERENT workers
// in parallel instead of all serializing through one dedicated worker.

/** contentHashes already confirmed built on their (affinity-routed) worker —
 * an in-memory mirror of that worker's own `bvhCache` (jobs/bvh.ts) so
 * `ensureBvhBuilt` can skip a redundant `buildBvh` round trip for a mesh
 * already queried this session. Cleared only by `releaseBvhForMesh` (mesh
 * removed from the case) — never grows unbounded beyond "meshes currently
 * live in this session", matching meshStore's own lifetime. */
const builtBvhHashes = new Set<string>();

/**
 * Ensures a BVH is cached (on `contentHash`'s affinity-routed worker) for
 * the mesh identified by `contentHash`, building it via the `buildBvh` job
 * if this is the first time this session sees that hash. `positions`/
 * `indices` should be the mesh's Float64 MASTER buffers (meshStore.ts's
 * `EngineMeshRecord`) — this function `.slice()`s them before transferring
 * the copy into the worker, so the caller's master buffers are never
 * detached (a `Transferable` transfer would otherwise steal them, breaking
 * rendering/every other consumer of that same EngineMeshRecord — see
 * jobs/bvh.ts's `BuildBvhPayload` doc for the same point from the worker
 * side).
 */
export async function ensureBvhBuilt(
  contentHash: string,
  positions: Float64Array,
  indices: Uint32Array,
): Promise<void> {
  if (builtBvhHashes.has(contentHash)) {
    return;
  }
  const positionsCopy = positions.slice();
  const indicesCopy = indices.slice();
  await getPool().run(
    'buildBvh',
    { contentHash, positions: positionsCopy, indices: indicesCopy },
    { transfer: [positionsCopy.buffer, indicesCopy.buffer], affinityKey: contentHash },
  );
  builtBvhHashes.add(contentHash);
}

/**
 * Releases a mesh's cached BVH — called from engine/caseStore.ts's
 * `removeSceneNode` alongside `meshStore.remove` (same "last reference
 * gone" lifecycle — see that method's doc), so a removed mesh's worker-side
 * BVH doesn't outlive it for the rest of the session. Fire-and-forget and a
 * no-op if this session never built a BVH for `contentHash` (skips issuing
 * a job for nothing to release). `affinityKey: contentHash` routes this to
 * the SAME worker `ensureBvhBuilt` used — required for the release to
 * actually find and evict that worker's cache entry (a different worker's
 * `bvhCache` never had it in the first place).
 */
export function releaseBvhForMesh(contentHash: string): void {
  if (!builtBvhHashes.delete(contentHash)) {
    return;
  }
  void getPool()
    .run('releaseBvh', { contentHash }, { affinityKey: contentHash })
    .catch((error: unknown) => {
      console.error('releaseBvhForMesh: releaseBvh job failed', error);
    });
}

/** TEST-ONLY: drops the "already built this session" memo so tests can
 * assert `ensureBvhBuilt` actually issues a fresh `buildBvh` call rather
 * than skipping it because an EARLIER test (same worker-process module
 * instance) happened to use the same literal contentHash. Does not destroy
 * the underlying pool/worker (mirrors `getPool()`'s own no-teardown
 * convention — spawning a worker is expensive, so the singleton persists
 * across a test file's whole run). */
export function resetBvhCacheForTests(): void {
  builtBvhHashes.clear();
}

/**
 * Deterministic (no unseeded randomness — Global Constraints) synthetic
 * mesh: `triangleCount` unconnected unit triangles, each vertex offset
 * along X/Y/Z by its index. Only used to exercise the worker round trip.
 */
function buildDeterministicMesh(triangleCount: number): {
  positions: Float64Array;
  indices: Uint32Array;
} {
  const vertexCount = triangleCount * 3;
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = v * 0.5;
    positions[v * 3 + 1] = v * 0.25;
    positions[v * 3 + 2] = v * 0.125;
    indices[v] = v;
  }
  return { positions, indices };
}

function typedArraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Generates a deterministic mesh buffer, round-trips it through the browser
 * worker pool (echoMesh), verifies byte-identity against a pre-transfer
 * copy, and publishes the outcome to the app store for the StatusBar smoke
 * panel to render.
 */
export async function runWorkerSmokeTest(): Promise<void> {
  const { setWorkerSmokeTestResult } = useAppStore.getState();
  setWorkerSmokeTestResult({ status: 'running', triangleCount: null });

  const { positions, indices } = buildDeterministicMesh(SMOKE_TEST_TRIANGLE_COUNT);
  // meshBuffers()'s transfer detaches these buffers, so snapshot the
  // expected values first.
  const expectedPositions = positions.slice();
  const expectedIndices = indices.slice();

  try {
    const { payload, transfer } = meshBuffers(positions, indices);
    const result = await getPool().run('echoMesh', payload, { transfer });
    const identical =
      typedArraysEqual(result.positions, expectedPositions) &&
      typedArraysEqual(result.indices, expectedIndices);

    setWorkerSmokeTestResult({
      status: identical ? 'success' : 'failure',
      triangleCount: SMOKE_TEST_TRIANGLE_COUNT,
    });
  } catch (err) {
    console.error('worker smoke test failed', err);
    setWorkerSmokeTestResult({ status: 'failure', triangleCount: null });
  }
}

// manifoldSmoke's own union is computed in Float32 at the manifold-3d WASM
// boundary (see packages/kernel/src/boolean/manifold.ts's @errorBound docs)
// — this only needs to be loose enough to absorb that rounding, not an exact
// equality check.
const MANIFOLD_SMOKE_TEST_TOLERANCE = 1e-4;

/**
 * Runs the manifoldSmoke job (packages/kernel-workers/src/jobs/misc.ts) in the
 * browser worker pool: builds two overlapping unit cubes, unions them via
 * manifold-3d, and checks the result against the analytic expected volume.
 * Proves manifold-3d's WASM module loads and runs inside a real browser Web
 * Worker (the Node-side equivalent is packages/kernel/src/boolean/
 * manifold.test.ts, which only exercises the main/test thread).
 */
export async function runManifoldSmokeTest(): Promise<void> {
  const { setManifoldSmokeTestResult } = useAppStore.getState();
  setManifoldSmokeTestResult({ status: 'running', volume: null });

  try {
    const result = await getPool().run('manifoldSmoke', {});
    const success = Math.abs(result.volume - result.expected) < MANIFOLD_SMOKE_TEST_TOLERANCE;
    setManifoldSmokeTestResult({
      status: success ? 'success' : 'failure',
      volume: result.volume,
    });
  } catch (err) {
    console.error('worker smoke test failed', err);
    setManifoldSmokeTestResult({ status: 'failure', volume: null });
  }
}
