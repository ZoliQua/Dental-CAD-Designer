// scripts/generate-client-cavity-fixture.ts
//
// Phase 5 Task 8 (review fix) — generates the CLIENT-side serialized MOD-cavity
// fixture asset from the kernel's OWN `modCavityMesh` (default parameters):
//
//   npx tsx scripts/generate-client-cavity-fixture.ts
//
// Output: apps/client/src/engine/modCavityFixture.asset.json — a committed TEST
// ASSET (not a golden: it carries no clinical/numerical acceptance claim; it is
// the input geometry the browser-lane dom test drives the cavity pipeline on).
// The dom test therefore consumes the EXACT kernel-built geometry — no duplicate
// client-side construction to drift.
//
// Drift guard: packages/kernel/src/cavity/cavity.fixture-asset.test.ts
// regenerates this serialization on every kernel test run and compares it
// byte-for-byte against the committed asset — a change to `modCavityMesh` fails
// the kernel suite until this script is deliberately re-run and the new asset
// reviewed + committed. The canonical byte form is defined ONCE, in
// packages/kernel/src/cavity/cavity.fixture-serialize.ts (used by both this
// script and the guard test).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { modCavityMesh } from '../packages/kernel/src/cavity/cavity.test-fixtures.ts';
import { serializeModCavityFixture } from '../packages/kernel/src/cavity/cavity.fixture-serialize.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetPath = join(repoRoot, 'apps', 'client', 'src', 'engine', 'modCavityFixture.asset.json');

const fx = modCavityMesh(); // DEFAULT parameters — the canonical MOD fixture
const serialized = serializeModCavityFixture(fx);
writeFileSync(assetPath, serialized);

console.log(
  `wrote ${assetPath}\n` +
    `  vertices=${fx.mesh.positions.length / 3} triangles=${fx.mesh.indices.length / 3} ` +
    `outlinePoints=${fx.cavityOutline.length} bytes=${Buffer.byteLength(serialized)}`,
);
