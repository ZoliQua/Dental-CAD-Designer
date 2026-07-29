// apps/server/src/case-archive.ts
//
// Phase 7 Task 6 (Part B) — the DQ Case Archive (DQCA) container: a single-file,
// DETERMINISTIC, self-verifying bundle of a case's entire state for support and
// inter-lab transfer. See docs/adr/016-case-archive-container.md for why a
// documented concatenation container over ZIP (byte-determinism without fighting
// ZIP's timestamp/mode-bit fields; zero new dependencies; full control of the
// integrity manifest).
//
// ## Byte layout (normative; deterministic)
//
//   bytes 0..3    magic ASCII 'DQCA'
//   bytes 4..7    uint32 LE format version (1)
//   bytes 8..11   uint32 LE manifestLength
//   bytes 12..    manifest: canonical JSON (sorted keys, no whitespace) UTF-8
//   then          each entry's payload bytes, concatenated in manifest order
//
// The manifest carries, per entry: `name`, `kind`, `offset` (into the payload
// section), `length`, and `sha256`; plus a whole-archive `archiveSha256` (the
// sha256 of the concatenated payload section) and a versioned `formatVersion`.
// Entries are emitted in a fixed deterministic order (by `name`, ascending), so
// the same case always yields BIT-IDENTICAL archive bytes (the export-
// determinism global constraint, extended to archives — no timestamps anywhere
// in the archive; the Case row's audit timestamps stay in the DB, never here).
//
// ## Integrity
//
// `parseCaseArchive` recomputes every entry's sha256 from its slice of the
// payload section and the whole-archive sha256, and REJECTS (typed
// `CaseArchiveError`, naming the failing entry) on any mismatch — a corrupted
// entry is caught, never reconstructed. The manifest itself is covered because
// each entry's declared `offset`/`length`/`sha256` must agree with the actual
// bytes, and `archiveSha256` pins the whole payload section.
import { createHash } from 'node:crypto';
import { canonicalStringify } from '@dqcad/clinical-profiles';

export const CASE_ARCHIVE_MAGIC = 0x41434451; // 'D','Q','C','A' read LE
export const CASE_ARCHIVE_FORMAT_VERSION = 1;
const HEADER_BYTES = 12;

/** Entry kinds an archive carries — a closed set (the manifest records which). */
export type CaseArchiveEntryKind =
  | 'case-document' // the full CaseDocument JSON (journal + settings + QC + restorations + measurements)
  | 'scan-mesh' // a content-addressed scan mesh (binary STL bytes), name `scan-mesh/<fileHash>`
  | 'final-mesh' // a restoration final-mesh container, name `final-mesh/<contentHash>`
  | 'export-row' // an Export ledger row (JSON), name `export-row/<exportId>`
  | 'export-bytes'; // released export bytes, name `export-bytes/<bytesSha256>`

export interface CaseArchiveManifestEntry {
  name: string;
  kind: CaseArchiveEntryKind;
  offset: number;
  length: number;
  sha256: string;
}

export interface CaseArchiveManifest {
  formatVersion: typeof CASE_ARCHIVE_FORMAT_VERSION;
  kernelVersion: string;
  case: { id: string; name: string; schemaVersion: number };
  entries: readonly CaseArchiveManifestEntry[];
  /** sha256 of the concatenated payload section (the whole-archive hash). */
  archiveSha256: string;
}

/** An entry to bundle: a name + kind + its raw payload bytes. */
export interface CaseArchiveInputEntry {
  name: string;
  kind: CaseArchiveEntryKind;
  bytes: Uint8Array;
}

export class CaseArchiveError extends Error {
  readonly entryName: string | null;
  constructor(message: string, entryName: string | null = null) {
    super(`case archive: ${message}`);
    this.name = 'CaseArchiveError';
    this.entryName = entryName;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Builds a deterministic DQCA archive. Entries are sorted by `name` (ascending)
 * before layout, so the same logical case always produces bit-identical bytes.
 * Duplicate entry names are a programming error (typed rejection).
 */
export function buildCaseArchive(
  caseInfo: { id: string; name: string; schemaVersion: number; kernelVersion: string },
  entries: readonly CaseArchiveInputEntry[],
): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.name === sorted[i - 1]!.name) {
      throw new CaseArchiveError(`duplicate entry name ${JSON.stringify(sorted[i]!.name)}`, sorted[i]!.name);
    }
  }

  let offset = 0;
  const manifestEntries: CaseArchiveManifestEntry[] = [];
  const payloads: Uint8Array[] = [];
  for (const entry of sorted) {
    manifestEntries.push({
      name: entry.name,
      kind: entry.kind,
      offset,
      length: entry.bytes.byteLength,
      sha256: sha256Hex(entry.bytes),
    });
    payloads.push(entry.bytes);
    offset += entry.bytes.byteLength;
  }
  const payloadSection = concat(payloads, offset);
  const archiveSha256 = sha256Hex(payloadSection);

  const manifest: CaseArchiveManifest = {
    formatVersion: CASE_ARCHIVE_FORMAT_VERSION,
    kernelVersion: caseInfo.kernelVersion,
    case: { id: caseInfo.id, name: caseInfo.name, schemaVersion: caseInfo.schemaVersion },
    entries: manifestEntries,
    archiveSha256,
  };
  const manifestBytes = new TextEncoder().encode(canonicalStringify(manifest));

  const out = new Uint8Array(HEADER_BYTES + manifestBytes.byteLength + payloadSection.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, CASE_ARCHIVE_MAGIC, true);
  view.setUint32(4, CASE_ARCHIVE_FORMAT_VERSION, true);
  view.setUint32(8, manifestBytes.byteLength, true);
  out.set(manifestBytes, HEADER_BYTES);
  out.set(payloadSection, HEADER_BYTES + manifestBytes.byteLength);
  return out;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface ParsedCaseArchive {
  manifest: CaseArchiveManifest;
  /** Entry name → its verified payload bytes. */
  entries: Map<string, { kind: CaseArchiveEntryKind; bytes: Uint8Array }>;
}

/**
 * Parses + FULLY VERIFIES a DQCA archive: header/magic/version, manifest JSON,
 * each entry's sha256 against its payload slice, and the whole-archive
 * `archiveSha256`. Any mismatch → `CaseArchiveError` naming the failing entry
 * (a corrupted entry is caught, never reconstructed — the acceptance criterion's
 * "corrupted-entry import → rejected naming the failing entry").
 */
export function parseCaseArchive(bytes: Uint8Array): ParsedCaseArchive {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new CaseArchiveError(`truncated: ${bytes.byteLength} bytes < ${HEADER_BYTES}-byte header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== CASE_ARCHIVE_MAGIC) {
    throw new CaseArchiveError('bad magic (expected DQCA)');
  }
  const version = view.getUint32(4, true);
  if (version !== CASE_ARCHIVE_FORMAT_VERSION) {
    throw new CaseArchiveError(`unsupported format version ${version} (this build reads ${CASE_ARCHIVE_FORMAT_VERSION})`);
  }
  const manifestLength = view.getUint32(8, true);
  const manifestStart = HEADER_BYTES;
  const payloadStart = manifestStart + manifestLength;
  if (payloadStart > bytes.byteLength) {
    throw new CaseArchiveError(`manifest length ${manifestLength} overruns the archive`);
  }
  let manifest: CaseArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(manifestStart, payloadStart))) as CaseArchiveManifest;
  } catch {
    throw new CaseArchiveError('manifest is not parseable JSON — tampered/corrupted');
  }
  if (manifest.formatVersion !== CASE_ARCHIVE_FORMAT_VERSION || !Array.isArray(manifest.entries)) {
    throw new CaseArchiveError('manifest is structurally invalid');
  }

  const payloadSection = bytes.subarray(payloadStart);
  if (sha256Hex(payloadSection) !== manifest.archiveSha256) {
    throw new CaseArchiveError('whole-archive hash mismatch — the payload section is corrupted/tampered');
  }

  const entries = new Map<string, { kind: CaseArchiveEntryKind; bytes: Uint8Array }>();
  for (const entry of manifest.entries) {
    const end = entry.offset + entry.length;
    if (entry.offset < 0 || end > payloadSection.byteLength) {
      throw new CaseArchiveError(`entry ${JSON.stringify(entry.name)} range is out of bounds`, entry.name);
    }
    // Copy out so callers own stable buffers independent of the source.
    const slice = payloadSection.slice(entry.offset, end);
    if (sha256Hex(slice) !== entry.sha256) {
      throw new CaseArchiveError(`entry ${JSON.stringify(entry.name)} failed its integrity hash`, entry.name);
    }
    if (entries.has(entry.name)) {
      throw new CaseArchiveError(`duplicate entry name ${JSON.stringify(entry.name)}`, entry.name);
    }
    entries.set(entry.name, { kind: entry.kind, bytes: slice });
  }
  return { manifest, entries };
}
