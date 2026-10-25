// scripts/generate-client-arch-bridge-fixture.ts
//
// Phase 9 Task 6 — writes the client-side arch bridge case asset (the inputs
// of the bridge built from the case) from the kernel's closed-form
// `archBridgeFixture`:
//
//   npx tsx scripts/generate-client-arch-bridge-fixture.ts
//
// Output: apps/client/src/engine/archBridgeFixture.asset.json — a committed
// test asset. Drift guard: packages/kernel/src/bridge/archBridge.fixture-asset.test.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serializeArchBridgeFixture } from '../packages/kernel/src/bridge/archBridge.fixture-serialize.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetPath = join(repoRoot, 'apps', 'client', 'src', 'engine', 'archBridgeFixture.asset.json');
const serialized = serializeArchBridgeFixture();
writeFileSync(assetPath, serialized);
console.log(`wrote ${assetPath} (${Buffer.byteLength(serialized)} bytes)`);
