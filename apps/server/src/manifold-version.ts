// apps/server/src/manifold-version.ts
//
// Phase 7 Task 5 — the installed manifold-3d version, for the traceability
// document's `versions.manifoldVersion` (the regulatory record must name the
// exact boolean-engine build the QC gates ran on, alongside KERNEL_VERSION).
//
// Resolution is anchored at `@dqcad/kernel`'s OWN module location — the
// version recorded is the copy the kernel's `manifold-3d` imports actually
// resolve, not whatever a differently-hoisted copy near apps/server might
// be. manifold-3d's package.json `exports` map exposes neither `.` under a
// `require` condition nor `./package.json`, so `require.resolve('manifold-
// 3d')` is not usable; instead the CJS resolution SEARCH PATHS from the
// kernel's location are walked for the package directory (the same
// node_modules lookup order Node's own resolver uses), and its package.json
// is read directly — the exact approach the golden suites use
// (test/golden/export-serialization.test.ts), made location-independent.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Walks node_modules-style `searchPaths` (CJS `require.resolve.paths`
 * order) for `manifold-3d/package.json` and returns its `version`. Split
 * out pure-by-arguments so the two failure modes are unit-testable
 * (manifold-version.test.ts) without unwiring the real resolution.
 *
 * @throws when no search path contains the package, or its package.json
 *   carries no version string — either way the traceability document must
 *   NOT be generated with a guessed engine version.
 */
export function resolveManifoldVersionFrom(searchPaths: readonly string[], anchor: string): string {
  for (const candidate of searchPaths) {
    const packageJsonPath = join(candidate, 'manifold-3d', 'package.json');
    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
        throw new Error(`manifold-3d package.json at ${packageJsonPath} carries no version string`);
      }
      return parsed.version;
    }
  }
  throw new Error(
    `manifold-3d is not resolvable from @dqcad/kernel (${anchor}) — cannot record the boolean-engine ` +
      'version in the traceability document',
  );
}

let cached: string | null = null;

/** The version of the manifold-3d build `@dqcad/kernel` resolves. Cached
 * after the first read (the installed tree cannot change mid-process). */
export function installedManifoldVersion(): string {
  if (cached !== null) return cached;
  const requireFromHere = createRequire(import.meta.url);
  // @dqcad/kernel's exports map is a plain path (`./src/index.ts`), so this
  // resolves regardless of import/require conditions.
  const kernelEntry = requireFromHere.resolve('@dqcad/kernel');
  const requireFromKernel = createRequire(kernelEntry);
  cached = resolveManifoldVersionFrom(
    requireFromKernel.resolve.paths('manifold-3d') ?? [],
    kernelEntry,
  );
  return cached;
}
