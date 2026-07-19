// icpRegister job tests (Phase 3 Task 3) — exercised via a real Node
// worker_threads WorkerPool (same rationale as undercutJobs.test.ts: job
// logic is environment-agnostic, so testing it through the real Comlink
// transport also proves payload shapes and thrown-error names survive the
// postMessage boundary — in particular `DegenerateTripleError`/
// `JobCancelledError`, both recognized by `.name` after crossing the
// boundary per pool.ts's documented convention).
import { afterEach, describe, expect, it } from 'vitest';
import { JobCancelledError, WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

// ---------------------------------------------------------------------------
// A small, self-contained unit icosahedron (12 vertices, 20 triangles) — a
// standard, hand-checkable "sphere-ish" watertight fixture (same "own local
// fixture, not a kernel test-only import" convention offsetJob.test.ts's
// `icosahedronBuffers` uses, since kernel's TEST-ONLY fixture modules aren't
// exported from @dqcad/kernel's package.json exports map). Radius ~1.902 mm
// (the golden-ratio construction's own vertex distance from origin) — small
// enough for a fast BVH/ICP round trip, large enough that closest-point
// correspondences are meaningfully non-degenerate.
// ---------------------------------------------------------------------------

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: ReadonlyArray<readonly [number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces: ReadonlyArray<readonly [number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const positions = new Float64Array(raw.flat());
  const indices = Uint32Array.from(faces.flat());
  return { positions, indices };
}

type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

/** Exact Rodrigues rotation matrix about `axis` by `angleRad` — the same
 * closed-form construction kernel's own register.test-fixtures.ts uses
 * (independent re-derivation, not an import: this package cannot reach
 * across into @dqcad/kernel's TEST-ONLY fixture modules — see this file's
 * top-of-file note). */
function rotationAboutAxis(axis: readonly [number, number, number], angleRad: number): Mat3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const s = Math.sin(angleRad);
  const c = Math.cos(angleRad);
  const tt = 1 - c;
  return [
    [tt * x * x + c, tt * x * y - s * z, tt * x * z + s * y],
    [tt * x * y + s * z, tt * y * y + c, tt * y * z - s * x],
    [tt * x * z - s * y, tt * y * z + s * x, tt * z * z + c],
  ];
}

/** Column-major 4x4 (SceneNode/kernel `Mat4` convention) from a row-major
 * 3x3 rotation + translation. */
function composeRigidMat4(r: Mat3, t: readonly [number, number, number]): number[] {
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, t[0], t[1], t[2], 1];
}

function applyRigid(r: Mat3, t: readonly [number, number, number], p: readonly [number, number, number]): [number, number, number] {
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
  ];
}

function transformBuffers(positions: Float64Array, r: Mat3, t: readonly [number, number, number]): Float64Array {
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length / 3; i++) {
    const [x, y, z] = applyRigid(r, t, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

const AXIS: readonly [number, number, number] = [0.2, 0.9, -0.3];
const ANGLE = 0.4;
const TRANSLATION: readonly [number, number, number] = [3, -1, 2];
const KNOWN_ROTATION = rotationAboutAxis(AXIS, ANGLE);

function applyMat4ToPointForTest(m: readonly number[], p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

const IDENTITY_MAT4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function buildBvhFor(
  pool: WorkerPool,
  contentHash: string,
  positions: Float64Array,
  indices: Uint32Array,
): Promise<void> {
  await pool.run('buildBvh', { contentHash, positions: positions.slice(), indices: indices.slice() });
}

describe('icpRegister job — behavioral (icosahedron pair, known rigid transform)', () => {
  it('converges to the known transform when given an already-close initialTransform', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-icosa', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-icosa', dstPositions, src.indices);

    // A close-but-not-exact init (small extra rotation/translation) — ICP
    // must refine the rest of the way (see @dqcad/kernel's icpRefine.ts
    // local-minimum caveat: identity would be too far for this rotation).
    const closeRotation = rotationAboutAxis(AXIS, ANGLE + 0.03);
    const closeTranslation: readonly [number, number, number] = [
      TRANSLATION[0] + 0.2,
      TRANSLATION[1] - 0.1,
      TRANSLATION[2] + 0.15,
    ];
    const initialTransform = composeRigidMat4(closeRotation, closeTranslation);

    const result = await pool.run('icpRegister', {
      srcContentHash: 'src-icosa',
      dstContentHash: 'dst-icosa',
      initialTransform,
      sampleCount: 300,
      seed: 1,
      maxIterations: 60,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.inlierFraction).toBeGreaterThan(0.8);
    expect(result.initialTransform).toEqual(initialTransform);

    const probe: [number, number, number] = [1, 1, 1];
    const expected = applyRigid(KNOWN_ROTATION, TRANSLATION, probe);
    const actual = applyMat4ToPointForTest(result.transform, probe);
    const err = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
    expect(err).toBeLessThan(1e-3);
  });

  it('reports monotonically-bounded progress ending at 1', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-progress', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-progress', dstPositions, src.indices);

    const progressValues: number[] = [];
    await pool.run(
      'icpRegister',
      {
        srcContentHash: 'src-progress',
        dstContentHash: 'dst-progress',
        initialTransform: IDENTITY_MAT4,
        sampleCount: 100,
        seed: 2,
        maxIterations: 10,
      },
      { onProgress: (fraction) => progressValues.push(fraction) },
    );
    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBeCloseTo(1, 9);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]!).toBeGreaterThanOrEqual(progressValues[i - 1]!);
    }
  });

  it('is deterministic: same seed -> byte-identical result across two separate job runs', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-det', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-det', dstPositions, src.indices);

    const payload = {
      srcContentHash: 'src-det',
      dstContentHash: 'dst-det',
      initialTransform: IDENTITY_MAT4,
      sampleCount: 80,
      seed: 5,
      maxIterations: 15,
    } as const;
    const a = await pool.run('icpRegister', payload);
    const b = await pool.run('icpRegister', payload);
    expect(a).toEqual(b);
  });
});

describe('icpRegister job — coarse pairs path', () => {
  it('computes the coarse transform from 3 picked pairs, then refines, echoing initialTransform', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-coarse', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-coarse', dstPositions, src.indices);

    // 3 exact correspondences: vertices 0, 1, 2 of src map exactly to the
    // same-index vertices of dst (dst IS src transformed, so this is
    // consistent by construction).
    const srcPt = (i: number): [number, number, number] => [
      src.positions[i * 3]!,
      src.positions[i * 3 + 1]!,
      src.positions[i * 3 + 2]!,
    ];
    const dstPt = (i: number): [number, number, number] => [
      dstPositions[i * 3]!,
      dstPositions[i * 3 + 1]!,
      dstPositions[i * 3 + 2]!,
    ];
    const coarsePairs = [0, 1, 2].map((i) => ({ src: srcPt(i), dst: dstPt(i) }));

    const result = await pool.run('icpRegister', {
      srcContentHash: 'src-coarse',
      dstContentHash: 'dst-coarse',
      coarsePairs,
      sampleCount: 200,
      seed: 3,
      maxIterations: 40,
    });

    expect(result.converged).toBe(true);
    expect(result.rmsMm).toBeLessThan(1e-4);
    // initialTransform should already recover the known transform almost
    // exactly (the 3 pairs are exact correspondences of a real rigid map).
    const probe: [number, number, number] = [1, -1, 0.5];
    const viaCoarseInit = applyMat4ToPointForTest(result.initialTransform, probe);
    const viaFinal = applyMat4ToPointForTest(result.transform, probe);
    expect(Math.hypot(...(viaCoarseInit.map((v, i) => v - viaFinal[i]!) as [number, number, number]))).toBeLessThan(
      1e-2,
    );
  });

  it('rejects a degenerate (collinear) coarse triple with DegenerateTripleError, surviving the worker boundary', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-degenerate', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-degenerate', dstPositions, src.indices);

    const coarsePairs = [
      { src: [0, 0, 0] as const, dst: [0, 0, 0] as const },
      { src: [1, 0, 0] as const, dst: [1, 0, 0] as const },
      { src: [2, 0, 0] as const, dst: [2, 0, 0] as const }, // collinear with the first two
    ];

    await expect(
      pool.run('icpRegister', {
        srcContentHash: 'src-degenerate',
        dstContentHash: 'dst-degenerate',
        coarsePairs,
        sampleCount: 50,
        seed: 1,
      }),
    ).rejects.toThrow(/DegenerateTripleError|collinear/);
  });

  it('rejects a wrong-length coarsePairs array', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    await buildBvhFor(pool, 'src-badlen', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-badlen', src.positions, src.indices);
    await expect(
      pool.run('icpRegister', {
        srcContentHash: 'src-badlen',
        dstContentHash: 'dst-badlen',
        coarsePairs: [{ src: [0, 0, 0], dst: [0, 0, 0] }],
        sampleCount: 10,
        seed: 1,
      }),
    ).rejects.toThrow();
  });

  it('rejects both coarsePairs AND initialTransform provided together', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    await buildBvhFor(pool, 'src-both', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-both', src.positions, src.indices);
    await expect(
      pool.run('icpRegister', {
        srcContentHash: 'src-both',
        dstContentHash: 'dst-both',
        coarsePairs: [
          { src: [0, 0, 0], dst: [0, 0, 0] },
          { src: [1, 0, 0], dst: [1, 0, 0] },
          { src: [0, 1, 0], dst: [0, 1, 0] },
        ],
        initialTransform: IDENTITY_MAT4,
        sampleCount: 10,
        seed: 1,
      }),
    ).rejects.toThrow();
  });

  it('rejects neither coarsePairs nor initialTransform provided', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    await buildBvhFor(pool, 'src-neither', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-neither', src.positions, src.indices);
    await expect(
      pool.run('icpRegister', {
        srcContentHash: 'src-neither',
        dstContentHash: 'dst-neither',
        sampleCount: 10,
        seed: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('icpRegister job — cancellation', () => {
  it('is cancellable BEFORE it starts (pre-flight: signal already aborted)', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    await buildBvhFor(pool, 'src-preflight', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-preflight', src.positions, src.indices);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'icpRegister',
        {
          srcContentHash: 'src-preflight',
          dstContentHash: 'dst-preflight',
          initialTransform: IDENTITY_MAT4,
          sampleCount: 50,
          seed: 1,
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it('is cancellable MID-RUN (abort from the onProgress hook between iterations)', async () => {
    const pool = createPool({ size: 1 });
    const src = icosahedronBuffers();
    const dstPositions = transformBuffers(src.positions, KNOWN_ROTATION, TRANSLATION);
    await buildBvhFor(pool, 'src-midcancel', src.positions, src.indices);
    await buildBvhFor(pool, 'dst-midcancel', dstPositions, src.indices);

    const controller = new AbortController();
    const progressValues: number[] = [];
    let abortedMidRun = false;
    await expect(
      pool.run(
        'icpRegister',
        {
          srcContentHash: 'src-midcancel',
          dstContentHash: 'dst-midcancel',
          initialTransform: IDENTITY_MAT4, // far from the true transform -> many iterations to cancel between
          sampleCount: 100,
          seed: 4,
          maxIterations: 200,
          convergenceRelTol: 1e-12,
        },
        {
          signal: controller.signal,
          onProgress: (fraction) => {
            progressValues.push(fraction);
            if (!abortedMidRun && fraction > 0.01 && fraction < 0.5) {
              abortedMidRun = true;
              controller.abort();
            }
          },
        },
      ),
    ).rejects.toThrow(JobCancelledError);
    expect(abortedMidRun).toBe(true);
  });
});
