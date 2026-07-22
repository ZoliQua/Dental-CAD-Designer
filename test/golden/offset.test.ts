// test/golden/offset.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// golden regression pin for @dqcad/kernel's offset pipeline (Phase 2
// Task 7) on the standin-prep-die fixture at the clinical default voxel
// pitch, extending the intake golden pattern (intake.test.ts): stats +
// errorBound + a sha256 over the output mesh buffers, committed as
// test-fixtures/offset/standin-prep-die.offset.golden.json.
//
// Lives here (not in packages/kernel) because it parses the STL fixture
// with @dqcad/io, which the layer rule forbids kernel itself from
// importing — and because it consumes the clinical default pitch from
// @dqcad/clinical-profiles, which kernel (deliberately — required-param
// rule) has no dependency on.
//
// NOTE (golden discipline, CLAUDE.md): this hash pins kernel output — it
// may only change together with a KERNEL_VERSION bump + changelog entry.
// test/golden/goldenEnforcement.ts's live-vs-committed comparison doesn't
// cover this file directly (it's Task 8's kernel-ops suite's own
// mechanism), but scripts/check-golden-version-gate.ts's CI base-ref gate
// DOES — this golden's path matches its `test-fixtures/offset/*.golden.json`
// pattern, so a push/PR that changes it without a version bump + changelog
// entry fails that gate. To regenerate after an INTENTIONAL kernel change:
//   UPDATE_OFFSET_GOLDEN=1 RUN_CLINICAL_GOLDEN=1 npx vitest run --project golden test/golden/offset.test.ts
// then review the diff and bump KERNEL_VERSION accordingly.
//
// ## Runtime split (golden-suite headroom)
//
// The actual offset run below — the die at DEFAULT_OFFSET_VOXEL_PITCH_MM
// (0.02 mm), the real clinical cement-gap scenario — takes ~117-118 s,
// which was ~99% of `npm run test:golden`'s total runtime and sat right at
// the suite's ~2 min CI budget. A FAST, coarse-pitch (0.1 mm) regression pin
// of this SAME fixture already lives in the default suite instead:
// scripts/kernel-ops-lib.ts's `offsetMesh` entry (same die, same distance,
// committed in test-fixtures/golden/kernel-ops.json, ~2 s) — it catches an
// SDF/marching-cubes/cleanup regression on every push/PR; it just can't
// stand in for the clinical-pitch precision this file specifically pins.
//
// So the expensive test below is env-gated (`RUN_CLINICAL_GOLDEN=1`,
// SKIPPED by default) rather than deleted or weakened: the clinical-pitch
// hash stays committed and is still actually checked, just not on every
// push. It's wired into the existing weekly `perf-guard` CI job (ci.yml —
// same "slow-moving regression, not every-push" rationale as that job's
// e2e perf check), plus available on demand via workflow_dispatch or a
// local `RUN_CLINICAL_GOLDEN=1` run.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseStl } from '@dqcad/io';
import { intake, offsetMesh, offsetMeshRoi, KERNEL_VERSION, type MeshStats } from '@dqcad/kernel';
import { DEFAULT_OFFSET_VOXEL_PITCH_MM } from '@dqcad/clinical-profiles';
import { assertNotLfsPointer } from './stl-reader.ts';
import { getInstalledManifoldVersion } from '../../scripts/kernel-ops-lib.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const diePath = join(repoRoot, 'test-fixtures', 'standin-scans', 'standin-prep-die.stl');
const goldenPath = join(repoRoot, 'test-fixtures', 'offset', 'standin-prep-die.offset.golden.json');

/** The cement-gap distance this golden pins: PLAN.md §3's "Cement gap
 * (spacer)" default, 50 µm — the exact clinical scenario Task 7 is the
 * foundation for (Phase 4 crown inner surfaces). */
const OFFSET_DISTANCE_MM = 0.05;

interface OffsetGoldenSnapshot {
  /** See test/golden/intake.test.ts's `IntakeGoldenSnapshot.kernelVersion`
   * doc (Phase 3 Task 1 housekeeping) — same field, same rationale. */
  kernelVersion: string;
  /** The offset pipeline's manifold cleanup stage (`cleanupMesh`,
   * @dqcad/kernel's boolean/manifold.ts) is WASM-derived (manifold-3d) —
   * unlike intake/curvature's pure-kernel-math goldens, this snapshot
   * records the installed manifold-3d package version alongside
   * kernelVersion, same convention as scripts/kernel-ops-lib.ts's
   * `KernelOpsSnapshot.manifoldVersion` (see that field's doc for why: "a
   * manifold-3d upgrade that changes this suite's hashes is visible AS a
   * manifold-3d-version change, not just an unexplained numeric diff"). */
  manifoldVersion: string;
  distanceMm: number;
  pitchMm: number;
  errorBoundMm: number;
  stats: MeshStats;
  resultSha256: string;
}

function hashResultMesh(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

describe('offset — golden on standin-prep-die at the clinical default pitch', () => {
  it('the clinical default pitch is the value the phase acceptance criterion (and the kernel acceptance test) assume', () => {
    // packages/kernel/src/offset/offsetMesh.test.ts hardcodes 0.02 (kernel
    // must not import clinical-profiles); this assertion keeps the two in
    // verified lockstep.
    expect(DEFAULT_OFFSET_VOXEL_PITCH_MM).toBe(0.02);
  });

  it.skipIf(process.env['RUN_CLINICAL_GOLDEN'] !== '1')(
    'offset(+50 µm) of the die matches the committed golden (stats, errorBound, output-buffer sha256) [RUN_CLINICAL_GOLDEN=1 — weekly perf-guard CI job / on-demand only, see module doc]',
    { timeout: 600_000 },
    async () => {
      const buffer = readFileSync(diePath);
      assertNotLfsPointer(buffer, diePath);
      const { soup } = parseStl(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
      const die = intake({ kind: 'soup', soup });
      expect(die.stats.watertight).toBe(true); // fixture sanity — offset requires a closed input

      const started = performance.now();
      const result = await offsetMesh(die.mesh, OFFSET_DISTANCE_MM, { pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM });
      const elapsedMs = performance.now() - started;
      // Timing evidence for this task's report (die-sized offset at default
      // pitch — expected tens of seconds, worker-side scale).
      console.log(
        `[golden] standin-prep-die offset +${OFFSET_DISTANCE_MM} mm @ pitch ${DEFAULT_OFFSET_VOXEL_PITCH_MM}: ` +
          `${(elapsedMs / 1000).toFixed(1)} s, ${result.mesh.indices.length / 3} triangles`,
      );

      expect(result.stats.watertight).toBe(true);
      expect(result.stats.manifoldEdges).toBe(true);
      expect(result.stats.componentCount).toBe(1);

      const snapshot: OffsetGoldenSnapshot = {
        kernelVersion: KERNEL_VERSION,
        manifoldVersion: getInstalledManifoldVersion(),
        distanceMm: OFFSET_DISTANCE_MM,
        pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM,
        errorBoundMm: result.errorBoundMm,
        stats: result.stats,
        resultSha256: hashResultMesh(result.mesh.positions, result.mesh.indices),
      };

      if (process.env['UPDATE_OFFSET_GOLDEN'] === '1') {
        // Regeneration path — see this file's module doc for the golden
        // discipline (kernel version bump + changelog) this requires.
        mkdirSync(join(repoRoot, 'test-fixtures', 'offset'), { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        console.log(`[golden] WROTE ${goldenPath} — review the diff before committing.`);
      }

      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as OffsetGoldenSnapshot;
      expect(snapshot.stats).toEqual(golden.stats);
      expect(snapshot.errorBoundMm).toBe(golden.errorBoundMm);
      expect(snapshot.resultSha256).toBe(golden.resultSha256);
      expect(snapshot.distanceMm).toBe(golden.distanceMm);
      expect(snapshot.pitchMm).toBe(golden.pitchMm);
      // Well-formedness only (not equality with the live version) — see
      // test/golden/intake.test.ts's identical check's doc for why.
      expect(typeof golden.kernelVersion).toBe('string');
      expect(golden.kernelVersion.length).toBeGreaterThan(0);
      expect(typeof golden.manifoldVersion).toBe('string');
      expect(golden.manifoldVersion.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Phase 4 Task 1 carry-in — die-offset ROI-band perf fix, before/after
// evidence (see @dqcad/kernel's offset/offsetMesh.ts, `offsetMeshRoi`'s
// module doc, for the full root-cause analysis and correctness argument).
//
// "Before" is the SAME `offsetMesh` call the golden test above pins
// (~117-126s, P2 Task 7's original report) — reproduced HERE too (not just
// cited) so this task's report carries a real, current measurement rather
// than a stale historical number. "After" is `offsetMeshRoi` restricted to
// a small, honestly-real ROI around the die's 1mm shoulder collar (the
// region a crown's inner-surface stage actually needs — see the fixture's
// own geometry, task-6-report.md: "4mm shoulder-collar radius, 1mm shoulder
// height, 10mm total height") rather than the die's full 8x8x10mm extent
// (which includes 9mm of coarsely-tessellated lateral wall and a flat base
// the crown pipeline never touches).
//
// Env-gated (`RUN_OFFSET_ROI_PERF=1`, skipped by default) — same rationale
// as this file's `RUN_CLINICAL_GOLDEN` gate above (a >100s test would blow
// every other suite's CI budget if it ran on every push); on-demand /
// weekly perf-guard territory.
describe('offset — die-offset ROI-band perf fix: before/after on standin-prep-die at the clinical default pitch', () => {
  it.skipIf(process.env['RUN_OFFSET_ROI_PERF'] !== '1')(
    'offsetMeshRoi (shoulder-collar ROI) is dramatically faster than offsetMesh (full die bbox), same accuracy where both sample [RUN_OFFSET_ROI_PERF=1 — weekly perf-guard CI job / on-demand only]',
    { timeout: 600_000 },
    async () => {
      const buffer = readFileSync(diePath);
      assertNotLfsPointer(buffer, diePath);
      const { soup } = parseStl(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
      const die = intake({ kind: 'soup', soup });
      expect(die.stats.watertight).toBe(true);

      const beforeStarted = performance.now();
      const before = await offsetMesh(die.mesh, OFFSET_DISTANCE_MM, { pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM });
      const beforeElapsedMs = performance.now() - beforeStarted;

      // The die's own bbox is [-4,-4,0]..[4,4,10] (measured, this task's
      // report) — the shoulder collar (constant radius-4mm vertical wall)
      // occupies z in [0,1]; padded slightly (z in [-0.1, 0.7]) to keep the
      // ROI clearly non-empty without needing to know the exact margin
      // z-coordinate.
      const roiBboxMm = { min: [-4, -4, -0.1] as const, max: [4, 4, 0.7] as const };
      const afterStarted = performance.now();
      const after = await offsetMeshRoi(die.mesh, OFFSET_DISTANCE_MM, {
        pitchMm: DEFAULT_OFFSET_VOXEL_PITCH_MM,
        roiBboxMm,
      });
      const afterElapsedMs = performance.now() - afterStarted;

      console.log(
        `[ROI perf] standin-prep-die offset +${OFFSET_DISTANCE_MM} mm @ pitch ${DEFAULT_OFFSET_VOXEL_PITCH_MM}: ` +
          `BEFORE (full bbox) ${(beforeElapsedMs / 1000).toFixed(1)}s, ${before.mesh.indices.length / 3} triangles; ` +
          `AFTER (shoulder-collar ROI) ${(afterElapsedMs / 1000).toFixed(1)}s, ${after.mesh.indices.length / 3} triangles ` +
          `(watertight=${after.stats.watertight}, boundaryEdgeCount=${after.stats.boundaryEdgeCount})`,
      );

      // The target this carry-in fix is measured against (this task's brief).
      expect(afterElapsedMs).toBeLessThan(10_000);
      // A real, meaningful speedup — not a fluke of machine noise.
      expect(afterElapsedMs).toBeLessThan(beforeElapsedMs / 3);

      // Correctness: the ROI patch is open (cropped at z~=[-0.1,0.7]'s
      // domain edge — the shoulder wall continues past both ends) — never
      // silently "closed".
      expect(after.stats.watertight).toBe(false);
      expect(after.stats.boundaryEdgeCount).toBeGreaterThan(0);
      expect(after.mesh.indices.length).toBeGreaterThan(0);

      // Every ROI vertex comfortably inside the crop (z in [0.15, 0.55],
      // clear of both z~-0.1/0.7 domain edges) lies within the SAME
      // documented error bound of the KNOWN analytic shoulder radius
      // (4mm + the 0.05mm outward offset — the shoulder is an exact
      // cylinder, so this is a genuine closed-form check, not just an
      // internal-consistency one).
      let checked = 0;
      let maxErr = 0;
      const EXPECTED_RADIUS_MM = 4 + OFFSET_DISTANCE_MM;
      for (let v = 0; v < after.mesh.positions.length / 3; v++) {
        const x = after.mesh.positions[v * 3]!;
        const y = after.mesh.positions[v * 3 + 1]!;
        const z = after.mesh.positions[v * 3 + 2]!;
        if (z < 0.15 || z > 0.55) continue;
        checked++;
        const r = Math.hypot(x, y);
        maxErr = Math.max(maxErr, Math.abs(r - EXPECTED_RADIUS_MM));
      }
      expect(checked).toBeGreaterThan(10);
      expect(maxErr).toBeLessThanOrEqual(after.errorBoundMm);
    },
  );
});
