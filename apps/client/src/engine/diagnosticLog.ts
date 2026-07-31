// apps/client/src/engine/diagnosticLog.ts
//
// Phase 8 Task 5 — the bounded, PHI-FREE-BY-CONSTRUCTION in-memory log ring.
//
// The diagnostic bundle (engine/diagnosticBundle.ts) carries a snapshot of the
// most recent technical log events so a maintainer can see the sequence that led
// to an error. This module is that log's single source of truth.
//
// ## Two hard properties, both enforced here (not by after-the-fact scrubbing)
//
// 1. BOUNDED. The ring holds at most `DIAGNOSTIC_LOG_CAPACITY` entries; the
//    oldest is dropped when the cap is exceeded. A crash bundle can therefore
//    never grow without limit, and the log's memory cost is fixed.
//
// 2. PHI-FREE BY CONSTRUCTION. An entry carries an `event` (a CODE-CONTROLLED
//    label — never user/case content) plus a small `fields` bag restricted to
//    SCALARS (string | number | boolean). The intended discipline is: callers
//    log ids, content HASHES, versions, counts, and event names — never case
//    document content, never scan geometry, never patient identifiers. Two
//    layers back that discipline up so a mistake cannot leak a whole object:
//      - the `fields` type only permits scalar values (a `CaseDocument` or a
//        geometry buffer is a type error at the call site); and
//      - at runtime `logDiagnostic` DROPS any field whose value is not a scalar
//        (defensive against an `unknown`-typed caller) — a nested object/array
//        is never serialized into the ring, so it can never reach the bundle.
//    This is a deliberate ALLOWLIST posture (scalars in, everything else out),
//    matching the bundle builder's allowlist: a new kind of value is excluded by
//    default, not scrubbed after the fact.
//
// Layer: engine/ leaf module — depends on nothing (no store, no kernel, no DOM,
// no network). Node-lane testable.

/** A single scalar a log field may carry — see this module's doc. */
export type DiagnosticLogFieldValue = string | number | boolean;

/** The narrow, scalar-only field bag a log entry may carry. Typed to forbid
 * objects/arrays at the call site; enforced again at runtime (drop). */
export type DiagnosticLogFields = Readonly<Record<string, DiagnosticLogFieldValue>>;

export type DiagnosticLogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  /** Monotonic per-session sequence number (1-based). Lets a reader order
   * entries even though timestamps are display-only. */
  readonly seq: number;
  /** ISO-8601 — metadata/display only, NEVER fed into any computation. */
  readonly at: string;
  readonly level: DiagnosticLogLevel;
  /** A code-controlled event label (e.g. `'case.opened'`) — never user copy. */
  readonly event: string;
  /** Scalar-only diagnostic fields (ids / hashes / versions / counts). */
  readonly fields: DiagnosticLogFields;
}

/** Max entries retained. Small enough to keep the bundle compact, large enough
 * to show a meaningful lead-up to an error. */
export const DIAGNOSTIC_LOG_CAPACITY = 200;

// A ring implemented as a plain array with a head-drop on overflow — capacity is
// small, so the O(n) shift is negligible and the code stays obviously correct.
let ring: DiagnosticLogEntry[] = [];
let sequence = 0;

// Injectable clock (test seam) so a bundle's log can be pinned deterministically.
let clock: () => string = () => new Date().toISOString();

function isScalar(value: unknown): value is DiagnosticLogFieldValue {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/** Keep only scalar-valued fields — defensive PHI guard (see module doc). A
 * non-scalar value (object/array/function/etc.) is DROPPED, never serialized. */
function sanitizeFields(fields: DiagnosticLogFields | undefined): DiagnosticLogFields {
  if (fields === undefined) {
    return {};
  }
  const out: Record<string, DiagnosticLogFieldValue> = {};
  for (const key of Object.keys(fields)) {
    const value: unknown = fields[key];
    if (isScalar(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Append one entry to the PHI-free ring. `event` is a code-controlled label;
 * `fields` is scalar-only (ids/hashes/versions/counts). Non-scalar field values
 * are dropped (never serialized). Never throws.
 */
export function logDiagnostic(
  level: DiagnosticLogLevel,
  event: string,
  fields?: DiagnosticLogFields,
): void {
  sequence += 1;
  ring.push({
    seq: sequence,
    at: clock(),
    level,
    event,
    fields: sanitizeFields(fields),
  });
  if (ring.length > DIAGNOSTIC_LOG_CAPACITY) {
    // Drop oldest — keep the most recent CAPACITY entries.
    ring = ring.slice(ring.length - DIAGNOSTIC_LOG_CAPACITY);
  }
}

/** Convenience wrappers. */
export function logInfo(event: string, fields?: DiagnosticLogFields): void {
  logDiagnostic('info', event, fields);
}
export function logWarn(event: string, fields?: DiagnosticLogFields): void {
  logDiagnostic('warn', event, fields);
}
export function logError(event: string, fields?: DiagnosticLogFields): void {
  logDiagnostic('error', event, fields);
}

/** An immutable snapshot of the current ring (oldest → newest). The bundle
 * builder copies this verbatim. */
export function diagnosticLogSnapshot(): readonly DiagnosticLogEntry[] {
  return ring.slice();
}

/** TEST-ONLY: clear the ring and reset the sequence + clock. */
export function resetDiagnosticLogForTests(injectedClock?: () => string): void {
  ring = [];
  sequence = 0;
  clock = injectedClock ?? (() => new Date().toISOString());
}
