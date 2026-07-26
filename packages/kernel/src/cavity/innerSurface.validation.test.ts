// packages/kernel/src/cavity/innerSurface.validation.test.ts
//
// Fast guard/validation + progress/cancel-hook coverage for
// `buildCavityInnerSurface` (the heavy geometry is in innerSurface.analytic.test.ts).
// The validation cases throw BEFORE any heavy work, so they are instant.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { PitchTooSmallError } from '../offset/marchingCubes.ts';
import { BlendWidthTooNarrowError } from '../offset/innerSurfaceOffset.ts';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import { buildCavityInnerSurface } from './innerSurface.ts';

const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const AXIS: Vec3 = [0, 0, 1];
const OUTLINE: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
const dummyMesh = { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) };

describe('buildCavityInnerSurface — validation guards (throw before heavy work)', () => {
  it.each([
    { name: 'pitch = 0', params: { ...GAP, pitchMm: 0, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: TypeError },
    { name: 'pitch below MIN', params: { ...GAP, pitchMm: 1e-6, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: PitchTooSmallError },
    { name: 'marginalGap negative', params: { ...GAP, marginalGapMm: -0.01, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: TypeError },
    { name: 'cementGap NaN', params: { ...GAP, cementGapMm: NaN, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: TypeError },
    { name: 'spacerStart 0', params: { ...GAP, spacerStartMm: 0, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: TypeError },
    { name: 'blendWidth 0', params: { ...GAP, blendWidthMm: 0, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: TypeError },
    { name: 'blend too narrow for gap step', params: { ...GAP, blendWidthMm: 0.01, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: AXIS }, err: BlendWidthTooNarrowError },
    { name: 'outline < 3 points', params: { ...GAP, pitchMm: 0.1, cavityOutline: [[0, 0, 0], [1, 0, 0]] as Vec3[], insertionAxis: AXIS }, err: TypeError },
    { name: 'zero-length axis', params: { ...GAP, pitchMm: 0.1, cavityOutline: OUTLINE, insertionAxis: [0, 0, 0] as Vec3 }, err: TypeError },
  ])('rejects $name', async ({ params, err }) => {
    await expect(buildCavityInnerSurface(dummyMesh, params)).rejects.toBeInstanceOf(err);
  });
});

describe('buildCavityInnerSurface — progress/cancel hooks', () => {
  it('reports monotone progress ending at 1 (hooks change no computed value)', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh();
    const progress: number[] = [];
    const withHooks = await buildCavityInnerSurface(
      fx.mesh,
      { ...GAP, pitchMm: 0.14, cavityOutline: fx.cavityOutline, insertionAxis: AXIS },
      { onProgress: (f) => progress.push(f), checkCancel: async () => {} },
    );
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    // Byte-identical to a no-hooks call (hooks don't change the math).
    const noHooks = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: 0.14, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
    expect(withHooks.patchTriangleCount).toBe(noHooks.patchTriangleCount);
    expect(withHooks.skirtTriangleCount).toBe(noHooks.skirtTriangleCount);
  });

  it('checkCancel throwing mid-field-grid propagates (cooperative cancellation)', { timeout: 120_000 }, async () => {
    const fx = modCavityMesh();
    class Cancelled extends Error {}
    let calls = 0;
    await expect(
      buildCavityInnerSurface(
        fx.mesh,
        { ...GAP, pitchMm: 0.14, cavityOutline: fx.cavityOutline, insertionAxis: AXIS },
        { checkCancel: async () => { if (++calls > 2) throw new Cancelled('stop'); } },
      ),
    ).rejects.toBeInstanceOf(Cancelled);
  });
});
