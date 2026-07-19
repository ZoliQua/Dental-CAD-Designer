// scripts/check-golden-version-gate.ts
//
// CI-only, merge-boundary gate that CLOSES the hole
// test/golden/goldenEnforcement.ts cannot close by itself: `checkGoldenSnapshot`
// only ever compares live kernel output against whatever golden file is
// CURRENTLY COMMITTED. If a change to kernel behavior is paired with a
// regenerated (and correctly-matching) golden file, but NO `KERNEL_VERSION`
// bump and NO docs/CHANGELOG-kernel.md entry, the enforcement suite is
// green — hashes match themselves — even though the golden-file policy
// (CLAUDE.md: "Golden hashes change ONLY with a deliberate kernel version
// bump + changelog entry") was silently defeated. See
// docs/CHANGELOG-kernel.md's policy header and
// test/golden/kernel-ops.test.ts's module doc for how this gate and the
// test-layer enforcement fit together (two layers, two different failure
// modes — neither redundant with the other).
//
// This script answers a narrower question than the test suite: not "does
// the golden file match live output" but "did anyone change a golden-pinned
// file WITHOUT also bumping KERNEL_VERSION and adding a changelog entry, in
// this push/PR?" That requires a BASE REF to diff against, which only
// exists at CI time (a local `npx tsx scripts/generate-kernel-goldens.ts`
// has no "base" to compare to) — hence "CI-only" above. Local golden
// regeneration stays free or convenient; this gate is what actually blocks
// a merge that regenerated-without-bumping.
//
// ## Golden-pinned paths (single source of truth — see `isGoldenPath` below)
//
// - test-fixtures/golden/kernel-ops.json (Task 8's kernel-ops snapshot)
// - test-fixtures/intake/*.golden.json
// - test-fixtures/curvature/*.golden.json
// - test-fixtures/offset/*.golden.json (includes the clinical-pitch die
//   golden, test-fixtures/offset/standin-prep-die.offset.golden.json)
//
// ## Base ref selection (documented per event type)
//
// - `pull_request`: base ref is `origin/${GITHUB_BASE_REF}` (the PR's
//   target branch, as GitHub Actions exposes it) — matches "did this PR
//   touch a golden file without a version bump", independent of how many
//   commits are on the PR branch.
// - `push`: base ref is `GITHUB_EVENT_BEFORE` (the commit SHA the push
//   moved the ref FROM — GitHub Actions' `github.event.before`), UNLESS
//   that value is unset, all-zeros (GitHub's sentinel for "new branch/ref,
//   no prior commit" — e.g. the branch's first push), or not present in
//   this checkout's history (possible with a shallow/partial fetch) — in
//   which case it falls back to `merge-base(HEAD, origin/<default branch>)`
//   so a new-branch's first push is still diffed against where it forked
//   from, not treated as "everything changed".
// - Any other event (`schedule`, `workflow_dispatch`, ...): there is no
//   natural single "range" to diff (these run against one ref, not a
//   push/PR range) — the gate is a no-op (prints why, exits 0). The main CI
//   job still runs on these triggers (see ci.yml's job-level comment) but
//   this gate's job is specifically "catch a bad push/PR", which doesn't
//   apply here.
//
// In all cases the actual diffed range is `git merge-base(<base ref>,
// HEAD)..HEAD` (two-dot diff from the merge-base, i.e. the same file set a
// three-dot `base...HEAD` diff would show) — computed explicitly rather
// than relying on `git diff base...HEAD` so the exact commit being diffed
// from is logged for debugging.
//
// Requires the checkout step to use `fetch-depth: 0` (full history for all
// branches) — a shallow checkout would make `git merge-base` fail or (worse)
// silently pick the wrong ancestor.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const KERNEL_INDEX_PATH = 'packages/kernel/src/index.ts';
const CHANGELOG_PATH = 'docs/CHANGELOG-kernel.md';

// ---------------------------------------------------------------------------
// Golden-pinned path enumeration (the "one place" the brief asks for).
// ---------------------------------------------------------------------------

interface GoldenPathPattern {
  readonly label: string;
  readonly matches: (relPath: string) => boolean;
}

export const GOLDEN_PATH_PATTERNS: readonly GoldenPathPattern[] = [
  {
    label: 'kernel-ops golden snapshot',
    matches: (f) => f === 'test-fixtures/golden/kernel-ops.json',
  },
  {
    label: 'intake golden fixtures',
    matches: (f) => f.startsWith('test-fixtures/intake/') && f.endsWith('.golden.json'),
  },
  {
    label: 'curvature golden fixtures',
    matches: (f) => f.startsWith('test-fixtures/curvature/') && f.endsWith('.golden.json'),
  },
  {
    label: 'offset golden fixtures (incl. the clinical-pitch die golden)',
    matches: (f) => f.startsWith('test-fixtures/offset/') && f.endsWith('.golden.json'),
  },
];

export function isGoldenPath(relPath: string): boolean {
  return GOLDEN_PATH_PATTERNS.some((p) => p.matches(relPath));
}

// ---------------------------------------------------------------------------
// Pure gate logic — the testable core. Takes file-change lists + old/new
// version strings + a pre-computed changelog signal; no git, no fs, no
// process. See test/golden/check-golden-version-gate.test.ts for the
// synthetic-input unit tests (including the exact "regenerate without a
// bump" scenario this whole gate exists to catch).
// ---------------------------------------------------------------------------

export interface GoldenVersionGateInput {
  /** Repo-relative paths of every file changed in the diffed range. */
  readonly changedFiles: readonly string[];
  readonly oldKernelVersion: string;
  readonly newKernelVersion: string;
  /** Whether docs/CHANGELOG-kernel.md gained an ADDED line mentioning
   * `newKernelVersion` in the diffed range — computed by the caller (the
   * CLI below parses `git diff` output for this); passed in as a plain
   * boolean here so this function stays pure/diff-parsing-free. */
  readonly changelogHasNewVersionEntry: boolean;
}

export interface GoldenVersionGateResult {
  readonly ok: boolean;
  /** Golden-pinned files touched in the diffed range (empty when the gate
   * doesn't apply at all — no golden file changed). */
  readonly goldenFilesChanged: readonly string[];
  /** Present iff `!ok` — actionable explanation. */
  readonly message?: string;
}

export function checkGoldenVersionGate(input: GoldenVersionGateInput): GoldenVersionGateResult {
  const goldenFilesChanged = input.changedFiles.filter(isGoldenPath);

  if (goldenFilesChanged.length === 0) {
    return { ok: true, goldenFilesChanged };
  }

  const versionBumped = input.oldKernelVersion !== input.newKernelVersion;
  const problems: string[] = [];
  if (!versionBumped) {
    problems.push(
      `KERNEL_VERSION (${KERNEL_INDEX_PATH}) is unchanged (still "${input.oldKernelVersion}") in this range.`,
    );
  }
  if (!input.changelogHasNewVersionEntry) {
    problems.push(
      versionBumped
        ? `${CHANGELOG_PATH} has no added entry mentioning the new version ("${input.newKernelVersion}").`
        : `${CHANGELOG_PATH} has no new entry either.`,
    );
  }

  if (problems.length === 0) {
    return { ok: true, goldenFilesChanged };
  }

  const fileList = goldenFilesChanged.map((f) => `    - ${f}`).join('\n');
  return {
    ok: false,
    goldenFilesChanged,
    message:
      `Golden version gate FAILED: ${goldenFilesChanged.length} golden-pinned file(s) changed in this range without ` +
      `a deliberate KERNEL_VERSION bump + changelog entry:\n${fileList}\n` +
      `  Problem(s):\n${problems.map((p) => `    - ${p}`).join('\n')}\n` +
      `  This is exactly the scenario checkGoldenSnapshot's test-layer enforcement CANNOT catch on its own: a ` +
      `regenerated golden file that matches its own new hashes is invisible to a live-output-vs-committed-file ` +
      `comparison. Fix: bump KERNEL_VERSION in ${KERNEL_INDEX_PATH} and add an entry to ${CHANGELOG_PATH} explaining ` +
      `the numerical difference (CLAUDE.md: "A 'small numeric diff' in golden files is a red flag — investigate, ` +
      `don't regenerate"), then commit both together with the refreshed golden file(s).`,
  };
}

// ---------------------------------------------------------------------------
// CLI — computes the inputs above from git + the working tree, and is the
// only part of this file that touches either. Guarded so this module can
// still be imported for its pure exports (isGoldenPath,
// checkGoldenVersionGate, GOLDEN_PATH_PATTERNS) without running the CLI —
// see test/golden/check-golden-version-gate.test.ts.
// ---------------------------------------------------------------------------

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function refExists(ref: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ALL_ZERO_SHA = '0'.repeat(40);

/** Base-ref selection per this file's module doc. Returns `null` when no
 * base ref applies (non push/PR event) — the CLI then no-ops. */
function selectBaseRef(env: NodeJS.ProcessEnv): string | null {
  const eventName = env['GITHUB_EVENT_NAME'];

  if (eventName === 'pull_request') {
    const baseBranch = env['GITHUB_BASE_REF'];
    if (!baseBranch) {
      throw new Error('golden version gate: GITHUB_EVENT_NAME=pull_request but GITHUB_BASE_REF is unset.');
    }
    return `origin/${baseBranch}`;
  }

  if (eventName === 'push') {
    const before = env['GITHUB_EVENT_BEFORE'];
    if (before && before !== ALL_ZERO_SHA && refExists(before)) {
      return before;
    }
    const defaultBranch = env['GITHUB_DEFAULT_BRANCH'] || 'main';
    return `origin/${defaultBranch}`;
  }

  // schedule / workflow_dispatch / local ad-hoc runs: no natural range.
  return null;
}

function parseKernelVersion(source: string): string {
  const match = /export const KERNEL_VERSION\s*=\s*'([^']+)'/.exec(source);
  if (!match) {
    throw new Error(`golden version gate: could not find "export const KERNEL_VERSION = '...'" in ${KERNEL_INDEX_PATH}`);
  }
  return match[1]!;
}

function main(): void {
  const env = process.env;
  const baseRef = selectBaseRef(env);

  if (baseRef === null) {
    console.log(
      `[golden-version-gate] event "${env['GITHUB_EVENT_NAME'] ?? '(unset)'}" has no push/PR range to diff — skipping (no-op).`,
    );
    return;
  }

  const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
  console.log(`[golden-version-gate] diffing ${mergeBase}..HEAD (base ref: ${baseRef})`);

  const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD'])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  const oldKernelVersion = parseKernelVersion(git(['show', `${mergeBase}:${KERNEL_INDEX_PATH}`]));
  const kernelIndexPath = join(repoRoot, KERNEL_INDEX_PATH);
  const newKernelVersion = parseKernelVersion(readFileSync(kernelIndexPath, 'utf8'));

  const changelogPath = join(repoRoot, CHANGELOG_PATH);
  let changelogHasNewVersionEntry = false;
  if (existsSync(changelogPath) && changedFiles.includes(CHANGELOG_PATH)) {
    const changelogDiff = git(['diff', mergeBase, 'HEAD', '--', CHANGELOG_PATH]);
    changelogHasNewVersionEntry = changelogDiff
      .split('\n')
      .some((line) => line.startsWith('+') && !line.startsWith('+++') && line.includes(newKernelVersion));
  }

  const result = checkGoldenVersionGate({
    changedFiles,
    oldKernelVersion,
    newKernelVersion,
    changelogHasNewVersionEntry,
  });

  if (result.goldenFilesChanged.length > 0) {
    console.log(
      `[golden-version-gate] golden-pinned file(s) changed: ${result.goldenFilesChanged.join(', ')} ` +
        `(KERNEL_VERSION ${oldKernelVersion} -> ${newKernelVersion})`,
    );
  } else {
    console.log('[golden-version-gate] no golden-pinned files changed in this range — nothing to gate.');
  }

  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }

  console.log('[golden-version-gate] OK.');
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
