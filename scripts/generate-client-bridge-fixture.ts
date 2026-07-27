// scripts/generate-client-bridge-fixture.ts
//
// Phase 6 Task 7 — generates the CLIENT-side serialized 3-unit bridge fixture
// asset from the kernel's OWN `bridgeAssemblyFixture` (+ the T3 pontic-relief
// measurements + the T4 connector frames):
//
//   npx tsx scripts/generate-client-bridge-fixture.ts
//
// Output: apps/client/src/engine/bridgeFixture.asset.json — a committed TEST
// ASSET (not a golden: it carries no clinical/numerical acceptance claim; it is
// the input geometry the browser-lane dom test drives the bridge pipeline on).
// The dom test therefore consumes the EXACT kernel-built geometry — no duplicate
// client-side construction to drift.
//
// Drift guard: packages/kernel/src/bridge/bridge.fixture-asset.test.ts
// regenerates this serialization on every kernel test run and compares it
// byte-for-byte against the committed asset. The canonical byte form is defined
// ONCE, in packages/kernel/src/bridge/bridge.fixture-serialize.ts (used by both
// this script and the guard test).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serializeBridgeFixture } from '../packages/kernel/src/bridge/bridge.fixture-serialize.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetPath = join(repoRoot, 'apps', 'client', 'src', 'engine', 'bridgeFixture.asset.json');

const serialized = serializeBridgeFixture();
writeFileSync(assetPath, serialized);

const asset = JSON.parse(serialized) as {
  units: { label: string; kind: string }[];
  connectors: { label: string }[];
};
console.log(
  `wrote ${assetPath}\n` +
    `  units=${asset.units.map((u) => `${u.label}(${u.kind})`).join(',')} ` +
    `connectors=${asset.connectors.map((c) => c.label).join(',')} bytes=${Buffer.byteLength(serialized)}`,
);
