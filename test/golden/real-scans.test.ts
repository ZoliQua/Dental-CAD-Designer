// test/golden/real-scans.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`).
// Verifies the anonymized real-scan fixtures produced by
// scripts/import-scan-case.ts (docs/plans/phase-0-foundation.md Task 8):
//
//  1. Manifest agreement: each mesh file's sha256/byteSize and
//     triangleCount (STL) / vertexCount+faceCount (PLY) match
//     manifest.json, checked with an INDEPENDENT reader — stl-reader.ts's
//     `parseBinaryStl` (not the importer's own writer) and a small local
//     PLY header parser below (not the importer's own `anonymizePly`) — so
//     this is a real check on the checked-in bytes, not a tautology.
//  2. PLY headers carry no `comment TextureFile ...` line (that line would
//     otherwise embed the original, patient-identifying source filename).
//  3. PHI hard assertion, as a WHITELIST rather than a deny-list — every
//     committed file under test-fixtures/real-scans/ is checked against an
//     exhaustive grammar of what bytes are *allowed* to appear in the one
//     region of each file format that can ever carry text (see
//     `textRegionEnd` below), rather than a list of specific forbidden
//     strings. This is strictly stronger: unknown/unanticipated text cannot
//     pass, whereas a deny-list only catches tokens someone remembered to
//     list. It also means this file itself never needs to hardcode any
//     patient-derived token (name fragments, mangled filename encodings,
//     practice contact info, source GUIDs, acquisition dates) to do its
//     job — nothing here is reconstructable patient data.
//     - Binary STL: the whole 80-byte header must be byte-identical to the
//       importer's fixed anonymization string, zero-padded (see
//       `EXPECTED_STL_HEADER` below) — that's the only text region binary
//       STL has.
//     - Binary PLY: every header line up to and including `end_header` must
//       match one of a small set of known-safe line shapes (magic/format/
//       comment/element/property/end_header) — see `PLY_HEADER_LINE_RULES`.
//     - manifest.json / README.md: schema-shape assertions (expected keys
//       only) plus generic pattern checks — no date-like, GUID-like, or
//       email-like substring anywhere in the bytes.
//  4. Optional extra layer, LOCAL-ONLY: if the git-ignored file
//     `scans/phi-tokens.json` exists (an array of strings — never
//     committed), this file also re-runs a classic token deny-list scan
//     against every committed real-scan byte using tokens loaded from that
//     file. It's conditionally skipped (not failed) when the file is
//     absent, which is always true in CI and in a fresh clone.
//
// This file does not re-run the importer against `scans/` (unlike
// golden.test.ts's synthetic-fixture determinism check) because that
// source is git-ignored and generally absent outside the one machine that
// produced these fixtures. Idempotency (re-running the importer produces
// byte-identical output) was verified manually via two runs + a byte-level
// diff when the fixtures were produced — see
// test-fixtures/real-scans/README.md.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { CaseManifest } from '../../scripts/import-scan-case.ts';
import { assertNotLfsPointer, parseBinaryStl } from './stl-reader.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const realScansDir = join(repoRoot, 'test-fixtures', 'real-scans');

const CASE_IDS = ['arch-case-01', 'arch-case-02'] as const;
const ROLES = ['upperjaw', 'lowerjaw', 'bite0', 'bite1'] as const;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function readChecked(path: string): Buffer {
  const buffer = readFileSync(path);
  if (path.endsWith('.stl') || path.endsWith('.ply')) {
    assertNotLfsPointer(buffer, path);
  }
  return buffer;
}

function readManifest(caseId: string): CaseManifest {
  return JSON.parse(readFileSync(join(realScansDir, caseId, 'manifest.json'), 'utf8')) as CaseManifest;
}

interface ParsedPlyHeader {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly commentLines: readonly string[];
  readonly lines: readonly string[];
}

/** Minimal, independent PLY header reader — deliberately separate from
 * scripts/import-scan-case.ts's own `anonymizePly` parsing, same rationale
 * as stl-reader.ts vs. generate-fixtures.ts's writer. */
function parsePlyHeader(buffer: Buffer, label: string): ParsedPlyHeader {
  const marker = Buffer.from('end_header\n', 'ascii');
  const markerIndex = buffer.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`${label}: no "end_header" marker found`);
  }
  const headerText = buffer.subarray(0, markerIndex + marker.length).toString('ascii');
  const lines = headerText.split('\n').filter((line) => line.length > 0);
  const commentLines = lines.filter((line) => line.startsWith('comment'));

  const vertexMatch = lines.map((line) => /^element vertex (\d+)$/.exec(line)).find((m) => m !== null);
  const faceMatch = lines.map((line) => /^element face (\d+)$/.exec(line)).find((m) => m !== null);
  if (vertexMatch === undefined || faceMatch === undefined) {
    throw new Error(`${label}: missing "element vertex"/"element face" header lines`);
  }
  const vertexRaw = vertexMatch[1];
  const faceRaw = faceMatch[1];
  if (vertexRaw === undefined || faceRaw === undefined) {
    throw new Error(`${label}: unreachable — regex capture group missing`);
  }

  return { vertexCount: Number(vertexRaw), faceCount: Number(faceRaw), commentLines, lines };
}

// ---------------------------------------------------------------------------
// (a) Binary STL: the 80-byte header must be byte-identical to the
// importer's fixed anonymization string (scripts/import-scan-case.ts's
// `anonymizeStl`), zero-padded. This is the ONLY region of a binary STL that
// can ever contain text — everything from byte 80 onward is the triangle
// count (uint32) and raw IEEE-754 triangle data, copied verbatim from the
// source and never containing text of any kind.
// ---------------------------------------------------------------------------
const STL_HEADER_TEXT = 'DQCAD anonymized fixture';
const EXPECTED_STL_HEADER = (() => {
  const header = Buffer.alloc(80);
  header.write(STL_HEADER_TEXT, 0, 'ascii');
  return header;
})();

// ---------------------------------------------------------------------------
// (b) Binary PLY: exhaustive whitelist grammar for header lines. Every line
// up to and including `end_header` must match exactly one of these shapes;
// anything else — in particular any stray text a source `comment
// TextureFile <original filename>` line could have left behind — fails the
// test. Types/names below are exactly what scripts/import-scan-case.ts's
// anonymization is known to produce/pass through (see the header dumps this
// grammar was built from); nothing is copied from patient-derived headers.
// ---------------------------------------------------------------------------
const PLY_SCALAR_TYPE = '(?:int8|uint8|char|uchar|int16|uint16|short|ushort|int32|uint32|int|uint|float32|float|float64|double)';
const PLY_VERTEX_PROPERTY_NAME = '(?:x|y|z|nx|ny|nz)';
const PLY_LIST_PROPERTY_NAME = '(?:vertex_indices|texcoord)';

const PLY_HEADER_LINE_RULES: readonly RegExp[] = [
  /^ply$/,
  /^format binary_little_endian 1\.0$/,
  /^comment anonymized$/,
  /^element vertex \d+$/,
  /^element face \d+$/,
  new RegExp(`^property ${PLY_SCALAR_TYPE} ${PLY_VERTEX_PROPERTY_NAME}$`),
  new RegExp(`^property list ${PLY_SCALAR_TYPE} ${PLY_SCALAR_TYPE} ${PLY_LIST_PROPERTY_NAME}$`),
  /^end_header$/,
];

function assertPlyHeaderMatchesWhitelist(lines: readonly string[], label: string): void {
  lines.forEach((line, index) => {
    const matches = PLY_HEADER_LINE_RULES.some((rule) => rule.test(line));
    if (!matches) {
      // Deliberately redacted (CI-log safety): this assertion runs in CI, so
      // if it ever fires on a real PHI leak, echoing the raw offending line
      // would put the PHI itself into CI logs. Report only its position and
      // length, never its content.
      throw new Error(
        `${label}: PLY header line ${index} (${Buffer.byteLength(line, 'ascii')} bytes) does not match the ` +
          `whitelist grammar (magic/format/comment/element/property/end_header) — refusing to accept ` +
          `unrecognized header text`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// (c) manifest.json / README.md: schema-shape + generic pattern checks.
// These are pure text files, so their whole buffer is the "text region".
// Rather than looking for specific forbidden strings, assert (1) the JSON
// has exactly the expected keys (nothing extra could have snuck in) and (2)
// no date-like, GUID-like, or email-like substring appears anywhere —
// generic structural patterns, not any actual token value.
// ---------------------------------------------------------------------------
const DATE_LIKE_PATTERN = /\d{4}-\d{2}-\d{2}/;
const GUID_LIKE_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_LIKE_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function assertNoLeakyPatterns(text: string, label: string): void {
  expect(DATE_LIKE_PATTERN.test(text), `${label}: contains a date-like (YYYY-MM-DD) substring`).toBe(false);
  expect(GUID_LIKE_PATTERN.test(text), `${label}: contains a GUID-like substring`).toBe(false);
  expect(EMAIL_LIKE_PATTERN.test(text), `${label}: contains an email-like substring`).toBe(false);
}

const EXPECTED_MANIFEST_KEYS = [
  'caseId',
  'alignmentMatrixConvention',
  'alignmentMatrix',
  'antagonistType',
  'toothColor',
  'meshes',
].sort();
const EXPECTED_ROLE_MANIFEST_KEYS = ['stl', 'ply'].sort();
const EXPECTED_STL_MESH_KEYS = ['sha256', 'byteSize', 'triangleCount', 'bbox'].sort();
const EXPECTED_PLY_MESH_KEYS = ['sha256', 'byteSize', 'vertexCount', 'faceCount'].sort();
const EXPECTED_BBOX_KEYS = ['min', 'max'].sort();

// ---------------------------------------------------------------------------
// (d) Optional extra layer: a classic token deny-list re-scan, but ONLY run
// locally when the git-ignored `scans/phi-tokens.json` file exists (an
// array of strings, never committed — see the batch's operator notes for
// how to populate it). Conditionally skipped everywhere else (CI, fresh
// clones) so this file never needs to hardcode any patient-derived value.
// ---------------------------------------------------------------------------
const phiTokensPath = join(repoRoot, 'scans', 'phi-tokens.json');
const hasPhiTokensFile = existsSync(phiTokensPath);
const phiTokens: readonly string[] = hasPhiTokensFile
  ? (JSON.parse(readFileSync(phiTokensPath, 'utf8')) as readonly string[])
  : [];

/**
 * Byte offset marking the end of a file's "text region" — the only region
 * that can ever contain leaked text, given how scripts/import-scan-case.ts
 * anonymizes these files: binary STL's 80-byte header, or binary PLY's
 * ASCII header (everything up to and including `end_header\n`). Everything
 * after that offset is raw geometry (vertex/normal/index floats and ints),
 * copied byte-for-byte from the source and never containing text of any
 * kind. `manifest.json`/`README.md` are pure text, so their whole buffer
 * counts as the "text region".
 */
function textRegionEnd(buffer: Buffer, path: string): number {
  if (path.endsWith('.stl')) {
    return 80;
  }
  if (path.endsWith('.ply')) {
    const marker = Buffer.from('end_header\n', 'ascii');
    const markerIndex = buffer.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error(`${path}: no "end_header" marker found`);
    }
    return markerIndex + marker.length;
  }
  return buffer.length;
}

// A short (< 5 UTF-8 bytes) generic ASCII/near-ASCII token has a
// non-negligible chance of appearing purely by coincidence somewhere inside
// several megabytes of binary IEEE-754 triangle/vertex data (empirically
// confirmed while building the original version of this check: some
// realistically-cased 3-4 letter substrings turned up as pure float-mantissa
// noise in raw geometry bytes, while never appearing in any file's
// *header*). Since text can only ever leak into a header (see
// `textRegionEnd` above) — never into the geometry body, which is always
// copied verbatim from the source and was never text to begin with — short
// tokens are scanned ONLY against each file's text region, where an
// exhaustive, no-false-positive-risk check is possible. Longer/more
// distinctive tokens (>= 5 UTF-8 bytes) are scanned against the ENTIRE file,
// full defense in depth, since their false-positive probability over a few
// megabytes of binary data is astronomically small.
const FULL_BODY_MIN_TOKEN_UTF8_BYTES = 5;

/** Case-insensitive token scan — mirrors
 * scripts/import-scan-case.ts's `assertNoPhiTokens`, but re-implemented
 * independently here (not imported) so this test doesn't just re-check the
 * importer's own logic against itself. See `textRegionEnd` and the comment
 * above for why short tokens are scoped to each file's text region while
 * longer tokens are scanned against the whole file. Only reachable when
 * `scans/phi-tokens.json` exists locally — see the optional-layer comment
 * above. */
function assertBufferHasNoToken(buffer: Buffer, token: string, path: string): void {
  const scanTarget =
    Buffer.byteLength(token, 'utf8') >= FULL_BODY_MIN_TOKEN_UTF8_BYTES ? buffer : buffer.subarray(0, textRegionEnd(buffer, path));
  const variants = new Set<string>([
    token,
    token.toLowerCase(),
    token.toUpperCase(),
    token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
  ]);
  for (const variant of variants) {
    const needle = Buffer.from(variant, 'utf8');
    if (needle.length > 0 && scanTarget.includes(needle)) {
      throw new Error(`${path} contains a patient-identifying token (as "${variant}")`);
    }
  }
}

describe('real-scan fixtures: manifest agreement', () => {
  for (const caseId of CASE_IDS) {
    const caseDir = join(realScansDir, caseId);
    const manifest = readManifest(caseId);

    it(`${caseId}: manifest caseId and alignmentMatrix are well-formed`, () => {
      expect(manifest.caseId).toBe(caseId);
      expect(manifest.alignmentMatrix).toHaveLength(16);
      for (const value of manifest.alignmentMatrix) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(typeof manifest.antagonistType).toBe('string');
      expect(manifest.antagonistType.length).toBeGreaterThan(0);
      expect(typeof manifest.toothColor).toBe('string');
      expect(manifest.toothColor.length).toBeGreaterThan(0);
    });

    for (const role of ROLES) {
      it(`${caseId}/${role}.stl: sha256, byteSize, and triangleCount match manifest`, () => {
        const path = join(caseDir, `${caseId}-${role}.stl`);
        const buffer = readChecked(path);
        const entry = manifest.meshes[role].stl;

        expect(sha256(buffer)).toBe(entry.sha256);
        expect(buffer.length).toBe(entry.byteSize);

        const parsed = parseBinaryStl(buffer, path);
        expect(parsed.triangleCount).toBe(entry.triangleCount);
        expect(parsed.bbox.min[0]).toBeCloseTo(entry.bbox.min[0], 3);
        expect(parsed.bbox.min[1]).toBeCloseTo(entry.bbox.min[1], 3);
        expect(parsed.bbox.min[2]).toBeCloseTo(entry.bbox.min[2], 3);
        expect(parsed.bbox.max[0]).toBeCloseTo(entry.bbox.max[0], 3);
        expect(parsed.bbox.max[1]).toBeCloseTo(entry.bbox.max[1], 3);
        expect(parsed.bbox.max[2]).toBeCloseTo(entry.bbox.max[2], 3);
      });

      it(`${caseId}/${role}.ply: sha256, byteSize, vertexCount, and faceCount match manifest`, () => {
        const path = join(caseDir, `${caseId}-${role}.ply`);
        const buffer = readChecked(path);
        const entry = manifest.meshes[role].ply;

        expect(sha256(buffer)).toBe(entry.sha256);
        expect(buffer.length).toBe(entry.byteSize);

        const parsed = parsePlyHeader(buffer, path);
        expect(parsed.vertexCount).toBe(entry.vertexCount);
        expect(parsed.faceCount).toBe(entry.faceCount);
      });

      it(`${caseId}/${role}.ply: header has no "TextureFile" comment`, () => {
        // Jaw PLYs (upperjaw/lowerjaw) carry a "comment anonymized" line in
        // place of the source's "comment TextureFile <filename>" line; bite
        // PLYs (bite0/bite1, from TotalJaw0/TotalJaw1) have no texture and
        // so have no comment line at all in the source — both are fine, the
        // only hard requirement is that "TextureFile" never appears.
        const path = join(caseDir, `${caseId}-${role}.ply`);
        const buffer = readChecked(path);
        const parsed = parsePlyHeader(buffer, path);
        for (const line of parsed.commentLines) {
          expect(line.toLowerCase()).not.toContain('texturefile');
          expect(line).toBe('comment anonymized');
        }
      });
    }
  }
});

describe('real-scan fixtures: PHI scrub verification (whitelist, hard assertion)', () => {
  for (const caseId of CASE_IDS) {
    const caseDir = join(realScansDir, caseId);

    for (const role of ROLES) {
      it(`${caseId}/${role}.stl: 80-byte header is byte-exactly the anonymized-fixture header`, () => {
        const path = join(caseDir, `${caseId}-${role}.stl`);
        const buffer = readChecked(path);
        expect(buffer.length).toBeGreaterThanOrEqual(80);
        const header = buffer.subarray(0, 80);
        expect(header.equals(EXPECTED_STL_HEADER)).toBe(true);
      });

      it(`${caseId}/${role}.ply: every header line matches the exhaustive safe-header grammar`, () => {
        const path = join(caseDir, `${caseId}-${role}.ply`);
        const buffer = readChecked(path);
        const parsed = parsePlyHeader(buffer, path);
        assertPlyHeaderMatchesWhitelist(parsed.lines, path);
      });
    }

    it(`${caseId}: manifest.json has exactly the expected keys and no leaky patterns`, () => {
      const path = join(caseDir, 'manifest.json');
      const buffer = readChecked(path);
      const text = buffer.toString('utf8');
      const manifest = JSON.parse(text) as Record<string, unknown>;

      expect(Object.keys(manifest).sort()).toEqual(EXPECTED_MANIFEST_KEYS);
      const meshes = manifest['meshes'] as Record<string, Record<string, Record<string, unknown>>>;
      expect(Object.keys(meshes).sort()).toEqual([...ROLES].sort());
      for (const role of ROLES) {
        const roleManifest = meshes[role];
        expect(roleManifest).toBeDefined();
        expect(Object.keys(roleManifest as object).sort()).toEqual(EXPECTED_ROLE_MANIFEST_KEYS);
        const stlEntry = (roleManifest as Record<string, Record<string, unknown>>)['stl'];
        const plyEntry = (roleManifest as Record<string, Record<string, unknown>>)['ply'];
        expect(Object.keys(stlEntry as object).sort()).toEqual(EXPECTED_STL_MESH_KEYS);
        expect(Object.keys(plyEntry as object).sort()).toEqual(EXPECTED_PLY_MESH_KEYS);
        expect(Object.keys((stlEntry as Record<string, object>)['bbox'] as object).sort()).toEqual(EXPECTED_BBOX_KEYS);
      }

      assertNoLeakyPatterns(text, path);
    });
  }

  it('real-scans/README.md contains no date-like, GUID-like, or email-like substring', () => {
    const path = join(realScansDir, 'README.md');
    const buffer = readChecked(path);
    assertNoLeakyPatterns(buffer.toString('utf8'), path);
  });

  // Completeness check backing the file-top comment's claim that "every
  // committed file under test-fixtures/real-scans/ is checked": everything
  // else in this describe block whitelists the *content* of specific known
  // files, but never noticed if an unexpected extra file were added
  // alongside them. This test whitelists the *file set itself* — an exact
  // expected listing per directory — so any unanticipated extra committed
  // file (which would otherwise silently skip every content check above)
  // fails the suite.
  it('test-fixtures/real-scans/ contains exactly the expected files — no unexpected extras', () => {
    const expectedRootEntries = [...CASE_IDS, 'README.md'].sort();
    expect(readdirSync(realScansDir).sort()).toEqual(expectedRootEntries);

    for (const caseId of CASE_IDS) {
      const caseDir = join(realScansDir, caseId);
      const expectedFiles = ['manifest.json', ...ROLES.flatMap((role) => [`${caseId}-${role}.stl`, `${caseId}-${role}.ply`])].sort();
      expect(readdirSync(caseDir).sort()).toEqual(expectedFiles);
    }
  });
});

describe.skipIf(!hasPhiTokensFile)(
  'real-scan fixtures: local-only token re-scan (scans/phi-tokens.json, git-ignored, not present in CI)',
  () => {
    for (const caseId of CASE_IDS) {
      const caseDir = join(realScansDir, caseId);

      it(`${caseId}: no committed file contains a locally-configured token`, () => {
        const filenames = readdirSync(caseDir);
        expect(filenames.length).toBeGreaterThan(0);
        for (const name of filenames) {
          const path = join(caseDir, name);
          const buffer = readChecked(path);
          for (const token of phiTokens) {
            assertBufferHasNoToken(buffer, token, path);
          }
        }
      });
    }

    it('real-scans/README.md contains no locally-configured token', () => {
      const path = join(realScansDir, 'README.md');
      const buffer = readChecked(path);
      for (const token of phiTokens) {
        assertBufferHasNoToken(buffer, token, path);
      }
    });
  },
);
