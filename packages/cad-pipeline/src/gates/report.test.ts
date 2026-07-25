// packages/cad-pipeline/src/gates/report.test.ts
//
// Phase 4 Task 9 — the QC-REPORT ASSEMBLY + the STANDIN ACCEPTANCE (the task
// headline). Builds a genuine end-to-end synthetic crown (frustum prep die →
// kernel buildInnerSurface intaglio → enclosing outer dome → runShellStage
// watertight solid) and a genuine T6 morph (real measured contact residuals),
// runs the full §6 gate set through `runCrownQc`, and asserts:
//   - STANDIN: ALL gates pass; margin-fit ≤ 10 µm; seating interference ≈ 0;
//     min wall ≥ profile min; watertight + manifold. HARD acceptance.
//   - a deliberately-thin crown → the thickness gate FAILS (blocks).
//   - the acknowledge path (a failed gate acknowledged-with-warning is journaled
//     into the report, never silently flipping passed=true).
//   - determinism (the QcReport is byte-identical across two runs).
//   - the report structure/order golden.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { buildInnerSurface, analyzeMesh, KERNEL_VERSION, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile, PipelineMeshHandle } from '../pipeline/context.ts';
import { runShellStage } from '../stages/shell.ts';
import { runMorphingStage } from '../stages/morphing.ts';
import { runCrownQc, type RunCrownQcInput } from './report.ts';
import type { ContactResidualInput } from './contact.ts';

// --- geometry builders (mirror shell.test.ts / morphing.test.ts) ---
const MARGIN_R = 1.2, TOP_R = 0.8, MARGIN_Z = 0.5, TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];
const TOOTH = 11 as FdiTooth;

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => { P.push(x, y, z); return P.length / 3 - 1; };
  const b: number[] = [], t: number[] = [];
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ)); }
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ)); }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(b[s]!, b[sn]!, t[sn]!); tr.push(b[s]!, t[sn]!, t[s]!); }
  if (capBot) { const bc = push(0, 0, mZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(bc, b[sn]!, b[s]!); } }
  if (capTop) { const tc = push(0, 0, tZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(tc, t[s]!, t[sn]!); } }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}
function marginCircle(r: number, z: number, n: number): { closed: true; resampledPoints: Vec3[] } {
  const resampledPoints: Vec3[] = [];
  for (let i = 0; i < n; i++) { const th = (2 * Math.PI * i) / n; resampledPoints.push([r * Math.cos(th), r * Math.sin(th), z]); }
  return { closed: true, resampledPoints };
}
function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}
function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle { return { contentHash, mesh }; }
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
function cylinderTooth(radius: number, height: number, rings: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) { const z = (height * r) / (rings - 1); for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; positions.push(radius * Math.cos(th), radius * Math.sin(th), z); } }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segments; s++) { const s1 = (s + 1) % segments; const a = r * segments + s, b = r * segments + s1, c = (r + 1) * segments + s, d = (r + 1) * segments + s1; indices.push(a, b, d, a, d, c); }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia', version: '1.1.0',
  restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0 },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0, occlusalMinWallThicknessMm: 0.5, maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5, onlayMinThicknessMm: 0.5, cuspCoverageMinThicknessMm: 0.7, marginExclusionMm: 0.2,
};

// The standin prep die: a closed watertight cone-frustum (bottom rim = margin).
const die = (): IndexedMesh => buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
// An open-cervical enclosing outer dome (offset radially out + up), thick walls.
const outerDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);
// A deliberately-thin outer (occlusal shortened) → sub-0.5 mm wall.
const thinDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + 0.9, 96, true, false);

const MARGIN = marginCircle(MARGIN_R, MARGIN_Z, 240);

let INNER: IndexedMesh | null = null;
async function intaglio(): Promise<IndexedMesh> {
  if (!INNER) {
    INNER = (await buildInnerSurface(die(), { pitchMm: 0.08, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, marginLoop: MARGIN.resampledPoints, insertionAxis: AXIS })).mesh;
  }
  return INNER;
}

function shellContext(): PipelineContext {
  return {
    restorationId: 'qc-accept', restorationType: 'crown', materialProfile: PROFILE, insertionAxis: AXIS,
    targetMesh: handle('die', die()), marginLoops: { [TOOTH]: MARGIN },
    neighbors: {}, antagonist: null, stages: {},
  };
}

/** A genuine T6 morph run (real measured contact residuals — near-zero, no
 * clamp on the clean synthetic scene). */
function realContactResiduals(): { contacts: ContactResidualInput[]; contactClampWarning: boolean } {
  const R = 1.2, H = 5;
  const ctx: PipelineContext = {
    restorationId: 'qc-morph', restorationType: 'crown', materialProfile: PROFILE, insertionAxis: [0, 0, 1],
    targetMesh: handle('die', cylinderTooth(R, H - 1, 6, 16)),
    marginLoops: { [TOOTH]: marginCircle(R, 0, 48) },
    neighbors: {
      [12 as FdiTooth]: handle('nb-12', outwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7])),
      [21 as FdiTooth]: handle('nb-21', outwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7])),
    },
    antagonist: handle('anta', outwardBox([-2, -2, H + 0.1], [2, 2, H + 2])),
    stages: { anatomyPlacement: 'placed-11' },
  };
  const placed = handle('placed-11', cylinderTooth(R, H, 11, 24));
  const result = runMorphingStage(ctx, TOOTH, { placedMesh: placed, hashMesh, morphOptions: { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 } });
  const contacts = (result.params['contacts'] as ContactResidualInput[]).map((c) => ({
    kind: c.kind, targetPenetrationMm: c.targetPenetrationMm, achievedSignedDistanceMm: c.achievedSignedDistanceMm,
    contactResidualMm: c.contactResidualMm, regionResidualMm: c.regionResidualMm, clampBound: c.clampBound,
  }));
  return { contacts, contactClampWarning: result.params['contactClampWarning'] as boolean };
}

async function buildQcInput(outer: IndexedMesh, overrides?: Partial<RunCrownQcInput>): Promise<RunCrownQcInput> {
  const inner = await intaglio();
  const shell = await runShellStage(shellContext(), TOOTH, { outerAnatomyMesh: handle('morph-11', outer), innerSurfaceMesh: handle('inner-11', inner), hashMesh });
  const { contacts, contactClampWarning } = realContactResiduals();
  return {
    crownSolid: shell.mesh!, innerSurfaceMesh: inner, outerSurfaceMesh: outer, dieSolid: die(),
    marginResampledPoints: MARGIN.resampledPoints, insertionAxis: AXIS,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm, occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.anteriorMm2,
    contacts, contactClampWarning,
    kernelVersion: KERNEL_VERSION, profileVersion: PROFILE.version, journalHash: 'journal-hash-fixed',
    ...overrides,
  };
}

const GATE_ORDER = ['watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seating', 'connectorCrossSection', 'contact'];

describe('runCrownQc — STANDIN ACCEPTANCE (all gates pass)', () => {
  it('a genuine end-to-end synthetic crown passes EVERY gate', async () => {
    const input = await buildQcInput(outerDome(1.0));
    const report = await runCrownQc(input);

    for (const g of report.gates) console.log(`[QC ACCEPT standin] ${g.gate}: passed=${g.passed} value=${g.value} threshold=${g.threshold} ${g.unit ?? ''} | ${g.message}`);

    // Structure / order golden.
    expect(report.gates.map((g) => g.gate)).toEqual(GATE_ORDER);
    expect(report.kernelVersion).toBe(KERNEL_VERSION);
    expect(report.profileVersion).toBe('1.1.0');

    // HARD acceptance: every gate passed; report passed.
    for (const g of report.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(report.passed).toBe(true);

    const byName = Object.fromEntries(report.gates.map((g) => [g.gate, g]));
    // watertight + manifold.
    expect(byName['watertight']!.passed).toBe(true);
    expect(byName['manifold']!.passed).toBe(true);
    expect(analyzeMesh(input.crownSolid).watertight).toBe(true);
    // margin fit ≤ 10 µm.
    expect(byName['marginFit']!.value! * 1000).toBeLessThanOrEqual(10);
    // seating interference ≈ 0: only the marginal-seal / Float32 noise sliver,
    // below the documented noise-floor tolerance (NOT wall penetration).
    expect(byName['seating']!.value!).toBeLessThanOrEqual(byName['seating']!.threshold!);
    expect(byName['seating']!.value!).toBeLessThan(1e-7);
    // min wall ≥ 0.5 mm.
    expect(byName['minWallThickness']!.value! + 0).toBeGreaterThanOrEqual(0.5);
    // contact achieved (no clamp) on the clean morph.
    expect(byName['contact']!.passed).toBe(true);
    // connector N/A stub.
    expect(byName['connectorCrossSection']!.value).toBeNull();
  }, 180000);
});

describe('runCrownQc — deliberately-thin crown BLOCKS on thickness', () => {
  it('the thickness gate FAILS and the report is blocked', async () => {
    const input = await buildQcInput(thinDome(0.3));
    const report = await runCrownQc(input);
    const thickness = report.gates.find((g) => g.gate === 'minWallThickness')!;
    console.log(`[QC thin] minWallThickness: passed=${thickness.passed} value=${thickness.value} | ${thickness.message}`);
    expect(thickness.passed).toBe(false);
    expect(thickness.value! + 0).toBeLessThan(0.5);
    expect(report.passed).toBe(false);
  }, 180000);
});

describe('runCrownQc — acknowledge-with-warning (journaled, never silent)', () => {
  it('a failed gate acknowledged is acknowledged=true but its passed stays false; report can pass', async () => {
    const input = await buildQcInput(thinDome(0.3), { acknowledgedGates: ['minWallThickness'] });
    const report = await runCrownQc(input);
    const thickness = report.gates.find((g) => g.gate === 'minWallThickness')!;
    // The gate itself NEVER silently flips to passed=true.
    expect(thickness.passed).toBe(false);
    expect(thickness.acknowledged).toBe(true);
    // The overall report may pass via the explicit, journaled acknowledgment.
    expect(report.passed).toBe(true);
    // A passing gate is never marked acknowledged.
    expect(report.gates.find((g) => g.gate === 'watertight')!.acknowledged).toBe(false);
  }, 180000);
});

describe('runCrownQc — determinism (hash-stable, no timestamp)', () => {
  it('two runs produce a byte-identical QcReport', async () => {
    const input = await buildQcInput(outerDome(1.0));
    const a = await runCrownQc(input);
    const b = await runCrownQc(input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // The report carries no timestamp (it is version/journal-addressed).
    expect(Object.keys(a)).not.toContain('timestamp');
  }, 180000);
});
