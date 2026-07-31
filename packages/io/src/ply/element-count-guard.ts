// packages/io/src/ply/element-count-guard.ts
//
// Defensive check against a class of bug this package's fuzz suite
// (packages/io/fuzz/) specifically targets: a PLY header's `element <name>
// <count>` line is TRUSTED input from the file itself, with no
// spec-mandated relationship to the file's actual byte length (unlike
// STL's binary format, whose triangle count is corroborated by the
// byte-length-consistency check in stl/parse.ts's `classifyStlFormat` —
// see that module's doc). Both binary.ts and ascii.ts's vertex/face
// readers allocate `positions`/`normals`/`colors`/an index buffer sized
// directly from the header's declared row count BEFORE reading a single
// row of real data — so a corrupted or adversarial header declaring an
// enormous row count (e.g. a single flipped/inserted digit turning
// "element vertex 5" into "element vertex 5000000000") would attempt a
// multi-gigabyte allocation immediately, on a file that might be only a
// few hundred bytes long. That's a crash/hang risk (`RangeError` at best,
// a slow near-OOM allocation at worst) reachable from untrusted file
// content, not a clean, typed `IoParseError`.
//
// Deliberately a HARD CEILING on the declared count alone, not a
// remaining-bytes comparison: an earlier version of this guard compared
// `declaredCount` against `remainingBytes / minRowBytesPerRow`, but that
// double-covers ground the per-row readers (readVertexRow/readFaceRow/
// requireBytes, binary.ts) already handle perfectly well — and MORE
// precisely: a file that's genuinely truncated by just a few bytes (a
// completely ordinary, real-world truncation) would trip that comparison
// too, replacing the per-row reader's specific "unexpected end of file
// while reading vertex[1].y at offset N" error with a vaguer, less useful
// one. The actual risk this guard exists for — an OOM-scale allocation
// attempt — only appears when the declared count is huge in absolute
// terms, so bounding it in absolute terms is both sufficient and strictly
// more precise: ordinary truncation (declared count merely a little more
// than what fits) is left entirely to the existing per-row error paths,
// and only implausible-on-their-face counts are rejected here, before any
// allocation.

import { MalformedSyntaxError, TruncatedFileError } from '../types.ts';
import type { PlyElementSpec } from './types.ts';

/** Comfortably above this project's largest expected real scan (PLAN.md's
 * ~5M-triangle full-arch ceiling) while still bounding a single element's
 * worst-case allocation (e.g. `positions`/`normals`/`colors`, each
 * `count * 3` Float64 values) to a fixed, sane amount regardless of how
 * corrupted or adversarial the header is — `50_000_000 * 3 * 8` bytes
 * (1.2 GB) is a real but bounded worst case, not the effectively-unbounded
 * multi-terabyte attempt an uncorroborated 32-bit-ish header count could
 * otherwise request. */
export const MAX_PLAUSIBLE_ELEMENT_COUNT = 50_000_000;

/**
 * Throws `TruncatedFileError` if `declaredCount` exceeds
 * `MAX_PLAUSIBLE_ELEMENT_COUNT` — see module doc for why this is an
 * absolute ceiling rather than a remaining-bytes comparison. Used by both
 * the in-memory readers (binary.ts/ascii.ts, which additionally have the
 * per-row `requireBytes` checks to catch ordinary truncation precisely)
 * and the streaming reader (stream.ts, which has no reliable "bytes
 * remaining" bound to compare against in the first place).
 */
export function assertPlausibleElementCount(
  elementName: string,
  declaredCount: number,
  ceiling: number = MAX_PLAUSIBLE_ELEMENT_COUNT,
): void {
  if (declaredCount > ceiling) {
    throw new TruncatedFileError(
      `element "${elementName}" declares ${declaredCount} row(s), which exceeds this parser's sanity ` +
        `ceiling of ${ceiling} row(s) for a single element — this looks like a corrupted or adversarial ` +
        'header rather than a genuinely large real file',
    );
  }
}

/**
 * Full pre-loop guard for ANY element the parser is about to iterate row by
 * row — the vertex/face readers additionally have this ceiling applied
 * directly (they always carry x/y/z etc. properties, so the second check
 * below can never fire for them), but SKIPPED elements had no guard at all
 * before, which is the exact gap the parser-DoS blocker exploited.
 *
 * Two distinct hostile-header shapes are rejected here, both BEFORE the
 * row-skip loop runs even once (so neither can turn into an
 * uncancellable CPU spin):
 *
 *   1. An implausibly huge declared count (`assertPlausibleElementCount`) —
 *      a skipped element declaring, say, `Number.MAX_SAFE_INTEGER` rows.
 *
 *   2. A "zero-byte row" element: a nonzero declared count paired with ZERO
 *      properties. Every real PLY property consumes at least one body byte
 *      per row (the smallest scalar is 1 byte; a list field always reads its
 *      count-type first), so a legitimate element's row ALWAYS advances the
 *      byte cursor. An element with no properties advances it by nothing, so
 *      `for (r < count) skipRow()` becomes a pure no-op spin of up to `count`
 *      iterations that never runs out of bytes to trip `requireBytes` — a
 *      DoS pattern regardless of whether `count` is under the ceiling above.
 *      No real file needs to declare a positive row count for a
 *      property-less element, so this is rejected outright as malformed.
 */
export function assertSkippableElement(element: PlyElementSpec): void {
  assertPlausibleElementCount(element.name, element.count);
  if (element.count > 0 && element.properties.length === 0) {
    throw new MalformedSyntaxError(
      `element "${element.name}" declares ${element.count} row(s) but has zero properties — each such ` +
        'row consumes zero body bytes, so a positive row count here is an unbounded no-op "spin" ' +
        'pattern rather than a legitimate element (every real PLY element consumes at least one byte per row)',
    );
  }
}
