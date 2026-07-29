import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '@dqcad/clinical-profiles';
import {
  buildCaseArchive,
  CaseArchiveError,
  parseCaseArchive,
  type CaseArchiveInputEntry,
} from './case-archive.js';

const CASE_INFO = { id: 'case-1', name: 'Archive Case', schemaVersion: 2, kernelVersion: '0.26.0' };

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Re-emits an archive from a MUTATED manifest object + the (possibly already
 * corrupted) payload section — the adversarial "consistent tamper" constructor.
 * `recomputeSelfHashes` recomputes `archiveSha256` (over the current payload)
 * and `manifestSha256`, so a test can ISOLATE which downstream check fires:
 *  - false → the manifest self-hash is left STALE (tests F-B2: descriptive-field
 *    tampering with the payload + archiveSha256 untouched — RED pre-fix parsed
 *    cleanly);
 *  - true  → the outer hashes are made valid, so only a deliberately-stale
 *    per-entry `sha256` vs a corrupted payload slice can trip the per-entry
 *    check (tests F-B3: the genuinely-named per-entry rejection).
 */
function reemit(
  archive: Uint8Array,
  mutate: (m: Record<string, unknown>) => void,
  recomputeSelfHashes: boolean,
): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const manifestLen = view.getUint32(8, true);
  const payloadStart = 12 + manifestLen;
  const payload = archive.subarray(payloadStart);
  const manifest = JSON.parse(new TextDecoder().decode(archive.subarray(12, payloadStart))) as Record<
    string,
    unknown
  >;
  mutate(manifest);
  if (recomputeSelfHashes) {
    manifest.archiveSha256 = sha(payload);
    manifest.manifestSha256 = '0'.repeat(64);
    manifest.manifestSha256 = sha(new TextEncoder().encode(canonicalStringify(manifest)));
  }
  const mb = new TextEncoder().encode(canonicalStringify(manifest));
  const out = new Uint8Array(12 + mb.byteLength + payload.byteLength);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, view.getUint32(0, true), true);
  ov.setUint32(4, view.getUint32(4, true), true);
  ov.setUint32(8, mb.byteLength, true);
  out.set(mb, 12);
  out.set(payload, 12 + mb.byteLength);
  return out;
}

function entries(): CaseArchiveInputEntry[] {
  return [
    { name: 'case-document', kind: 'case-document', bytes: new TextEncoder().encode('{"id":"case-1"}') },
    { name: 'scan-mesh/aaa', kind: 'scan-mesh', bytes: Uint8Array.from([1, 2, 3, 4, 5]) },
    { name: 'final-mesh/bbb', kind: 'final-mesh', bytes: Uint8Array.from([9, 8, 7]) },
    { name: 'export-bytes/ccc', kind: 'export-bytes', bytes: Uint8Array.from([]) },
  ];
}

describe('case archive container', () => {
  it('round-trips every entry byte-identically and verifies integrity', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const parsed = parseCaseArchive(archive);
    expect(parsed.manifest.case).toEqual({ id: 'case-1', name: 'Archive Case', schemaVersion: 2 });
    expect(parsed.manifest.kernelVersion).toBe('0.26.0');
    for (const e of entries()) {
      const got = parsed.entries.get(e.name);
      expect(got).toBeDefined();
      expect(Array.from(got!.bytes)).toEqual(Array.from(e.bytes));
      expect(got!.kind).toBe(e.kind);
    }
  });

  it('is DETERMINISTIC: same case ⇒ bit-identical bytes regardless of input order', () => {
    const a = buildCaseArchive(CASE_INFO, entries());
    const shuffled = [...entries()].reverse();
    const b = buildCaseArchive(CASE_INFO, shuffled);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('rejects a corrupted entry payload, NAMING the failing entry', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    // Flip a byte inside the payload section (past the header + manifest).
    const corrupt = archive.slice();
    corrupt[corrupt.length - 2] = (corrupt[corrupt.length - 2]! ^ 0xff) & 0xff;
    try {
      parseCaseArchive(corrupt);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CaseArchiveError);
      // Whole-archive hash catches it first (payload section changed).
      expect((error as CaseArchiveError).message).toMatch(/whole-archive hash mismatch|failed its integrity hash/);
    }
  });

  // F-B2: the manifest's DESCRIPTIVE fields are self-hash-protected. Payload +
  // archiveSha256 are left untouched/valid; ONLY the descriptive field is
  // tampered and the self-hash left stale — RED pre-fix (parsed cleanly), now
  // rejected.
  it('rejects a tampered case.name (self-hash protects the DB case-name source)', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const forged = reemit(archive, (m) => {
      (m.case as { name: string }).name = 'DIFFERENT PATIENT';
    }, false);
    expect(() => parseCaseArchive(forged)).toThrow(/manifest self-hash mismatch/);
  });

  it('rejects a tampered kernelVersion', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const forged = reemit(archive, (m) => {
      m.kernelVersion = '9.9.9';
    }, false);
    expect(() => parseCaseArchive(forged)).toThrow(/manifest self-hash mismatch/);
  });

  it('rejects a tampered entry kind', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const forged = reemit(archive, (m) => {
      // entries[0] is 'case-document' (sorted by name); relabel its kind.
      (m.entries as { kind: string }[])[0]!.kind = 'scan-mesh';
    }, false);
    expect(() => parseCaseArchive(forged)).toThrow(/manifest self-hash mismatch/);
  });

  // F-B3: a genuinely-stale per-entry hash — corrupt a payload byte, recompute
  // the OUTER hashes (self + whole-archive) so they pass, leave the target
  // entry's own sha256 stale → the per-entry check fires, NAMING the entry.
  it('rejects a stale per-entry hash, naming the failing entry', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const corrupted = archive.slice();
    // Last payload byte belongs to scan-mesh/aaa (entries sorted by name;
    // scan-mesh/aaa sorts last and is the only trailing non-empty payload).
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! ^ 0xff) & 0xff;
    // Recompute self + whole-archive hashes over the corrupted payload, but do
    // NOT touch any entry's per-entry sha256 (they stay stale).
    const forged = reemit(corrupted, () => {}, true);
    try {
      parseCaseArchive(forged);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CaseArchiveError);
      expect((error as CaseArchiveError).message).toMatch(/failed its integrity hash/);
      expect((error as CaseArchiveError).entryName).toBe('scan-mesh/aaa');
    }
  });

  it('rejects a bad magic / unsupported version', () => {
    const archive = buildCaseArchive(CASE_INFO, entries());
    const badMagic = archive.slice();
    badMagic[0] = 0;
    expect(() => parseCaseArchive(badMagic)).toThrow(/bad magic/);
    expect(() => parseCaseArchive(new Uint8Array(4))).toThrow(/truncated/);
  });

  it('rejects duplicate entry names at build time', () => {
    expect(() =>
      buildCaseArchive(CASE_INFO, [
        { name: 'dup', kind: 'scan-mesh', bytes: Uint8Array.from([1]) },
        { name: 'dup', kind: 'scan-mesh', bytes: Uint8Array.from([2]) },
      ]),
    ).toThrow(CaseArchiveError);
  });
});
