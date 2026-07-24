// test/golden/morph-shell-coupling.test.ts
//
// Phase 4 Task 12 — the morph→shell coupling DIAGNOSTIC (the bit the standin
// acceptance deliberately does NOT exercise). The standin builds its shell from
// the intaglio + a clean synthetic outer DOME (not the morph output), so it
// proves the FIT/geometry chain + the whole QC gate set + full journal
// reproducibility — but it does NOT prove that a realistic morph-DERIVED outer
// anatomy stitches into a buildable manifold crown. That morph→shell coupling
// is otherwise exercised ONLY on the real arch-case-01 (where it blocks). This
// diagnostic isolates "bad scan" from "coupling-robustness gap" on CLEAN,
// well-formed SYNTHETIC input — so the real-case block can be attributed
// correctly.
//
// ## What it does
//
//  1. CONTROL: an un-morphed clean CLOSED tooth (a barrel crown-blank whose
//     cervical == the crown margin) + the intaglio → `constructShell`. This
//     BUILDS a watertight crown — proving the tooth / inner / margin are all
//     shell-compatible (the closed-outer trim+stitch path from Task 7).
//
//  2. THE DIAGNOSTIC: the SAME tooth, RBF-MORPHED with GOOD synthetic contacts
//     (well-formed output — watertight, no clamped contact, sub-100 µm cervical
//     seal, sub-100 µm contact residual) → `constructShell`.
//
// ## Result (measured — see the console output + the report)
//
// The clean MORPHED closed tooth is currently REJECTED by `constructShell`
// (`NonManifoldInputError` / `ShellBoundaryError`), even though the byte-
// identical un-morphed tooth builds. This reproduces across mesh resolutions,
// tooth profiles, aligned/misaligned seal margins, and gentle/moderate morphs
// (5 configurations probed during development). CONCLUSION: there is a
// morph→shell coupling ROBUSTNESS GAP INDEPENDENT OF SCAN QUALITY — the RBF
// morph produces geometry (self-intersections / near-degenerate triangles
// invisible to halfedge watertightness) that the margin-trim + manifold-3d
// stitch reject. So the real tooth-11 shell block is NOT purely input quality;
// robustness work on the morph→shell seam is needed regardless of scan quality.
//
// If a future robustness improvement makes the morphed tooth BUILD, the
// `expect` below flips — that is the gap CLOSING, a win to celebrate: update
// this doc + p4-task-12-report.md accordingly (do NOT just relax the assertion).
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { analyzeMesh, buildInnerSurface, constructShell, type IndexedMesh } from '@dqcad/kernel';
import { runMorphingStage, type PipelineContext, type PipelineMeshHandle } from '@dqcad/cad-pipeline';
import { PROFILE } from '../../scripts/crown-journal-lib.ts';

const AXIS: Vec3 = [0, 0, 1];
const TOOTH = 11 as FdiTooth;
const µm = (mm: number): string => `${(mm * 1000).toFixed(1)} µm`;

function hashMesh(m: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  h.update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  return h.digest('hex');
}
function handle(c: string, m: IndexedMesh): PipelineMeshHandle {
  return { contentHash: c, mesh: m };
}
function marginCircle(r: number, z: number, n: number): { closed: true; resampledPoints: Vec3[] } {
  const p: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    p.push([r * Math.cos(t), r * Math.sin(t), z]);
  }
  return { closed: true, resampledPoints: p };
}
function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
/** A CLOSED barrel crown-blank from a (z, radius) profile — cervical ring first
 * (== the crown margin), fanned caps top + bottom → watertight closed solid. */
function barrelTooth(profile: readonly [number, number][], seg: number): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => { P.push(x, y, z); return P.length / 3 - 1; };
  const rings: number[][] = [];
  for (const [z, r] of profile) {
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; ring.push(push(r * Math.cos(th), r * Math.sin(th), z)); }
    rings.push(ring);
  }
  const tr: number[] = [];
  for (let l = 0; l < rings.length - 1; l++)
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(rings[l]![s]!, rings[l]![sn]!, rings[l + 1]![sn]!);
      tr.push(rings[l]![s]!, rings[l + 1]![sn]!, rings[l + 1]![s]!);
    }
  const bc = push(0, 0, profile[0]![0]);
  for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(bc, rings[0]![sn]!, rings[0]![s]!); }
  const tc = push(0, 0, profile[profile.length - 1]![0]);
  const top = rings[rings.length - 1]!;
  for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(tc, top[s]!, top[sn]!); }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}
/** A closed frustum die (margin circle 1.2 @ 0.5) for the intaglio. */
function frustumDie(): IndexedMesh {
  const seg = 96, mR = 1.2, tR = 0.8, mZ = 0.5, tZ = 2.0;
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => { P.push(x, y, z); return P.length / 3 - 1; };
  const b: number[] = [], t: number[] = [];
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ)); }
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ)); }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(b[s]!, b[sn]!, t[sn]!); tr.push(b[s]!, t[sn]!, t[s]!); }
  const bc = push(0, 0, mZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(bc, b[sn]!, b[s]!); }
  const tc = push(0, 0, tZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(tc, t[s]!, t[sn]!); }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}

const CROWN_MARGIN = marginCircle(1.2, 0.5, 240);
// A dense barrel crown-blank whose cervical ring sits AT the crown margin
// (r 1.2 @ z 0.5), bulging out to enclose the die then rounding to a top — the
// fairest clean CLOSED outer for the coupling (minimal seal deformation at the
// margin trim zone).
const BARREL_PROFILE: readonly [number, number][] = [[0.5, 1.2], [0.85, 1.55], [1.2, 1.75], [1.6, 1.8], [2.0, 1.72], [2.4, 1.5], [2.7, 1.1], [3.0, 0.6]];

const KNOWN_SHELL_ERRORS = ['NonManifoldInputError', 'ShellBoundaryError', 'ShellNotWatertightError'];

describe('morph → shell coupling diagnostic (isolates scan-quality from coupling-robustness)', () => {
  let inner: IndexedMesh;
  let barrel: IndexedMesh;

  beforeAll(async () => {
    inner = (await buildInnerSurface(frustumDie(), { pitchMm: 0.08, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, marginLoop: CROWN_MARGIN.resampledPoints, insertionAxis: AXIS })).mesh;
    barrel = barrelTooth(BARREL_PROFILE, 120);
  }, 300_000);

  it('CONTROL: an un-morphed clean closed tooth builds a WATERTIGHT crown (geometry/inner/margin are shell-compatible)', async () => {
    expect(analyzeMesh(barrel).watertight).toBe(true);
    const shell = await constructShell(barrel, inner, { insertionAxis: AXIS, marginLoop: CROWN_MARGIN.resampledPoints });
    const stats = analyzeMesh(shell.mesh);
    console.log(`[MORPH→SHELL control] un-morphed closed tooth → BUILT watertight=${stats.watertight} components=${stats.componentCount} tris=${shell.mesh.indices.length / 3}`);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
  }, 300_000);

  it('DIAGNOSTIC: a CLEAN RBF-morphed closed tooth is currently REJECTED by constructShell — morph→shell robustness gap, independent of scan quality', async () => {
    // A well-formed morph: good synthetic contacts, aligned seal margin.
    const ctx: PipelineContext = {
      restorationId: 'morph-shell-diag',
      materialProfile: PROFILE,
      insertionAxis: AXIS,
      targetMesh: handle('die', frustumDie()),
      marginLoops: { [TOOTH]: marginCircle(1.2, 0.5, 48) },
      neighbors: {
        [12 as FdiTooth]: handle('nb12', box([1.8, -2, 1.2], [3, 2, 2.2])),
        [21 as FdiTooth]: handle('nb21', box([-3, -2, 1.2], [-1.8, 2, 2.2])),
      },
      antagonist: handle('anta', box([-1.5, -1.5, 3.05], [1.5, 1.5, 5])),
      stages: {},
    };
    const morph = runMorphingStage(ctx, TOOTH, { placedMesh: handle('placed', barrel), hashMesh, morphOptions: { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 } });
    const morphed = morph.mesh!;
    const morphStats = analyzeMesh(morphed);
    const sealMaxMm = morph.params['marginSealMaxDeviationMm'] as number;
    const maxResMm = morph.params['maxContactResidualMm'] as number;
    const clamp = morph.params['contactClampWarning'] as boolean;

    // The morph output IS well-formed by every halfedge/contact measure.
    expect(morphStats.watertight).toBe(true);
    expect(clamp).toBe(false);
    expect(sealMaxMm).toBeLessThan(0.2);
    expect(maxResMm).toBeLessThan(0.2);

    let built: { watertight: boolean; tris: number } | null = null;
    let errorName = '';
    try {
      const shell = await constructShell(morphed, inner, { insertionAxis: AXIS, marginLoop: CROWN_MARGIN.resampledPoints });
      const st = analyzeMesh(shell.mesh);
      built = { watertight: st.watertight, tris: shell.mesh.indices.length / 3 };
    } catch (e) {
      errorName = (e as Error).name;
    }

    console.log(
      `[MORPH→SHELL diagnostic] clean morph: watertight=${morphStats.watertight} clamp=${clamp} sealMax=${µm(sealMaxMm)} maxContactResidual=${µm(maxResMm)} → ` +
        (built ? `constructShell BUILT watertight=${built.watertight} tris=${built.tris} (ROBUSTNESS GAP CLOSED — update the report + this doc)` : `constructShell FAILED: ${errorName}`),
    );

    // CURRENT honest state: a clean synthetic morph→shell coupling FAILS — a
    // real robustness gap independent of scan quality. If `built` is non-null a
    // future improvement closed the gap; that is a WIN — update the docs, do
    // NOT silently relax this into always-passing.
    expect(built, 'clean morph→shell now BUILDS — the coupling robustness gap has CLOSED; update p4-task-12-report.md + this file\'s doc').toBeNull();
    expect(KNOWN_SHELL_ERRORS).toContain(errorName);
  }, 300_000);
});
