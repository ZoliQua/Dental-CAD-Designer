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
// Phase 2 Task 12 extended this file's pipeline with two more stages — BVH
// build + ONE heatmap query — per that task's brief: "generated 5M fixture
// through stream-parse + intake + halfedge + BVH build + one heatmap —
// timings + peak memory reported in docs" (docs/demos/phase-2.md). The
// "heatmap" stage queries the fixture's own vertices against its own BVH
// (`closestPointBatch`, the same kernel primitive
// packages/kernel-workers/src/jobs/heatmap.ts's `distanceHeatmap` job
// calls per-point) — a self-query, not a real two-mesh comparison, because
// this fixture is a single generated horseshoe tube with no natural second
// mesh to compare against; the point of this stage is exercising the SAME
// per-vertex-BVH-query workload at 5M scale (timing/memory), not producing
// a clinically meaningful distance number (distances are trivially ~0 by
// construction and are not asserted on).
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
  buildBvh,
  buildHalfedge,
  closestPointBatch,
  computeEulerCharacteristic,
  findBoundaryLoops,
  intake,
} from '@dqcad/kernel';

const RUN_LARGE_FIXTURE = process.env.RUN_LARGE_FIXTURE === '1';

const GENERATED_DIR = fileURLToPath(new URL('../../test-fixtures/generated/', import.meta.url));

/**
 * Yields to the event loop for one macrotask tick. At 5M-triangle scale
 * several stages below (buildBvh, the self-heatmap closestPointBatch loop)
 * are each tens of seconds of UNINTERRUPTED synchronous CPU work — with NO
 * yield point between them the whole test body can block the worker thread
 * long enough that Vitest's own RPC heartbeat to the main process
 * ("onTaskUpdate") times out, logging a spurious `[vitest-worker]: Timeout
 * calling "onTaskUpdate"` unhandled error AND flipping the process's exit
 * code to 1 — even though every actual test/assertion passed (observed:
 * `Test Files 1 passed (1)` / `Tests 2 passed (2)` alongside `exit code 1`
 * before this fix). A `setImmediate` yield between each timed stage gives
 * Node's event loop a chance to service that heartbeat without materially
 * affecting the measured per-stage timings (each stage's own `t*` timestamp
 * is still taken immediately before/after the real work, never around this
 * yield).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
    // Bumped from 120_000 (Phase 2 Task 2) to fit the two new stages this
    // task adds (buildBvh + one heatmap query) with real headroom — see
    // this file's own measured numbers in docs/demos/phase-2.md.
    timeoutMs: 240_000,
  },
  {
    name: '~5M triangles (standin-arch-5m.stl)',
    fileName: 'standin-arch-5m.stl',
    npmScriptHint: 'npm run fixtures:generate-large-5m',
    // Bumped from 240_000 (Phase 2 Task 2) — same reason as above, doubled
    // for the ~2x triangle count.
    timeoutMs: 480_000,
  },
];

describe.skipIf(!RUN_LARGE_FIXTURE)(
  'intake + halfedge build + BVH + heatmap — large generated fixtures (PLAN §7 5M NFR evidence)',
  () => {
    for (const fixture of FIXTURES) {
      it(
        `${fixture.name}: parse -> intake -> buildHalfedge -> assertValidTopology -> buildBvh -> distanceHeatmap(self) completes, timings/RSS reported`,
        async () => {
          const path = `${GENERATED_DIR}${fixture.fileName}`;
          if (!existsSync(path)) {
            throw new Error(
              `Perf fixture not found at ${path} — generate it first with \`${fixture.npmScriptHint}\`.`,
            );
          }

          if (typeof global.gc === 'function') global.gc();
          const rssBefore = process.memoryUsage().rss;
          let rssPeak = rssBefore;
          const trackPeak = (): number => {
            const rss = process.memoryUsage().rss;
            if (rss > rssPeak) rssPeak = rss;
            return rss;
          };

          const bytes = readFileSync(path);
          const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

          const t0 = performance.now();
          const { soup } = parseStl(view);
          const t1 = performance.now();
          trackPeak();
          await yieldToEventLoop();
          const intakeResult = intake({ kind: 'soup', soup });
          const t2 = performance.now();
          trackPeak();
          await yieldToEventLoop();
          const hm = buildHalfedge(intakeResult.mesh);
          const t3 = performance.now();
          trackPeak();
          await yieldToEventLoop();
          assertValidTopology(hm);
          const t4 = performance.now();
          trackPeak();
          await yieldToEventLoop();
          const bvh = buildBvh(intakeResult.mesh);
          const t5 = performance.now();
          trackPeak();
          await yieldToEventLoop();
          // "One heatmap" (this task's brief) — self-query, see this file's
          // module doc for why: exercises the SAME per-vertex-BVH-query
          // workload distanceHeatmap's job does, at full 5M scale.
          const heatmapResult = closestPointBatch(intakeResult.mesh, bvh, intakeResult.mesh.positions);
          const t6 = performance.now();
          const rssAfterHeatmap = trackPeak();

          const rssDeltaMb = (rssAfterHeatmap - rssBefore) / (1024 * 1024);
          const rssPeakMb = rssPeak / (1024 * 1024);

          const parseMs = t1 - t0;
          const intakeMs = t2 - t1;
          const halfedgeBuildMs = t3 - t2;
          const validateMs = t4 - t3;
          const buildBvhMs = t5 - t4;
          const heatmapMs = t6 - t5;
          const totalMs = t6 - t0;

          expect(soup.triangleCount).toBeGreaterThan(0);
          expect(intakeResult.mesh.indices.length).toBeGreaterThan(0);
          expect(hm.faceCount).toBe(
            soup.triangleCount -
              intakeResult.report.steps.find((s) => s.step === 'dropDegenerateTriangles')!.details[
                'degenerateCount'
              ]!,
          );
          expect(bvh.triangleCount).toBe(hm.faceCount);
          expect(heatmapResult.length).toBe(intakeResult.mesh.positions.length / 3);
          // Self-query sanity: every vertex's closest point on its OWN mesh
          // is itself (or another coincident/adjacent point on a triangle it
          // touches) — distance must be ~0, never a large stray value that
          // would indicate the BVH/query wiring is actually broken.
          for (const r of heatmapResult) {
            expect(r.distance).toBeLessThan(1e-6);
          }

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
              `  vertices: ${(intakeResult.mesh.positions.length / 3).toLocaleString()}\n` +
              `  parseStl:        ${parseMs.toFixed(0)} ms\n` +
              `  intake:          ${intakeMs.toFixed(0)} ms\n` +
              `  buildHalfedge:   ${halfedgeBuildMs.toFixed(0)} ms\n` +
              `  assertValidTopology: ${validateMs.toFixed(0)} ms\n` +
              `  buildBvh:        ${buildBvhMs.toFixed(0)} ms\n` +
              `  heatmap (self, ${heatmapResult.length.toLocaleString()} pts): ${heatmapMs.toFixed(0)} ms\n` +
              `  TOTAL:           ${totalMs.toFixed(0)} ms\n` +
              `  RSS before: ${(rssBefore / 1024 / 1024).toFixed(0)} MB, after: ${(rssAfterHeatmap / 1024 / 1024).toFixed(0)} MB, ` +
              `delta: ${rssDeltaMb.toFixed(0)} MB, PEAK: ${rssPeakMb.toFixed(0)} MB\n` +
              `  boundary loops: ${boundaryLoops.length}, Euler characteristic: ${euler.eulerCharacteristic}`,
          );
        },
        fixture.timeoutMs,
      );
    }
  },
);
