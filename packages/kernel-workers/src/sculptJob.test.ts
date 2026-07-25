// applySculptStroke job test (Phase 4 Task 8) — the freeform-sculpt worker job.
// The kernel's sculpt.test.ts covers the brush geometry; here we prove the
// payload→kernel wiring, byte-identity with a direct computeShellLock +
// applySculptGesture call, the lock counts, progress/cancel, and the unlock path.
import { createHash } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  applySculptGesture,
  buildInnerSurface,
  computeShellLock,
  constructShell,
  type IndexedMesh,
  type SculptStroke,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { applySculptStrokeJob } from './jobs/sculpt.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };
const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, vLevels: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const rings: number[][] = [];
  for (let l = 0; l <= vLevels; l++) {
    const f = l / vLevels;
    const r = mR + (tR - mR) * f;
    const z = mZ + (tZ - mZ) * f;
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) {
      const th = (2 * Math.PI * s) / seg;
      ring.push(push(r * Math.cos(th), r * Math.sin(th), z));
    }
    rings.push(ring);
  }
  const tr: number[] = [];
  for (let l = 0; l < vLevels; l++) {
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(rings[l]![s]!, rings[l]![sn]!, rings[l + 1]![sn]!);
      tr.push(rings[l]![s]!, rings[l + 1]![sn]!, rings[l + 1]![s]!);
    }
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, rings[0]![sn]!, rings[0]![s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, rings[vLevels]![s]!, rings[vLevels]![sn]!);
    }
  }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}
function marginFlat(r: number, z: number, n: number): Float64Array {
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    flat.push(r * Math.cos(th), r * Math.sin(th), z);
  }
  return new Float64Array(flat);
}
function marginLoopVec(r: number, z: number, n: number): Vec3[] {
  const l: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    l.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return l;
}
function hash(pos: Float64Array, idx: Uint32Array): string {
  const h = createHash('sha256');
  h.update(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
  h.update(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  return h.digest('hex');
}

let INNER: IndexedMesh;
let SHELL: IndexedMesh;
const GESTURE: SculptStroke[] = [
  { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.2, strength: 0.2, brush: 'add' },
  { center: [TOP_R + 0.7, 0, TOP_Z], radiusMm: 1.0, strength: 0.15, brush: 'remove' },
  { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.5, strength: 1, brush: 'smooth' },
];

describe('applySculptStroke worker job', () => {
  beforeAll(async () => {
    const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, 1, true, true);
    INNER = (
      await buildInnerSurface(die, {
        pitchMm: 0.08,
        marginalGapMm: 0.02,
        cementGapMm: 0.05,
        spacerStartMm: 0.8,
        blendWidthMm: 0.3,
        marginLoop: marginLoopVec(MARGIN_R, MARGIN_Z, 240),
        insertionAxis: AXIS,
      })
    ).mesh;
    const outer = buildFrustum(MARGIN_R + 0.7, TOP_R + 0.7, MARGIN_Z, TOP_Z + 0.7, 96, 8, true, false);
    SHELL = (await constructShell(outer, INNER, { insertionAxis: AXIS })).mesh;
  }, 180000);

  it('sculpts byte-identically to a direct computeShellLock + applySculptGesture call', async () => {
    const margin = marginLoopVec(MARGIN_R, MARGIN_Z, 240);
    const lock = computeShellLock(SHELL, { innerMesh: INNER, marginLoop: margin });
    const direct = applySculptGesture(SHELL, GESTURE, lock.locked);

    const job = await applySculptStrokeJob(
      {
        shellPositions: SHELL.positions,
        shellIndices: SHELL.indices,
        innerPositions: INNER.positions,
        innerIndices: INNER.indices,
        strokes: GESTURE,
        marginLoop: marginFlat(MARGIN_R, MARGIN_Z, 240),
      },
      NOOP_CTX,
    );
    expect(job.watertight).toBe(true);
    expect(job.componentCount).toBe(1);
    expect(job.lockedVertexCount).toBe(lock.lockedCount);
    expect(job.sculptableVertexCount).toBe(lock.outerCount);
    expect(job.movedVertexCount).toBeGreaterThan(0);
    expect(hash(job.positions, job.indices)).toBe(hash(direct.mesh.positions, direct.mesh.indices));
  });

  it('reports monotonic progress ending at 1', async () => {
    const fractions: number[] = [];
    const ctx: JobContext = { progress: (f) => fractions.push(f), cancelled: () => false };
    await applySculptStrokeJob(
      { shellPositions: SHELL.positions, shellIndices: SHELL.indices, innerPositions: INNER.positions, innerIndices: INNER.indices, strokes: GESTURE, marginLoop: marginFlat(MARGIN_R, MARGIN_Z, 240) },
      ctx,
    );
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!)).toBe(true);
  });

  it('throws JobCancelledError when cancelled up front', async () => {
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(
      applySculptStrokeJob(
        { shellPositions: SHELL.positions, shellIndices: SHELL.indices, innerPositions: INNER.positions, innerIndices: INNER.indices, strokes: GESTURE },
        ctx,
      ),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('unlockFitSurface locks nothing', async () => {
    const job = await applySculptStrokeJob(
      {
        shellPositions: SHELL.positions,
        shellIndices: SHELL.indices,
        innerPositions: INNER.positions,
        innerIndices: INNER.indices,
        strokes: [{ center: [0, 0, TOP_Z + 0.7], radiusMm: 1.0, strength: 0.05, brush: 'add' }],
        unlockFitSurface: true,
      },
      NOOP_CTX,
    );
    expect(job.lockedVertexCount).toBe(0);
    expect(job.watertight).toBe(true);
  });
});
