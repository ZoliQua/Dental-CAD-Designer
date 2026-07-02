// scripts/import-scan-case.ts
//
// Imports one real patient-scan case (Shining 3D scanner -> exocad export
// folder) from the git-ignored `scans/` drop directory into an anonymized,
// committed fixture under `test-fixtures/real-scans/<case-id>/`. See Task 8
// in docs/plans/phase-0-foundation.md.
//
// PRIVACY IS THE POINT OF THIS SCRIPT. The source folder's name, its file
// names, PLY header `comment TextureFile <original filename>` lines, and the
// `.dentalProject` XML (PatientName, PracticeName incl. a personal email,
// DateTime, ProjectGUID) all carry patient-identifying data (PHI). NONE of
// that may reach the files this script writes. Concretely:
//
//   - Binary STL: the 80-byte header is overwritten with a fixed,
//     zero-padded string (`DQCAD anonymized fixture`); the little-endian
//     triangle count and all triangle data after it are copied verbatim
//     (never re-serialized, so we never risk re-encoding a stray patient
//     string that a re-serializer might otherwise copy through).
//   - Binary PLY (`binary_little_endian 1.0`): the ASCII header (everything
//     up to and including the `end_header\n` line) is rewritten line by
//     line, replacing any `comment TextureFile ...` line with a fixed
//     `comment anonymized` line; every other header line (format/element/
//     property) is kept verbatim since those describe layout, not the
//     patient. The binary body after `end_header\n` is copied verbatim.
//   - `manifest.json` is built from an explicit allow-list of two
//     `.dentalProject` fields (AntagonistType, ToothColor) plus the
//     `.matrix4` alignment matrix and per-mesh hashes/counts/bbox computed
//     by this script — PatientName/PracticeName/DateTime/ProjectGUID are
//     read transiently (only to build the PHI deny-list below) and are
//     never written anywhere.
//
// As a hard backstop, before writing anything to disk this script builds a
// deny-list of PHI tokens from the source folder name, every source file
// name, and the four PHI fields above, and asserts (case-insensitively, at
// the byte level) that none of those tokens appear anywhere in the bytes it
// is about to write. A match throws and aborts the import with nothing
// written — see `assertNoPhiTokens` below.
//
// Determinism (hard invariant, see docs/plans/phase-0-foundation.md's Global
// Constraints): no Math.random / unseeded randomness, no Date.now() or any
// other wall-clock value baked into output bytes. Re-running this script
// against the same source folder must produce byte-identical output.
//
// Usage: tsx scripts/import-scan-case.ts --src <folder> --id <case-id>

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CliArgs {
  readonly src: string;
  readonly id: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let src: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--src') {
      src = argv[i + 1];
      i++;
    } else if (arg === '--id') {
      id = argv[i + 1];
      i++;
    }
  }
  if (src === undefined || id === undefined) {
    throw new Error('usage: tsx scripts/import-scan-case.ts --src <folder> --id <case-id>');
  }
  return { src, id };
}

// ---------------------------------------------------------------------------
// Source folder anatomy
// ---------------------------------------------------------------------------

const ROLES = [
  { sourceSuffix: 'UpperJaw', role: 'upperjaw' },
  { sourceSuffix: 'LowerJaw', role: 'lowerjaw' },
  { sourceSuffix: 'TotalJaw0', role: 'bite0' },
  { sourceSuffix: 'TotalJaw1', role: 'bite1' },
] as const;

export type MeshRole = (typeof ROLES)[number]['role'];

function findRoleFile(entries: readonly string[], srcDir: string, sourceSuffix: string, ext: 'stl' | 'ply'): string {
  const suffix = `-${sourceSuffix}.${ext}`;
  const matches = entries.filter((name) => name.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one file ending with "${suffix}" in ${srcDir}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('unreachable: length-checked above');
  }
  return match;
}

function findDentalProjectFile(entries: readonly string[], srcDir: string): string {
  const matches = entries.filter((name) => name.endsWith('.dentalProject'));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one .dentalProject file in ${srcDir}, found ${matches.length}`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('unreachable: length-checked above');
  }
  return match;
}

function findMatrix4File(entries: readonly string[], srcDir: string): string {
  const matches = entries.filter((name) => name.endsWith('.matrix4'));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one .matrix4 file in ${srcDir}, found ${matches.length}`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('unreachable: length-checked above');
  }
  return match;
}

// ---------------------------------------------------------------------------
// Binary STL anonymization + manifest data
// ---------------------------------------------------------------------------

const STL_HEADER_TEXT = 'DQCAD anonymized fixture';

export interface StlBbox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface StlManifestData {
  readonly triangleCount: number;
  readonly bbox: StlBbox;
}

/** Rewrites the 80-byte STL header to a fixed, zero-padded string. Bytes 80+
 * (the little-endian triangle count and all triangle records) are copied
 * verbatim, never re-serialized — see the file-level comment for why that
 * matters for PHI safety. */
export function anonymizeStl(original: Buffer): Buffer {
  if (original.length < 84) {
    throw new Error(`STL buffer too small (${original.length} bytes) to be a valid binary STL`);
  }
  const header = Buffer.alloc(80); // zero-filled, then patched with ASCII text
  header.write(STL_HEADER_TEXT, 0, 'ascii');
  return Buffer.concat([header, original.subarray(80)]);
}

/** Reads the triangle count and computes a Float64 bounding box by parsing
 * every triangle's three vertices. Independent of (and not shared with) the
 * `generate-fixtures.ts` writer or `test/golden/stl-reader.ts`'s reader —
 * this is the import script's own accounting for what it wrote. */
export function readStlManifestData(buffer: Buffer, label: string): StlManifestData {
  const triangleCount = buffer.readUInt32LE(80);
  const expectedLength = 84 + triangleCount * 50;
  if (buffer.length !== expectedLength) {
    throw new Error(
      `${label}: binary STL layout mismatch — expected ${expectedLength} bytes for ` +
        `${triangleCount} triangles, got ${buffer.length}`,
    );
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < triangleCount; i++) {
    const triangleBase = 84 + i * 50 + 12; // skip the 12-byte stored normal
    for (let v = 0; v < 3; v++) {
      const vertexBase = triangleBase + v * 12;
      const x = buffer.readFloatLE(vertexBase);
      const y = buffer.readFloatLE(vertexBase + 4);
      const z = buffer.readFloatLE(vertexBase + 8);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  return { triangleCount, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

// ---------------------------------------------------------------------------
// Binary PLY anonymization + manifest data
// ---------------------------------------------------------------------------

const END_HEADER_MARKER = Buffer.from('end_header\n', 'ascii');
const TEXTURE_COMMENT_PATTERN = /^comment\s+TextureFile\b/i;
const ANONYMIZED_COMMENT_LINE = 'comment anonymized';

export interface PlyManifestData {
  readonly vertexCount: number;
  readonly faceCount: number;
}

export interface AnonymizedPly {
  readonly buffer: Buffer;
  readonly manifestData: PlyManifestData;
}

/** Rewrites `comment TextureFile ...` header lines (which carry the
 * original, patient-identifying source filename) to a fixed
 * `comment anonymized` line. Every other header line (format/element/
 * property, which describe layout, not the patient) is kept verbatim. The
 * binary body after `end_header\n` is copied byte-for-byte. */
export function anonymizePly(original: Buffer, label: string): AnonymizedPly {
  const headerMarkerIndex = original.indexOf(END_HEADER_MARKER);
  if (headerMarkerIndex === -1) {
    throw new Error(`${label}: no "end_header\\n" marker found — not a well-formed PLY header`);
  }
  const headerEnd = headerMarkerIndex + END_HEADER_MARKER.length;
  const headerText = original.subarray(0, headerEnd).toString('latin1');
  const body = original.subarray(headerEnd); // binary, copied verbatim below

  const lines = headerText.split('\n');
  const trailing = lines.pop(); // headerText ends with '\n', so split leaves a trailing ''
  if (trailing !== '') {
    throw new Error(`${label}: PLY header did not end with a newline as expected`);
  }
  if (lines[0] !== 'ply') {
    throw new Error(`${label}: PLY header does not start with the "ply" magic line`);
  }
  if (lines[1] !== 'format binary_little_endian 1.0') {
    throw new Error(`${label}: unsupported PLY format (expected "format binary_little_endian 1.0")`);
  }

  let vertexCount: number | undefined;
  let faceCount: number | undefined;
  const newLines = lines.map((line) => {
    const vertexMatch = /^element vertex (\d+)$/.exec(line);
    if (vertexMatch !== null) {
      vertexCount = Number(vertexMatch[1]);
    }
    const faceMatch = /^element face (\d+)$/.exec(line);
    if (faceMatch !== null) {
      faceCount = Number(faceMatch[1]);
    }
    return TEXTURE_COMMENT_PATTERN.test(line) ? ANONYMIZED_COMMENT_LINE : line;
  });

  if (vertexCount === undefined || faceCount === undefined) {
    throw new Error(`${label}: PLY header is missing "element vertex" and/or "element face"`);
  }

  const newHeaderText = `${newLines.join('\n')}\n`;
  const newHeaderBuffer = Buffer.from(newHeaderText, 'latin1');
  const buffer = Buffer.concat([newHeaderBuffer, body]);

  return { buffer, manifestData: { vertexCount, faceCount } };
}

// ---------------------------------------------------------------------------
// .matrix4 (occlusion alignment matrix — not PHI)
// ---------------------------------------------------------------------------

/**
 * Parses a `.matrix4` XML file (tags `<_RC>value</_RC>` for row R, column C,
 * R,C in 0..3) into a flat 16-element array.
 *
 * Storage order chosen after inspecting the file (see e.g.
 * `scans/.../*.matrix4`): translation values live in the LAST row
 * (`_30`, `_31`, `_32`), which is the row-vector convention
 * (`v' = v * M`, row vector times matrix, translation row). We store the
 * array in row-major order — `alignmentMatrix[r * 4 + c]` is the tag
 * `_<r><c>`'s value — so index 12/13/14 (row 3, columns 0/1/2) hold the
 * translation. This matches the tags' own textual order in the source file,
 * but the parser below looks each tag up explicitly rather than relying on
 * document order, so a reordered/reformatted source file would still parse
 * correctly.
 */
export function parseMatrix4(xml: string, label: string): readonly number[] {
  const matrix = new Array<number>(16).fill(NaN);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const tag = `_${r}${c}`;
      const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
      if (match === null) {
        throw new Error(`${label}: missing <${tag}> in .matrix4 XML`);
      }
      const raw = match[1];
      if (raw === undefined) {
        throw new Error(`${label}: unreachable — regex capture group missing for <${tag}>`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`${label}: <${tag}> value "${raw}" is not a finite number`);
      }
      matrix[r * 4 + c] = value;
    }
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// .dentalProject (XML — PHI-bearing; only two fields are ever kept)
// ---------------------------------------------------------------------------

function extractXmlTag(xml: string, tag: string, label: string): string {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  if (match === null) {
    throw new Error(`${label}: missing <${tag}> in .dentalProject XML`);
  }
  const value = match[1];
  if (value === undefined) {
    throw new Error(`${label}: unreachable — regex capture group missing for <${tag}>`);
  }
  return value;
}

export interface DentalProjectAllowlisted {
  readonly antagonistType: string;
  readonly toothColor: string;
}

/** Extracts ONLY the two non-PHI fields that end up in manifest.json.
 * PatientName/PracticeName/DateTime/ProjectGUID are read separately (by
 * `extractPhiFields`, below) purely to build the scrub deny-list — never
 * returned from here, never written anywhere. */
export function extractAllowlistedDentalProjectFields(xml: string, label: string): DentalProjectAllowlisted {
  return {
    antagonistType: extractXmlTag(xml, 'AntagonistType', label),
    toothColor: extractXmlTag(xml, 'ToothColor', label),
  };
}

interface PhiFields {
  readonly patientName: string;
  readonly practiceName: string;
  readonly dateTime: string;
  readonly projectGuid: string;
}

function extractPhiFields(xml: string, label: string): PhiFields {
  return {
    patientName: extractXmlTag(xml, 'PatientName', label),
    practiceName: extractXmlTag(xml, 'PracticeName', label),
    dateTime: extractXmlTag(xml, 'DateTime', label),
    projectGuid: extractXmlTag(xml, 'ProjectGUID', label),
  };
}

// ---------------------------------------------------------------------------
// PHI scrub-verification (hard backstop before any bytes are written)
// ---------------------------------------------------------------------------

const MIN_GENERIC_TOKEN_LENGTH = 5; // short alnum runs risk coincidental matches in binary geometry
const UNICODE_ALNUM_RUN = /[\p{L}\p{N}]+/gu;

// Structural tokens that are expected to appear verbatim in every case's own
// (anonymized) output — mesh-role names and this importer's own file-suffix
// vocabulary — and are therefore never patient-identifying. Excluded from
// the generic filename-derived deny list so they don't produce false-
// positive scrub failures against our own output.
const STRUCTURAL_TOKEN_STOPLIST = new Set([
  'upperjaw',
  'lowerjaw',
  'totaljaw',
  'totaljaw0',
  'totaljaw1',
  'dentalproject',
  'matrix4',
]);

function alnumRuns(text: string, minLength: number): string[] {
  return [...text.matchAll(UNICODE_ALNUM_RUN)]
    .map((m) => m[0])
    .filter((token) => token.length >= minLength && !STRUCTURAL_TOKEN_STOPLIST.has(token.toLowerCase()));
}

/**
 * Builds the deny-list of PHI tokens for one source case: the source folder
 * name, every file name inside it, and the four PHI `.dentalProject` fields
 * — split into individual alphanumeric runs (Unicode-aware, so an accented
 * name like "Ník" survives as one token rather than being split at the
 * accent) plus each field kept whole (catches multi-word
 * matches like an email address or a GUID). Also adds the leading
 * `YYYY-MM-DD` date from the folder name as its own token, since a bare
 * date string has no alnum-run boundary to split on that would make it
 * distinctive on its own otherwise.
 */
export function buildPhiDenyList(srcDir: string, entries: readonly string[], phi: PhiFields): readonly string[] {
  const tokens = new Set<string>();

  const folderName = basename(srcDir);
  const wholeStrings = [folderName, ...entries, phi.patientName, phi.practiceName, phi.dateTime, phi.projectGuid];

  for (const s of wholeStrings) {
    for (const token of alnumRuns(s, MIN_GENERIC_TOKEN_LENGTH)) {
      tokens.add(token.toLowerCase());
    }
  }

  // The GUID and email/practice string as a whole are useful extra
  // fingerprints (a partial alnum run alone might not be distinctive).
  tokens.add(phi.projectGuid.toLowerCase());
  tokens.add(phi.practiceName.toLowerCase());
  tokens.add(phi.patientName.toLowerCase());

  const dateMatch = /^\d{4}-\d{2}-\d{2}/.exec(folderName);
  if (dateMatch !== null) {
    tokens.add(dateMatch[0]);
  }

  return [...tokens];
}

/**
 * Case-insensitive, byte-level scan for any deny-list token in `buffer`.
 * Deliberately works at the Buffer level (not by decoding the whole file to
 * a JS string) so it's cheap even for multi-megabyte mesh bodies: for each
 * token we check a handful of case variants (as-is, lower, upper, and — for
 * the common "Capitalized word" shape — title case) as UTF-8 byte needles
 * via `Buffer.prototype.includes`.
 */
export function assertNoPhiTokens(buffer: Buffer, tokens: readonly string[], label: string): void {
  for (const token of tokens) {
    if (token.length === 0) continue;
    const variants = new Set<string>([
      token,
      token.toLowerCase(),
      token.toUpperCase(),
      token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    ]);
    for (const variant of variants) {
      const needle = Buffer.from(variant, 'utf8');
      if (needle.length > 0 && buffer.includes(needle)) {
        throw new Error(
          `PHI SCRUB FAILURE: ${label} contains the patient-identifying token "${token}" ` +
            `(matched variant "${variant}"). Aborting before writing anything.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface StlMeshManifest {
  readonly sha256: string;
  readonly byteSize: number;
  readonly triangleCount: number;
  readonly bbox: StlBbox;
}

export interface PlyMeshManifest {
  readonly sha256: string;
  readonly byteSize: number;
  readonly vertexCount: number;
  readonly faceCount: number;
}

export interface RoleManifest {
  readonly stl: StlMeshManifest;
  readonly ply: PlyMeshManifest;
}

export interface CaseManifest {
  readonly caseId: string;
  readonly alignmentMatrixConvention: string;
  readonly alignmentMatrix: readonly number[];
  readonly antagonistType: string;
  readonly toothColor: string;
  readonly meshes: {
    readonly upperjaw: RoleManifest;
    readonly lowerjaw: RoleManifest;
    readonly bite0: RoleManifest;
    readonly bite1: RoleManifest;
  };
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

const ALIGNMENT_MATRIX_CONVENTION =
  'Row-major, row-vector convention (v_row * M = v_row_transformed): ' +
  'alignmentMatrix[r * 4 + c] is source tag "_<r><c>" (r,c in 0..3); ' +
  'translation lives in row 3 (indices 12, 13, 14).';

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

interface AnonymizedMesh {
  readonly role: MeshRole;
  readonly stlBuffer: Buffer;
  readonly stlManifest: StlMeshManifest;
  readonly plyBuffer: Buffer;
  readonly plyManifest: PlyMeshManifest;
}

function importCase(src: string, caseId: string): { manifest: CaseManifest; files: ReadonlyMap<string, Buffer> } {
  const entries = readdirSync(src);

  const dentalProjectName = findDentalProjectFile(entries, src);
  const matrix4Name = findMatrix4File(entries, src);
  const dentalProjectXml = readFileSync(join(src, dentalProjectName), 'utf8');
  const matrix4Xml = readFileSync(join(src, matrix4Name), 'utf8');

  const allowlisted = extractAllowlistedDentalProjectFields(dentalProjectXml, dentalProjectName);
  const phi = extractPhiFields(dentalProjectXml, dentalProjectName);
  const alignmentMatrix = parseMatrix4(matrix4Xml, matrix4Name);

  const denyList = buildPhiDenyList(src, entries, phi);

  const anonymizedMeshes: AnonymizedMesh[] = [];
  for (const { sourceSuffix, role } of ROLES) {
    const stlName = findRoleFile(entries, src, sourceSuffix, 'stl');
    const plyName = findRoleFile(entries, src, sourceSuffix, 'ply');

    const stlOriginal = readFileSync(join(src, stlName));
    const plyOriginal = readFileSync(join(src, plyName));

    const stlAnonymized = anonymizeStl(stlOriginal);
    const stlData = readStlManifestData(stlAnonymized, stlName);
    const { buffer: plyAnonymized, manifestData: plyData } = anonymizePly(plyOriginal, plyName);

    anonymizedMeshes.push({
      role,
      stlBuffer: stlAnonymized,
      stlManifest: {
        sha256: sha256Hex(stlAnonymized),
        byteSize: stlAnonymized.length,
        triangleCount: stlData.triangleCount,
        bbox: stlData.bbox,
      },
      plyBuffer: plyAnonymized,
      plyManifest: {
        sha256: sha256Hex(plyAnonymized),
        byteSize: plyAnonymized.length,
        vertexCount: plyData.vertexCount,
        faceCount: plyData.faceCount,
      },
    });
  }

  const byRole = new Map(anonymizedMeshes.map((m) => [m.role, m]));
  const upperjaw = byRole.get('upperjaw');
  const lowerjaw = byRole.get('lowerjaw');
  const bite0 = byRole.get('bite0');
  const bite1 = byRole.get('bite1');
  if (upperjaw === undefined || lowerjaw === undefined || bite0 === undefined || bite1 === undefined) {
    throw new Error('unreachable: all four roles are always produced by the ROLES loop above');
  }

  const manifest: CaseManifest = {
    caseId,
    alignmentMatrixConvention: ALIGNMENT_MATRIX_CONVENTION,
    alignmentMatrix,
    antagonistType: allowlisted.antagonistType,
    toothColor: allowlisted.toothColor,
    meshes: {
      upperjaw: { stl: upperjaw.stlManifest, ply: upperjaw.plyManifest },
      lowerjaw: { stl: lowerjaw.stlManifest, ply: lowerjaw.plyManifest },
      bite0: { stl: bite0.stlManifest, ply: bite0.plyManifest },
      bite1: { stl: bite1.stlManifest, ply: bite1.plyManifest },
    },
  };

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestBuffer = Buffer.from(manifestJson, 'utf8');

  const files = new Map<string, Buffer>();
  for (const mesh of anonymizedMeshes) {
    files.set(`${caseId}-${mesh.role}.stl`, mesh.stlBuffer);
    files.set(`${caseId}-${mesh.role}.ply`, mesh.plyBuffer);
  }
  files.set('manifest.json', manifestBuffer);

  // Hard backstop: scan every byte this import is about to write, plus the
  // manifest JSON text itself, for any PHI deny-list token. Throws (and
  // writes nothing) on the first match.
  for (const [name, buffer] of files) {
    assertNoPhiTokens(buffer, denyList, `${caseId}/${name}`);
  }

  return { manifest, files };
}

function writeCase(outDir: string, files: ReadonlyMap<string, Buffer>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, buffer] of files) {
    writeFileSync(join(outDir, name), buffer);
  }
}

export function runImport(src: string, caseId: string, fixturesRoot: string): { manifest: CaseManifest } {
  const { manifest, files } = importCase(src, caseId);
  const outDir = join(fixturesRoot, caseId);
  writeCase(outDir, files);
  return { manifest };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectlyExecuted()) {
  const { src, id } = parseArgs(process.argv.slice(2));
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(scriptDir, '..');
  const fixturesRoot = join(repoRoot, 'test-fixtures', 'real-scans');
  const { manifest } = runImport(resolve(src), id, fixturesRoot);
  console.log(`imported ${id} from ${src} -> test-fixtures/real-scans/${id}/`);
  console.log(`  antagonistType=${manifest.antagonistType} toothColor=${manifest.toothColor}`);
}
