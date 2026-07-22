// packages/clinical-profiles/src/canonicalJson.ts
//
// Deterministic ("canonical") JSON serialization: object keys sorted
// recursively, no whitespace. Used ONLY to give `materialProfile.ts`'s
// checksum a stable byte representation independent of a JSON file's
// on-disk key order/formatting (a human editing standard-zirconia.json and
// reordering keys, or a formatter reflowing whitespace, must NOT change the
// computed checksum — only an actual VALUE change should).
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`;
  }
  // Primitives (string/number/boolean) and null all round-trip correctly
  // through JSON.stringify on their own — no NaN/Infinity/undefined/bigint/
  // function ever appears in a parsed-JSON value, so this never hits
  // JSON.stringify's "returns undefined" edge cases.
  return JSON.stringify(value);
}
