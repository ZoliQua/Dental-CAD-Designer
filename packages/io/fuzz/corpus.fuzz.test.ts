// packages/io/fuzz/corpus.fuzz.test.ts
//
// Replays every entry in test-fixtures/fuzz-corpus/ (see its README) —
// bytes that previously triggered a real parser bug — against the CURRENT
// parser, asserting each still behaves exactly as its sidecar `.json`
// describes. A fixed bug regressing would show up here as a specific,
// named test failure rather than only being caught (or missed) by luck on
// a future random fuzz run.

import { describe, expect, it } from 'vitest';
import { IoParseError, MalformedSyntaxError, TruncatedFileError } from '../src/types.ts';
import { parseStl } from '../src/stl/parse.ts';
import { parsePly } from '../src/ply/parse.ts';
import { assertFinitePlyMesh, assertFiniteStlSoup, loadFuzzCorpus } from './helpers.ts';

const ERROR_CLASSES = {
  TruncatedFileError,
  MalformedSyntaxError,
} as const;

describe('fuzz corpus regression replay', () => {
  const entries = loadFuzzCorpus();

  it('the corpus directory is not accidentally empty', () => {
    // A green fuzz suite with zero corpus entries would be silently
    // vacuous for this describe block — fail loudly instead so a future
    // refactor that breaks `loadFuzzCorpus()`'s path resolution (or an
    // accidental `git rm` of the corpus) is caught immediately, not
    // "passed" by having nothing to replay.
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    it(`${entry.name}: ${entry.meta.note.split('.')[0]}.`, () => {
      const parseFn = entry.meta.parser === 'stl' ? parseStl : parsePly;

      if (entry.meta.expected.kind === 'throws') {
        const ErrorClass = ERROR_CLASSES[entry.meta.expected.errorClassName];
        let thrown: unknown;
        try {
          parseFn(entry.bytes);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ErrorClass);
        // Also re-assert the broader "typed error, not a crash" contract —
        // belt-and-suspenders with the specific class check above.
        expect(thrown).toBeInstanceOf(IoParseError);
      } else {
        const result = parseFn(entry.bytes);
        if (entry.meta.parser === 'stl') {
          assertFiniteStlSoup((result as ReturnType<typeof parseStl>).soup, entry.name);
        } else {
          assertFinitePlyMesh(result as ReturnType<typeof parsePly>, entry.name);
        }
      }
    });
  }
});
