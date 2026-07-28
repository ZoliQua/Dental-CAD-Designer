// test/golden/bridge-acceptance.test.ts
//
// Phase 6 Task 6 — THE ACCEPTANCE: the 3-unit posterior fixture bridge is
// ASSEMBLED into one watertight solid and passes ALL whole-bridge QC gates; the
// three falsifiable blocks (5 mm² connector / thin unit / mis-configured relief)
// each fail their gate; the abutment margin fit SURVIVES the union ≤ 10 µm
// (before/after REPORTED); the whole bridge seats cleanly; the QcReport is
// deterministic (byte-identical across runs).
//
// This lives in test/ (not a package) so it can import the kernel assembly
// FIXTURE (relative) AND @dqcad/cad-pipeline's `runBridgeQc` — the crown/cavity/
// inlay-shell-acceptance precedent.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assembleBridge,
  buildBvh,
  computePseudonormals,
  shapePonticBase,
  measurePonticRelief,
  KERNEL_VERSION,
  type RidgeCrestCylinder,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type PonticBaseSample,
  type IndexedMesh,
} from '@dqcad/kernel';
import {
  runBridgeQc,
  measureMarginFit,
  connectorPositionalTargetMm2,
  type ConnectorCrossSection,
  type BridgeUnitQcInput,
  type RunBridgeQcInput,
} from '@dqcad/cad-pipeline';
import type { QcReport, FdiTooth } from '@dqcad/shared-types';
import { bridgeAssemblyFixture, type BridgeAssemblyFixture } from '../../packages/kernel/src/bridge/bridgeAssembly.test-fixtures.ts';
import { bridgeFixture } from '../../packages/kernel/src/bridge/bridge.test-fixtures.ts';

const µm = (mm: number): string => `${(mm * 1000).toFixed(3)} µm`;

// --- Profile thresholds (zirconia; the live-UI bridge default) ---
const PROFILE = {
  version: '1.4.0',
  minWallThicknessMm: 0.5,
  occlusalMinWallThicknessMm: 0.5,
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
} as const;

// --- The pontic relief measurement (Task 3 instrument on a fine ridge) ---
const RIDGE = { ridgeCrestRadiusMm: 3, ridgeCrestCenterZMm: 1, ridgeHalfLengthMm: 5, ridgeCrestSegments: 160, ridgeStations: 16 } as const;
const FOOTPRINT: PonticBaseFootprint = { stationMinMm: -4, stationMaxMm: 4, angularHalfSpanRad: (60 * Math.PI) / 180 };
const RES: PonticBaseResolution = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };
function fixtureCrest(): RidgeCrestCylinder {
  return { axisPointMm: [0, 0, RIDGE.ridgeCrestCenterZMm], mesialDistalDir: [1, 0, 0], buccalDir: [0, 1, 0], upDir: [0, 0, 1], radiusMm: RIDGE.ridgeCrestRadiusMm };
}
/** A REAL hygienic-pontic relief measurement — worst |measured − configured|. */
function measureHygienicRelief(configuredMm: number, builtAtMm: number = configuredMm): number {
  const fx = bridgeFixture(RIDGE);
  const gingiva = fx.ridge.mesh;
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  const crest = fixtureCrest();
  const shaped = shapePonticBase(crest, 'hygienic', { clearanceMm: builtAtMm }, FOOTPRINT, RES);
  const samples: PonticBaseSample[] = builtAtMm === configuredMm ? [...shaped.samples] : shaped.samples.map((s) => ({ ...s, targetMm: configuredMm }));
  return measurePonticRelief(gingiva, bvh, pn, samples, crest).primary.maxAbsDeviationMm;
}

function hashReport(r: QcReport): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}

interface BuiltCase {
  fx: BridgeAssemblyFixture;
  assembled: IndexedMesh;
  input: RunBridgeQcInput;
}

/** Assemble a bridge case + build its `runBridgeQc` input. */
async function buildCase(
  fixtureOpts: Parameters<typeof bridgeAssemblyFixture>[0] = {},
  overrides: { ponticReliefMm?: number; ponticBuiltAtMm?: number; frameworkMode?: boolean } = {},
): Promise<BuiltCase> {
  const fx = bridgeAssemblyFixture(fixtureOpts);
  const result = await assembleBridge(fx.solids);
  const assembled = result.solid;

  const units: BridgeUnitQcInput[] = fx.units.map((u) => ({
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: u.innerSurfaceMesh,
    outerSurfaceMesh: u.outerSurfaceMesh,
    insertionAxis: u.insertionAxis,
    marginLoop: u.marginLoop,
    fitRegion: u.kind === 'abutment' ? u.fitRegion : undefined,
  }));
  const dieSolids = fx.units.filter((u) => u.die).map((u) => u.die!);
  const connectors: ConnectorCrossSection[] = fx.connectors.map((c) => {
    const teeth: [FdiTooth, FdiTooth] = [c.teeth[0] as FdiTooth, c.teeth[1] as FdiTooth];
    return {
      label: c.label,
      minAreaMm2: c.minAreaMm2,
      teeth,
      targetMm2: connectorPositionalTargetMm2(teeth[0], teeth[1], PROFILE.connectorAreaMm2),
    };
  });
  const configured = overrides.ponticReliefMm ?? PROFILE.ponticHygienicClearanceMm;
  const maxAbsDeviationMm = measureHygienicRelief(configured, overrides.ponticBuiltAtMm ?? configured);

  const input: RunBridgeQcInput = {
    assembledSolid: assembled,
    units,
    dieSolids,
    connectors,
    minWallThicknessMm: PROFILE.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.posteriorMm2,
    frameworkMode: overrides.frameworkMode,
    frameworkMinThicknessMm: PROFILE.frameworkMinThicknessMm,
    ponticRelief: { maxAbsDeviationMm, style: 'hygienic', configuredReliefMm: configured },
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: 'bridge-acceptance-fixture',
  };
  return { fx, assembled, input };
}

describe('Phase 6 acceptance — the 3-unit posterior bridge passes ALL gates', () => {
  it('assembles ONE watertight solid and EVERY gate passes (the acceptance table)', async () => {
    const { input } = await buildCase();
    const report = await runBridgeQc(input);

    const table = report.gates
      .map((g) => `  ${g.passed ? '✓' : '✗'} ${g.gate.padEnd(22)} value=${g.value === null ? 'N/A' : g.value.toExponential(3)} thr=${g.threshold} — ${g.message}`)
      .join('\n');
    console.log(`[bridge][ACCEPTANCE TABLE] kernel ${KERNEL_VERSION}\n${table}`);

    for (const g of report.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(report.passed).toBe(true);
    // The expected gate set is present (per-unit thickness, per-abutment margin fit).
    const names = report.gates.map((g) => g.gate);
    expect(names).toEqual([
      'watertight',
      'manifold',
      'selfIntersection',
      'minWallThickness:14',
      'minWallThickness:15',
      'minWallThickness:16',
      'connectorCrossSection',
      'marginFit:14',
      'marginFit:16',
      'ponticRelief',
      'seating',
    ]);
  });

  it('FALSIFIABLE #1 — a 5 mm² posterior connector BLOCKS (connectorCrossSection)', async () => {
    const { input } = await buildCase({ connectorSemiAxisMm: 1.2633 }); // ~5 mm²
    const report = await runBridgeQc(input);
    const g = report.gates.find((x) => x.gate === 'connectorCrossSection')!;
    console.log(`[bridge][BLOCK #1] 5 mm² connector → ${g.passed ? 'PASS' : 'BLOCK'}: ${g.message}`);
    expect(g.value).toBeLessThan(9);
    expect(g.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('FALSIFIABLE #2 — a thin unit (wall < min) BLOCKS (minWallThickness:15)', async () => {
    const { input } = await buildCase({ thinPonticInnerRadiusMm: 2.6 }); // wall 0.4 mm < 0.5
    const report = await runBridgeQc(input);
    const g = report.gates.find((x) => x.gate === 'minWallThickness:15')!;
    console.log(`[bridge][BLOCK #2] thin pontic wall → ${g.passed ? 'PASS' : 'BLOCK'}: ${g.message}`);
    expect(g.passed).toBe(false);
    expect(report.passed).toBe(false);
    // the abutments (r=1, wall 2 mm) still pass — the block is localized
    expect(report.gates.find((x) => x.gate === 'minWallThickness:14')!.passed).toBe(true);
    expect(report.gates.find((x) => x.gate === 'minWallThickness:16')!.passed).toBe(true);
  });

  it('FALSIFIABLE #3 — a mis-configured pontic relief BLOCKS (ponticRelief)', async () => {
    // Base built at 1.0 mm, judged against the configured 2.0 mm → ~1000 µm ≫ 20 µm.
    const { input } = await buildCase({}, { ponticReliefMm: 2.0, ponticBuiltAtMm: 1.0 });
    const report = await runBridgeQc(input);
    const g = report.gates.find((x) => x.gate === 'ponticRelief')!;
    console.log(`[bridge][BLOCK #3] mis-configured relief → ${g.passed ? 'PASS' : 'BLOCK'}: ${g.message}`);
    expect(g.value!).toBeGreaterThan(0.02);
    expect(g.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});

describe('Phase 6 — margin fit SURVIVES the union ≤ 10 µm (before/after REPORTED)', () => {
  it('re-measures each abutment margin fit on the ASSEMBLED solid and reports the delta vs the pre-union surface', async () => {
    const { fx, input } = await buildCase();
    const report = await runBridgeQc(input);
    for (const unit of fx.units.filter((u) => u.kind === 'abutment')) {
      // BEFORE — the pre-union intaglio submesh (exact Float64).
      const before = measureMarginFit(unit.innerSurfaceMesh, unit.marginLoop).maxMm;
      // AFTER — the gate's value on the assembled-solid extracted patch.
      const g = report.gates.find((x) => x.gate === `marginFit:${unit.label}`)!;
      const after = g.value!;
      console.log(`[bridge][margin survival] unit ${unit.label}: before ${µm(before)} → after ${µm(after)} (Δ ${µm(Math.abs(after - before))})`);
      expect(before).toBeLessThanOrEqual(0.010);
      expect(after).toBeLessThanOrEqual(0.010); // survives the WASM Float32 boundary
      expect(g.passed).toBe(true);
    }
  });
});

describe('Phase 6 — whole-bridge seating + determinism', () => {
  it('the whole bridge seats cleanly on both dies (seating passes, interference ≤ noise floor)', async () => {
    const { input } = await buildCase();
    const report = await runBridgeQc(input);
    const g = report.gates.find((x) => x.gate === 'seating')!;
    console.log(`[bridge][seating] ${g.message}`);
    expect(g.passed).toBe(true);
  });

  it('the QcReport is deterministic — byte-identical across two runs (kernel + gates)', async () => {
    const a = await buildCase();
    const b = await buildCase();
    const ra = await runBridgeQc(a.input);
    const rb = await runBridgeQc(b.input);
    expect(hashReport(ra)).toBe(hashReport(rb));
    // the report is version/journalHash-addressed — carries NO timestamp field
    expect(Object.keys(ra)).not.toContain('timestamp');
    expect(ra.journalHash).toBe('bridge-acceptance-fixture');
  });

  it('framework mode still passes on the default units (mode-aware thickness gate)', async () => {
    const { input } = await buildCase({}, { frameworkMode: true });
    const report = await runBridgeQc(input);
    for (const g of report.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(report.passed).toBe(true);
  });
});
