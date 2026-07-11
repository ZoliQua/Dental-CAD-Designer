// scripts/generate-intake-golden.ts
//
// Regenerates test-fixtures/intake/arch-case-01-upperjaw.intake.golden.json
// — the golden snapshot pinned by test/golden/intake.test.ts. Run with
// `npx tsx scripts/generate-intake-golden.ts`.
//
// Golden-file policy (CLAUDE.md "Testing expectations"): this snapshot's
// values change ONLY with a deliberate kernel version bump + changelog
// entry explaining the numerical difference. Re-running this script must
// otherwise produce byte-identical output (kernel determinism invariant) —
// if it doesn't, that's a determinism bug to investigate, not a file to
// regenerate.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStl } from '@dqcad/io';
import { intake, type IntakeResult } from '@dqcad/kernel';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
const goldenPath = join(repoRoot, 'test-fixtures', 'intake', 'arch-case-01-upperjaw.intake.golden.json');

/** Must match test/golden/intake.test.ts's hashIntakeResult exactly. */
function hashIntakeResult(result: IntakeResult): string {
  const hash = createHash('sha256');
  hash.update(
    Buffer.from(result.mesh.positions.buffer, result.mesh.positions.byteOffset, result.mesh.positions.byteLength),
  );
  hash.update(Buffer.from(result.mesh.indices.buffer, result.mesh.indices.byteOffset, result.mesh.indices.byteLength));
  hash.update(JSON.stringify(result.stats));
  hash.update(JSON.stringify(result.report));
  return hash.digest('hex');
}

const buffer = readFileSync(upperjawStlPath);
const { soup } = parseStl(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
const result = intake({ kind: 'soup', soup });

const snapshot = {
  stats: result.stats,
  report: result.report,
  resultSha256: hashIntakeResult(result),
};

mkdirSync(dirname(goldenPath), { recursive: true });
writeFileSync(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`wrote ${goldenPath}`);
