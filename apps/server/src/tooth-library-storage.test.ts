// apps/server/src/tooth-library-storage.test.ts
//
// Focused unit tests for tooth-library-storage internals that are not
// exercised by the app.inject route tests in app.test.ts. Currently the
// semver-aware version comparator used to pick the "latest" asset for an
// FDI — the starter set ships one version per FDI today, but the ordering
// must stay numerically correct once a real version bump lands.
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeToothAssetMetadataChecksum, STARTER_TOOTH_ASSETS } from '@dqcad/tooth-library';
import {
  compareSemver,
  listToothLibraryAssets,
  readLatestToothLibraryMetadata,
  seedStarterToothLibrary,
} from './tooth-library-storage.ts';

describe('compareSemver', () => {
  it('orders by numeric component, not lexicographically (1.10.0 > 1.2.0)', () => {
    expect(compareSemver('1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBeLessThan(0);
  });

  it('orders MAJOR before MINOR before PATCH', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.2')).toBeGreaterThan(0);
  });

  it('is 0 for equal versions', () => {
    expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
  });

  it('treats missing or non-numeric components as 0 (total, deterministic)', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.x.0', '1.0.5')).toBeLessThan(0);
  });

  it('produces a descending sort that puts the highest semver first', () => {
    const versions = ['1.2.0', '1.10.0', '1.1.0', '2.0.0'];
    versions.sort((a, b) => compareSemver(b, a));
    expect(versions).toEqual(['2.0.0', '1.10.0', '1.2.0', '1.1.0']);
  });
});

describe('seeding over a pre-Phase-9-Task-4 data directory', () => {
  it('a stored 1.0.0 asset without assetKind still loads; 1.1.0 is still seeded and 1.2.0 supersedes both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tooth-lib-'));
    const metadataDir = join(root, 'meta');
    const meshDir = join(root, 'mesh');
    await mkdir(metadataDir, { recursive: true });
    // The 1.0.0 shape: no assetKind, its own checksum.
    const legacyFields: Record<string, unknown> = { ...STARTER_TOOTH_ASSETS.get(11)!.metadata, version: '1.0.0' };
    delete legacyFields['assetKind'];
    delete legacyFields['cervicalRing'];
    delete legacyFields['metadataChecksum'];
    const legacy = { ...legacyFields, metadataChecksum: computeToothAssetMetadataChecksum(legacyFields as Parameters<typeof computeToothAssetMetadataChecksum>[0]) };
    await writeFile(join(metadataDir, '11-1.0.0.json'), JSON.stringify(legacy), 'utf8');

    await seedStarterToothLibrary(metadataDir, meshDir);
    const versions = (await listToothLibraryAssets(metadataDir)).filter((a) => a.fdi === 11).map((a) => a.version);
    expect(versions).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    const latest = await readLatestToothLibraryMetadata(metadataDir, 11);
    expect(latest?.version).toBe('1.2.0');
    expect(latest?.cervicalRing).toBeDefined();
    expect(latest?.assetKind).toBe('generator');
  });
});
