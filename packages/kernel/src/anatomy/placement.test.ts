// packages/kernel/src/anatomy/placement.test.ts
//
// Phase 4 Task 5 — anatomy-placement solver: analytic frame construction, the
// two scale factors (fill inter-neighbour + margin→antagonist space),
// antagonist-absent fallback, occlusal re-orientation, determinism
// (byte-identical transform + placed-mesh hash), and the manual-override API.
// A fully SYNTHETIC scenario whose expected target frame + scales are derived
// closed-form here (no fixtures) — see each test's derivation comment.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  translatePlacement,
  rotatePlacement,
  rescalePlacement,
  solveLandmarkHandleTranslation,
  DegeneratePlacementError,
  applyMat4ToPoint,
  type CanonicalFrameAxes,
  type AnatomyPlacementInput,
  type IndexedMesh,
  type Vec3,
  type Mat3,
} from '../index.ts';

// --- Identity canonical frame (matches the tooth-library incisor asset) ---
const IDENTITY_CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

/** Axis-aligned box [min..max], 12 triangles. Native extents: X, Y, Z sizes. */
function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: number[] = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const idx = [
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // front
    1, 2, 6, 1, 6, 5, // right
    2, 3, 7, 2, 7, 6, // back
    3, 0, 4, 3, 4, 7, // left
  ];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

/** N-point circle of radius `r` centred at `c` in the plane z = c[2]. */
function marginCircle(c: Vec3, r: number, n = 64): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([c[0] + r * Math.cos(th), c[1] + r * Math.sin(th), c[2]]);
  }
  return loop;
}

function hashPositions(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

function projectedSpan(mesh: IndexedMesh, axis: Vec3): number {
  let min = Infinity;
  let max = -Infinity;
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const p =
      mesh.positions[i * 3]! * axis[0] + mesh.positions[i * 3 + 1]! * axis[1] + mesh.positions[i * 3 + 2]! * axis[2];
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return max - min;
}

// ---------------------------------------------------------------------------
// A canonical analytic scenario (derived closed-form):
//   library box  X∈[-1,1]  Y∈[-1,1]  Z∈[0,4]   → native MD=2, BL=2, OG=4
//   margin circle centred O_t = [10,5,2] in plane z=2, radius 1.5
//   insertion axis +Z                          → og = [0,0,1]
//   mesial neighbour box X∈[4,8]  (centroid 6) → most-distal extent on md = 8
//   distal neighbour box X∈[12,16] (centroid 14) → most-mesial extent on md = 12
//     → md = [1,0,0], bl = og×md = [0,1,0]; proximal gap = 12-8 = 4
//   antagonist box centred over the site at Z∈[8,10]
//     → nearest occlusal surface 8, target O-G height = 8-2 = 6
//   ⇒ scaleMD = 4/2 = 2, scaleBL = 2, scaleOG = 6/4 = 1.5
//   ⇒ transform: world = O_t + diag(2,2,1.5)·(p - 0)
// ---------------------------------------------------------------------------
const O_T: Vec3 = [10, 5, 2];
function baseInput(overrides?: Partial<AnatomyPlacementInput>): AnatomyPlacementInput {
  return {
    canonicalFrame: IDENTITY_CANONICAL,
    libraryMesh: box([-1, -1, 0], [1, 1, 4]),
    marginLoop: marginCircle(O_T, 1.5),
    insertionAxis: [0, 0, 1],
    mesialNeighborPositions: box([4, 4, 1], [8, 6, 3]).positions,
    distalNeighborPositions: box([12, 4, 1], [16, 6, 3]).positions,
    // Narrow enough in x/y that its corners sit within the margin's lateral
    // window (radius 1.5 about the og axis through O_t) — so it registers as
    // the opposing surface over the site.
    antagonistPositions: box([9, 4.5, 8], [11, 5.5, 10]).positions,
    ...overrides,
  };
}

describe('solveAnatomyPlacement — analytic frame + scale', () => {
  it('builds the derived target frame (og from axis, md from neighbours, bl = og×md)', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    expect(frame.originMm[0]).toBeCloseTo(10, 9);
    expect(frame.originMm[1]).toBeCloseTo(5, 9);
    expect(frame.originMm[2]).toBeCloseTo(2, 9);
    expect(frame.occlusoGingival).toEqual([0, 0, 1]);
    expect(frame.mesialDistal[0]).toBeCloseTo(1, 9);
    expect(frame.mesialDistal[1]).toBeCloseTo(0, 9);
    expect(frame.mesialDistal[2]).toBeCloseTo(0, 9);
    expect(frame.buccoLingual[0]).toBeCloseTo(0, 9);
    expect(frame.buccoLingual[1]).toBeCloseTo(1, 9);
    expect(frame.buccoLingual[2]).toBeCloseTo(0, 9);
  });

  it('scales to fill the proximal gap (M-D) and margin→antagonist (O-G); reports measured', () => {
    const { frame, measurements } = solveAnatomyPlacement(baseInput());
    expect(measurements.nativeMesialDistalWidthMm).toBeCloseTo(2, 9);
    expect(measurements.nativeOcclusoGingivalHeightMm).toBeCloseTo(4, 9);
    expect(measurements.targetMesialDistalWidthMm).toBeCloseTo(4, 9);
    expect(measurements.targetOcclusoGingivalHeightMm!).toBeCloseTo(6, 9);
    expect(measurements.usedProximalGap).toBe(true);
    expect(measurements.antagonistUsed).toBe(true);
    expect(frame.scaleMesialDistal).toBeCloseTo(2, 9);
    expect(frame.scaleBuccoLingual).toBeCloseTo(2, 9);
    expect(frame.scaleOcclusoGingival).toBeCloseTo(1.5, 9);

    // The PLACED mesh's spans match the case space it was scaled to fill.
    const t = buildPlacementTransform(frame, IDENTITY_CANONICAL);
    const placed = placeMesh(baseInput().libraryMesh, t);
    const mdSpan = projectedSpan(placed, frame.mesialDistal);
    const ogSpan = projectedSpan(placed, frame.occlusoGingival);
    console.log(`[ANATOMY-PLACEMENT synthetic] placed M-D span=${mdSpan.toFixed(4)}mm (target 4), O-G span=${ogSpan.toFixed(4)}mm (target 6)`);
    expect(mdSpan).toBeCloseTo(4, 6);
    expect(ogSpan).toBeCloseTo(6, 6);
  });

  it('maps a library point through the derived affine exactly', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    const t = buildPlacementTransform(frame, IDENTITY_CANONICAL);
    // incisal-edge-like top-centre [0,0,4] → [10, 5, 2 + 1.5*4] = [10,5,8]
    const p = applyMat4ToPoint(t, [0, 0, 4]);
    expect(p[0]).toBeCloseTo(10, 6);
    expect(p[1]).toBeCloseTo(5, 6);
    expect(p[2]).toBeCloseTo(8, 6);
    // canonical origin → target origin
    const o = applyMat4ToPoint(t, [0, 0, 0]);
    expect(o[0]).toBeCloseTo(10, 6);
    expect(o[1]).toBeCloseTo(5, 6);
    expect(o[2]).toBeCloseTo(2, 6);
  });

  it('re-orients og toward the antagonist when the insertion axis sign is flipped', () => {
    const { frame, measurements } = solveAnatomyPlacement(baseInput({ insertionAxis: [0, 0, -1] }));
    expect(measurements.occlusoGingivalReoriented).toBe(true);
    expect(frame.occlusoGingival[2]).toBeCloseTo(1, 9); // flipped back to occlusal (toward antagonist)
  });

  it('antagonist-absent fallback: O-G reuses the M-D scale (undistorted), reports null height', () => {
    const { frame, measurements } = solveAnatomyPlacement(baseInput({ antagonistPositions: null }));
    expect(measurements.antagonistUsed).toBe(false);
    expect(measurements.targetOcclusoGingivalHeightMm).toBeNull();
    expect(frame.scaleOcclusoGingival).toBeCloseTo(frame.scaleMesialDistal, 12);
    expect(frame.occlusoGingival).toEqual([0, 0, 1]); // insertion-axis sign trusted (no antagonist datum)
  });

  it('falls back to centroid separation when neighbours overlap (non-positive proximal gap)', () => {
    // Overlapping neighbour boxes (both span the site) → proximal gap ≤ 0.
    const { measurements } = solveAnatomyPlacement(
      baseInput({
        mesialNeighborPositions: box([4, 4, 1], [13, 6, 3]).positions, // centroid x=8.5
        distalNeighborPositions: box([9, 4, 1], [16, 6, 3]).positions, // centroid x=12.5
      }),
    );
    expect(measurements.usedProximalGap).toBe(false);
    expect(measurements.targetMesialDistalWidthMm).toBeCloseTo(4, 9); // |12.5 - 8.5|
  });

  it('throws on a zero insertion axis and on an M-D line parallel to og', () => {
    expect(() => solveAnatomyPlacement(baseInput({ insertionAxis: [0, 0, 0] }))).toThrow(DegeneratePlacementError);
    // Neighbours stacked along og (z) → md line parallel to og, no M-D direction.
    expect(() =>
      solveAnatomyPlacement(
        baseInput({
          mesialNeighborPositions: box([9, 4, 0], [11, 6, 1]).positions, // centroid z ~0.5
          distalNeighborPositions: box([9, 4, 8], [11, 6, 9]).positions, // centroid z ~8.5
        }),
      ),
    ).toThrow(DegeneratePlacementError);
  });
});

describe('anatomy placement — determinism', () => {
  it('produces byte-identical transform + placed-mesh hash across two runs', () => {
    const a = solveAnatomyPlacement(baseInput());
    const ta = buildPlacementTransform(a.frame, IDENTITY_CANONICAL);
    const ha = hashPositions(placeMesh(baseInput().libraryMesh, ta));

    const b = solveAnatomyPlacement(baseInput());
    const tb = buildPlacementTransform(b.frame, IDENTITY_CANONICAL);
    const hb = hashPositions(placeMesh(baseInput().libraryMesh, tb));

    expect(tb).toEqual(ta);
    expect(hb).toBe(ha);
  });
});

describe('anatomy placement — manual override API', () => {
  it('landmark handle keeps the dragged landmark at the target exactly', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    const landmarkAssetPoint: Vec3 = [0, 0, 4]; // incisal-edge-like
    const target: Vec3 = [3, -7, 20];
    const dragged = solveLandmarkHandleTranslation(frame, IDENTITY_CANONICAL, landmarkAssetPoint, target);
    const t = buildPlacementTransform(dragged, IDENTITY_CANONICAL);
    const landed = applyMat4ToPoint(t, landmarkAssetPoint);
    expect(landed[0]).toBeCloseTo(target[0], 6);
    expect(landed[1]).toBeCloseTo(target[1], 6);
    expect(landed[2]).toBeCloseTo(target[2], 6);
  });

  it('explicit translation / rescale overrides compose deterministically', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    const moved = translatePlacement(frame, [1, 2, 3]);
    expect(moved.originMm[0]).toBeCloseTo(11, 9);
    expect(moved.originMm[1]).toBeCloseTo(7, 9);
    expect(moved.originMm[2]).toBeCloseTo(5, 9);
    const bigger = rescalePlacement(frame, { md: 1.1, og: 0.5 });
    expect(bigger.scaleMesialDistal).toBeCloseTo(frame.scaleMesialDistal * 1.1, 12);
    expect(bigger.scaleOcclusoGingival).toBeCloseTo(frame.scaleOcclusoGingival * 0.5, 12);
    expect(bigger.scaleBuccoLingual).toBe(frame.scaleBuccoLingual);
  });

  it('rotation override about the origin rotates axes and keeps the origin fixed', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    // 90° about world Z: x→y, y→-x.
    const rotZ: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ];
    const rotated = rotatePlacement(frame, rotZ);
    expect(rotated.originMm).toEqual(frame.originMm); // pivot = origin
    expect(rotated.mesialDistal[0]).toBeCloseTo(0, 9);
    expect(rotated.mesialDistal[1]).toBeCloseTo(1, 9);
    expect(rotated.occlusoGingival[2]).toBeCloseTo(1, 9);
  });
});

describe('anatomy placement — frame validation guard (no silent mirror)', () => {
  it('throws for a LEFT-handed canonical frame (would otherwise be silently mirrored by Kabsch)', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    const leftHandedCanonical: CanonicalFrameAxes = {
      origin: [0, 0, 0],
      mesialDistal: [1, 0, 0],
      buccoLingual: [0, 1, 0],
      occlusoGingival: [0, 0, -1], // flips handedness: det = -1
    };
    expect(() => buildPlacementTransform(frame, leftHandedCanonical)).toThrow(DegeneratePlacementError);
  });

  it('throws for a LEFT-handed / non-orthonormal placement (target) frame', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    const mirrored = { ...frame, occlusoGingival: [0, 0, -1] as Vec3 }; // right-handed → mirrored
    expect(() => buildPlacementTransform(mirrored, IDENTITY_CANONICAL)).toThrow(DegeneratePlacementError);
    const skewed = { ...frame, buccoLingual: [0.5, 0.5, 0] as Vec3 }; // non-unit, non-orthogonal
    expect(() => buildPlacementTransform(skewed, IDENTITY_CANONICAL)).toThrow(DegeneratePlacementError);
  });

  it('accepts the well-formed auto-solved frame (right-handed orthonormal)', () => {
    const { frame } = solveAnatomyPlacement(baseInput());
    expect(() => buildPlacementTransform(frame, IDENTITY_CANONICAL)).not.toThrow();
  });
});

describe('anatomy placement — property: transform maps canonical frame onto target frame', () => {
  it('for random orthonormal target frames, canonical origin/axis tips map onto the target', () => {
    fc.assert(
      fc.property(
        fc.record({
          ax: fc.double({ min: -3, max: 3, noNaN: true }),
          ay: fc.double({ min: -3, max: 3, noNaN: true }),
          az: fc.double({ min: -3, max: 3, noNaN: true }),
          angle: fc.double({ min: 0.1, max: 3, noNaN: true }),
          sMd: fc.double({ min: 0.3, max: 3, noNaN: true }),
          sOg: fc.double({ min: 0.3, max: 3, noNaN: true }),
          ox: fc.double({ min: -20, max: 20, noNaN: true }),
          oy: fc.double({ min: -20, max: 20, noNaN: true }),
          oz: fc.double({ min: -20, max: 20, noNaN: true }),
        }),
        (p) => {
          // Rotation about a GENUINE unit axis. fc.double can emit subnormal
          // magnitudes (e.g. 5e-324) for all three components at once, which
          // underflow Math.hypot to 0 and would make a NON-unit axis → a
          // non-proper Rodrigues matrix (det = cos³θ ≠ 1). Discard those seeds
          // (never seed around a bug) so every case is a real rotation.
          const al = Math.hypot(p.ax, p.ay, p.az);
          fc.pre(al > 1e-6);
          const u: Vec3 = [p.ax / al, p.ay / al, p.az / al];
          const rot = rodrigues(u, p.angle);
          const md = matVec(rot, [1, 0, 0]);
          const bl = matVec(rot, [0, 1, 0]);
          const og = matVec(rot, [0, 0, 1]);
          const frame = {
            originMm: [p.ox, p.oy, p.oz] as Vec3,
            mesialDistal: md,
            buccoLingual: bl,
            occlusoGingival: og,
            scaleMesialDistal: p.sMd,
            scaleBuccoLingual: p.sMd,
            scaleOcclusoGingival: p.sOg,
          };
          const t = buildPlacementTransform(frame, IDENTITY_CANONICAL);
          const o = applyMat4ToPoint(t, [0, 0, 0]);
          expect(o[0]).toBeCloseTo(p.ox, 6);
          expect(o[1]).toBeCloseTo(p.oy, 6);
          expect(o[2]).toBeCloseTo(p.oz, 6);
          // Assert ALL THREE canonical axis tips map onto the target frame:
          // canonical e_i (scaled by s_i along axis_i) → origin + s_i·axis_i.
          const checkTip = (tip: Vec3, axis: Vec3, s: number): void => {
            const q = applyMat4ToPoint(t, tip);
            expect(q[0]).toBeCloseTo(p.ox + s * axis[0], 5);
            expect(q[1]).toBeCloseTo(p.oy + s * axis[1], 5);
            expect(q[2]).toBeCloseTo(p.oz + s * axis[2], 5);
          };
          checkTip([1, 0, 0], md, p.sMd); // mesial-distal
          checkTip([0, 1, 0], bl, p.sMd); // bucco-lingual (scaleBL == scaleMD)
          checkTip([0, 0, 1], og, p.sOg); // occluso-gingival
        },
      ),
      { numRuns: 60 },
    );
  });
});

function rodrigues(u: Vec3, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const [x, y, z] = u;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}
function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
