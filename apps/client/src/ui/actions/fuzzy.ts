// Phase 8 Task 2 — tiny deterministic fuzzy matcher for the command palette.
//
// Pure and framework-free (node-lane testable). Subsequence match with a
// lightweight score that rewards a prefix / word-boundary / contiguous run so
// the palette ranks the obvious hit first, without pulling in a dependency.
// Determinism (invariant 2): a pure function of (query, candidate) — a stable
// sort in the palette keeps registry order for equal scores.

export interface FuzzyResult {
  /** True when every query char appears in order in the candidate. */
  readonly matched: boolean;
  /** Higher is better; 0 when `matched` is false. */
  readonly score: number;
}

/**
 * Case-insensitive subsequence match of `query` against `text`. An empty query
 * matches everything with score 0 (the palette then shows the full list in
 * registry order). Scoring: +base per matched char, +bonus when the match sits
 * at the start or just after a separator (space / '-' / '.'), +bonus for a
 * contiguous run — all bounded and integer, so results are reproducible.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return { matched: true, score: 0 };
  }
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatchIndex = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) {
      return { matched: false, score: 0 };
    }
    score += 1;
    if (found === 0) {
      score += 8; // absolute prefix
    } else {
      const before = t[found - 1]!;
      if (before === ' ' || before === '-' || before === '.') {
        score += 4; // word-boundary start
      }
    }
    if (found === prevMatchIndex + 1) {
      score += 3; // contiguous with the previous matched char
    }
    prevMatchIndex = found;
    ti = found + 1;
  }
  return { matched: true, score };
}
