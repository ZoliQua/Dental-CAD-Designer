// packages/kernel-workers/src/journalHash.ts
//
// Phase 7 Task 3 — the CASE JOURNAL HASH: the single shared definition of
// `RestorationExportRequest.caseJournalHash` (shared-types), computed by the
// client at export-request assembly time and RECOMPUTED INDEPENDENTLY by the
// Task 4 server over the journal it receives (dual validation — the shared
// implementation is what makes a mismatch meaningful rather than a
// formatting accident).
//
// ## Definition (precise, binds Tasks 4/5/8)
//
// `hashCaseJournal(history)` = SHA-256 (lowercase hex) over the UTF-8 bytes
// of `canonicalJournalJson(history)`, which serializes the journal's
// REPRODUCIBLE view: a JSON array, one element per `Operation` IN ORDER,
// each element exactly
//
//   { inputHashes, kernelVersion, name, outputHashes, params }
//
// with object keys sorted recursively (arrays keep their order — order IS
// data for hashes and journals). `Operation.id` and `Operation.timestamp`
// are EXCLUDED by definition:
//  - `id` is a random UUID minted at record time — a journal REPLAY (PLAN.md
//    §6.3) regenerates it while reproducing every hash/param, and the
//    journal hash must certify the reproducible content, not the minting
//    session;
//  - `timestamp` is "audit display only — never fed into computations" by
//    `Operation`'s own contract (shared-types); folding it into a hash that
//    downstream validation compares WOULD feed it into a computation.
// Both fields are persisted verbatim with the document, so their exclusion
// is a definition choice, not a stability necessity: the hash is stable
// across save/load either way, and ADDITIONALLY stable across replay.
//
// ## Canonicalization strictness
//
// Same key-sorted/no-whitespace shape as `@dqcad/clinical-profiles`'
// `canonicalStringify` (not imported: kernel-workers → clinical-profiles is
// not an allowed dependency edge — see eslint.config.js's boundaries
// policy), but deliberately STRICTER: that helper only ever sees
// parsed-JSON values, while journal `params` are arbitrary in-memory
// `Record<string, unknown>` built by engine code. Any value JSON cannot
// faithfully represent — NaN/±Infinity (JSON.stringify silently emits
// `null`, so two DIFFERENT param sets could collide), bigint, function,
// symbol, typed arrays, Date/Map/class instances, `undefined` array
// elements — is REJECTED with a typed `JournalHashUnserializableError`
// naming the offending path. A journal hash that silently normalizes lossy
// values would certify something other than what the journal says.
// `undefined` OBJECT properties are dropped (standard JSON.stringify
// semantics — an absent property and an undefined property are the same
// journal content).
//
// Not in the Node worker-entry import closure (no job imports this file),
// so relative imports use the repo's normal `.js` convention — see
// CLAUDE.md's "Import extension convention".
import type { Operation } from '@dqcad/shared-types';
import { sha256Hex } from './hash.js';

/** Thrown when a journal operation carries a value the canonical JSON
 * cannot faithfully represent — see this module's doc. `path` names the
 * offending location (e.g. `history[3].params.outer.inner`). */
export class JournalHashUnserializableError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`hashCaseJournal: ${path} is not canonically serializable — ${detail}`);
    this.name = 'JournalHashUnserializableError';
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function canonicalStringifyStrict(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JournalHashUnserializableError(path, `non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new JournalHashUnserializableError(path, 'bigint has no faithful JSON representation');
    case 'function':
      throw new JournalHashUnserializableError(path, 'function values cannot be journaled');
    case 'symbol':
      throw new JournalHashUnserializableError(path, 'symbol values cannot be journaled');
    case 'undefined':
      // Reachable only for ARRAY elements (object properties with undefined
      // values are dropped by the object branch below) — JSON.stringify
      // would silently write `null`; reject instead.
      throw new JournalHashUnserializableError(path, 'undefined array element (JSON would coerce to null)');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((element, i) => canonicalStringifyStrict(element, `${path}[${i}]`)).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new JournalHashUnserializableError(
          path,
          'non-plain object (typed array / Date / Map / class instance) has no canonical JSON form',
        );
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalStringifyStrict(record[key], `${path}.${key}`)}`)
        .join(',')}}`;
    }
    default:
      // Unreachable: the cases above cover every `typeof` result — kept for
      // the compiler's control-flow analysis (typeof-switch exhaustiveness
      // is not narrowed like a discriminated union's).
      throw new JournalHashUnserializableError(path, `unsupported value type ${typeof value}`);
  }
}

/**
 * Canonical JSON of the journal's reproducible view — see this module's doc
 * for the exact definition (per-op field set, key sorting, id/timestamp
 * exclusion, strictness).
 *
 * @throws {JournalHashUnserializableError} for any value the canonical form
 * cannot faithfully represent (never silently normalized).
 */
export function canonicalJournalJson(history: readonly Operation[]): string {
  const parts = history.map((operation, i) =>
    canonicalStringifyStrict(
      {
        inputHashes: operation.inputHashes,
        kernelVersion: operation.kernelVersion,
        name: operation.name,
        outputHashes: operation.outputHashes,
        params: operation.params,
      },
      `history[${i}]`,
    ),
  );
  return `[${parts.join(',')}]`;
}

/** The case journal hash — SHA-256 (lowercase hex) over the UTF-8 bytes of
 * `canonicalJournalJson(history)`. See this module's doc for the full
 * definition and stability contract. */
export async function hashCaseJournal(history: readonly Operation[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJournalJson(history)));
}
