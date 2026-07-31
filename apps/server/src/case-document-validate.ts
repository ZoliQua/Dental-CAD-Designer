// apps/server/src/case-document-validate.ts
//
// Server code-review MEDIUM #2 (Defect B) — a standalone validator for the
// strict `caseDocumentSchema` (schemas.ts), so the archive-IMPORT write path can
// enforce the SAME document contract `PUT /api/cases/:id` enforces before it
// persists a reconstructed document.
//
// Why this exists: the PUT route validates its body through Fastify's own AJV
// (schemaVersion `const: 2`, full `required`, `additionalProperties: false`).
// The archive import reconstructs a `CaseDocument` from client-supplied archive
// bytes and wrote it to `Case.documentJson` with NO schema check — a second,
// unvalidated write path that could persist a document PUT would reject
// (arbitrary `schemaVersion`, missing/extra fields), which `GET /api/cases/:id`
// then serves verbatim (ADR-005, no response schema). This module closes that
// gap with a compiled-once AJV validator over the exact same schema object.
//
// STRICT options, chosen deliberately to REJECT (never silently mutate) a
// malformed document — matching a request-side gate's intent:
//   - `coerceTypes: false`  — a string `schemaVersion` is a rejection, not a
//     silent cast to a number.
//   - `removeAdditional: false` — an unknown field is a rejection (the
//     `additionalProperties: false` error), never silently stripped.
//   - `useDefaults: false`  — the archive's document is persisted as-authored;
//     no field is invented.
// `allErrors: true` surfaces every failure at once for a readable diagnostic.
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { CaseDocument } from '@dqcad/shared-types';
import { caseDocumentSchema } from './schemas.js';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});

// Compiled ONCE at module load (the same cheap-on-every-call discipline the
// traceability read-path validator uses). The schema is a self-contained object
// (no `$ref`), so a single `compile` is sufficient.
const validate: ValidateFunction = ajv.compile(caseDocumentSchema as unknown as Record<string, unknown>);

export interface CaseDocumentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

/**
 * Validates a reconstructed document against the strict `caseDocumentSchema`.
 * Pure (does not mutate `document` — `removeAdditional`/`useDefaults`/
 * `coerceTypes` are all off). Returns the AJV error list on failure so the
 * caller can name the specific failure in a typed 4xx.
 */
export function validateCaseDocument(document: unknown): CaseDocumentValidationResult {
  const valid = validate(document) as boolean;
  return { valid, errors: valid ? [] : (validate.errors ?? []) };
}

/** A one-line human summary of the FIRST validation error (schema path +
 * message) — for the typed rejection body naming the failure. */
export function summarizeCaseDocumentErrors(errors: readonly ErrorObject[]): string {
  const first = errors[0];
  if (!first) return 'unknown validation error';
  const where = first.instancePath === '' ? '(root)' : first.instancePath;
  return `${where} ${first.message ?? 'is invalid'}`.trim();
}

/** Re-export the CaseDocument type for callers narrowing after a successful
 * validation. */
export type { CaseDocument };
