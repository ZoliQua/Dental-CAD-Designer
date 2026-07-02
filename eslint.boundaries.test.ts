// Regression test for a Critical finding: `eslint-plugin-boundaries`'
// `boundaries/dependencies` rule was configured with the correct layer
// allow-list, but had no TypeScript-capable import resolver wired up, so it
// silently never fired on any real intra-repo import (bare `@dqcad/*`
// workspace specifiers into exports-only package.json, and relative
// `.js`-suffixed imports of `.ts` files, both resolved as "unknown" and were
// ignored). This test proves the rule is actually lint-enforced by running
// ESLint's Node API against small fixture files and asserting on the
// specific rule ids produced.
//
// Fixture files are written to real paths under each package's `src/`
// (which every package's tsconfig `include`s) rather than linted as
// virtual/in-memory paths, because `eslint-import-resolver-typescript`
// resolves against each workspace tsconfig's `include`d file set — a path
// that doesn't exist on disk defeats TS-project-based resolution and makes
// the rule silently no-op again, exactly the failure mode this test guards
// against. Fixtures are written immediately before each assertion and always
// removed afterwards, so nothing under `src/` is left behind or committed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = dirname(fileURLToPath(import.meta.url));

const fixturePaths: string[] = [];

function writeFixture(relativePath: string, content: string): string {
  const absolutePath = join(repoRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  fixturePaths.push(absolutePath);
  return absolutePath;
}

afterEach(() => {
  while (fixturePaths.length > 0) {
    const fixturePath = fixturePaths.pop();
    if (fixturePath) {
      rmSync(fixturePath, { force: true });
    }
  }
});

function ruleIds(results: ESLint.LintResult[]): Array<string | null> {
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

async function lint(paths: string[]): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  return eslint.lintFiles(paths);
}

describe('boundaries/dependencies is actually lint-enforced (resolver regression)', () => {
  it('errors on a disallowed bare-specifier import (kernel -> io)', async () => {
    const fixture = writeFixture(
      'packages/kernel/src/__eslint_boundaries_fixture_kernel_to_io__.ts',
      "import '@dqcad/io';\nexport {};\n",
    );

    const results = await lint([fixture]);
    const ids = ruleIds(results);

    // If the resolver regresses, this import resolves as "unknown" and the
    // rule produces zero messages instead of an error — fail loudly.
    expect(ids).toContain('boundaries/dependencies');
    expect(results.flatMap((r) => r.messages).some((m) => m.severity === 2)).toBe(true);
  });

  it('errors on a disallowed relative, .js-suffixed cross-layer import (ui -> kernel)', async () => {
    const fixture = writeFixture(
      'apps/client/src/ui/__eslint_boundaries_fixture_ui_to_kernel__.ts',
      "import '../../../../packages/kernel/src/index.js';\nexport {};\n",
    );

    const results = await lint([fixture]);
    const ids = ruleIds(results);

    expect(ids).toContain('boundaries/dependencies');
    expect(results.flatMap((r) => r.messages).some((m) => m.severity === 2)).toBe(true);
  });

  it('produces zero boundaries errors on an allowed import (kernel -> shared-types)', async () => {
    const fixture = writeFixture(
      'packages/kernel/src/__eslint_boundaries_fixture_kernel_to_shared_types__.ts',
      "import type { Vec3 } from '@dqcad/shared-types';\nexport type { Vec3 };\n",
    );

    const results = await lint([fixture]);
    const boundariesMessages = results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === 'boundaries/dependencies');

    expect(boundariesMessages).toHaveLength(0);
  });

  it('errors on `three` imported from a kernel file (no-restricted-imports)', async () => {
    const fixture = writeFixture(
      'packages/kernel/src/__eslint_boundaries_fixture_kernel_three_ban__.ts',
      "import 'three';\nexport {};\n",
    );

    const results = await lint([fixture]);
    const ids = ruleIds(results);

    expect(ids).toContain('no-restricted-imports');
    expect(results.flatMap((r) => r.messages).some((m) => m.severity === 2)).toBe(true);
  });

  it('errors on `three` imported from apps/client/src/ui (no-restricted-imports)', async () => {
    const fixture = writeFixture(
      'apps/client/src/ui/__eslint_boundaries_fixture_ui_three_ban__.tsx',
      "import * as THREE from 'three';\nexport const probe = new THREE.Vector3();\n",
    );

    const results = await lint([fixture]);
    const ids = ruleIds(results);

    expect(ids).toContain('no-restricted-imports');
    expect(results.flatMap((r) => r.messages).some((m) => m.severity === 2)).toBe(true);
  });

  it('errors on `three` imported from apps/client/src/state (no-restricted-imports)', async () => {
    const fixture = writeFixture(
      'apps/client/src/state/__eslint_boundaries_fixture_state_three_ban__.ts',
      "import * as THREE from 'three';\nexport const probe = new THREE.Vector3();\n",
    );

    const results = await lint([fixture]);
    const ids = ruleIds(results);

    expect(ids).toContain('no-restricted-imports');
    expect(results.flatMap((r) => r.messages).some((m) => m.severity === 2)).toBe(true);
  });

  it('produces zero errors on `three` imported from apps/client/src/engine (allowed)', async () => {
    const fixture = writeFixture(
      'apps/client/src/engine/__eslint_boundaries_fixture_engine_three_allowed__.ts',
      "import * as THREE from 'three';\nexport const probe = new THREE.Vector3();\n",
    );

    const results = await lint([fixture]);
    const messages = results.flatMap((r) => r.messages);

    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false);
  });
});
