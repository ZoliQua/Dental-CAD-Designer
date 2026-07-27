// packages/kernel/src/bridge/bridge.fixture-asset.test.ts
//
// Phase 6 Task 7 — the DRIFT GUARD binding the kernel's bridge fixture geometry
// to the committed CLIENT fixture asset
// `apps/client/src/engine/bridgeFixture.asset.json` (consumed by the browser-lane
// dom test through engine/bridgeGeometry.ts's loader).
//
// The asset is GENERATED from `bridgeAssemblyFixture` (+ the T3 pontic-relief
// measurements + the T4 connector frames) by
// `scripts/generate-client-bridge-fixture.ts` using the canonical serializer
// (bridge.fixture-serialize.ts — the byte format's single definition). This test
// regenerates that serialization on every kernel run and compares it
// BYTE-FOR-BYTE against the committed asset, so ANY change to the fixture geometry
// fails HERE, loudly, until the asset is deliberately regenerated (npx tsx
// scripts/generate-client-bridge-fixture.ts), reviewed and committed — silent
// client/kernel fixture divergence is impossible.
//
// Reading the asset FILE across the package boundary is data, not code — the
// layer rule (ui → engine → kernel-workers → kernel) governs imports of kernel
// test CODE into apps/client, which is exactly what the asset exists to avoid.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serializeBridgeFixture } from './bridge.fixture-serialize.ts';

const assetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'apps', 'client', 'src', 'engine', 'bridgeFixture.asset.json',
);

describe('client bridge fixture asset — kernel↔client drift guard', () => {
  it('the committed client asset is byte-identical to a fresh serializeBridgeFixture()', () => {
    const committed = readFileSync(assetPath, 'utf8');
    const regenerated = serializeBridgeFixture();
    expect(
      committed,
      'apps/client/src/engine/bridgeFixture.asset.json has drifted from the kernel bridge fixture — ' +
        'if the change is deliberate, regenerate with ' +
        '`npx tsx scripts/generate-client-bridge-fixture.ts`, review the diff, and commit it ' +
        'together with the fixture change (see bridge.fixture-serialize.ts).',
    ).toBe(regenerated);
  });

  it('the asset carries the closed-form invariants (3 units, 2 connectors, 3 pontic styles)', () => {
    const asset = JSON.parse(readFileSync(assetPath, 'utf8')) as {
      units: { label: string; kind: string; die: unknown; fitRegion: unknown }[];
      connectors: { label: string; teeth: number[] }[];
      ponticReliefByStyle: Record<string, { configuredReliefMm: number; maxAbsDeviationMm: number }>;
      sharedAxis: { acceptable: boolean; perAbutment: { label: string; marginFitMm: number }[] };
    };
    // 3 units: two abutments (with a die + fitRegion) flanking one pontic.
    expect(asset.units.map((u) => `${u.label}:${u.kind}`)).toEqual(['14:abutment', '15:pontic', '16:abutment']);
    for (const u of asset.units) {
      if (u.kind === 'abutment') {
        expect(u.die).not.toBeNull();
        expect(u.fitRegion).not.toBeNull();
      } else {
        expect(u.die).toBeNull();
        expect(u.fitRegion).toBeNull();
      }
    }
    // 2 connectors (14–15, 15–16).
    expect(asset.connectors.map((c) => c.label)).toEqual(['14–15', '15–16']);
    // 3 pontic styles, each with a real ±20 µm-scale measured deviation.
    expect(Object.keys(asset.ponticReliefByStyle).sort()).toEqual(['hygienic', 'ovate', 'ridgeLap']);
    for (const s of Object.values(asset.ponticReliefByStyle)) {
      expect(s.maxAbsDeviationMm).toBeLessThan(0.02); // within the ±20 µm acceptance
    }
    // The shared axis is acceptable; per-abutment margin fit is byte-exact (≤ 10 µm).
    expect(asset.sharedAxis.acceptable).toBe(true);
    expect(asset.sharedAxis.perAbutment.map((a) => a.label)).toEqual(['14', '16']);
    for (const a of asset.sharedAxis.perAbutment) expect(a.marginFitMm).toBeLessThanOrEqual(0.01);
  });
});
