// test/golden/upperjaw-mesh.ts
//
// Shared "load + intake the real arch-case-01 upperjaw STL fixture" helper —
// factored out of margin-validate.test.ts / margin-anchor-count-fidelity.
// test.ts / margin-references.test.ts, which each carried an identical
// `loadUpperjawMesh()` body independently. Lives alongside this directory's
// other shared test tooling (stl-reader.ts, goldenEnforcement.ts) per this
// repo's established "cross-file golden test helpers live in test/golden/"
// convention.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStl } from '@dqcad/io';
import { intake, type IndexedMesh } from '@dqcad/kernel';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';

export const ARCH_UPPERJAW_PATH = 'test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl';

export function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(join(repoRoot, ARCH_UPPERJAW_PATH));
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}
