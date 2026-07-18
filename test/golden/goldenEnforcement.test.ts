// test/golden/goldenEnforcement.test.ts
//
// Unit tests of the golden-hash ENFORCEMENT MECHANISM itself, with
// synthetic version/hash inputs — independent of any real kernel op or
// fixture (per this task's guardrail: "test the mechanism both ways — a
// unit test of the enforcement logic itself"). See goldenEnforcement.ts's
// module doc for the exact rule being tested here.
import { describe, expect, it } from 'vitest';
import { checkGoldenHash, checkGoldenSnapshot } from './goldenEnforcement.ts';

describe('checkGoldenHash', () => {
  it('passes when the computed hash matches the golden hash, version unchanged', () => {
    const result = checkGoldenHash({
      opId: 'fakeOp',
      computedHash: 'aaa',
      goldenHash: 'aaa',
      runtimeKernelVersion: '0.0.0',
      goldenKernelVersion: '0.0.0',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('passes when the computed hash matches the golden hash EVEN IF the version differs (a properly-regenerated bump)', () => {
    // This is the guardrail's "must NOT fail when KERNEL_VERSION was
    // legitimately bumped" case: after a real bump + regeneration, the
    // committed file's hash already matches the new runtime output.
    const result = checkGoldenHash({
      opId: 'fakeOp',
      computedHash: 'bbb',
      goldenHash: 'bbb',
      runtimeKernelVersion: '0.1.0',
      goldenKernelVersion: '0.1.0',
    });
    expect(result.ok).toBe(true);
  });

  it('FAILS when the computed hash differs and KERNEL_VERSION is UNCHANGED — the headline enforcement case', () => {
    const result = checkGoldenHash({
      opId: 'fakeOp',
      computedHash: 'aaa',
      goldenHash: 'zzz',
      runtimeKernelVersion: '0.0.0',
      goldenKernelVersion: '0.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/UNCHANGED/);
    expect(result.message).toMatch(/bump/i);
    expect(result.message).toMatch(/docs\/CHANGELOG-kernel\.md/);
  });

  it('FAILS when the computed hash differs and KERNEL_VERSION DID change but the golden was not regenerated (stale bump)', () => {
    const result = checkGoldenHash({
      opId: 'fakeOp',
      computedHash: 'aaa',
      goldenHash: 'zzz',
      runtimeKernelVersion: '0.1.0',
      goldenKernelVersion: '0.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/DID change/);
    expect(result.message).toMatch(/still stale/);
  });

  it('is not fooled by a version change alone when hashes actually agree (no false failure)', () => {
    // Belt-and-suspenders re-statement of the "must not fail" guardrail
    // with a THIRD distinct version pair, to rule out an accidental
    // string-equality-only implementation.
    const result = checkGoldenHash({
      opId: 'fakeOp',
      computedHash: 'same-value',
      goldenHash: 'same-value',
      runtimeKernelVersion: '9.9.9',
      goldenKernelVersion: '0.0.0',
    });
    expect(result.ok).toBe(true);
  });
});

describe('checkGoldenSnapshot', () => {
  it('reports one failing result per mismatched op, and no result for matching ops', () => {
    const computed = {
      kernelVersion: '0.0.0',
      ops: [
        { id: 'a', hash: 'same' },
        { id: 'b', hash: 'changed' },
      ],
    };
    const golden = {
      kernelVersion: '0.0.0',
      ops: [
        { id: 'a', hash: 'same' },
        { id: 'b', hash: 'original' },
      ],
    };
    const results = checkGoldenSnapshot(computed, golden);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
  });

  it('flags an op present in computed but missing from golden (a new op added without regenerating)', () => {
    const computed = { kernelVersion: '0.0.0', ops: [{ id: 'newOp', hash: 'x' }] };
    const golden = { kernelVersion: '0.0.0', ops: [] };
    const results = checkGoldenSnapshot(computed, golden);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.message).toMatch(/no entry in the committed golden file/);
  });

  it('flags an op present in golden but no longer computed (an op removed without updating the golden file)', () => {
    const computed = { kernelVersion: '0.0.0', ops: [] };
    const golden = { kernelVersion: '0.0.0', ops: [{ id: 'oldOp', hash: 'x' }] };
    const results = checkGoldenSnapshot(computed, golden);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.message).toMatch(/no longer computed/);
  });

  it('an entirely clean snapshot (every op matches) reports all-ok', () => {
    const computed = { kernelVersion: '0.0.0', ops: [{ id: 'a', hash: 'x' }, { id: 'b', hash: 'y' }] };
    const golden = { kernelVersion: '0.0.0', ops: [{ id: 'a', hash: 'x' }, { id: 'b', hash: 'y' }] };
    const results = checkGoldenSnapshot(computed, golden);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
