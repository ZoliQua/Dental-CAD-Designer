// test/golden/inlay-shell-acceptance.test.ts
//
// Phase 5 Task 6 ACCEPTANCE (the phase's "MOD inlay passes QC; seating clean;
// shallow-cavity thickness BLOCKS"): the FULL, genuinely-coupled inlay chain on
// the canonical analytic MOD cavity — fit surface (T3) + occlusal patch (T4) +
// adapted proximal faces (T5), welded into the shell (T6), then `runInlayQc`
// over the assembled solid. No decoupled stand-ins: the patch that is measured
// is the patch that is welded is the patch that seats.
//
// This is the cross-package home (imports the kernel's own modCavityMesh test
// fixture AND cad-pipeline's runInlayQc — a combination that sits outside any
// single package's rootDir). Task 10 layers the journal record→replay
// reproducibility harness on top of this same coupled chain.
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { Vec3 } from '@dqcad/shared-types';
import {
  buildCavityInnerSurface,
  buildOcclusalPatch,
  adaptProximalContacts,
  constructInlayShell,
  measureSeamDihedral,
  KERNEL_VERSION,
  type IndexedMesh,
  type ProximalAdaptationInput,
  type ProximalFaceBoundary,
} from '@dqcad/kernel';
import type { QcReport } from '@dqcad/shared-types';
import { runInlayQc, marginFitGate, type ContactResidualInput, type RunInlayQcInput } from '@dqcad/cad-pipeline';
import { modCavityMesh } from '../../packages/kernel/src/cavity/cavity.test-fixtures.ts';

const AXIS: Vec3 = [0, 0, 1];
const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const PITCH = 0.06;
const PEN = 0.02;
const INLAY_MIN = 1.0; // e.max IFU inlay isthmus/occlusal minimum
// The cavity min-wall MARGINAL-TRANSITION band (mm). An inlay closes along its
// ENTIRE cavity outline (not a single cervical margin like a crown), so the
// fit-surface↔occlusal-patch CONVERGENCE WEDGE — the restoration feathering to
// the cavosurface margin (the marginal-seal region, governed by marginFit) —
// wraps the whole perimeter. The min-wall gate excludes this band so it measures
// the STRUCTURAL isthmus/floor bulk, not the marginal wedge (exactly the crown's
// marginExclusion role, sized for the cavity's larger convergence zone: ~one
// restoration-thickness, vs the crown's 0.2 mm finish-line feather). See the
// report's reviewer-attention item — a butt-margin occlusal patch (T4) would let
// a smaller band suffice.
const MARGIN_EXCL = 1.3;
const µm = (mm: number): string => `${(mm * 1000).toFixed(2)} µm`;

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
function faceOnSide(faces: readonly ProximalFaceBoundary[], sign: -1 | 1): ProximalFaceBoundary {
  const f = faces.find((face) => Math.sign(face.columnPoints[0]![0]) === sign);
  if (!f) throw new Error(`no proximal face on side ${sign}`);
  return f;
}
function hashReport(r: QcReport): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}

interface BuiltInlay {
  fitMesh: IndexedMesh;
  patchMesh: IndexedMesh;
  shellMesh: IndexedMesh;
  toothMesh: IndexedMesh;
  outline: Vec3[];
  seamEdges: RunInlayQcInput['seamEdges'];
  cavityTriangleIndices: Uint32Array;
  contacts: ContactResidualInput[];
  contactClampWarning: boolean;
}

async function buildInlay(opts: Parameters<typeof modCavityMesh>[0] = {}): Promise<BuiltInlay> {
  const fx = modCavityMesh(opts);
  const halfLen = fx.lengthMm / 2;
  const fit = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: PITCH, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
  const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
  const gap = 0.1;
  const adaptations: ProximalAdaptationInput[] = [
    {
      label: 'mesial',
      columnPoints: faceOnSide(patch.proximalFaces, -1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, -1).freeRunPoints,
      neighborMesh: outwardBox([-halfLen - gap - 2, -6, -1], [-halfLen - gap, 6, 12]),
      targetPenetrationMm: PEN,
    },
    {
      label: 'distal',
      columnPoints: faceOnSide(patch.proximalFaces, 1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, 1).freeRunPoints,
      neighborMesh: outwardBox([halfLen + gap, -6, -1], [halfLen + gap + 2, 6, 12]),
      targetPenetrationMm: PEN,
    },
  ];
  const adapted = adaptProximalContacts(patch.mesh, adaptations);
  const shell = await constructInlayShell(fit.mesh, adapted.mesh);
  const contacts: ContactResidualInput[] = adapted.boxes.map((b) => ({
    kind: b.label === 'mesial' ? 'proximalMesial' : 'proximalDistal',
    targetPenetrationMm: b.targetPenetrationMm,
    achievedSignedDistanceMm: b.achievedSignedDistanceMm,
    contactResidualMm: b.contactResidualMm,
    regionResidualMm: b.faceResidualMm,
    clampBound: b.clampBound,
  }));
  return {
    fitMesh: fit.mesh,
    patchMesh: adapted.mesh,
    shellMesh: shell.mesh,
    toothMesh: fx.mesh,
    outline: fx.cavityOutline,
    seamEdges: patch.seamEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    contacts,
    contactClampWarning: adapted.clampedBoxes.length > 0,
  };
}

function qcInput(b: BuiltInlay, over: Partial<RunInlayQcInput> = {}): RunInlayQcInput {
  return {
    inlaySolid: b.shellMesh,
    fitSurfaceMesh: b.fitMesh,
    patchMesh: b.patchMesh,
    toothWithCavitySolid: b.toothMesh,
    cavityOutlineResampledPoints: b.outline,
    insertionAxis: AXIS,
    restorationType: 'inlay',
    thicknessMinimums: { inlayMinThicknessMm: INLAY_MIN, onlayMinThicknessMm: INLAY_MIN },
    marginExclusionMm: MARGIN_EXCL,
    seamEdges: b.seamEdges,
    cavityTriangleIndices: b.cavityTriangleIndices,
    contacts: b.contacts,
    contactClampWarning: b.contactClampWarning,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.0.0',
    journalHash: 'inlay-acceptance',
    ...over,
  };
}

describe('inlay shell + QC acceptance — MOD fixture (all gates pass; seating clean)', () => {
  let built: BuiltInlay;
  let report: QcReport;

  beforeAll(async () => {
    built = await buildInlay();
    report = await runInlayQc(qcInput(built));
    for (const g of report.gates) {
      console.log(`[INLAY ACCEPT] ${g.gate}: passed=${g.passed} value=${g.value} threshold=${g.threshold} ${g.unit ?? ''} | ${g.message}`);
    }
  }, 120_000);

  it('runs the full inlay gate set in order', () => {
    expect(report.gates.map((g) => g.gate)).toEqual([
      'watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seamDihedral', 'seating', 'contact',
    ]);
    expect(report.kernelVersion).toBe(KERNEL_VERSION);
  });

  it('EVERY gate passes and the report is passed=true', () => {
    for (const g of report.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('min wall ≥ the INLAY minimum (1.0 mm), MEASURED', () => {
    const thick = report.gates.find((g) => g.gate === 'minWallThickness')!;
    expect(thick.threshold).toBe(INLAY_MIN);
    expect(thick.value as number).toBeGreaterThanOrEqual(INLAY_MIN);
  });

  it('seating penetration ≤ interference tolerance (≈ 0, MEASURED)', () => {
    const seating = report.gates.find((g) => g.gate === 'seating')!;
    console.log(`[INLAY ACCEPT seating] interference=${(seating.value as number).toExponential(3)} mm³ ≤ ${(seating.threshold as number).toExponential(1)} mm³`);
    expect(seating.value as number).toBeLessThanOrEqual(seating.threshold as number);
    expect(seating.value as number).toBeLessThan(1e-6);
  });

  it('marginFit ≤ 10 µm + seamDihedral < 5° SURVIVE assembly (before/after byte-identical)', () => {
    const marginBefore = marginFitGate({ innerSurfaceMesh: built.fitMesh, marginResampledPoints: built.outline });
    const seamBefore = measureSeamDihedral(built.patchMesh, built.toothMesh, built.seamEdges, {
      excludeToothTriangles: new Set(built.cavityTriangleIndices),
    });
    const marginAfter = report.gates.find((g) => g.gate === 'marginFit')!;
    const seamAfter = report.gates.find((g) => g.gate === 'seamDihedral')!;
    console.log(
      `[INLAY ACCEPT survive-assembly] marginFit before=${µm(marginBefore.value as number)} after=${µm(marginAfter.value as number)} | ` +
        `seamDihedral before=${seamBefore.maxDeg.toFixed(4)}° after=${(seamAfter.value as number).toFixed(4)}°`,
    );
    expect(marginAfter.value as number).toBeLessThanOrEqual(0.010);
    expect(seamAfter.value as number).toBeLessThan(5);
    expect(marginAfter.value).toBe(marginBefore.value);
    expect(seamAfter.value).toBe(seamBefore.maxDeg);
  });

  it('is deterministic + hash-stable (two runs → identical report hash)', async () => {
    const again = await runInlayQc(qcInput(built));
    expect(hashReport(again)).toBe(hashReport(report));
  }, 120_000);
});

describe('inlay shell + QC — deliberately-SHALLOW cavity BLOCKS on thickness (gate NOT weakened)', () => {
  it('the min-wall gate FAILS with the inlay minimum and the report is blocked', async () => {
    // Shallow isthmus (0.4 mm deep) + shallow boxes → the STRUCTURAL bulk (not
    // just the marginal wedge) is far below 1.0 mm, so it blocks even with the
    // 1.3 mm transition band excluded.
    const thin = await buildInlay({ isthmusDepthMm: 0.4, boxDepthMm: 0.9 });
    const report = await runInlayQc(qcInput(thin));
    const thick = report.gates.find((g) => g.gate === 'minWallThickness')!;
    console.log(`[INLAY ACCEPT shallow] minWallThickness passed=${thick.passed} value=${µm(thick.value as number)} (min ${INLAY_MIN * 1000}µm) | report.passed=${report.passed}`);
    expect(thick.threshold).toBe(INLAY_MIN);
    expect(thick.passed).toBe(false);
    expect(thick.value as number).toBeLessThan(INLAY_MIN);
    expect(report.passed).toBe(false);
  }, 120_000);
});
