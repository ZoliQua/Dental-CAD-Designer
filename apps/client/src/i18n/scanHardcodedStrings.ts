// Phase 8 Task 1 — hardcoded-string guard (scanner core).
//
// Static AST scan that finds USER-FACING string literals rendered in the UI
// layer (`apps/client/src/ui/**`) outside the i18n system. The CLAUDE.md
// frontend invariant is "No hardcoded UI strings; keys in
// apps/client/src/i18n/" — react-i18next is the ONLY sanctioned source of UI
// copy, so any bare prose in JSX is a locale that silently ships English.
//
// This is intentionally a scanning guard (a Vitest test drives it — see
// scanHardcodedStrings.test.ts) rather than a bundled eslint plugin: the
// detection surface is tiny and precisely scoped, and a pure function is far
// easier to prove FALSIFIABLE (a seeded hardcoded string must fail) and to
// unit-test to the ≥90% bar than a custom flat-config rule module.
//
// SCOPE (matches the Task 1 brief): JSX text nodes + a small set of
// user-facing string PROPS. Everything else — className, data-*, keys, event
// handlers, technical constants, i18n key arguments to t() — is out of scope
// by construction, so the guard never fires on them.
//
// STRUCTURAL LIMITATIONS (a green guard is NOT proof of full coverage). This is
// a syntactic scan, not dataflow analysis, so it is *incapable* of seeing a
// user-facing string that reaches the DOM through a variable rather than a
// literal:
//   • const/variable-hoisted text — `const label = 'Export'; <b>{label}</b>`.
//   • string-literal ternary as a JSX child — `{ok ? 'Ready' : 'Not ready'}`.
//   • a raw `error.message` routed through a state setter or a store value and
//     rendered as `{startError}` / `{error}` (the F1 class — see the sibling
//     lock DesignPanelErrorI18n.dom.test.tsx, which covers it behaviorally).
//   • strings handed to non-JSX sinks — `throw new Error(...)`, `alert(...)`,
//     template-literal JSX expressions (`` `${x} mm²` ``).
// None of these patterns carry hardcoded user copy in ui/ today (audited), but
// closing them needs `t()`-tracing lint or behavioral tests, not this scanner.
import ts from 'typescript';

/**
 * Attributes whose string-literal value is rendered to (or announced to) the
 * user and therefore MUST come from i18n. Deliberately narrow — props like
 * `className`, `id`, `name`, `type`, `role`, `htmlFor`, `data-testid`, and any
 * `data-*`/`aria-*` other than `aria-label` are technical, not user copy, and
 * are never flagged.
 */
export const USER_FACING_PROPS: ReadonlySet<string> = new Set([
  'label',
  'title',
  'placeholder',
  'aria-label',
  'alt',
]);

/**
 * The narrow, documented allowlist: trimmed text that consists solely of a
 * metric-unit / typographic symbol token is NOT translatable UI copy. This
 * mirrors the established, already-documented convention in
 * `apps/client/src/engine/formatMm.ts`: unit SYMBOLS ("mm"/"µm"/"°") are
 * identical across en/hu/de/es (the metric system is locale-invariant) — only
 * the LABEL that precedes a value is translated. Prose that happens to contain
 * one of these substrings is still flagged, because the match is on the WHOLE
 * trimmed text, exact.
 *
 * Keep this list minimal and reviewed: adding a token here is an explicit
 * assertion that it is a locale-invariant unit/symbol, not copy. `×`, `·`,
 * `—`, `–`, `%`, `°` need no entry — they contain no Unicode letter, so they
 * are never candidates in the first place.
 */
export const ALLOWED_UNIT_TOKENS: ReadonlySet<string> = new Set([
  'µm',
  'mm',
  'cm',
  'nm',
  'µm²',
  'mm²',
  'cm²',
  'µm³',
  'mm³',
  'mm²/s',
]);

export interface HardcodedStringViolation {
  readonly fileName: string;
  readonly line: number;
  /** 'text' for a JSX text node, or `prop:<name>` for a string-prop value. */
  readonly kind: string;
  readonly value: string;
}

const HAS_LETTER = /\p{L}/u;

/**
 * A candidate string is a violation only if it contains at least one Unicode
 * letter (pure numbers/symbols/punctuation are never UI copy) AND its trimmed
 * form is not an allowlisted unit token.
 */
function isViolation(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (trimmed === '') {
    return false;
  }
  if (!HAS_LETTER.test(trimmed)) {
    return false;
  }
  return !ALLOWED_UNIT_TOKENS.has(trimmed);
}

function stringLiteralFromInitializer(
  initializer: ts.JsxAttribute['initializer'],
): ts.StringLiteral | undefined {
  if (initializer === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(initializer)) {
    return initializer;
  }
  // `prop={'literal'}` — a string literal wrapped in a JSX expression.
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    ts.isStringLiteral(initializer.expression)
  ) {
    return initializer.expression;
  }
  return undefined;
}

/**
 * Scan one TSX source for hardcoded user-facing strings. Pure: given the same
 * `fileName` + `sourceText` it always returns the same violations (sorted by
 * line, then kind) — no filesystem, no ordering flakiness.
 */
export function scanSourceForHardcodedStrings(
  fileName: string,
  sourceText: string,
): HardcodedStringViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const violations: HardcodedStringViolation[] = [];

  const record = (node: ts.Node, kind: string, value: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ fileName, line: line + 1, kind, value });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (isViolation(node.text)) {
        record(node, 'text', node.text.trim());
      }
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const propName = node.name.text;
      if (USER_FACING_PROPS.has(propName)) {
        const literal = stringLiteralFromInitializer(node.initializer);
        if (literal !== undefined && isViolation(literal.text)) {
          record(node, `prop:${propName}`, literal.text.trim());
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  violations.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return violations;
}
