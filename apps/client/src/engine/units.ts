// apps/client/src/engine/units.ts
//
// Unit-mistake heuristic (docs/plans/phase-1-import-viewer.md Task 5 §2 /
// CLAUDE.md "Common pitfalls": "STL has no units — bbox heuristic + mandatory
// user confirmation; never silently rescale"). PLY carries no reliable unit
// metadata either (only vertex/face element properties — see packages/io's
// PLY module doc), so the same heuristic applies to both parsed formats.
//
// A full dental arch scan is clinically expected to span roughly 40-80 mm
// (mesio-distal width of an adult arch). If the parsed bbox's largest extent
// falls well outside that band, the file's numbers are very likely NOT in
// millimeters even though the format has no unit field to check — the two
// most common scanner/exporter mistakes are centimeters (values 10x too
// small) and micrometers (values 1000x too large). This module only ever
// PROPOSES a correction; apps/client/src/engine/importer.ts is responsible
// for gating any actual rescale behind an explicit, non-defaultable user
// confirmation (CLAUDE.md invariant 5: "No silent data mutation").
//
// Bbox is computed here directly over the raw parsed positions (BEFORE
// intake's weld/analyze stages) — the check only needs a coordinate extent,
// not a validated topology, so it runs on whatever `parseMeshFile` returned
// without waiting on a second worker round trip.

/** Lower bound of a clinically plausible full-arch scan's largest bbox
 * extent, in mm. Informational — only the two SUSPECT_* thresholds below
 * actually drive the heuristic's decision; this constant documents where
 * the "definitely fine, do nothing" band starts. */
export const EXPECTED_ARCH_EXTENT_MIN_MM = 40;

/** Upper bound of a clinically plausible full-arch scan's largest bbox
 * extent, in mm. See EXPECTED_ARCH_EXTENT_MIN_MM. */
export const EXPECTED_ARCH_EXTENT_MAX_MM = 80;

/** Below this, the scan is almost certainly too small to be a real
 * mm-scale dental object — the classic symptom of a file actually authored
 * in centimeters (so the true mm size is 10x the parsed numbers). Strictly
 * less-than: exactly 8 mm is left unflagged (a small die/prep fragment is a
 * legitimate mm-scale import). */
export const SUSPECT_CM_MAX_EXTENT_MM = 8;

/** Above this, the scan is almost certainly too large to be a real mm-scale
 * dental object — the classic symptom of a file actually authored in
 * micrometers (so the true mm size is 1/1000th of the parsed numbers).
 * Strictly greater-than: exactly 400 mm is left unflagged. */
export const SUSPECT_UM_MIN_EXTENT_MM = 400;

/** Multiply parsed (mis-scaled) coordinates by this to convert cm -> mm. */
export const CM_TO_MM_FACTOR = 10;

/** Multiply parsed (mis-scaled) coordinates by this to convert µm -> mm. */
export const UM_TO_MM_FACTOR = 0.001;

export interface BboxMm {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/**
 * Bounding box over `positions` (a flat, Float64, xyz-triples buffer — works
 * uniformly whether it's an unindexed 9-per-triangle soup (STL) or a
 * 3-per-vertex indexed buffer (PLY): both are just a sequence of xyz
 * triples, and repeated soup vertices don't change the resulting extent).
 * Returns the degenerate zero box for an empty buffer, mirroring
 * @dqcad/kernel's `analyzeMesh` convention for a zero-triangle mesh.
 */
export function computeBboxMm(positions: Float64Array): BboxMm {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function bboxMaxExtentMm(bbox: BboxMm): number {
  const dx = bbox.max[0] - bbox.min[0];
  const dy = bbox.max[1] - bbox.min[1];
  const dz = bbox.max[2] - bbox.min[2];
  return Math.max(dx, dy, dz);
}

export type SuspectedUnit = 'cm' | 'um';

export interface UnitRescaleSuggestion {
  suspectedUnit: SuspectedUnit;
  /** Factor to multiply parsed coordinates by to reach true mm scale. */
  factor: number;
  /** The bbox max extent (mm, as parsed — i.e. still in the suspect unit)
   * that triggered this suggestion, surfaced for the confirmation dialog's
   * message. */
  maxExtentMm: number;
}

/**
 * Returns a rescale suggestion iff `bbox`'s largest extent falls outside the
 * plausible mm range (see SUSPECT_CM_MAX_EXTENT_MM / SUSPECT_UM_MIN_EXTENT_MM
 * above), else `null` (no suspicion — importer.ts proceeds without ever
 * showing a confirmation dialog). This function only SUGGESTS; it never
 * mutates anything and has no notion of a default/timeout choice — see this
 * module's doc comment.
 */
export function suggestUnitRescale(bbox: BboxMm): UnitRescaleSuggestion | null {
  const maxExtentMm = bboxMaxExtentMm(bbox);
  if (maxExtentMm < SUSPECT_CM_MAX_EXTENT_MM) {
    return { suspectedUnit: 'cm', factor: CM_TO_MM_FACTOR, maxExtentMm };
  }
  if (maxExtentMm > SUSPECT_UM_MIN_EXTENT_MM) {
    return { suspectedUnit: 'um', factor: UM_TO_MM_FACTOR, maxExtentMm };
  }
  return null;
}
