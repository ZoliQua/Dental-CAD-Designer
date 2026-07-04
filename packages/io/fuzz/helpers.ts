// packages/io/fuzz/helpers.ts
//
// Shared utilities for this package's fuzz suite (`npm run test:fuzz` — see
// the root `vitest.fuzz.config.ts`, a project deliberately EXCLUDED from
// the default `npm test` run because fuzzing is comparatively slow and
// belongs in its own CI step, see .github/workflows/ci.yml). NOT part of
// packages/io's public API — this directory sits outside `src/`
// specifically so none of it is reachable from `@dqcad/io` imports.
//
// This file is intentionally NOT itself a `*.test.ts` file (so neither the
// default `io` vitest project nor this `fuzz` project's `fuzz/**/*.test.ts`
// glob picks it up as a test file with zero tests).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IoParseError } from '../src/types.ts';
import type { RawTriangleSoup } from '../src/types.ts';
import type { PlyMesh } from '../src/ply/types.ts';

// ---------------------------------------------------------------------------
// Regression corpus (test-fixtures/fuzz-corpus/) — small, plain (non-LFS)
// binary blobs previously found to trip a real parser bug, replayed by
// corpus.fuzz.test.ts on every fuzz run so a fixed bug can never silently
// regress. Each entry is a `<name>.bin` byte blob plus a `<name>.json`
// sidecar describing which parser it targets and what a CORRECT parser must
// do with it now (throw a specific `IoParseError` subclass, by name, or
// parse successfully).
// ---------------------------------------------------------------------------

const FUZZ_CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test-fixtures',
  'fuzz-corpus',
);

export interface CorpusEntryMeta {
  /** Which parser this blob targets. */
  parser: 'stl' | 'ply';
  /** What a correct parser must do with these bytes now. `'throws'` checks
   * only that the given error class is thrown (not specific field values —
   * the point is "doesn't crash/hang/misbehave", not exact wording).
   * `'parses'` additionally is used for a case where the bug was a
   * WRONG-but-successful parse (rare, but the guard exists for that class
   * too) — `expectFinite: true` re-asserts the never-NaN/Infinity
   * guardrail on the result. */
  expected:
    | { kind: 'throws'; errorClassName: 'TruncatedFileError' | 'MalformedSyntaxError' }
    | { kind: 'parses'; expectFinite: true };
  /** One-line human summary of the bug this entry regression-locks, and
   * when/why it was found — shown in assertion failure messages. */
  note: string;
}

export interface CorpusEntry {
  name: string;
  bytes: Uint8Array;
  meta: CorpusEntryMeta;
}

/** Reads every `<name>.bin` + `<name>.json` pair from
 * `test-fixtures/fuzz-corpus/`. Returns an empty array (not an error) if
 * the directory doesn't exist yet or has no entries — a fresh checkout
 * with no regressions found yet is a valid, green state. */
export function loadFuzzCorpus(): CorpusEntry[] {
  let files: string[];
  try {
    files = readdirSync(FUZZ_CORPUS_DIR);
  } catch {
    return [];
  }
  const binFiles = files.filter((f) => f.endsWith('.bin')).sort();
  return binFiles.map((binFile) => {
    const name = binFile.slice(0, -'.bin'.length);
    const bytes = new Uint8Array(readFileSync(join(FUZZ_CORPUS_DIR, binFile)));
    const meta = JSON.parse(readFileSync(join(FUZZ_CORPUS_DIR, `${name}.json`), 'utf-8')) as CorpusEntryMeta;
    return { name, bytes, meta };
  });
}

/** Writes a new corpus entry (used only while developing this fuzz suite —
 * see this package's Task 3 report for how the currently-committed entries
 * were produced; not called from any `*.test.ts` in normal CI runs). */
export function writeFuzzCorpusEntry(name: string, bytes: Uint8Array, meta: CorpusEntryMeta): void {
  mkdirSync(FUZZ_CORPUS_DIR, { recursive: true });
  writeFileSync(join(FUZZ_CORPUS_DIR, `${name}.bin`), bytes);
  writeFileSync(join(FUZZ_CORPUS_DIR, `${name}.json`), JSON.stringify(meta, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// "Never NaN/Infinity on success" guardrail checks.
// ---------------------------------------------------------------------------

function assertAllFinite(values: Float64Array, label: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      throw new Error(`[${label}] non-finite value ${v} at index ${i} — violates the never-NaN/Infinity guardrail`);
    }
  }
}

export function assertFiniteStlSoup(soup: RawTriangleSoup, label: string): void {
  assertAllFinite(soup.positions, `${label}.positions`);
  if (soup.normals) {
    assertAllFinite(soup.normals, `${label}.normals`);
  }
  if (soup.positions.length !== soup.triangleCount * 9) {
    throw new Error(
      `[${label}] positions.length (${soup.positions.length}) !== triangleCount*9 (${soup.triangleCount * 9})`,
    );
  }
}

export function assertFinitePlyMesh(mesh: PlyMesh, label: string): void {
  assertAllFinite(mesh.positions, `${label}.positions`);
  if (mesh.normals) {
    assertAllFinite(mesh.normals, `${label}.normals`);
  }
  if (mesh.colors) {
    assertAllFinite(mesh.colors, `${label}.colors`);
  }
  if (mesh.positions.length !== mesh.vertexCount * 3) {
    throw new Error(
      `[${label}] positions.length (${mesh.positions.length}) !== vertexCount*3 (${mesh.vertexCount * 3})`,
    );
  }
  if (mesh.indices.length % 3 !== 0) {
    throw new Error(`[${label}] indices.length (${mesh.indices.length}) is not a multiple of 3`);
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    const idx = mesh.indices[i]!;
    if (idx >= mesh.vertexCount) {
      throw new Error(`[${label}] indices[${i}] = ${idx} is out of range for vertexCount ${mesh.vertexCount}`);
    }
  }
}

/** Re-thrown by `assertSafeParse` when a mutated input triggers a real bug
 * (a non-`IoParseError` throw, or a successful-but-invalid result) — a
 * distinct type so fuzz test failure output is unambiguous about WHICH
 * guardrail broke, separate from a plain assertion mismatch. */
export class FuzzGuardrailViolation extends Error {
  constructor(
    message: string,
    readonly bytes: Uint8Array,
  ) {
    super(message);
    this.name = 'FuzzGuardrailViolation';
  }
}

/**
 * Runs `parseFn(bytes)` and enforces this task's mutation-fuzzing
 * guardrail: the call must either (a) throw an `IoParseError` (any
 * subclass), or (b) return successfully with `checkResult` raising nothing
 * (the caller's `checkResult` is expected to run the appropriate
 * `assertFinite*` check plus any other structural invariant). Any other
 * outcome — a non-`IoParseError` throw, or `checkResult` itself throwing —
 * is wrapped in `FuzzGuardrailViolation` so fast-check's shrinker/reporter
 * clearly attributes the failure to a real parser bug, not a test-harness
 * assertion.
 */
export function assertSafeParse<T>(bytes: Uint8Array, parseFn: (bytes: Uint8Array) => T, checkResult: (result: T) => void, label: string): void {
  let result: T;
  try {
    result = parseFn(bytes);
  } catch (error) {
    if (error instanceof IoParseError) {
      return; // expected outcome (a): a typed parse failure.
    }
    throw new FuzzGuardrailViolation(
      `[${label}] parse threw a non-IoParseError (${error instanceof Error ? error.name : typeof error}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      bytes,
    );
  }
  try {
    checkResult(result);
  } catch (checkError) {
    throw new FuzzGuardrailViolation(
      `[${label}] parse returned a result that failed a safety check: ` +
        `${checkError instanceof Error ? checkError.message : String(checkError)}`,
      bytes,
    );
  }
}

// ---------------------------------------------------------------------------
// Seeded byte-level mutation model — shared by mutation.fuzz.test.ts for
// both STL and PLY base fixtures. See that file for the fast-check
// arbitrary built on top of `Edit`/`applyEdits`.
// ---------------------------------------------------------------------------

export type Edit =
  | { kind: 'flip'; posFrac: number; byte: number }
  | { kind: 'truncate'; lenFrac: number }
  | { kind: 'insert'; posFrac: number; bytes: readonly number[] };

/**
 * Applies `edits` to `base` in order, producing a mutated copy. Positions
 * are expressed as fractions (`posFrac`/`lenFrac`, in `[0, 1)`) of the
 * CURRENT byte length at the time each edit is applied (not the original
 * base length) — this keeps the edit arbitrary independent of any
 * particular base fixture's size while still remaining well-defined
 * (in-range) after earlier edits have grown or shrunk the buffer. Bounded
 * by construction (`edits` has a small max length, `insert` a small max
 * byte count — see the arbitrary in mutation.fuzz.test.ts) so a single
 * mutated buffer never grows large enough to pose its own risk.
 */
export function applyEdits(base: Uint8Array, edits: readonly Edit[]): Uint8Array {
  let bytes = base.slice();
  for (const edit of edits) {
    switch (edit.kind) {
      case 'flip': {
        if (bytes.length === 0) continue;
        const pos = Math.min(bytes.length - 1, Math.floor(edit.posFrac * bytes.length));
        bytes[pos] = edit.byte;
        break;
      }
      case 'truncate': {
        const len = Math.min(bytes.length, Math.floor(edit.lenFrac * bytes.length));
        bytes = bytes.slice(0, len);
        break;
      }
      case 'insert': {
        const pos = Math.min(bytes.length, Math.floor(edit.posFrac * bytes.length));
        const insertBytes = Uint8Array.from(edit.bytes);
        const merged = new Uint8Array(bytes.length + insertBytes.length);
        merged.set(bytes.subarray(0, pos), 0);
        merged.set(insertBytes, pos);
        merged.set(bytes.subarray(pos), pos + insertBytes.length);
        bytes = merged;
        break;
      }
    }
  }
  return bytes;
}
