# Real scan fixtures (anonymized)

Two real patient scan cases, anonymized and imported by
`scripts/import-scan-case.ts` (`docs/plans/phase-0-foundation.md` Task 8).
These are the canonical input shape the app itself must accept later: a
Shining 3D intraoral scanner export, processed through exocad, containing an
upper jaw, a lower jaw, and two bite (occlusion) scans per case.

## Provenance

- **Source:** Shining 3D scanner → exocad export folder (one folder per
  patient case), dropped into the git-ignored `scans/` directory.
- **Anonymization:** every file below was produced by
  `tsx scripts/import-scan-case.ts --src <scans-folder> --id <case-id>`,
  which:
  - overwrites the 80-byte binary-STL header with a fixed string
    (`DQCAD anonymized fixture`, zero-padded) — triangle data after the
    header is copied verbatim, never re-serialized;
  - rewrites binary-PLY `comment TextureFile <original filename>` header
    lines to a fixed `comment anonymized` line — every other header line
    (format/element/property) and the entire binary body are copied
    verbatim;
  - reads only two allow-listed fields from the source `.dentalProject` XML
    (`AntagonistType`, `ToothColor`) into `manifest.json`; every other
    field in that XML — PatientName, PracticeName (which includes a
    personal email address), DateTime, ProjectGUID — is read only
    transiently in memory (to build a scrub-verification deny-list) and is
    never written to any committed file;
  - before writing anything, scans every byte it is about to write for
    patient-identifying tokens derived from the source folder name, every
    source file name, and those four PHI fields, and aborts (writing
    nothing) if any match is found.
  - the acquisition **date is intentionally not preserved** — case IDs
    (`arch-case-01`, `arch-case-02`) are sequence numbers assigned at import
    time, not dates or patient tray numbers.
- OBJ/MTL/JPG texture files from the source export are **not** copied in
  Phase 0 (STL and PLY geometry only).
- `git lfs ls-files` should list 16 files here (2 cases × 4 mesh roles × 2
  formats — STL and PLY); `manifest.json` is plain committed JSON, not LFS.
- Re-running the import script against the same source folder produces
  byte-identical output (verified manually via two runs + a sha256 diff over
  every produced file, since the git-ignored `scans/` source is not present
  in CI or a fresh clone to re-verify this automatically).

See `test/golden/real-scans.test.ts` for the automated checks: manifest
agreement (sha256, byte size, triangle/vertex/face counts, bbox), absence of
`TextureFile` PLY comments, and the hard PHI-token scrub assertion.

## Layout

Each case is a directory `<case-id>/` containing:

| File | Meaning |
| --- | --- |
| `<case-id>-upperjaw.stl` / `.ply` | Upper jaw arch scan |
| `<case-id>-lowerjaw.stl` / `.ply` | Lower jaw arch scan |
| `<case-id>-bite0.stl` / `.ply` | Bite (occlusion) scan, first of two |
| `<case-id>-bite1.stl` / `.ply` | Bite (occlusion) scan, second of two |
| `manifest.json` | Per-mesh sha256/byteSize/counts/bbox, the occlusion `alignmentMatrix` (16 numbers, row-major/row-vector convention — see the field `alignmentMatrixConvention` in the file itself), and `antagonistType`/`toothColor` |

STL triangle counts and the corresponding PLY's face count may legitimately
differ (different export passes through the same pipeline) — both are
recorded in the manifest; nothing asserts they're equal.

## Cases

- **`arch-case-01`** — full arch (upper + lower + two bite scans).
- **`arch-case-02`** — full arch (upper + lower + two bite scans).

Both are **arch/antagonist** scans. **A real crown-prep (single-tooth
preparation margin) case is still needed** from the project owner before
Phase 3 acceptance — `test-fixtures/standin-scans/standin-prep-die.stl` is a
procedural stand-in used only to unblock pipeline plumbing until that real
case arrives.
