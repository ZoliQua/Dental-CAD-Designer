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
 * Runs the manifoldSmoke job (packages/kernel-workers/src/jobs.ts) in the
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
