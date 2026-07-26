// packages/kernel/src/cavity/cavity.fixture-asset.test.ts
//
// Phase 5 Task 8 (review fix) — the DRIFT GUARD binding the kernel's
// `modCavityMesh` to the committed CLIENT fixture asset
// `apps/client/src/engine/modCavityFixture.asset.json` (consumed by the
// browser-lane dom test through engine/cavityGeometry.ts's loader).
//
// The asset is GENERATED from `modCavityMesh(default params)` by
// `scripts/generate-client-cavity-fixture.ts` using the canonical serializer
// (cavity.fixture-serialize.ts — the byte format's single definition). This test
// regenerates that serialization on every kernel run and compares it
// BYTE-FOR-BYTE against the committed asset, so ANY change to `modCavityMesh`'s
// defaults or construction fails HERE, loudly, until the asset is deliberately
// regenerated (npx tsx scripts/generate-client-cavity-fixture.ts), reviewed and
// committed — silent client/kernel fixture divergence is impossible.
//
// Reading the asset FILE across the package boundary is data, not code — the
// layer rule (ui → engine → kernel-workers → kernel) governs imports of kernel
// test CODE into apps/client, which is exactly what the asset exists to avoid.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import { serializeModCavityFixture } from './cavity.fixture-serialize.ts';

const assetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'apps', 'client', 'src', 'engine', 'modCavityFixture.asset.json',
);

describe('client MOD-cavity fixture asset — kernel↔client drift guard', () => {
  it('the committed client asset is byte-identical to a fresh modCavityMesh() serialization', () => {
    const committed = readFileSync(assetPath, 'utf8');
    const regenerated = serializeModCavityFixture(modCavityMesh());
    expect(
      committed,
      'apps/client/src/engine/modCavityFixture.asset.json has drifted from modCavityMesh() — ' +
        'if the fixture change is deliberate, regenerate the asset with ' +
        '`npx tsx scripts/generate-client-cavity-fixture.ts`, review the diff, and commit it ' +
        'together with the fixture change (see cavity.fixture-serialize.ts).',
    ).toBe(regenerated);
  });

  it('the asset carries the closed-form invariants (46-point outline; watertight-scale mesh)', () => {
    // Coarse closed-form anchors, human-checkable independently of the byte
    // guard: the default MOD outline is 46 points (19 buccal stations + 5-point
    // distal U + 18 lingual stations + 4-point mesial U), and the parsed counts
    // match the array lengths.
    const asset = JSON.parse(readFileSync(assetPath, 'utf8')) as {
      vertexCount: number;
      triangleCount: number;
      outlinePointCount: number;
      positions: number[];
      indices: number[];
      cavityOutline: number[][];
    };
    expect(asset.outlinePointCount).toBe(46);
    expect(asset.cavityOutline.length).toBe(46);
    expect(asset.positions.length).toBe(asset.vertexCount * 3);
    expect(asset.indices.length).toBe(asset.triangleCount * 3);
  });
});
