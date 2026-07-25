// placeAnatomy job tests (Phase 4 Task 5) — the fast transform-solve worker
// job. Exercised by calling the handler directly with a noop JobContext (it is
// a pure transform solve — no BVH/SDF cache, no progress slices — so the real
// Comlink transport adds nothing the kernel's own anatomy/placement.test.ts and
// registry wiring don't already cover). Proves the payload→kernel wiring, the
// manual-override path, determinism (byte-identical transform + placed mesh),
// and the cancel/unknown-landmark guards.
import { describe, expect, it } from 'vitest';
import { applyMat4ToPoint, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { placeAnatomyJob, UnknownLandmarkError, type PlaceAnatomyPayload } from './jobs/placeAnatomy.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };

function boxPositions(min: Vec3, max: Vec3): Float64Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return new Float64Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
}
const BOX_INDICES = Uint32Array.from([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
]);

function marginCircleFlat(c: Vec3, r: number, n = 64): Float64Array {
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    flat.push(c[0] + r * Math.cos(th), c[1] + r * Math.sin(th), c[2]);
  }
  return new Float64Array(flat);
}

function basePayload(overrides?: Partial<PlaceAnatomyPayload>): PlaceAnatomyPayload {
  return {
    canonicalFrame: {
      origin: [0, 0, 0],
      mesialDistal: [1, 0, 0],
      buccoLingual: [0, 1, 0],
      occlusoGingival: [0, 0, 1],
    },
    libraryPositions: boxPositions([-1, -1, 0], [1, 1, 4]),
    libraryIndices: BOX_INDICES.slice(),
    marginLoop: marginCircleFlat([0, 0, 0], 1.5),
    insertionAxis: [0, 0, 1],
    mesialNeighborPositions: boxPositions([-4, -1, 0], [-2, 1, 3]),
    distalNeighborPositions: boxPositions([2, -1, 0], [4, 1, 3]),
    antagonistPositions: boxPositions([-0.75, -0.75, 8], [0.75, 0.75, 10]),
    landmarks: { incisalEdge: [0, 0, 4] },
    ...overrides,
  };
}

describe('placeAnatomyJob', () => {
  it('solves the auto-placement and returns the placed mesh + transform + measurements', async () => {
    const r = await placeAnatomyJob(basePayload(), NOOP_CTX);
    expect(r.transform.length).toBe(16);
    expect(r.positions.length).toBe(basePayload().libraryPositions.length);
    expect(r.occlusoGingival).toEqual([0, 0, 1]);
    expect(r.scaleMesialDistal).toBeCloseTo(2, 9);
    expect(r.targetMesialDistalWidthMm).toBeCloseTo(4, 9);
    expect(r.antagonistUsed).toBe(true);
    expect(r.targetOcclusoGingivalHeightMm!).toBeCloseTo(8, 9);
  });

  it('antagonist-absent fallback reuses the M-D scale', async () => {
    const r = await placeAnatomyJob(basePayload({ antagonistPositions: null }), NOOP_CTX);
    expect(r.antagonistUsed).toBe(false);
    expect(r.targetOcclusoGingivalHeightMm).toBeNull();
    expect(r.scaleOcclusoGingival).toBeCloseTo(r.scaleMesialDistal, 12);
  });

  it('is deterministic (byte-identical transform + placed positions across runs)', async () => {
    const a = await placeAnatomyJob(basePayload(), NOOP_CTX);
    const b = await placeAnatomyJob(basePayload(), NOOP_CTX);
    expect(b.transform).toEqual(a.transform);
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });

  it('manual landmark handle lands the landmark on target', async () => {
    const target: Vec3 = [2, -3, 30];
    const r = await placeAnatomyJob(
      basePayload({ manualOverride: { landmarkHandle: { landmark: 'incisalEdge', targetMm: target } } }),
      NOOP_CTX,
    );
    const landed = applyMat4ToPoint(r.transform, [0, 0, 4]);
    expect(landed[0]).toBeCloseTo(target[0], 6);
    expect(landed[1]).toBeCloseTo(target[1], 6);
    expect(landed[2]).toBeCloseTo(target[2], 6);
  });

  it('throws UnknownLandmarkError for an unknown handle landmark', async () => {
    await expect(
      placeAnatomyJob(basePayload({ manualOverride: { landmarkHandle: { landmark: 'nope', targetMm: [0, 0, 0] } } }), NOOP_CTX),
    ).rejects.toBeInstanceOf(UnknownLandmarkError);
  });

  it('throws JobCancelledError when cancelled', async () => {
    await expect(
      placeAnatomyJob(basePayload(), { progress: () => {}, cancelled: () => true }),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });
});
