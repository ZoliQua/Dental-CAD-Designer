// test/golden/halfedge-intake.perf.test.ts
//
// Perf/memory evidence for Phase 2 Task 2's intake scalability rebuild +
// new halfedge structure (docs/plans/phase-2-kernel-core.md Task 2 item 6):
// "intake + halfedge build on the 2.5M-tri generated fixture — report
// time/RSS vs the 8.5 s / 3 GB baseline; 5M-tri variant ... MUST complete;
// report numbers against PLAN §7 NFR." Lives here (not inside
// packages/kernel) for the same layer-rule reason test/golden/intake.test.ts
// does — it needs both `@dqcad/io` (to parse the generated STL fixture) and
// `@dqcad/kernel`, and `packages/kernel` may not depend on `packages/io`
// (CLAUDE.md's layer rule) — this root-level `golden` Vitest project sits
// outside that boundary.
//
// Env-gated (RUN_LARGE_FIXTURE=1), same convention as
// packages/io/src/stl/large-fixture.perf.test.ts: skipped by default (the
// fixtures are large, git-ignored, on-demand-generated files, and this test
// takes meaningfully longer than the rest of the suite). Run via
// `npm run test:perf-halfedge` (generates both fixtures first).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import {
  assertValidTopology,
  buildHalfedge,
  computeEulerCharacteristic,
  findBoundaryLoops,
  intake,
} from '@dqcad/kernel';

const RUN_LARGE_FIXTURE = process.env.RUN_LARGE_FIXTURE === '1';

const GENERATED_DIR = fileURLToPath(new URL('../../test-fixtures/generated/', import.meta.url));

interface FixtureCase {
  name: string;
  fileName: string;
  npmScriptHint: string;
  /** Generous but bounded per-test timeout (ms) — this must fail loudly if
   * something regresses badly, not hang forever (same rationale as
   * packages/io/src/stl/large-fixture.perf.test.ts). */
  timeoutMs: number;
}

const FIXTURES: FixtureCase[] = [
  {
    name: '~2.5M triangles (standin-arch-large.stl)',
    fileName: 'standin-arch-large.stl',
    npmScriptHint: 'npm run fixtures:generate-large',
    timeoutMs: 120_000,
  },
  {
    name: '~5M triangles (standin-arch-5m.stl)',
    fileName: 'standin-arch-5m.stl',
    npmScriptHint: 'npm run fixtures:generate-large-5m',
    timeoutMs: 240_000,
  },
];

describe.skipIf(!RUN_LARGE_FIXTURE)(
  'intake + halfedge build — large generated fixtures (perf/memory evidence)',
  () => {
    for (const fixture of FIXTURES) {
      it(
        `${fixture.name}: parse -> intake -> buildHalfedge -> assertValidTopology completes, timings/RSS reported`,
        () => {
          const path = `${GENERATED_DIR}${fixture.fileName}`;
          if (!existsSync(path)) {
            throw new Error(
              `Perf fixture not found at ${path} — generate it first with \`${fixture.npmScriptHint}\`.`,
            );
          }

          if (typeof global.gc === 'function') global.gc();
          const rssBefore = process.memoryUsage().rss;

          const bytes = readFileSync(path);
          const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

          const t0 = performance.now();
          const { soup } = parseStl(view);
          const t1 = performance.now();
          const intakeResult = intake({ kind: 'soup', soup });
          const t2 = performance.now();
          const hm = buildHalfedge(intakeResult.mesh);
          const t3 = performance.now();
          assertValidTopology(hm);
          const t4 = performance.now();

          const rssAfter = process.memoryUsage().rss;
          const rssDeltaMb = (rssAfter - rssBefore) / (1024 * 1024);

          const parseMs = t1 - t0;
          const intakeMs = t2 - t1;
          const halfedgeBuildMs = t3 - t2;
          const validateMs = t4 - t3;
          const totalMs = t4 - t0;

          expect(soup.triangleCount).toBeGreaterThan(0);
          expect(intakeResult.mesh.indices.length).toBeGreaterThan(0);
          expect(hm.faceCount).toBe(
            soup.triangleCount -
              intakeResult.report.steps.find((s) => s.step === 'dropDegenerateTriangles')!.details[
                'degenerateCount'
              ]!,
          );

          // Sanity, not a strict topology assertion — this fixture is an
          // OPEN horseshoe tube (two boundary rings at the theta ends), never
          // watertight; log the observed boundary/Euler facts for the record
          // rather than asserting exact values (which would overfit to this
          // generator's exact segment counts).
          const boundaryLoops = findBoundaryLoops(hm);
          const euler = computeEulerCharacteristic(hm);

          console.log(
            `[halfedge-intake perf] ${fixture.name}\n` +
              `  triangles: ${soup.triangleCount.toLocaleString()} (parsed) -> ${hm.faceCount.toLocaleString()} (after intake)\n` +
              `  parseStl:        ${parseMs.toFixed(0)} ms\n` +
              `  intake:          ${intakeMs.toFixed(0)} ms\n` +
              `  buildHalfedge:   ${halfedgeBuildMs.toFixed(0)} ms\n` +
              `  assertValidTopology: ${validateMs.toFixed(0)} ms\n` +
              `  TOTAL:           ${totalMs.toFixed(0)} ms\n` +
              `  RSS before: ${(rssBefore / 1024 / 1024).toFixed(0)} MB, after: ${(rssAfter / 1024 / 1024).toFixed(0)} MB, delta: ${rssDeltaMb.toFixed(0)} MB\n` +
              `  boundary loops: ${boundaryLoops.length}, Euler characteristic: ${euler.eulerCharacteristic}`,
          );
        },
        fixture.timeoutMs,
      );
    }
  },
);
