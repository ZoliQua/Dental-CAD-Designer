# Hand-traced reference margins

Phase 3 Task 7. Reference margin-line polylines, hand-traced and confirmed
by the dentist project owner in the running app, used as the acceptance
ground truth for Task 8's auto-propose comparison harness
(`docs/plans/phase-3-margin-axis.md` Task 8).

**Not machine-generated.** Every other `test-fixtures/*/README.md` in this
repo documents a *script-regenerated* fixture. These files are the opposite:
a human traced the finish line on the real anonymized scan, adjusted it by
hand until it satisfied Task 6's validation gate, then clicked "Export as
reference (dev)" in the margin editor. There is no `generate-*` script for
this directory and none is planned — see "Golden integrity" below for how
these files are still protected against silent drift.

## Provenance

- **Source case:** `test-fixtures/real-scans/arch-case-01` UpperJaw (the
  same anonymized fixture `test-fixtures/real-scans/README.md` documents —
  no new PHI surface here, only a hash reference to that mesh).
- **Teeth:** FDI 12, 11, 21, 22 (four shoulder-prepped anterior teeth —
  satisfies PLAN.md Phase 3's "3 real prep fixtures" acceptance criterion).
- **Producer:** `apps/client/src/engine/marginEditor.ts`'s
  `exportReferenceMargin()` — a DEV-ONLY button in the margin editor panel
  (`import.meta.env.DEV`-gated, same convention as `engine/testHooks.ts`;
  absent from any production build). Visible only after a margin has been
  traced (manually, or auto-proposed and then human-adjusted — the FINAL
  trace must be human-touched, that is what makes it a reference) **and**
  confirmed via Task 6's validation gate. One click exports the tooth
  currently being edited; the file is a browser download named
  `<tooth>.reference.json`.
- **Committing:** the exported download is moved by hand into
  `test-fixtures/margins/<caseId>/<tooth>.reference.json` (e.g.
  `test-fixtures/margins/arch-case-01/11.reference.json`) and committed as
  plain git-tracked JSON — small enough (a few hundred KB at most for a
  ~200-anchor margin) that Git LFS is unnecessary, unlike the STL/PLY scan
  fixtures.

## Schema

One JSON object per file — `@dqcad/shared-types`' `MarginReferenceExport`
interface (`packages/shared-types/src/index.ts`) is the canonical,
type-checked definition; this table is a human-readable mirror of it.

| Field | Type | Meaning |
| --- | --- | --- |
| `tooth` | `FdiTooth` (11–48) | Which tooth this margin belongs to — matches the filename. |
| `anchors` | `MarginAnchor[]` | The authoritative control points: `{ position: Vec3 (mm), triangleIndex: number, barycentric: [number, number, number] }` — same currency as `CaseDocument.restorations[].marginLines[tooth].anchors`. |
| `closed` | `boolean` | Always `true` for a confirmed reference (Task 6's gate blocks confirm on an open loop) — carried explicitly anyway so a consumer never has to assume it. |
| `resampledPoints` | `Vec3[]` (mm) | The dense, geodesic-sampled display/measurement polyline between anchors — **not** a fixed arc-length resampling (see "Density" below); this is what Task 8's comparison harness measures deviation against. |
| `meshContentHash` | `string` (hex SHA-256) | The target mesh's `MeshAsset.contentHash` this margin was traced against — ties the file to a specific, immutable, anonymized fixture mesh. **Never** a filename, scan ID, or acquisition date. |
| `traced` | `'human-reference'` | Fixed literal — distinguishes this file, by construction, from any machine-generated (`proposeMargin`) fixture. |
| `appVersion` | `string` | `apps/client/src/appVersion.ts`'s `APP_VERSION` at export time. |
| `kernelVersion` | `string` | `@dqcad/kernel`'s `KERNEL_VERSION` at export time — the same value every journaled `Operation.kernelVersion` records. |
| `exportedAt` | `string` (ISO-8601 UTC) | When the export button was clicked — provenance only, never clinically meaningful. |

**No PHI.** Every field above is either a mesh-relative geometric quantity,
a content-hash reference, or build/export metadata — never a patient name,
scan filename, or acquisition date. `MarginReferenceExport`'s own TSDoc
carries this as an explicit, audited allow-list; `test/golden/
margin-references.test.ts` asserts `Object.keys(...)` against exactly this
field set for every committed file, so an accidental extra field (e.g. a
stray debug field leaking something identifying) fails CI, not just a
manual review.

## Layout

```
test-fixtures/margins/<caseId>/<tooth>.reference.json
```

Currently: `test-fixtures/margins/arch-case-01/{12,11,21,22}.reference.json`.

## Density (a deliberate non-fixed-step choice)

`resampledPoints` is **not** resampled at a fixed arc-length step. It is the
concatenation of every anchor-to-anchor segment's real geodesic shortest
path (`@dqcad/kernel`'s `geodesicPath`, walking triangle-edge crossings) —
the exact same representation the live margin editor uses for display
(`engine/marginEditor.ts`'s `flattenResampledPoints`) and the exact same
representation `validateMarginLine` checks. Point density therefore tracks
**local mesh resolution** (arch-case-01's upperjaw averages roughly
100–200 µm triangle edges — `test-fixtures/real-scans/arch-case-01/
manifest.json`'s ~250k triangles over its own bbox), not a resampling
parameter. `test/golden/margin-references.test.ts`'s density check asserts
a broad sanity band grounded in that same mesh-resolution estimate — see
that file's own module doc for the exact bounds and why they are sanity,
not a clinical or algorithmic spec.

## Reference-quality checks

`test/golden/margin-references.test.ts` runs, for each **committed** file
in this directory:

1. `validateMarginLine` against the real arch-case-01 upperjaw mesh —
   closed, non-self-intersecting, on-surface, non-degenerate (Task 6's own
   gate, re-run here against the file instead of the live editor).
2. `resampledPoints` density within the sanity band above.
3. Per-tooth circumference (closed-loop length) within a **loose anatomical
   sanity bound** for an upper incisor/canine finish line — **not** clinical
   dogma, just "did something go very wrong" (see that file for the exact
   numbers and reasoning).
4. `meshContentHash` matches the actual, freshly-computed content hash of
   `test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl` after
   intake — catches a reference accidentally traced against a stale/wrong
   mesh version.

A file for a tooth that hasn't been traced yet is **skipped, not failed**
(with an explicit, human-readable message identifying which tooth/path is
missing) — this task's tooling lands before the human tracing session does;
`npm run test:golden` must stay green in both states.

## Golden integrity — no separate checksums.json (deliberate)

Every other `*.golden.json`/`*.golden` fixture in this repo is
machine-regenerated by a script and gets its own value re-derived and
compared on every run — a hash mismatch there means "the live kernel
produced something different than last time," which is exactly what those
tests want to catch. That framing doesn't fit a **hand-traced** file: there
is no "regenerate" step to compare against, so pinning a sha256 of the
file's own bytes would only ever assert "this file has not silently changed
since the moment the check was written" — worth catching, but a narrower
job than it sounds.

`scripts/check-golden-version-gate.ts`'s `GOLDEN_PATH_PATTERNS` already
provides exactly that mechanism for the whole repo, and this directory is
now in it (`test-fixtures/margins/**/*.reference.json`): any PR that
modifies a committed reference file must ALSO bump `KERNEL_VERSION` and add
a `docs/CHANGELOG-kernel.md` entry, or CI's version-gate job fails — the
identical discipline every other golden-pinned path already enforces. A
standalone `checksums.json` here would duplicate that mechanism (and could
silently drift from it, e.g. if someone updated the checksum file but
forgot the gate's exact matcher, or vice versa) for no additional coverage,
so `test/golden/margin-references.test.ts` computes and asserts nothing
hash-wise on its own — the version gate IS this directory's integrity pin.

## Relationship to other fixtures

- Real source scan: `test-fixtures/real-scans/arch-case-01/` (STL/PLY, Git
  LFS).
- Machine-generated margin proposal golden (for comparison, not identity):
  `test-fixtures/golden/kernel-ops.json`'s own `proposeMargin` entry (Phase
  3 Task 4) — pins a *different* thing (one fixed-seed auto-proposal's exact
  output), not a human reference.
- Consumer: Task 8's `scripts/margin-acceptance.ts` +
  `test/golden/margin-acceptance.test.ts` (comparison harness — measures
  auto-propose deviation against these references; not part of this task).
