import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// UI-thread responsiveness guard for streaming a real ~120 MB scan through
// the import pipeline (docs/plans/phase-1-import-viewer.md's Global
// Constraints NFR: "UI thread never blocked > 50 ms: parsing/intake/
// measurement math runs in the worker pool with progress + cancellation").
//
// ## Why this is a SEPARATE, env-gated spec, not part of phase1.spec.ts
//
// Reading + hashing + stream-parsing + welding a real ~2.5M-triangle STL
// (test-fixtures/generated/standin-arch-large.stl, deterministically
// regenerated on demand — see scripts/generate-large-fixture.ts, NOT
// committed per the Global Constraints) takes tens of seconds even though
// it never blocks the UI thread — that's exactly the point being measured,
// but it's far too slow to run on every push alongside the fast phase1/smoke
// specs. Gated behind `RUN_PERF_E2E=1` (same env-gate convention as
// packages/io/src/stl/large-fixture.perf.test.ts's `RUN_LARGE_FIXTURE`), run
// on a schedule (not every push) in CI — see .github/workflows/ci.yml's
// `perf-guard` job for the exact trigger and the reasoning for why it isn't
// gated on every push.
//
// ## Measurement method: a requestAnimationFrame heartbeat
//
// A `requestAnimationFrame` callback can only run between the browser's
// other main-thread work — if something synchronous on the main thread
// blocks for (say) 200 ms, the NEXT rAF callback simply arrives 200 ms late.
// Recording the wall-clock gap between consecutive rAF callbacks is a
// standard, direct way to detect main-thread jank: unlike sampling
// `performance.now()` on a timer (which itself can be delayed the same way,
// masking the very thing being measured), rAF is scheduled by the browser's
// own rendering pipeline, so a late callback IS a real missed frame budget,
// not a measurement artifact.
//
// The heartbeat starts BEFORE the large file is fed into the app and stops
// once the import reaches a terminal phase, so the recorded gaps span the
// FULL pipeline this NFR is about: chunked file reads, SHA-256 hashing,
// worker-side streaming STL parse, and worker-side intake (weld / drop-
// degenerate / orient / analyze) — every stage `importer.ts` drives (see
// apps/client/src/engine/importer.ts's module doc).

const RUN_PERF_E2E = process.env.RUN_PERF_E2E === '1';

const LARGE_FIXTURE_PATH = fileURLToPath(
  new URL('../test-fixtures/generated/standin-arch-large.stl', import.meta.url),
);

/** Target from the Global Constraints NFR ("never blocked > 50 ms") —
 * reported honestly below regardless of which bound the test actually
 * gates on (see TEST_GATE_MS's doc, and docs/demos/phase-1.md's "Perf
 * guard: measured vs. gated" note for the measured number this produced). */
const TARGET_MS = 50;

/** What this test actually FAILS on. A real Chromium main thread has other
 * unavoidable, non-app work scheduled on it (GC pauses, compositor/GPU
 * process IPC, OS scheduler noise) that can occasionally push one or two
 * individual frame gaps past a strict 50 ms budget even when the app itself
 * never issues a single long synchronous task.
 *
 * ## Phase 1 baseline (pre worker-side hashing) — historical
 *
 * 3 back-to-back local runs (dev machine, NOT a clean CI runner — several
 * unrelated background processes/dev servers were concurrently competing
 * for CPU the whole time) produced max gaps of 102.5 ms / 76.8 ms / 83.2 ms
 * — the CI gate (then 100 ms) held in only 2 of 3 runs. The leading
 * hypothesis (docs/demos/phase-1.md's "Perf guard" note) was a large
 * synchronous memcpy at the WebCrypto IPC boundary for the whole-file
 * `sha256Hex` hash (the old `apps/client/src/engine/hash.ts`, main-thread).
 *
 * ## Phase 2 Task 1 re-measurement (post worker-side hashing) — current
 *
 * That hypothesis is now directly testable: Task 1 moved every hash
 * computation in the import pipeline off the main thread and into the
 * `parseMeshFile`/`intakeMesh`/`rescaleMesh` worker jobs (see
 * `packages/kernel-workers/src/hash.ts` and `jobs/io.ts`/`jobs/intake.ts`/
 * `jobs/misc.ts`) — `engine/hash.ts` no longer exists. 3 back-to-back local
 * runs under the SAME noisy-dev-machine conditions (same unrelated
 * background load, same measurement method) now produce max gaps of
 * **59.5 ms / 63.5 ms / 66.1 ms** — roughly HALVING the worst-case gap
 * (102.5 ms -> 66.1 ms) and, unlike the baseline, holding under the (then)
 * 100 ms gate in all 3 runs, with real margin (34-40 ms) to spare. A
 * handful of samples (1-2 out of ~1,070-1,190 total, i.e. well under 0.5%)
 * still land over the strict 50 ms TARGET_MS — this residual is consistent
 * with ordinary GC/compositor/OS-scheduler noise (the same class of
 * unavoidable non-app work this doc's first paragraph describes), not a
 * remaining main-thread hash/parse block: the halved max-gap and the
 * gate now holding 3/3 (vs 2/3) are exactly what "the hash was the
 * dominant blocking cost" predicts.
 *
 * Gating CI at 80 ms (a real, honest tightening from 100 ms — not the
 * strict 50 ms target, which a handful of noise samples still exceed) keeps
 * this a meaningful regression guard (an ACTUAL accidental main-thread
 * block shows up as a much larger, sustained gap than a one-off scheduler
 * hiccup) while still giving ~15-20 ms of headroom over every one of the 3
 * measured max gaps above for ordinary run-to-run noise — see
 * docs/demos/phase-1.md's "Perf guard" note for the full before/after
 * table. `playwright.config.ts`'s existing `retries: process.env.CI ? 1 :
 * 0` remains in place to absorb a genuine one-off miss in CI the same way
 * it did for the Phase 1 baseline. TARGET_MS (50 ms) above is still the
 * number printed to the console log and recorded in docs/demos/phase-1.md
 * for honest tracking against the NFR's real target, independent of what
 * this assertion actually gates on. */
const TEST_GATE_MS = 80;

test.describe(() => {
  test.skip(
    !RUN_PERF_E2E,
    'perf guard is gated behind RUN_PERF_E2E=1 — see this file’s module doc',
  );
  test.skip(
    !existsSync(LARGE_FIXTURE_PATH),
    `large fixture not found at ${LARGE_FIXTURE_PATH} — run \`npm run fixtures:generate-large\` first`,
  );

  test('UI thread stays responsive while streaming the ~120 MB fixture through the import pipeline', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto('/');

    await page.evaluate(() => {
      const w = window as unknown as {
        __perfGaps__: number[];
        __perfLast__: number;
        __perfRunning__: boolean;
      };
      w.__perfGaps__ = [];
      w.__perfLast__ = performance.now();
      w.__perfRunning__ = true;
      function tick(): void {
        if (!w.__perfRunning__) return;
        const now = performance.now();
        w.__perfGaps__.push(now - w.__perfLast__);
        w.__perfLast__ = now;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    await page.getByTestId('import-file-input').setInputFiles(LARGE_FIXTURE_PATH);

    const row = page.getByTestId('import-file-row').first();
    // Terminal phase text — i18n's `import.phase.done`/`.error` ("Done"/
    // "Error", see apps/client/src/i18n/en.json) — either way the pipeline
    // has finished driving work through the worker pool, which is what
    // this test is timing.
    await expect(row).toContainText(/done|error/i, { timeout: 150_000 });

    const gaps = await page.evaluate(() => {
      const w = window as unknown as { __perfGaps__: number[]; __perfRunning__: boolean };
      w.__perfRunning__ = false;
      return w.__perfGaps__;
    });

    expect(gaps.length).toBeGreaterThan(10); // sanity: the heartbeat actually ran for a while

    const maxGap = Math.max(...gaps);
    const overTarget = gaps.filter((g) => g > TARGET_MS).length;
    const overGate = gaps.filter((g) => g > TEST_GATE_MS).length;

    console.log(
      `[perf guard] ${gaps.length} rAF samples, max gap ${maxGap.toFixed(1)} ms ` +
        `(target ${TARGET_MS} ms: ${overTarget} sample(s) over; CI gate ${TEST_GATE_MS} ms: ${overGate} sample(s) over).`,
    );

    expect(
      maxGap,
      `max rAF gap ${maxGap.toFixed(1)} ms exceeded the ${TEST_GATE_MS} ms CI gate`,
    ).toBeLessThan(TEST_GATE_MS);
  });
});
