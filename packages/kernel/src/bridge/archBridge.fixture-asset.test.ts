// packages/kernel/src/bridge/archBridge.fixture-asset.test.ts
//
// Phase 9 Task 6 — the DRIFT GUARD binding the closed-form arch bridge case
// (archBridge.test-fixtures.ts) to the committed client asset
// `apps/client/src/engine/archBridgeFixture.asset.json`, plus the fixture's
// own closed-form invariants (watertight dies, exact margin rings on the
// scan, the ridge apex at the margin height).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeMesh } from '../intake/analyze.ts';
import { ARCH_DIE_SEGMENTS, ARCH_MARGIN_Z_MM, archBridgeFixture } from './archBridge.test-fixtures.ts';
import { serializeArchBridgeFixture } from './archBridge.fixture-serialize.ts';

const assetPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'apps', 'client', 'src', 'engine', 'archBridgeFixture.asset.json');

describe('arch bridge case fixture', () => {
  it('the committed client asset is byte-identical to a fresh serialization', () => {
    expect(
      readFileSync(assetPath, 'utf8'),
      'apps/client/src/engine/archBridgeFixture.asset.json has drifted from archBridgeFixture() — if deliberate, ' +
        'regenerate with `npx tsx scripts/generate-client-arch-bridge-fixture.ts`, review, and commit it with the change.',
    ).toBe(serializeArchBridgeFixture());
  });

  it('dies are watertight solids and each margin ring is a ring of exact scan vertices', () => {
    const fx = archBridgeFixture();
    const scanVertices = new Set<string>();
    for (let i = 0; i < fx.targetScan.positions.length; i += 3) {
      scanVertices.add(`${fx.targetScan.positions[i]},${fx.targetScan.positions[i + 1]},${fx.targetScan.positions[i + 2]}`);
    }
    const scan = analyzeMesh(fx.targetScan);
    expect(scan.watertight).toBe(true);
    expect(scan.componentCount).toBe(2);
    for (const a of fx.abutments) {
      const die = analyzeMesh(a.die);
      expect(die.watertight).toBe(true);
      expect(die.componentCount).toBe(1);
      expect(die.signedVolumeMm3).toBeGreaterThan(0);
      expect(a.marginLoop).toHaveLength(ARCH_DIE_SEGMENTS);
      for (const p of a.marginLoop) {
        expect(scanVertices.has(`${p[0]},${p[1]},${p[2]}`)).toBe(true);
        expect(p[2]).toBe(ARCH_MARGIN_Z_MM);
        expect(Math.hypot(p[0] - a.marginCenterMm[0], p[1])).toBeCloseTo(a.marginRadiusMm, 12);
      }
    }
  });

  it('the gingiva is a closed ridge whose crest apex sits at the margin height over the pontic site', () => {
    const fx = archBridgeFixture();
    const g = analyzeMesh(fx.gingiva);
    expect(g.watertight).toBe(true);
    let apex = -Infinity;
    for (let i = 2; i < fx.gingiva.positions.length; i += 3) apex = Math.max(apex, fx.gingiva.positions[i]!);
    expect(apex).toBeCloseTo(ARCH_MARGIN_Z_MM, 12);
    expect(fx.crest.axisPointMm[2] + fx.crest.radiusMm).toBeCloseTo(ARCH_MARGIN_Z_MM, 12);
  });
});
