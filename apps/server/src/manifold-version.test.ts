// apps/server/src/manifold-version.test.ts
//
// Phase 7 Task 5 — the manifold-3d version resolution feeding the
// traceability document's `versions.manifoldVersion`: the real kernel-
// anchored resolution, plus both refusal modes of the pure search-path
// walker (a guessed engine version must never enter a regulatory record).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installedManifoldVersion, resolveManifoldVersionFrom } from './manifold-version.js';

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function fakeNodeModules(packageJsonContent: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dqcad-manifold-version-'));
  scratchDirs.push(dir);
  if (packageJsonContent !== null) {
    mkdirSync(join(dir, 'manifold-3d'), { recursive: true });
    writeFileSync(join(dir, 'manifold-3d', 'package.json'), packageJsonContent, 'utf8');
  }
  return dir;
}

describe('installedManifoldVersion', () => {
  it('resolves the kernel-anchored installed build (the version the goldens pin)', () => {
    const version = installedManifoldVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    // Cached second read is identical.
    expect(installedManifoldVersion()).toBe(version);
  });
});

describe('resolveManifoldVersionFrom', () => {
  it('finds the first search path carrying the package and returns its version', () => {
    const missing = fakeNodeModules(null);
    const present = fakeNodeModules(JSON.stringify({ name: 'manifold-3d', version: '9.9.9' }));
    expect(resolveManifoldVersionFrom([missing, present], 'anchor')).toBe('9.9.9');
  });

  it('refuses a package.json without a version string', () => {
    const bad = fakeNodeModules(JSON.stringify({ name: 'manifold-3d' }));
    expect(() => resolveManifoldVersionFrom([bad], 'anchor')).toThrow(/no version string/);
  });

  it('refuses when no search path resolves the package (never a guessed version)', () => {
    const missing = fakeNodeModules(null);
    expect(() => resolveManifoldVersionFrom([missing], 'kernel-entry-anchor')).toThrow(
      /not resolvable from @dqcad\/kernel \(kernel-entry-anchor\)/,
    );
  });
});
