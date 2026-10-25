// packages/kernel/src/bridge/archBridge.fixture-serialize.ts
//
// TEST-ONLY canonical serializer for the CLIENT-side arch bridge case asset
// (Phase 9 Task 6): `apps/client/src/engine/archBridgeFixture.asset.json`,
// consumed by the client tests that drive the bridge built from the case. The
// asset carries the case INPUTS only — the target scan, the gingiva scan, the
// confirmed margin loops and the shared axis — never a kernel-built output:
// the client builds every unit itself through the registered jobs.
//
// The single definition of the byte format: the generator script
// (scripts/generate-client-arch-bridge-fixture.ts) and the drift guard
// (archBridge.fixture-asset.test.ts) both call this function.
import { archBridgeFixture } from './archBridge.test-fixtures.ts';

/** Canonical JSON (fixed key order, exact Float64 round-trip, one trailing newline). */
export function serializeArchBridgeFixture(): string {
  const fx = archBridgeFixture();
  const payload = {
    generator:
      'scripts/generate-client-arch-bridge-fixture.ts — archBridgeFixture() from ' +
      'packages/kernel/src/bridge/archBridge.test-fixtures.ts; regenerate with: ' +
      'npx tsx scripts/generate-client-arch-bridge-fixture.ts. Byte-guarded by ' +
      'packages/kernel/src/bridge/archBridge.fixture-asset.test.ts.',
    teeth: [14, 15, 16],
    ponticTooth: fx.ponticTooth,
    insertionAxis: [...fx.insertionAxis],
    targetScan: { positions: Array.from(fx.targetScan.positions), indices: Array.from(fx.targetScan.indices) },
    gingiva: { positions: Array.from(fx.gingiva.positions), indices: Array.from(fx.gingiva.indices) },
    abutments: fx.abutments.map((a) => ({ tooth: a.tooth, marginLoop: a.marginLoop.map((p) => [p[0], p[1], p[2]]) })),
  };
  return `${JSON.stringify(payload)}\n`;
}
