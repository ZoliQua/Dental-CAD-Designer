// constructShell job test (Phase 4 Task 7) — the crown-shell worker job.
// Exercised by calling the handler directly with a JobContext (the kernel's
// shell.test.ts covers the geometry; here we prove the payload→kernel wiring,
// byte-identity with a direct constructShell call, progress/cancel, and the
// auto-thicken path).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildInnerSurface, constructShell, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { constructShellJob } from './jobs/shell.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };
const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const b: number[] = [];
  const t: number[] = [];
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ));
  }
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ));
  }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) {
    const sn = (s + 1) % seg;
    tr.push(b[s]!, b[sn]!, t[sn]!);
    tr.push(b[s]!, t[sn]!, t[s]!);
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, b[sn]!, b[s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, t[s]!, t[sn]!);
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
function hash(pos: Float64Array, idx: Uint32Array): string {
  const h = createHash('sha256');
  h.update(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
  h.update(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  return h.digest('hex');
}

let INNER: IndexedMesh;
async function intaglio(): Promise<IndexedMesh> {
  if (!INNER) {
    const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
    INNER = (
      await buildInnerSurface(die, {
        pitchMm: 0.08,
        marginalGapMm: 0.02,
        cementGapMm: 0.05,
        spacerStartMm: 0.8,
        blendWidthMm: 0.3,
        marginLoop: (() => {
          const l: Vec3[] = [];
          for (let i = 0; i < 240; i++) {
            const th = (2 * Math.PI * i) / 240;
            l.push([MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z]);
          }
          return l;
        })(),
        insertionAxis: AXIS,
      })
    ).mesh;
  }
  return INNER;
}
const outer = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);

describe('constructShell worker job', () => {
  it('produces a watertight shell byte-identical to a direct constructShell call', async () => {
    const inner = await intaglio();
    const o = outer(0.7);
    const direct = await constructShell(o, inner, { insertionAxis: AXIS });
    const job = await constructShellJob(
      {
        outerPositions: o.positions,
        outerIndices: o.indices,
        innerPositions: inner.positions,
        innerIndices: inner.indices,
        insertionAxis: AXIS,
      },
      NOOP_CTX,
    );
    expect(job.watertight).toBe(true);
    expect(job.componentCount).toBe(1);
    expect(job.seamTriangleCount).toBeGreaterThan(0);
    expect(job.minWallThicknessMm).toBeGreaterThan(0.5);
    expect(hash(job.positions, job.indices)).toBe(hash(direct.mesh.positions, direct.mesh.indices));
  }, 120000);

  it('reports monotonic progress ending at 1', async () => {
    const inner = await intaglio();
    const o = outer(0.7);
    const fractions: number[] = [];
    const ctx: JobContext = { progress: (f) => fractions.push(f), cancelled: () => false };
    await constructShellJob(
      { outerPositions: o.positions, outerIndices: o.indices, innerPositions: inner.positions, innerIndices: inner.indices, insertionAxis: AXIS },
      ctx,
    );
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!)).toBe(true);
  }, 120000);

  it('throws JobCancelledError when cancelled up front', async () => {
    const inner = await intaglio();
    const o = outer(0.7);
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(
      constructShellJob(
        { outerPositions: o.positions, outerIndices: o.indices, innerPositions: inner.positions, innerIndices: inner.indices, insertionAxis: AXIS },
        ctx,
      ),
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 120000);

  it('applies auto-thicken when requested and reports it', async () => {
    const inner = await intaglio();
    const thin = buildFrustum(MARGIN_R + 0.3, TOP_R + 0.3, MARGIN_Z, TOP_Z + 0.9, 96, true, false);
    const job = await constructShellJob(
      {
        outerPositions: thin.positions,
        outerIndices: thin.indices,
        innerPositions: inner.positions,
        innerIndices: inner.indices,
        insertionAxis: AXIS,
        marginLoop: marginFlat(MARGIN_R, MARGIN_Z, 240),
        autoThicken: true,
        autoThickenMinThicknessMm: 0.5,
        autoThickenMaxDisplacementMm: 1.0,
        autoThickenOvershoot: 2.0,
        autoThickenPasses: 6,
      },
      NOOP_CTX,
    );
    expect(job.autoThickenApplied).toBe(true);
    expect(job.autoThickenDisplacedVertexCount).toBeGreaterThan(0);
    expect(job.watertight).toBe(true);
    expect(job.minWallThicknessMm).toBeGreaterThanOrEqual(0.5 - 1e-6);
  }, 120000);
});
