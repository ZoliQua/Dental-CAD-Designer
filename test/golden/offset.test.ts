// test/golden/offset.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// golden regression pin for @dqcad/kernel's offset pipeline (Phase 2
// Task 7) on the standin-prep-die fixture at the clinical default voxel
// pitch, extending the intake golden pattern (intake.test.ts): stats +
// errorBound + a sha256 over the output mesh buffers, committed as
// test-fixtures/offset/standin-prep-die.offset.golden.json.
//
// Lives here (not in packages/kernel) because it parses the STL fixture
// with @dqcad/io, which the layer rule forbids kernel itself from
// importing — and because it consumes the clinical default pitch from
// @dqcad/clinical-profiles, which kernel (deliberately — required-param
// rule) has no dependency on.
//
// NOTE (golden discipline, CLAUDE.md): this hash pins kernel output — it
// may only change together with a KERNEL_VERSION bump + changelog entry.
// The golden-enforcement framework lands in Task 8; until then the same
// commit-the-hash-file convention as the intake golden applies. To
// regenerate after an INTENTIONAL kernel change:
//   UPDATE_OFFSET_GOLDEN=1 npx vitest run --project golden test/golden/offset.test.ts
// then review the diff and bump KERNEL_VERSION accordingly.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseStl } from '@dqcad/io';
import { intake, offsetMesh, type MeshStats } from '@dqcad/kernel';
import { DEFAULT_OFFSET_VOXEL_PITCH_MM } from '@dqcad/clinical-profiles';
import { assertNotLfsPointer } from './stl-reader.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const diePath = join(repoRoot, 'test-fixtures', 'standin-scans', 'standin-prep-die.stl');
const goldenPath = join(repoRoot, 'test-fixtures', 'offset', 'standin-prep-die.offset.golden.json');

/** The cement-gap distance this golden pins: PLAN.md §3's "Cement gap
 * (spacer)" default, 50 µm — the exact clinical scenario Task 7 is the
 * foundation for (Phase 4 crown inner surfaces). */
const OFFSET_DISTANCE_MM = 0.05;

interface OffsetGoldenSnapshot {
  distanceMm: number;
  pitchMm: number;
  errorBoundMm: number;
  stats: MeshStats;
  resultSha256: string;
}

function hashResultMesh(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

describe('offset — golden on standin-prep-die at the clinical default pitch', () => {
  it('the clinical default pitch is the value the phase acceptance criterion (and the kernel acceptance test) assume', () => {
    // packages/kernel/src/offset/offsetMesh.test.ts hardcodes 0.02 (kernel
    // must not import clinical-profiles); this assertion keeps the two in
    // verified lockstep.
    expect(DEFAULT_OFFSET_VOXEL_PITCH_MM).toBe(0.02);
  });

  it(
    'offset(+50 µm) of the die matches the committed golden (stats, errorBound, output-buffer sha256)',
    { timeout: 600_000 },
    async () => {
      const buffer = readFileSync(diePath);
      assertNotLfsPointer(buffer, diePath);
      const { soup } = parseStl(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
      const die = intake({ kind: 'soup', soup });
      expect(die.stats.watertight).toBe(true); // fixture sanity — offset requires a closed input

      const started = performance.now();
      const result = await offsetMesh(die.mesh, OFFSET_DISTANCE_MM, { pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM });
      const elapsedMs = performance.now() - started;
      // Timing evidence for this task's report (die-sized offset at default
      // pitch — expected tens of seconds, worker-side scale).
      console.log(
        `[golden] standin-prep-die offset +${OFFSET_DISTANCE_MM} mm @ pitch ${DEFAULT_OFFSET_VOXEL_PITCH_MM}: ` +
          `${(elapsedMs / 1000).toFixed(1)} s, ${result.mesh.indices.length / 3} triangles`,
      );

      expect(result.stats.watertight).toBe(true);
      expect(result.stats.manifoldEdges).toBe(true);
      expect(result.stats.componentCount).toBe(1);

      const snapshot: OffsetGoldenSnapshot = {
        distanceMm: OFFSET_DISTANCE_MM,
        pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM,
        errorBoundMm: result.errorBoundMm,
        stats: result.stats,
        resultSha256: hashResultMesh(result.mesh.positions, result.mesh.indices),
      };

      if (process.env['UPDATE_OFFSET_GOLDEN'] === '1') {
        // Regeneration path — see this file's module doc for the golden
        // discipline (kernel version bump + changelog) this requires.
        mkdirSync(join(repoRoot, 'test-fixtures', 'offset'), { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        console.log(`[golden] WROTE ${goldenPath} — review the diff before committing.`);
      }

      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as OffsetGoldenSnapshot;
      expect(snapshot.stats).toEqual(golden.stats);
      expect(snapshot.errorBoundMm).toBe(golden.errorBoundMm);
      expect(snapshot.resultSha256).toBe(golden.resultSha256);
      expect(snapshot.distanceMm).toBe(golden.distanceMm);
      expect(snapshot.pitchMm).toBe(golden.pitchMm);
    },
  );
});
