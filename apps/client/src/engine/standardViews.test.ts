import { describe, expect, it } from 'vitest';
import {
  resolveJawContext,
  standardViewOffset,
  STANDARD_VIEW_KEY_ORDER,
  STANDARD_VIEWS,
  type StandardView,
} from './standardViews';

describe('resolveJawContext', () => {
  it('returns "none" for an empty role list', () => {
    expect(resolveJawContext([])).toBe('none');
  });

  it('returns "upperJaw" when only upperJaw is present', () => {
    expect(resolveJawContext(['upperJaw', 'gingiva'])).toBe('upperJaw');
  });

  it('returns "lowerJaw" when only lowerJaw is present', () => {
    expect(resolveJawContext(['lowerJaw'])).toBe('lowerJaw');
  });

  it('returns "mixed" when both jaws are present', () => {
    expect(resolveJawContext(['upperJaw', 'lowerJaw', 'antagonist'])).toBe('mixed');
  });

  it('returns "none" for roles that never include a jaw', () => {
    expect(resolveJawContext(['prepDie', 'situ', 'gingiva'])).toBe('none');
  });
});

describe('standardViewOffset — occlusal jaw-aware flip', () => {
  it('upper jaw: camera below, looking up (+Y target direction)', () => {
    expect(standardViewOffset('occlusal', 'upperJaw')).toEqual([0, -1, 0]);
  });

  it('lower jaw: camera above, looking down (-Y target direction)', () => {
    expect(standardViewOffset('occlusal', 'lowerJaw')).toEqual([0, 1, 0]);
  });

  it('mixed scene defaults to the lower-jaw convention', () => {
    expect(standardViewOffset('occlusal', 'mixed')).toEqual(standardViewOffset('occlusal', 'lowerJaw'));
  });

  it('no jaw present defaults to the lower-jaw convention', () => {
    expect(standardViewOffset('occlusal', 'none')).toEqual(standardViewOffset('occlusal', 'lowerJaw'));
  });

  it('upper and lower are exact opposites', () => {
    const upper = standardViewOffset('occlusal', 'upperJaw');
    const lower = standardViewOffset('occlusal', 'lowerJaw');
    // Negating 0 produces -0, which vitest's toEqual/toBe treat as distinct
    // from 0 (Object.is semantics) — toBeCloseTo compares numerically
    // instead, sidestepping the -0 vs 0 non-issue.
    expect(upper[0]).toBeCloseTo(-lower[0], 10);
    expect(upper[1]).toBeCloseTo(-lower[1], 10);
    expect(upper[2]).toBeCloseTo(-lower[2], 10);
  });
});

describe('standardViewOffset — non-occlusal views are jaw-independent', () => {
  const nonOcclusal: readonly StandardView[] = STANDARD_VIEWS.filter((v) => v !== 'occlusal');

  it.each(nonOcclusal)('%s is identical across every jaw context', (view) => {
    const contexts = ['upperJaw', 'lowerJaw', 'mixed', 'none'] as const;
    const offsets = contexts.map((ctx) => standardViewOffset(view, ctx));
    for (const offset of offsets.slice(1)) {
      expect(offset).toEqual(offsets[0]);
    }
  });

  it('every view direction is a unit vector', () => {
    for (const view of STANDARD_VIEWS) {
      const [x, y, z] = standardViewOffset(view, 'upperJaw');
      const length = Math.sqrt(x * x + y * y + z * z);
      expect(length).toBeCloseTo(1, 10);
    }
  });

  it('all 6 views are pairwise distinct directions', () => {
    const offsets = STANDARD_VIEWS.map((view) => standardViewOffset(view, 'upperJaw').join(','));
    expect(new Set(offsets).size).toBe(STANDARD_VIEWS.length);
  });

  it('front and lingual are exact opposites', () => {
    expect(standardViewOffset('front', 'none')).toEqual([0, 0, 1]);
    expect(standardViewOffset('lingual', 'none')).toEqual([0, 0, -1]);
  });

  it('buccal and mesial are exact opposites', () => {
    expect(standardViewOffset('buccal', 'none')).toEqual([1, 0, 0]);
    expect(standardViewOffset('mesial', 'none')).toEqual([-1, 0, 0]);
  });
});

describe('STANDARD_VIEW_KEY_ORDER (digit→view mapping source)', () => {
  it('covers all 6 standard views exactly once (the registry indexes this array)', () => {
    expect([...STANDARD_VIEW_KEY_ORDER].sort()).toEqual([...STANDARD_VIEWS].sort());
  });
});
