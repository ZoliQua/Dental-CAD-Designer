// packages/kernel/src/offset/offsetMeshRoi.test.ts
//
// Tests for `offsetMeshRoi` (Phase 4 Task 1 carry-in: die-offset ROI-band
// perf fix — see offsetMesh.ts's module doc for the full motivation and
// correctness argument). Fast, fixture-free (icosphere) tests only — the
// real die-scale perf comparison (the actual before/after evidence) lives
// in test/golden/offset.test.ts (env-gated, needs @dqcad/io + the real
// fixture, same convention as that file's existing clinical-pitch golden).
//
// Two correctness properties asserted here, per this task's guardrail
// ("correctness first — the offset result must be identical to the
// full-bbox version within the ROI"):
//
//  1. ROI == the mesh's own (padded) bbox reduces `offsetMeshRoi` to
//     EXACTLY `offsetMesh`'s own output (same triangle soup, same stats
//     modulo the deliberately-skipped `cleanupMesh` pass — see below).
//  2. A GENUINELY SMALLER ROI still meets the SAME documented `@errorBound`
//     for every vertex strictly INTERIOR to the crop (away from the domain
//     boundary) — the tight band cannot clip/corrupt the iso surface it
//     does sample, only omit surface outside the domain entirely.
import { describe, expect, it } from 'vitest';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { EmptyOffsetResultError, offsetMesh, offsetMeshRoi } from './offsetMesh.ts';

describe('offsetMeshRoi — ROI spanning the whole mesh bbox matches offsetMesh at every sampled point', () => {
  it('icosphere r=2 (subdivisions 3), d=0.3, pitch=0.1: identical vertex sets modulo cleanupMesh', async () => {
    const radius = 2;
    const pitch = 0.1;
    const d = 0.3;
    const mesh = icosphereMesh(radius, 3);
    const full = await offsetMesh(mesh, d, { pitchMm: pitch });
    const stats = analyzeMesh(mesh);
    const roi = await offsetMeshRoi(mesh, d, {
      pitchMm: pitch,
      roiBboxMm: { min: stats.bbox.min, max: stats.bbox.max },
    });

    // offsetMeshRoi skips cleanupMesh (documented: an open-patch-shaped
    // primitive) — but with an ROI spanning the whole bbox, the extracted
    // surface IS already closed (nothing crops it), so weld-only and
    // weld+manifold-cleanup should report the SAME watertight solid
    // (cleanupMesh's own job is validating/collapsing slivers, not
    // changing a genuinely-clean weld's topology here).
    expect(roi.stats.watertight).toBe(true);
    expect(roi.stats.boundaryEdgeCount).toBe(0);
    expect(roi.mesh.indices.length).toBe(full.mesh.indices.length);
    expect(roi.errorBoundMm).toBeCloseTo(full.errorBoundMm, 10);

    // Every ROI vertex is within the SAME documented bound of the ideal
    // sphere as the full computation — the ROI path is not somehow less
    // accurate merely because it derives its grid bbox differently.
    let maxErr = 0;
    for (let v = 0; v < roi.mesh.positions.length / 3; v++) {
      const r = Math.hypot(
        roi.mesh.positions[v * 3]!,
        roi.mesh.positions[v * 3 + 1]!,
        roi.mesh.positions[v * 3 + 2]!,
      );
      maxErr = Math.max(maxErr, Math.abs(r - (radius + d)));
    }
    expect(maxErr).toBeLessThanOrEqual(roi.errorBoundMm);
  });
});

describe('offsetMeshRoi — a genuinely smaller ROI: interior accuracy preserved, boundary honestly open', () => {
  it('icosphere r=2, d=0.1, pitch=0.05: half-space ROI (x>=0) — interior vertices (x>0.5) match the sphere bound; result is NOT watertight (honest open patch)', async () => {
    const radius = 2;
    const pitch = 0.05;
    const d = 0.1;
    const mesh = icosphereMesh(radius, 4);

    const roi = await offsetMeshRoi(mesh, d, {
      pitchMm: pitch,
      // Half the sphere's bbox (x in [0, r+pad]) — deliberately smaller
      // than the full mesh bbox ([-r,r]^3), so the true offset surface for
      // x < 0 is entirely outside the sampled domain.
      roiBboxMm: { min: [0, -radius, -radius], max: [radius, radius, radius] },
    });

    // A genuinely cropped ROI produces an OPEN patch (crop boundary near
    // x=0) — never silently "closed" by fabricating a cap.
    expect(roi.stats.watertight).toBe(false);
    expect(roi.stats.boundaryEdgeCount).toBeGreaterThan(0);

    // Vertices well INSIDE the crop (x > 0.5, comfortably clear of both the
    // x=0 crop boundary and the padded domain's own far edges) still meet
    // the SAME documented error bound against the ideal sphere.
    let checked = 0;
    let maxErr = 0;
    for (let v = 0; v < roi.mesh.positions.length / 3; v++) {
      const x = roi.mesh.positions[v * 3]!;
      const y = roi.mesh.positions[v * 3 + 1]!;
      const z = roi.mesh.positions[v * 3 + 2]!;
      if (x <= 0.5) continue;
      checked++;
      const r = Math.hypot(x, y, z);
      maxErr = Math.max(maxErr, Math.abs(r - (radius + d)));
    }
    expect(checked).toBeGreaterThan(20); // real coverage, not a vacuous pass
    expect(maxErr).toBeLessThanOrEqual(roi.errorBoundMm);
  });

  it('an ROI that never reaches the true offset surface throws EmptyOffsetResultError (honest, not a silently-empty mesh)', async () => {
    const mesh = icosphereMesh(1, 2);
    await expect(
      offsetMeshRoi(mesh, 0.1, {
        pitchMm: 0.1,
        // Far away from the unit sphere entirely.
        roiBboxMm: { min: [10, 10, 10], max: [11, 11, 11] },
      }),
    ).rejects.toThrow(EmptyOffsetResultError);
  });
});

describe('offsetMeshRoi — determinism and error paths', () => {
  it('double run produces byte-identical output (determinism hash)', async () => {
    const mesh = icosphereMesh(1.5, 2);
    const roiBboxMm = { min: [-1.5, -1.5, -1.5] as const, max: [1.5, 1.5, 1.5] as const };
    const first = await offsetMeshRoi(mesh, 0.2, { pitchMm: 0.1, roiBboxMm });
    const second = await offsetMeshRoi(mesh, 0.2, { pitchMm: 0.1, roiBboxMm });
    expect(Array.from(second.mesh.positions)).toEqual(Array.from(first.mesh.positions));
    expect(Array.from(second.mesh.indices)).toEqual(Array.from(first.mesh.indices));
    expect(second.stats).toEqual(first.stats);
  });

  it('rejects invalid pitchMm/distanceMm before any heavy work', async () => {
    const mesh = icosphereMesh(1, 1);
    const roiBboxMm = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };
    await expect(offsetMeshRoi(mesh, 0.1, { pitchMm: 0, roiBboxMm })).rejects.toThrow(TypeError);
    await expect(offsetMeshRoi(mesh, Number.NaN, { pitchMm: 0.1, roiBboxMm })).rejects.toThrow(TypeError);
  });
});
