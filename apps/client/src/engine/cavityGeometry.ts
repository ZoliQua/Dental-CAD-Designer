// apps/client/src/engine/cavityGeometry.ts
//
// Phase 5 Task 8 (review fix) — loader for the CLIENT-side analytic MOD-cavity
// fixture used by the browser-lane critical-path test
// (ui/CavityDesignPanel.dom.test.tsx).
//
// The geometry is NOT constructed here. It is the EXACT output of the kernel's
// own TEST-ONLY `modCavityMesh` (packages/kernel/src/cavity/
// cavity.test-fixtures.ts, default parameters), serialized into the committed
// TEST ASSET `./modCavityFixture.asset.json` by
// `scripts/generate-client-cavity-fixture.ts`. The layer rule bars apps/client
// from importing kernel test CODE (ui → engine → kernel-workers → kernel), but
// DATA may cross the boundary — so the asset replaces the earlier ~300-line
// engine-side port of the construction, which was a silent-drift hazard.
//
// Drift guard: packages/kernel/src/cavity/cavity.fixture-asset.test.ts
// regenerates the canonical serialization from `modCavityMesh()` on every
// kernel test run and compares it byte-for-byte against the committed asset —
// a change to the kernel fixture FAILS that test until the asset is
// deliberately regenerated (npx tsx scripts/generate-client-cavity-fixture.ts),
// reviewed, and committed. Kernel↔client divergence cannot happen silently.
//
// Test-fixture module (used only by the dom test, never by production UI); it
// lives in engine/ so the ui test may import it under the layer rule.
import asset from './modCavityFixture.asset.json';
import type { IndexedBuffers } from './crownGeometry';

type Vec3 = readonly [number, number, number];

export interface ClientModCavity {
  mesh: IndexedBuffers;
  /** The exact cavosurface outline — an ordered closed ring, every point a mesh
   * vertex (the "margin currency" the fit/patch stages consume). */
  cavityOutline: Vec3[];
}

/**
 * The analytic MOD-cavity fixture (kernel `modCavityMesh` defaults), rebuilt
 * into typed buffers from the committed asset. Frame: X = mesiodistal, Y =
 * buccolingual, Z = occlusal-up, base z=0, insertion axis +Z. Deterministic
 * (Float64 values survive the JSON round-trip bit-exactly).
 */
export function buildModCavity(): ClientModCavity {
  return {
    mesh: {
      positions: Float64Array.from(asset.positions),
      indices: Uint32Array.from(asset.indices),
    },
    cavityOutline: asset.cavityOutline.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3),
  };
}
