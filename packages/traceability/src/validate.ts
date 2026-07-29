// packages/traceability/src/validate.ts
//
// Phase 7 Task 5 — the schema validator for QcTraceabilityDocument, over the
// SINGLE schema authority `@dqcad/shared-types`'
// QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA (the acceptance criterion: "the QC
// JSON is schema-validated" — generation validates through this module, and
// CI validates the pinned goldens through it).
//
// SUBPATH MODULE (`@dqcad/traceability/validate`), deliberately not part of
// the root barrel: this file pulls in `ajv` (a full JSON-Schema compiler),
// which the server and test suites need but the client's preview rendering
// does not — keeping it out of `.` keeps ajv out of the browser bundle by
// construction rather than by tree-shaking luck.
import { Ajv, type ValidateFunction } from 'ajv';
import { QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA } from '@dqcad/shared-types';

/** Thrown by `assertValidTraceabilityDocument` — carries the flattened ajv
 * error paths so a generation-time failure names exactly what is malformed
 * (a genuine implementation bug: builders can only produce valid shapes). */
export class TraceabilityDocumentValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(
      `the QC traceability document does not validate against schema version ` +
        `${String(QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA.properties.schemaVersion.const)}: ${errors.join('; ')}`,
    );
    this.name = 'TraceabilityDocumentValidationError';
    this.errors = errors;
  }
}

// Compiled ONCE at module load — ajv compilation is deterministic and the
// schema is a static constant. `allErrors` so a failure names every
// violation, not just the first.
const ajv = new Ajv({ allErrors: true });
const compiled: ValidateFunction = ajv.compile(QC_TRACEABILITY_DOCUMENT_JSON_SCHEMA);

export type TraceabilityValidationResult = { valid: true } | { valid: false; errors: string[] };

/** Validates `value` against the shared-types schema. Never throws — the
 * result names every violation (`instancePath` + message). */
export function validateTraceabilityDocument(value: unknown): TraceabilityValidationResult {
  if (compiled(value)) {
    return { valid: true };
  }
  const errors = (compiled.errors ?? []).map(
    (error) =>
      `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'invalid'}`,
  );
  return { valid: false, errors: errors.length > 0 ? errors : ['unknown validation failure'] };
}

/** The generation-time gate: throws the typed error on any violation. */
export function assertValidTraceabilityDocument(value: unknown): void {
  const result = validateTraceabilityDocument(value);
  if (!result.valid) {
    throw new TraceabilityDocumentValidationError(result.errors);
  }
}
