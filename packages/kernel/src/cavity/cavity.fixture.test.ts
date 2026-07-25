// packages/kernel/src/cavity/cavity.fixture.test.ts
//
// Phase 5 Task 1: closed-form assertions for the analytic MOD-cavity fixture
// (cavity.test-fixtures.ts) — the fixture every later Phase 5 task tests
// against, so its guarantees are pinned HERE. Analytic first (closed-form
// dimensions + outline exactly on the constructed ring), then determinism,
// then property tests over the parameter space (fc.pre-guarded generators).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { analyzeMesh } from '../intake/analyze.ts';
import { modCavityMesh, type ModCavityMeshOptions } from './cavity.test-fixtures.ts';

type Vec3 = readonly [number, number, number];

const key = (p: Vec3): string => `${p[0]}|${p[1]}|${p[2]}`;

function meshVertexKeys(positions: Float64Array): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    keys.add(`${positions[i]}|${positions[i + 1]}|${positions[i + 2]}`);
  }
  return keys;
}

function hashMesh(positions: Float64Array, indices: Uint32Array): string {
  const h = createHash('sha256');
  h.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  h.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return h.digest('hex');
}

describe('modCavityMesh — topology (analyzeMesh)', () => {
  it('is watertight, 2-manifold, single-component, positive-volume, degenerate-free', () => {
    const { mesh } = modCavityMesh();
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
  });

  it('the onlay (reduced-cusp) variant is also a clean closed solid', () => {
    const { mesh } = modCavityMesh({ reducedCusp: true });
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
  });
});

describe('modCavityMesh — closed-form dimensions', () => {
  const f = modCavityMesh();

  it('the bounding box matches the block + cusps closed-form', () => {
    const { bbox } = analyzeMesh(f.mesh);
    expect(bbox.min[0]).toBeCloseTo(-f.lengthMm / 2, 10);
    expect(bbox.max[0]).toBeCloseTo(+f.lengthMm / 2, 10);
    expect(bbox.min[1]).toBeCloseTo(-f.widthMm / 2, 10);
    expect(bbox.max[1]).toBeCloseTo(+f.widthMm / 2, 10);
    expect(bbox.min[2]).toBeCloseTo(0, 10); // base
    expect(bbox.max[2]).toBeCloseTo(Math.max(f.cuspZBuccal, f.cuspZLingual), 10); // cusp tips
  });

  it('the floor is stepped: isthmus shallower than the proximal boxes', () => {
    expect(f.floorZ).toBeCloseTo(f.tableZ - 2.0, 10);
    expect(f.gingivalFloorZ).toBeCloseTo(f.tableZ - 3.5, 10);
    expect(f.gingivalFloorZ).toBeLessThan(f.floorZ); // box floor is deeper (lower Z)
  });

  it('the wall draft narrows the floor by depth*tan(taper) from the opening', () => {
    const tan = Math.tan(f.taperRad);
    expect(f.isthmusFloorHalfWidthMm).toBeCloseTo(f.isthmusHalfWidthMm - 2.0 * tan, 10);
    expect(f.boxFloorHalfWidthMm).toBeCloseTo(f.isthmusHalfWidthMm - 3.5 * tan, 10);
    // deeper box floor is narrower than the shallower isthmus floor (same draft)
    expect(f.boxFloorHalfWidthMm).toBeLessThan(f.isthmusFloorHalfWidthMm);
  });

  it('the gingival floor plane (z) exists as actual mesh vertices at both boxes', () => {
    const keys = meshVertexKeys(f.mesh.positions);
    // box floor corners at each proximal face
    expect(keys.has(key([+f.lengthMm / 2, -f.boxFloorHalfWidthMm, f.gingivalFloorZ]))).toBe(true);
    expect(keys.has(key([-f.lengthMm / 2, +f.boxFloorHalfWidthMm, f.gingivalFloorZ]))).toBe(true);
  });
});

describe('modCavityMesh — the exact cavity outline', () => {
  const f = modCavityMesh();

  it('is a closed ring (first != last, no duplicate consecutive points)', () => {
    const o = f.cavityOutline;
    expect(o.length).toBeGreaterThan(8);
    expect(key(o[0]!)).not.toBe(key(o[o.length - 1]!));
    for (let i = 0; i < o.length; i++) {
      expect(key(o[i]!)).not.toBe(key(o[(i + 1) % o.length]!));
    }
  });

  it('every outline vertex lies EXACTLY on a mesh vertex (bit-identical, no tolerance)', () => {
    const keys = meshVertexKeys(f.mesh.positions);
    for (const p of f.cavityOutline) {
      expect(keys.has(key(p))).toBe(true);
    }
  });

  it('every outline vertex lies EXACTLY on its analytic locus (bitwise ===, no tolerance)', () => {
    // The construction places these coordinates directly from the parameters
    // (|−a| === a holds bitwise for every double), so strict equality is the
    // honest assertion: a future refactor that introduced even 1-ULP rounding
    // on the outline would fail here.
    for (const [x, y, z] of f.cavityOutline) {
      const onOcclusalMargin = z === f.tableZ && Math.abs(y) === f.isthmusHalfWidthMm;
      const onProximalFace = Math.abs(x) === f.lengthMm / 2;
      // occlusal-margin runs are exactly z=tableZ, |y|=opening half-width;
      // the proximal-box "U" drops are exactly on the proximal face |x|=L/2.
      expect(onOcclusalMargin || onProximalFace).toBe(true);
      if (onProximalFace) {
        // never above the opening, never below the gingival floor
        expect(z).toBeLessThanOrEqual(f.tableZ);
        expect(z).toBeGreaterThanOrEqual(f.gingivalFloorZ);
      }
    }
  });

  it('reaches the gingival floor at the proximal boxes (true break-through MOD)', () => {
    const minZ = Math.min(...f.cavityOutline.map((p) => p[2]));
    expect(minZ).toBeCloseTo(f.gingivalFloorZ, 10);
  });
});

describe('modCavityMesh — onlay reduced-cusp knob', () => {
  it('lowers the buccal cusp only (default = symmetric cusps)', () => {
    const inlay = modCavityMesh();
    expect(inlay.cuspZBuccal).toBe(inlay.cuspZLingual);

    const onlay = modCavityMesh({ reducedCusp: true, reducedCuspDropMm: 1.0 });
    expect(onlay.cuspZBuccal).toBeCloseTo(onlay.cuspZLingual - 1.0, 10);
    expect(onlay.cuspZBuccal).toBeLessThan(onlay.cuspZLingual);
    // the reduced cusp still rises above the occlusal table (something to cover)
    expect(onlay.cuspZBuccal).toBeGreaterThan(onlay.tableZ);
    // the lowered buccal cusp tip is an actual mesh vertex
    const keys = meshVertexKeys(onlay.mesh.positions);
    expect(keys.has(key([0, -onlay.widthMm / 2, onlay.cuspZBuccal]))).toBe(true);
  });
});

describe('modCavityMesh — determinism', () => {
  it('two builds are byte-identical (positions + indices)', () => {
    const a = modCavityMesh();
    const b = modCavityMesh();
    expect(hashMesh(a.mesh.positions, a.mesh.indices)).toBe(hashMesh(b.mesh.positions, b.mesh.indices));
    expect(a.cavityOutline).toEqual(b.cavityOutline);
  });

  it('the reduced-cusp variant is deterministic too', () => {
    const a = modCavityMesh({ reducedCusp: true });
    const b = modCavityMesh({ reducedCusp: true });
    expect(hashMesh(a.mesh.positions, a.mesh.indices)).toBe(hashMesh(b.mesh.positions, b.mesh.indices));
  });
});

describe('modCavityMesh — rejects geometrically-invalid parameters (documented invariants)', () => {
  it.each([
    ['no isthmus left (2*boxLengthMm >= lengthMm)', { lengthMm: 4, boxLengthMm: 2.5 }, /real isthmus/],
    ['box not deeper than isthmus', { isthmusDepthMm: 2, boxDepthMm: 2 }, /must exceed isthmusDepthMm/],
    ['gingival floor below the base', { tableZ: 3, boxDepthMm: 3.5 }, /gingival floor would fall below/],
    ['drafted box floor collapses', { taperDeg: 45, boxDepthMm: 4 }, /non-positive width/],
    ['cavity wider than the tooth', { isthmusWidthMm: 20 }, /0 < isthmusWidthMm < widthMm/],
    ['reduced cusp drop exceeds cusp height', { reducedCuspDropMm: 2, cuspHeightMm: 1.5 }, /reducedCuspDropMm must be </],
    ['zero mesiodistal segments', { mdSegmentsPerZone: 0 }, /mdSegmentsPerZone must be >= 1/],
  ])('throws for %s', (_label, opts, re) => {
    expect(() => modCavityMesh(opts)).toThrow(re);
  });
});

describe('modCavityMesh — property tests over the parameter space', () => {
  it('stays a clean closed solid with an exact on-mesh outline for varied params', () => {
    fc.assert(
      fc.property(
        fc.record({
          lengthMm: fc.double({ min: 8, max: 14, noNaN: true }),
          widthMm: fc.double({ min: 7, max: 11, noNaN: true }),
          isthmusWidthMm: fc.double({ min: 1.5, max: 4, noNaN: true }),
          isthmusDepthMm: fc.double({ min: 1.0, max: 2.5, noNaN: true }),
          boxDepthMm: fc.double({ min: 2.5, max: 4.5, noNaN: true }),
          boxLengthMm: fc.double({ min: 1.5, max: 3.5, noNaN: true }),
          taperDeg: fc.double({ min: 2, max: 12, noNaN: true }),
          reducedCusp: fc.boolean(),
          mdSegmentsPerZone: fc.integer({ min: 2, max: 5 }),
        }),
        (o: ModCavityMeshOptions) => {
          // Guard the generators so every case is a geometrically-valid MOD
          // (the fixture throws otherwise — these are its documented invariants,
          // not flaky bugs). Phase 4 flaky-test lesson: fc.pre, never rely on
          // luck to avoid the invalid corner.
          const tan = Math.tan(((o.taperDeg ?? 6) * Math.PI) / 180);
          fc.pre(o.boxDepthMm! > o.isthmusDepthMm! + 0.2);
          fc.pre(2 * o.boxLengthMm! < o.lengthMm! - 1); // a real isthmus remains
          fc.pre(o.isthmusWidthMm! < o.widthMm! - 1);
          fc.pre(o.isthmusWidthMm! / 2 - o.boxDepthMm! * tan > 0.2); // drafted box floor stays wide
          fc.pre(o.tableZ === undefined); // tableZ default 6 ⇒ gingival floor > 0 for boxDepth ≤ 4.5

          const f = modCavityMesh(o);
          const stats = analyzeMesh(f.mesh);
          expect(stats.watertight).toBe(true);
          expect(stats.componentCount).toBe(1);
          expect(stats.degenerateCount).toBe(0);
          expect(stats.signedVolumeMm3!).toBeGreaterThan(0);

          const keys = meshVertexKeys(f.mesh.positions);
          for (const p of f.cavityOutline) expect(keys.has(key(p))).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });
});
