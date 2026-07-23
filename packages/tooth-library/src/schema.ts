// packages/tooth-library/src/schema.ts
//
// The tooth asset FORMAT (PLAN.md's Phase 4 tooth-library task: "documented
// for third-party import"). A tooth asset is TWO separately-addressable
// pieces:
//   1. Watertight anatomical mesh bytes (binary STL — packages/io's
//      `writeStlBinary`/`parseStl`), content-addressed by `meshChecksum`.
//   2. This metadata JSON: FDI number, named landmarks, a canonical local
//      frame, morph-target vertex deltas, a version, and its OWN checksum
//      over every other field.
// This split mirrors `@dqcad/clinical-profiles`' MaterialProfile precedent
// (schema.ts's `validateMaterialProfileShape`/`loadMaterialProfile` pair)
// closely enough that anyone already familiar with that package recognizes
// the shape immediately: hand-rolled structural validation (this is a
// single small fixed-shape document, same "no ajv" reasoning as
// materialProfile.ts's own module doc), a SHA-256 corruption-detection
// checksum (NOT a security primitive — same threat model as that package's:
// "did this get mangled", not "was this tampered with by an adversary" —
// checked-in-and-code-reviewed source, not an internet-facing upload), and
// a loud typed error on ANY shape or checksum failure (CLAUDE.md invariant
// 4/5's "corrupt -> loud typed error", never a silent fallback).
//
// A THIRD-PARTY tooth asset (a real anatomical library eventually replacing
// this task's procedural placeholder set — see generate/README's provenance
// doc) only needs to produce: a watertight binary-STL mesh, and a JSON file
// matching this exact shape with `meshChecksum` set to that STL's own
// SHA-256 and `metadataChecksum` set to `computeToothAssetMetadataChecksum`
// of everything else. `loadToothAssetMetadata` below is the only function
// that needs to accept it.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { canonicalStringify, sha256Bytes, sha256HexOfString } from '@dqcad/clinical-profiles';

/** Broad tooth-shape family — drives which landmark SET is anatomically
 * meaningful (an incisor has no cusps; a molar has no incisal edge). Only
 * the two families this task's starter set actually populates are listed;
 * a canine/premolar generator (YAGNI for this task, see generate/README)
 * would add its own member here, never repurpose an existing one. */
export type ToothType = 'incisor' | 'molar';

/** Named surface landmarks, keyed by a documented per-`ToothType` name set
 * (see generate/README.md's landmark table) — e.g. an incisor's
 * `'incisalEdge'`/`'cingulum'`/`'mesialMarginalRidge'`/`'distalMarginalRidge'`/
 * `'mesialContact'`/`'distalContact'`, or a molar's
 * `'mesiobuccalCusp'`/`'distobuccalCusp'`/`'mesiolingualCusp'`/
 * `'distolingualCusp'`/`'centralFossa'`/`'mesialMarginalRidge'`/
 * `'distalMarginalRidge'`. A `Record` (not a fixed interface) so a
 * third-party asset can carry a superset of names for its own tooth type
 * without a schema.ts change — `loader.ts` and the anatomy-placement stage
 * (Task 5) look landmarks up by name and tolerate an unfamiliar name being
 * present (they only require the ones they actually consume). Every
 * position is Float64 mm in the asset's OWN `canonicalFrame` (not
 * necessarily world space — see `CanonicalFrame`'s doc). */
export type ToothLandmarks = Readonly<Record<string, Vec3>>;

/** A right-handed local frame axis triple + origin, all in the mesh's own
 * coordinate space (the space `landmarks` and the mesh's own vertex
 * positions are expressed in — this asset format does not separately
 * carry a "world transform"; anatomy-placement (Task 5) is what maps this
 * frame onto a prep's own insertion axis). `mesialDistal`/`buccoLingual`/
 * `occlusoGingival` must each be unit length and mutually orthogonal
 * (`validateToothAssetMetadataShape` enforces this to a documented
 * tolerance — see `FRAME_ORTHONORMALITY_TOLERANCE`) — a non-orthonormal
 * frame would silently skew every downstream landmark-relative computation
 * (adaptation/morphing, Task 3, reads cusp height "along
 * occlusoGingival"). Sign convention (this package's own generators, and
 * the convention any third-party asset should follow): `mesialDistal`
 * increases toward DISTAL, `buccoLingual` increases toward BUCCAL/LABIAL,
 * `occlusoGingival` increases toward OCCLUSAL/INCISAL. */
export interface CanonicalFrame {
  origin: Vec3;
  mesialDistal: Vec3;
  buccoLingual: Vec3;
  occlusoGingival: Vec3;
}

/** One named morphable shape variation. `vertexDeltas` is a FLAT xyz-per-
 * vertex mm offset array — `vertexDeltas.length === mesh.positions.length`
 * (same vertex ORDER as the mesh's own `IndexedMesh.positions`; index i's
 * delta applies to vertex i) — added to the base mesh's positions, scaled
 * by a caller-chosen weight in `[0, 1]` (weight application is the
 * adaptation stage's job, Task 3; this package only carries the deltas).
 * `name` is a free-form string (not a closed union — see `ToothLandmarks`'s
 * doc for the same "third-party extensibility" reasoning); this task's own
 * generators use `'cuspHeight'`/`'cuspWidth'`-style names per
 * generate/README.md's table. */
export interface MorphTarget {
  name: string;
  vertexDeltas: readonly number[];
}

/** The versioned, checksum-verified metadata half of a tooth asset (see
 * this module's top doc for the mesh-bytes half). */
export interface ToothAssetMetadata {
  fdi: FdiTooth;
  /** Semver-shaped; bumped on ANY value change (same audit-trail-via-
   * version-bump convention as `MaterialProfile.version`'s doc) — includes
   * a change to the underlying mesh, since `meshChecksum` is itself a field
   * this checksum covers. */
  version: string;
  toothType: ToothType;
  /** Human-readable provenance/replaceability statement — REQUIRED (not
   * optional) so a consumer can never load an asset without knowing where
   * its anatomy came from. This task's own starter set always sets this to
   * a string starting with `'PLACEHOLDER-ANATOMY:'` — see
   * `PLACEHOLDER_PROVENANCE_PREFIX` and generate/README.md's licensing-risk
   * mitigation note (PLAN.md §9). A real third-party library replacing a
   * given FDI's asset would set this to its own real citation instead. */
  provenance: string;
  landmarks: ToothLandmarks;
  canonicalFrame: CanonicalFrame;
  morphTargets: readonly MorphTarget[];
  /** Lowercase 64-hex-char SHA-256 of the asset's mesh bytes (binary STL) —
   * the join key between this metadata and its mesh (see this module's top
   * doc: the two are separately addressable; a loader fetches/reads the
   * mesh bytes by this hash and MUST re-verify it, per `loader.ts`). */
  meshChecksum: string;
  /** SHA-256 hex of `canonicalStringify` over every OTHER field of this
   * object (mirrors `MaterialProfile.checksum`'s doc/scheme exactly). */
  metadataChecksum: string;
}

export type RawToothAssetMetadataJson = Record<string, unknown>;

/** Thrown by `loadToothAssetMetadata`/`validateToothAssetMetadataShape` for
 * ANY structural problem: missing/wrong-type field, malformed checksum
 * shape, non-orthonormal frame, or a `vertexDeltas` length mismatch.
 * CLAUDE.md invariant 4/5's "corrupt -> loud typed error". */
export class ToothAssetMetadataValidationError extends Error {
  constructor(message: string) {
    super(`ToothAssetMetadataValidationError: ${message}`);
    this.name = 'ToothAssetMetadataValidationError';
  }
}

/** Thrown by `loadToothAssetMetadata` when the recorded `metadataChecksum`
 * disagrees with the recomputed one — a SHAPE-valid but CONTENT-corrupted
 * (or hand-edited-without-re-deriving-the-checksum) metadata file. Kept
 * distinct from `ToothAssetMetadataValidationError` (mirrors
 * `materialProfile.ts`'s split of "shape" vs "checksum" failures into two
 * independently-testable modes) so a test can assert specifically on a
 * tamper scenario without conflating it with a malformed-shape scenario. */
export class ToothAssetMetadataChecksumError extends Error {
  constructor(fdi: number, recorded: string, recomputed: string) {
    super(
      `ToothAssetMetadataChecksumError: tooth asset metadata for FDI ${fdi} failed checksum ` +
        `verification (recorded ${recorded}, recomputed ${recomputed}) — the metadata JSON was ` +
        'corrupted or hand-edited without re-deriving metadataChecksum.',
    );
    this.name = 'ToothAssetMetadataChecksumError';
  }
}

/** Thrown by `loader.ts` when a mesh's bytes hash correctly (see
 * `ToothMeshChecksumError`) but the mesh itself is not watertight once
 * parsed+welded — a defense-in-depth gate: the checksum only proves the
 * bytes are exactly what a producer submitted, not that those bytes
 * describe a valid closed solid (CLAUDE.md invariant 4, "QC gates block
 * export/import, never silently bypassed"). */
export class ToothMeshNotWatertightError extends Error {
  constructor(fdi: number) {
    super(
      `ToothMeshNotWatertightError: mesh bytes for FDI ${fdi} hash-verified correctly but are not ` +
        'watertight once parsed — the asset is corrupt or was never a valid closed solid.',
    );
    this.name = 'ToothMeshNotWatertightError';
  }
}

/** Thrown by `loader.ts` when mesh BYTES don't hash to the metadata's
 * `meshChecksum` — declared here (not loader.ts) alongside its metadata-
 * checksum sibling so both of this format's "loud error on tamper" failure
 * modes live next to the field they guard. */
export class ToothMeshChecksumError extends Error {
  constructor(fdi: number, recorded: string, recomputed: string) {
    super(
      `ToothMeshChecksumError: mesh bytes for FDI ${fdi} do not match metadata.meshChecksum ` +
        `(recorded ${recorded}, recomputed ${recomputed}) — the mesh file was corrupted, truncated, ` +
        'or swapped for a different tooth.',
    );
    this.name = 'ToothMeshChecksumError';
  }
}

function fail(message: string): never {
  throw new ToothAssetMetadataValidationError(message);
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${fieldPath} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${fieldPath} must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${fieldPath} must be an array, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${fieldPath} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireVec3(value: unknown, fieldPath: string): Vec3 {
  const arr = requireArray(value, fieldPath);
  if (arr.length !== 3) {
    fail(`${fieldPath} must have exactly 3 components, got ${arr.length}`);
  }
  return [
    requireFiniteNumber(arr[0], `${fieldPath}[0]`),
    requireFiniteNumber(arr[1], `${fieldPath}[1]`),
    requireFiniteNumber(arr[2], `${fieldPath}[2]`),
  ];
}

function requireHex64(value: unknown, fieldPath: string): string {
  const s = requireString(value, fieldPath);
  if (!/^[0-9a-f]{64}$/.test(s)) {
    fail(`${fieldPath} must be a lowercase 64-hex-char SHA-256 digest, got ${JSON.stringify(s)}`);
  }
  return s;
}

/** The 32 valid FDI tooth numbers — same cross-product construction as
 * apps/server/src/schemas.ts's `FDI_TOOTH_NUMBERS`, duplicated here rather
 * than imported (this package has no dependency on apps/server, nor should
 * it — see this module's header doc: it must stay importable by a plain
 * Node script with zero server/DB dependencies). */
const VALID_FDI_TEETH: ReadonlySet<number> = new Set(
  [1, 2, 3, 4].flatMap((quadrant) => [1, 2, 3, 4, 5, 6, 7, 8].map((position) => quadrant * 10 + position)),
);

function requireFdiTooth(value: unknown, fieldPath: string): FdiTooth {
  if (typeof value !== 'number' || !VALID_FDI_TEETH.has(value)) {
    fail(`${fieldPath} must be a valid FDI tooth number (11-18/21-28/31-38/41-48), got ${JSON.stringify(value)}`);
  }
  return value as FdiTooth;
}

const VALID_TOOTH_TYPES: ReadonlySet<string> = new Set(['incisor', 'molar']);

function requireToothType(value: unknown, fieldPath: string): ToothType {
  const s = requireString(value, fieldPath);
  if (!VALID_TOOTH_TYPES.has(s)) {
    fail(`${fieldPath} must be one of ${[...VALID_TOOTH_TYPES].join('/')}, got ${JSON.stringify(s)}`);
  }
  return s as ToothType;
}

/** Every asset this task's generators ship carries a provenance string
 * starting with this literal — `validateToothAssetMetadataShape` does NOT
 * enforce the prefix (a real third-party asset legitimately won't have it),
 * but `assets.ts`'s own test suite asserts every STARTER asset does. */
export const PLACEHOLDER_PROVENANCE_PREFIX = 'PLACEHOLDER-ANATOMY:';

/** Two unit vectors within this many radians of perpendicular still count
 * as "orthogonal" — generous enough to tolerate ordinary Float64 rounding
 * in a hand-authored (non-generated) third-party frame, tight enough to
 * catch a genuinely skewed/mislabeled axis triple. ~0.057 degrees. */
const FRAME_ORTHOGONALITY_TOLERANCE_RAD = 1e-3;
/** A unit vector's length must be within this of 1.0. */
const FRAME_UNIT_LENGTH_TOLERANCE = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Validates that `frame`'s three axes are each unit length and mutually
 * orthogonal to `FRAME_ORTHOGONALITY_TOLERANCE_RAD`/
 * `FRAME_UNIT_LENGTH_TOLERANCE` — see `CanonicalFrame`'s doc for why this
 * matters downstream. Exported (not just used internally) so generator
 * tests can assert orthonormality directly against the exact same check
 * `loadToothAssetMetadata` applies, rather than re-deriving their own
 * tolerance. */
export function assertOrthonormalFrame(frame: CanonicalFrame, fieldPath = 'canonicalFrame'): void {
  const axes: Array<[string, Vec3]> = [
    ['mesialDistal', frame.mesialDistal],
    ['buccoLingual', frame.buccoLingual],
    ['occlusoGingival', frame.occlusoGingival],
  ];
  for (const [name, axis] of axes) {
    const len = length(axis);
    if (Math.abs(len - 1) > FRAME_UNIT_LENGTH_TOLERANCE) {
      fail(`${fieldPath}.${name} must be unit length, got length ${len}`);
    }
  }
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      const [nameA, a] = axes[i]!;
      const [nameB, b] = axes[j]!;
      // acos(dot) is the angle between two unit vectors; orthogonal == PI/2.
      const angle = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
      if (Math.abs(angle - Math.PI / 2) > FRAME_ORTHOGONALITY_TOLERANCE_RAD) {
        fail(
          `${fieldPath}.${nameA} and ${fieldPath}.${nameB} must be orthogonal, got angle ` +
            `${((angle * 180) / Math.PI).toFixed(4)} degrees`,
        );
      }
    }
  }
}

function requireCanonicalFrame(value: unknown, fieldPath: string): CanonicalFrame {
  const root = requireObject(value, fieldPath);
  const frame: CanonicalFrame = {
    origin: requireVec3(root['origin'], `${fieldPath}.origin`),
    mesialDistal: requireVec3(root['mesialDistal'], `${fieldPath}.mesialDistal`),
    buccoLingual: requireVec3(root['buccoLingual'], `${fieldPath}.buccoLingual`),
    occlusoGingival: requireVec3(root['occlusoGingival'], `${fieldPath}.occlusoGingival`),
  };
  assertOrthonormalFrame(frame, fieldPath);
  return frame;
}

function requireLandmarks(value: unknown, fieldPath: string): ToothLandmarks {
  const root = requireObject(value, fieldPath);
  const landmarks: Record<string, Vec3> = {};
  for (const key of Object.keys(root)) {
    landmarks[key] = requireVec3(root[key], `${fieldPath}.${key}`);
  }
  if (Object.keys(landmarks).length === 0) {
    fail(`${fieldPath} must declare at least one landmark`);
  }
  return landmarks;
}

function requireMorphTargets(value: unknown, fieldPath: string, expectedVertexCount: number | null): MorphTarget[] {
  const arr = requireArray(value, fieldPath);
  return arr.map((entry, i) => {
    const root = requireObject(entry, `${fieldPath}[${i}]`);
    const name = requireString(root['name'], `${fieldPath}[${i}].name`);
    const deltasRaw = requireArray(root['vertexDeltas'], `${fieldPath}[${i}].vertexDeltas`);
    const vertexDeltas = deltasRaw.map((d, j) =>
      requireFiniteNumber(d, `${fieldPath}[${i}].vertexDeltas[${j}]`),
    );
    if (vertexDeltas.length % 3 !== 0) {
      fail(`${fieldPath}[${i}].vertexDeltas length must be a multiple of 3, got ${vertexDeltas.length}`);
    }
    if (expectedVertexCount !== null && vertexDeltas.length !== expectedVertexCount * 3) {
      fail(
        `${fieldPath}[${i}].vertexDeltas length (${vertexDeltas.length}) must equal ` +
          `mesh vertex count * 3 (${expectedVertexCount * 3})`,
      );
    }
    return { name, vertexDeltas };
  });
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'fdi',
  'version',
  'toothType',
  'provenance',
  'landmarks',
  'canonicalFrame',
  'morphTargets',
  'meshChecksum',
  'metadataChecksum',
]);

/**
 * Structurally validates `raw` against `ToothAssetMetadata`'s shape
 * (mirrors `materialProfile.ts`'s `validateMaterialProfileShape` split:
 * shape-only here, checksum verification layered on top by
 * `loadToothAssetMetadata`). If `expectedVertexCount` is given (the loader
 * passes the ALREADY-parsed mesh's vertex count once it has the mesh
 * bytes), every morph target's `vertexDeltas` length is cross-checked
 * against it; pass `null` to validate metadata shape alone, independent of
 * any mesh (used by the pure schema-validation tests).
 */
export function validateToothAssetMetadataShape(
  raw: unknown,
  expectedVertexCount: number | null = null,
): ToothAssetMetadata {
  const root = requireObject(raw, 'asset');

  const fdi = requireFdiTooth(root['fdi'], 'asset.fdi');
  const version = requireString(root['version'], 'asset.version');
  const toothType = requireToothType(root['toothType'], 'asset.toothType');
  const provenance = requireString(root['provenance'], 'asset.provenance');
  const landmarks = requireLandmarks(root['landmarks'], 'asset.landmarks');
  const canonicalFrame = requireCanonicalFrame(root['canonicalFrame'], 'asset.canonicalFrame');
  const morphTargets = requireMorphTargets(root['morphTargets'], 'asset.morphTargets', expectedVertexCount);
  const meshChecksum = requireHex64(root['meshChecksum'], 'asset.meshChecksum');
  const metadataChecksum = requireHex64(root['metadataChecksum'], 'asset.metadataChecksum');

  for (const key of Object.keys(root)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      fail(`asset has an unrecognized field ${JSON.stringify(key)}`);
    }
  }

  return {
    fdi,
    version,
    toothType,
    provenance,
    landmarks,
    canonicalFrame,
    morphTargets,
    meshChecksum,
    metadataChecksum,
  };
}

/** Recomputes the `metadataChecksum` a validated asset's metadata SHOULD
 * have — every field except `metadataChecksum` itself, canonically
 * serialized (identical scheme to `computeProfileChecksum`). */
export function computeToothAssetMetadataChecksum(metadata: Omit<ToothAssetMetadata, 'metadataChecksum'>): string {
  return sha256HexOfString(canonicalStringify(metadata));
}

/** SHA-256 hex of raw mesh bytes — the value `meshChecksum` must equal.
 * Exported so generators/loader/server storage all derive it identically
 * (never re-implemented ad hoc at a call site). */
export function computeMeshChecksum(meshBytes: Uint8Array): string {
  return Array.from(sha256Bytes(meshBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validates `raw`'s shape AND its `metadataChecksum` — the full "loud,
 * typed error on any corruption" contract. Does NOT touch mesh bytes or
 * `meshChecksum` verification (that is `loader.ts`'s job, once it has
 * actually read the mesh bytes to hash) — see `ToothMeshChecksumError`'s
 * doc for why that stays a separate step/error type.
 *
 * @throws {ToothAssetMetadataValidationError} on any shape failure.
 * @throws {ToothAssetMetadataChecksumError} on a metadataChecksum mismatch.
 */
export function loadToothAssetMetadata(raw: unknown, expectedVertexCount: number | null = null): ToothAssetMetadata {
  const metadata = validateToothAssetMetadataShape(raw, expectedVertexCount);
  const { metadataChecksum, ...rest } = metadata;
  const expected = computeToothAssetMetadataChecksum(rest);
  if (metadataChecksum !== expected) {
    throw new ToothAssetMetadataChecksumError(metadata.fdi, metadataChecksum, expected);
  }
  return Object.freeze({
    ...metadata,
    landmarks: Object.freeze({ ...metadata.landmarks }),
    canonicalFrame: Object.freeze({ ...metadata.canonicalFrame }),
    morphTargets: Object.freeze(metadata.morphTargets.map((m) => Object.freeze({ ...m }))),
  });
}
