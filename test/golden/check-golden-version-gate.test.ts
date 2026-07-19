// test/golden/check-golden-version-gate.test.ts
//
// Unit tests of scripts/check-golden-version-gate.ts's PURE logic
// (`isGoldenPath`, `checkGoldenVersionGate`) with synthetic file-change /
// version inputs — no git, no fs, independent of any real commit range. See
// that script's module doc for the mechanism this gate implements: a
// CI-only, base-ref-diff check that catches "golden file regenerated (and
// self-consistent) but KERNEL_VERSION was never bumped and no changelog
// entry was added" — the exact hole checkGoldenSnapshot's live-vs-committed
// comparison (test/golden/goldenEnforcement.ts) cannot close on its own,
// because a regenerated golden file matches ITSELF.
import { describe, expect, it } from 'vitest';
import { checkGoldenVersionGate, isGoldenPath, GOLDEN_PATH_PATTERNS } from '../../scripts/check-golden-version-gate.ts';

describe('isGoldenPath', () => {
  it('matches the kernel-ops golden snapshot', () => {
    expect(isGoldenPath('test-fixtures/golden/kernel-ops.json')).toBe(true);
  });

  it('matches intake/curvature/offset *.golden.json fixtures (incl. the clinical-pitch die golden)', () => {
    expect(isGoldenPath('test-fixtures/intake/arch-case-01-upperjaw.intake.golden.json')).toBe(true);
    expect(isGoldenPath('test-fixtures/curvature/arch-case-01-upperjaw.curvature.golden.json')).toBe(true);
    expect(isGoldenPath('test-fixtures/offset/standin-prep-die.offset.golden.json')).toBe(true);
  });

  it('does NOT match unrelated files, including non-golden files inside golden dirs', () => {
    expect(isGoldenPath('packages/kernel/src/index.ts')).toBe(false);
    expect(isGoldenPath('docs/CHANGELOG-kernel.md')).toBe(false);
    expect(isGoldenPath('test-fixtures/standin-scans/standin-prep-die.stl')).toBe(false);
    expect(isGoldenPath('test-fixtures/offset/README.md')).toBe(false);
  });

  it('every declared pattern has a non-empty label (documentation-in-code sanity)', () => {
    for (const pattern of GOLDEN_PATH_PATTERNS) {
      expect(pattern.label.length).toBeGreaterThan(0);
    }
  });
});

describe('checkGoldenVersionGate', () => {
  it('passes when no golden-pinned file changed, regardless of version state', () => {
    const result = checkGoldenVersionGate({
      changedFiles: ['packages/kernel/src/offset/offsetMesh.ts'],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.0.0',
      changelogHasNewVersionEntry: false,
    });
    expect(result.ok).toBe(true);
    expect(result.goldenFilesChanged).toHaveLength(0);
  });

  it('CRITICAL — FAILS the exact "regenerate golden without a version bump" scenario', () => {
    // This is the defeat scenario the reviewer confirmed live (0/14
    // failures from checkGoldenSnapshot alone): a golden file regenerated
    // and committed, self-consistent, with NO KERNEL_VERSION bump and NO
    // changelog entry.
    const result = checkGoldenVersionGate({
      changedFiles: ['test-fixtures/golden/kernel-ops.json'],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.0.0', // unchanged
      changelogHasNewVersionEntry: false, // no changelog entry either
    });
    expect(result.ok).toBe(false);
    expect(result.goldenFilesChanged).toEqual(['test-fixtures/golden/kernel-ops.json']);
    expect(result.message).toMatch(/unchanged/);
    expect(result.message).toMatch(/bump KERNEL_VERSION/);
  });

  it('FAILS when the version was bumped but the changelog has no new entry', () => {
    const result = checkGoldenVersionGate({
      changedFiles: ['test-fixtures/offset/standin-prep-die.offset.golden.json'],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.1.0',
      changelogHasNewVersionEntry: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no added entry mentioning the new version/);
  });

  it('FAILS when the changelog was updated but KERNEL_VERSION was not bumped', () => {
    const result = checkGoldenVersionGate({
      changedFiles: ['test-fixtures/intake/arch-case-01-upperjaw.intake.golden.json'],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.0.0',
      changelogHasNewVersionEntry: true, // e.g. an unrelated edit that happens to mention nothing useful
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/KERNEL_VERSION.*unchanged/);
  });

  it('PASSES a legitimate bump: version changed AND changelog gained a matching entry', () => {
    const result = checkGoldenVersionGate({
      changedFiles: ['test-fixtures/golden/kernel-ops.json', 'docs/CHANGELOG-kernel.md', 'packages/kernel/src/index.ts'],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.1.0',
      changelogHasNewVersionEntry: true,
    });
    expect(result.ok).toBe(true);
    expect(result.goldenFilesChanged).toEqual(['test-fixtures/golden/kernel-ops.json']);
  });

  it('reports every golden-pinned file changed, filtering out non-golden files from the range', () => {
    const result = checkGoldenVersionGate({
      changedFiles: [
        'test-fixtures/golden/kernel-ops.json',
        'test-fixtures/offset/standin-prep-die.offset.golden.json',
        'packages/kernel/src/offset/offsetMesh.ts',
        'docs/CHANGELOG-kernel.md',
      ],
      oldKernelVersion: '0.0.0',
      newKernelVersion: '0.1.0',
      changelogHasNewVersionEntry: true,
    });
    expect(result.ok).toBe(true);
    expect(result.goldenFilesChanged).toEqual([
      'test-fixtures/golden/kernel-ops.json',
      'test-fixtures/offset/standin-prep-die.offset.golden.json',
    ]);
  });
});
