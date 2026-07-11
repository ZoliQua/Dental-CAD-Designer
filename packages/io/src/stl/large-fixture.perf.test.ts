// packages/io/src/stl/large-fixture.perf.test.ts
//
// Node-side perf/memory test for `parseStlStream` against the ~120 MB
// generated fixture (scripts/generate-large-fixture.ts). Part of the `io`
// vitest project (so it's covered by `npm test`'s coverage report and
// typecheck), but env-gated: skipped unless `RUN_LARGE_FIXTURE=1`, since
// it needs the (large, git-ignored, on-demand-generated) fixture file on
// disk and takes meaningfully longer than this package's other tests.
//
// What this proves, per this task's brief:
//   1. Stream-parsing a real ~120 MB binary STL completes (no hang/crash).
//   2. Peak ADDITIONAL memory is bounded — specifically, `heapUsed` (the
//      V8 JS heap) grows by nowhere near the file's 120 MB, proving the
//      streaming reader never materializes a full-file-sized JS STRING or
//      array anywhere. The output soup's `positions`/`normals` Float64Arrays
//      are themselves ~180 MB / ~60 MB — LARGER than the input file — but
//      TypedArray backing stores live in V8's "external" memory, not the
//      JS heap, which is exactly the point: this package's Float64
//      preallocated-output discipline (see types.ts's module doc) keeps
//      bulk numeric data out of heap-tracked, GC-scanned structures
//      entirely, so "no full-file-sized intermediate copy" is a real,
//      checkable claim about `heapUsed`, not just an assertion about
//      output size.
//   3. Progress is monotonically non-decreasing and reaches 1.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStlStream } from './stream.ts';

const RUN_LARGE_FIXTURE = process.env.RUN_LARGE_FIXTURE === '1';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../test-fixtures/generated/standin-arch-large.stl', import.meta.url),
);

/** Bound on JS heap growth during the parse — deliberately generous (well
 * under half the 120 MB file, but well above ordinary GC/bookkeeping
 * noise) so this is a meaningful "not a full-file-sized copy" check
 * without being flaky under whatever GC timing happens to occur during a
 * run with no forced collection (this test doesn't require Node's
 * `--expose-gc` flag). */
const MAX_HEAP_GROWTH_BYTES = 60 * 1024 * 1024;

async function* readFileInChunks(path: string, highWaterMark: number): AsyncGenerator<Uint8Array, void, void> {
  const stream = createReadStream(path, { highWaterMark });
  for await (const chunk of stream) {
    // node:fs read streams yield Node `Buffer`s (a `Uint8Array` subclass) —
    // re-wrapped as a plain `Uint8Array` view over the same bytes (no
    // copy) so this generator's type matches `AsyncIterable<Uint8Array>`
    // exactly, with zero dependency on Buffer-specific behavior downstream.
    const buf = chunk as Buffer;
    yield new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

describe.skipIf(!RUN_LARGE_FIXTURE)('parseStlStream: large (~120 MB) fixture perf/memory', () => {
  it(
    'stream-parses the generated standin-arch fixture with bounded heap growth and monotonic progress',
    async () => {
      if (!existsSync(FIXTURE_PATH)) {
        throw new Error(
          `Large perf fixture not found at ${FIXTURE_PATH} — generate it first with ` +
            '`npm run fixtures:generate-large` (see scripts/generate-large-fixture.ts).',
        );
      }
      const totalBytes = statSync(FIXTURE_PATH).size;
      expect(totalBytes).toBeGreaterThan(100 * 1024 * 1024); // sanity: this really is the >100 MB fixture.

      if (typeof global.gc === 'function') {
        global.gc(); // best-effort — not required (see MAX_HEAP_GROWTH_BYTES's doc).
      }
      const heapBefore = process.memoryUsage().heapUsed;

      const progressSamples: number[] = [];
      const startedAt = performance.now();
      const { soup, diagnostics } = await parseStlStream(
        readFileInChunks(FIXTURE_PATH, 1 << 20),
        totalBytes,
        { onProgress: (fraction) => progressSamples.push(fraction) },
      );
      const elapsedMs = performance.now() - startedAt;

      const heapAfter = process.memoryUsage().heapUsed;
      const heapGrowthBytes = Math.max(0, heapAfter - heapBefore);

      expect(diagnostics.format).toBe('stl-binary');
      expect(soup.triangleCount).toBeGreaterThan(0);
      expect(soup.positions).toHaveLength(soup.triangleCount * 9);
      expect(soup.normals).not.toBeNull();
      expect(soup.normals).toHaveLength(soup.triangleCount * 3);

      expect(progressSamples.length).toBeGreaterThan(1);
      for (let i = 1; i < progressSamples.length; i++) {
        expect(progressSamples[i]!).toBeGreaterThanOrEqual(progressSamples[i - 1]!);
      }
      expect(progressSamples.at(-1)).toBe(1);

      expect(heapGrowthBytes).toBeLessThan(MAX_HEAP_GROWTH_BYTES);

      // Reported for this task's "timing + memory numbers" requirement —
      // visible in `npm run test:golden`-style CI output for this gated test.
      console.log(
        `[large-fixture perf] ${(totalBytes / (1024 * 1024)).toFixed(1)} MB, ` +
          `${soup.triangleCount.toLocaleString()} triangles, ${elapsedMs.toFixed(0)} ms, ` +
          `heap growth ${(heapGrowthBytes / (1024 * 1024)).toFixed(1)} MB ` +
          `(bound ${(MAX_HEAP_GROWTH_BYTES / (1024 * 1024)).toFixed(0)} MB), ` +
          `${progressSamples.length} progress sample(s).`,
      );
    },
    // Generous but bounded — reading + streaming-parsing ~120 MB should
    // complete in well under a minute even on a slow CI runner; this still
    // fails loudly (not hangs forever) if something regresses badly.
    60_000,
  );
});
