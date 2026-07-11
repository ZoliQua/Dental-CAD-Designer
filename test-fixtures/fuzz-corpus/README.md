# fuzz-corpus

Regression corpus for `packages/io`'s fuzz suite (`npm run test:fuzz`).

Each entry is a pair of files: `<name>.bin` (the raw byte blob that
previously triggered a real parser bug) and `<name>.json` (a small sidecar
describing which parser it targets and what a *correct* parser must do with
it now). `packages/io/fuzz/corpus.fuzz.test.ts` replays every entry here on
every fuzz run, so a bug fixed once can never silently regress.

These are small (under ~500 bytes each) — plain committed binary blobs, NOT
Git LFS. `.gitattributes`' LFS patterns only match `test-fixtures/**/*.stl`
and `test-fixtures/**/*.ply`; this directory deliberately uses a `.bin`
extension so these tiny fixtures stay in normal Git history like any other
small text/binary asset, matching this task's brief ("a small committed
regression corpus... text-only or LFS" — these are small enough that LFS
would be overkill).

## Sidecar JSON shape

```jsonc
{
  "parser": "stl" | "ply",
  "expected": { "kind": "throws", "errorClassName": "TruncatedFileError" | "MalformedSyntaxError" }
            | { "kind": "parses", "expectFinite": true },
  "note": "one-line summary of the bug this locks in, and how it was found/fixed"
}
```

## Current entries

All five entries below were found during Phase 1 Task 3 (fuzzing + chunked
parsing for large files) and are now fixed — see each entry's `note` field
and this task's report (`.superpowers/sdd/p1-task-3-report.md`) for full
detail:

- **`stl-ascii-infinity-coordinate` / `stl-binary-infinity-vertex`** — a
  literal `"Infinity"`/`"-Infinity"` ASCII token, or an IEEE-754 float32 bit
  pattern that decodes to `Infinity`, was silently accepted as a valid
  coordinate — `Number("Infinity")` parses successfully in JS and is not
  `NaN`, so the pre-fix `Number.isNaN`-only check missed it entirely. Found
  by targeted analysis while validating the mutation-fuzz harness's
  guardrails, confirmed reproducible, and fixed by switching to
  `!Number.isFinite` (STL ASCII) / an explicit finite check on raw float
  bits (STL binary).
- **`ply-ascii-infinity-coordinate` / `ply-binary-infinity-vertex`** — the
  same class of bug in PLY's ASCII and binary readers, scoped (in the fix)
  to only the roles this parser actually stores (x/y/z/normal/color) so a
  skipped/unrecognized property still tolerates arbitrary garbage values,
  same as before.
- **`ply-ascii-implausible-element-count`** — a PLY header's `element
  vertex <count>` line is trusted input with no byte-length-consistency
  check (unlike STL's binary format). A corrupted/adversarial huge count
  sized a `Float64Array` allocation directly from it, before reading any
  real row — a multi-gigabyte allocation risk from a tiny file. Fixed via
  `packages/io/src/ply/element-count-guard.ts`'s hard ceiling
  (`MAX_PLAUSIBLE_ELEMENT_COUNT`).
