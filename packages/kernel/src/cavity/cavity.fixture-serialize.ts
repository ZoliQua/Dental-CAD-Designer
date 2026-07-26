// packages/kernel/src/cavity/cavity.fixture-serialize.ts
//
// TEST-ONLY canonical serializer for the MOD-cavity fixture (Phase 5 Task 8
// review fix) — the single definition of the byte format of the CLIENT-side
// serialized fixture asset `apps/client/src/engine/modCavityFixture.asset.json`.
//
// ## Why this exists (the drift-guard contract)
//
// The browser-lane dom test (apps/client/src/ui/CavityDesignPanel.dom.test.tsx)
// needs the analytic MOD cavity, but the layer rule bars apps/client from
// importing kernel test CODE. Task 8 originally PORTED the ~300-line
// construction into the engine layer — a silent-drift hazard (a change to
// `modCavityMesh` would diverge the copy with no test catching it). The fix:
// the client consumes a committed DATA asset generated from the kernel's OWN
// `modCavityMesh` output (data may cross the layer boundary; code may not), and
// `cavity.fixture-asset.test.ts` regenerates the serialization on every kernel
// test run and compares it byte-for-byte against the committed asset — so any
// change to `modCavityMesh`'s defaults or geometry FAILS the kernel suite until
// the asset is deliberately regenerated:
//
//   npx tsx scripts/generate-client-cavity-fixture.ts
//
// Both the generator script and the guard test call THIS function, so the
// asset's canonical byte form has exactly one definition.
//
// ## Canonical form
//
// JSON with a FIXED key order and JSON.stringify's shortest-round-trip number
// formatting (a Float64 survives JSON stringify→parse bit-exactly), terminated
// with a single trailing newline. Not exported from the kernel index (same
// test-fixture convention as cavity.test-fixtures.ts).
import type { ModCavityMesh } from './cavity.test-fixtures.ts';

/**
 * Canonical JSON serialization of a `modCavityMesh` result for the client
 * fixture asset. Deterministic: fixed key order, exact Float64 round-trip.
 */
export function serializeModCavityFixture(fx: ModCavityMesh): string {
  const payload = {
    // Provenance + regen workflow, embedded so the asset is self-describing.
    generator:
      'scripts/generate-client-cavity-fixture.ts — modCavityMesh(default params) from ' +
      'packages/kernel/src/cavity/cavity.test-fixtures.ts; regenerate with: npx tsx scripts/generate-client-cavity-fixture.ts. ' +
      'Byte-guarded by packages/kernel/src/cavity/cavity.fixture-asset.test.ts.',
    // The closed-form parameters echoed by the fixture (documentation + a
    // coarse invariant anchor for readers; the byte guard is the real check).
    params: {
      lengthMm: fx.lengthMm,
      widthMm: fx.widthMm,
      tableZ: fx.tableZ,
      floorZ: fx.floorZ,
      gingivalFloorZ: fx.gingivalFloorZ,
      isthmusHalfWidthMm: fx.isthmusHalfWidthMm,
      isthmusHalfLenMm: fx.isthmusHalfLenMm,
      boxLengthMm: fx.boxLengthMm,
      cuspZBuccal: fx.cuspZBuccal,
      cuspZLingual: fx.cuspZLingual,
    },
    vertexCount: fx.mesh.positions.length / 3,
    triangleCount: fx.mesh.indices.length / 3,
    outlinePointCount: fx.cavityOutline.length,
    positions: Array.from(fx.mesh.positions),
    indices: Array.from(fx.mesh.indices),
    cavityOutline: fx.cavityOutline.map((p) => [p[0], p[1], p[2]]),
  };
  return `${JSON.stringify(payload)}\n`;
}
