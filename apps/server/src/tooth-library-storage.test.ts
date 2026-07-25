// apps/server/src/tooth-library-storage.test.ts
//
// Focused unit tests for tooth-library-storage internals that are not
// exercised by the app.inject route tests in app.test.ts. Currently the
// semver-aware version comparator used to pick the "latest" asset for an
// FDI — the starter set ships one version per FDI today, but the ordering
// must stay numerically correct once a real version bump lands.
import { describe, expect, it } from 'vitest';
import { compareSemver } from './tooth-library-storage.ts';

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
