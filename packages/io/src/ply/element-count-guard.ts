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

import { TruncatedFileError } from '../types.ts';

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
