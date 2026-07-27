// packages/cad-pipeline/src/gates/bridgeReport.test.ts
//
// Phase 6 Task 6 — runBridgeQc INPUT GUARDS. The full whole-bridge acceptance
// (all gates pass on the 3-unit + the three falsifiable blocks + margin survival)
// is test/golden/bridge-acceptance.test.ts (it needs the kernel assembly fixture);
// these cover the typed input guards with minimal inline solids.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import { runBridgeQc, BridgeQcInputError, type BridgeUnitQcInput, type RunBridgeQcInput } from './bridgeReport.ts';

/** A watertight box centred at (cx,0,0), half-extents (hx,h,h). */
function box(cx: number, hx: number, h: number): IndexedMesh {
  const x0 = cx - hx, x1 = cx + hx, y0 = -h, y1 = h, z0 = -h, z1 = h;
  const positions = new Float64Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

const AXIS: Vec3 = [0, 0, 1];
const LOOP: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];

function baseInput(overrides: Partial<RunBridgeQcInput> = {}): RunBridgeQcInput {
  return {
    assembledSolid: box(0, 2, 2),
    units: [{ label: '14', kind: 'abutment', innerSurfaceMesh: box(0, 1, 1), outerSurfaceMesh: box(0, 1.5, 1.5), insertionAxis: AXIS, marginLoop: LOOP, fitRegion: { axisPointMm: [0, 0, 0], axis: AXIS, maxRadialMm: 1.1, minAxialMm: -0.05, maxAxialMm: 2.05 } }],
    dieSolids: [box(0, 0.5, 0.5)],
    connectors: [],
    minWallThicknessMm: 0.5,
    occlusalMinWallThicknessMm: 0.5,
    connectorAreaTargetMm2: 9,
    ponticRelief: { maxAbsDeviationMm: 0.0001, style: 'hygienic', configuredReliefMm: 2.0 },
    kernelVersion: '0.26.0',
    profileVersion: '1.4.0',
    journalHash: 'guard-test',
    ...overrides,
  };
}

describe('runBridgeQc — input guards', () => {
  it('throws BridgeQcInputError when no units are supplied', async () => {
    await expect(runBridgeQc(baseInput({ units: [] }))).rejects.toBeInstanceOf(BridgeQcInputError);
  });

  it('throws BridgeQcInputError when no dies are supplied', async () => {
    await expect(runBridgeQc(baseInput({ dieSolids: [] }))).rejects.toBeInstanceOf(BridgeQcInputError);
  });

  it('throws BridgeQcInputError when an abutment has no fitRegion', async () => {
    const unit: BridgeUnitQcInput = { label: '14', kind: 'abutment', innerSurfaceMesh: box(0, 1, 1), outerSurfaceMesh: box(0, 1.5, 1.5), insertionAxis: AXIS, marginLoop: LOOP };
    await expect(runBridgeQc(baseInput({ units: [unit] }))).rejects.toBeInstanceOf(BridgeQcInputError);
  });
});
