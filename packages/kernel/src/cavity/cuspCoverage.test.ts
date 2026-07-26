// packages/kernel/src/cavity/cuspCoverage.test.ts
//
// Phase 5 Task 7 — cusp identification + onlay outline extension, tested against
// the analytic onlay fixture's CLOSED-FORM cusp geometry and extended outline.
//   - identifyCuspRegions finds exactly the two cusps (intact LINGUAL at
//     lingualCuspTipZ, reduced BUCCAL crest at covMarginZ) — heights + tip
//     positions closed-form; reducedCusp (deeper reduction) tracked;
//   - extendOutlineOverCusp reproduces `onlayOutline` EXACTLY (bit-exact set),
//     the ring is closed + on-mesh, and its rerouted buccal run lands on the
//     coverage-margin crest (closed-form positioned);
//   - determinism (byte-identical double run + committed sha256 pin);
//   - fc.pre-guarded property over the fixture's reduction/geometry space.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { analyzeMesh } from '../intake/analyze.ts';
import { modOnlayCavityMesh } from './cavity.test-fixtures.ts';
import {
  identifyCuspRegions,
  extendOutlineOverCusp,
  NoCuspFoundError,
  CoverageBoundaryError,
} from './cuspCoverage.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const AXIS: Vec3 = [0, 0, 1];
const key = (p: Vec3): string => `${p[0]}|${p[1]}|${p[2]}`;

function sha256Points(pts: readonly Vec3[]): string {
  const h = createHash('sha256');
  h.update(Buffer.from(new Float64Array(pts.flatMap((p) => [p[0], p[1], p[2]])).buffer));
  return h.digest('hex');
}

describe('modOnlayCavityMesh — onlay fixture topology + closed-form outline', () => {
  it('is a watertight single-component solid (default + thin + deeper-reduction + chamfered junction)', () => {
    for (const o of [{}, { reductionTableZ: 6.2 }, { reductionTableZ: 4.2 }, { junctionChamferMm: 0.2 }, { junctionChamferMm: 0.4 }]) {
      const fx = modOnlayCavityMesh(o);
      const st = analyzeMesh(fx.mesh);
      expect(st.watertight, JSON.stringify(o)).toBe(true);
      expect(st.componentCount).toBe(1);
      expect(st.degenerateCount).toBe(0);
      expect(st.signedVolumeMm3!).toBeGreaterThan(0);
    }
  });

  it('junctionChamferMm validates its room (>= 0, < bevel length, < wall length)', () => {
    expect(() => modOnlayCavityMesh({ junctionChamferMm: -0.1 })).toThrow(RangeError);
    // wall length ≈ 0.66 mm on the default — a chamfer beyond it must throw
    expect(() => modOnlayCavityMesh({ junctionChamferMm: 0.7 })).toThrow(RangeError);
  });

  it('onlayOutline is closed on-mesh and its buccal run is the coverage-margin crest', () => {
    const fx = modOnlayCavityMesh();
    const meshKeys = new Set<string>();
    for (let v = 0; v < fx.mesh.positions.length / 3; v++) {
      meshKeys.add(key([fx.mesh.positions[v * 3]!, fx.mesh.positions[v * 3 + 1]!, fx.mesh.positions[v * 3 + 2]!]));
    }
    // every outline point is a mesh vertex; first !== last (open ring)
    for (const p of fx.onlayOutline) expect(meshKeys.has(key(p))).toBe(true);
    expect(key(fx.onlayOutline[0]!)).not.toBe(key(fx.onlayOutline[fx.onlayOutline.length - 1]!));
    // the buccal run lands EXACTLY on the crest (y = -covMarginY, z = covMarginZ)
    const buccal = fx.onlayOutline.filter((p) => p[1] === -fx.covMarginY);
    expect(buccal.length).toBeGreaterThan(0);
    for (const p of buccal) expect(p[2]).toBe(fx.covMarginZ);
  });
});

describe('identifyCuspRegions — closed-form cusp detection', () => {
  it('finds exactly the two cusps (lingual intact, buccal reduced crest)', () => {
    const fx = modOnlayCavityMesh();
    const res = identifyCuspRegions(fx.mesh, AXIS);
    expect(res.cusps.length).toBe(2);
    // sorted by height desc: lingual (7.5) then buccal crest (7.0)
    expect(res.cusps[0]!.tipHeightMm).toBeCloseTo(fx.lingualCuspTipZ, 10);
    expect(res.cusps[0]!.tipPositionMm[1]).toBeGreaterThan(0); // lingual (+y)
    expect(res.cusps[1]!.tipHeightMm).toBeCloseTo(fx.covMarginZ, 10);
    expect(res.cusps[1]!.tipPositionMm[1]).toBeLessThan(0); // buccal (-y)
  });

  it('tracks a deeper reduction (a lower buccal crest is a lower cusp)', () => {
    const shallow = identifyCuspRegions(modOnlayCavityMesh({ covMarginZ: 7.2 }).mesh, AXIS);
    const buccalShallow = shallow.cusps.find((c) => c.tipPositionMm[1] < 0)!;
    expect(buccalShallow.tipHeightMm).toBeCloseTo(7.2, 10);
  });

  it('throws NoCuspFoundError on an axis with no occlusal surface', () => {
    const fx = modOnlayCavityMesh();
    // an in-plane axis: no triangle faces it as an occlusal upward surface with a maximum
    expect(() => identifyCuspRegions(fx.mesh, [0, 0, 1], { occlusalMaxAngleDeg: 0.001 })).toThrow(NoCuspFoundError);
  });

  it('throws on a zero-length axis', () => {
    const fx = modOnlayCavityMesh();
    expect(() => identifyCuspRegions(fx.mesh, [0, 0, 0])).toThrow(TypeError);
  });
});

describe('extendOutlineOverCusp — the onlay outline extension', () => {
  const fx = modOnlayCavityMesh();
  const res = extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, fx.coveredCuspTriangleIndices);

  it('reproduces the fixture onlayOutline EXACTLY (bit-exact set)', () => {
    const extSet = new Set(res.extendedOutline.map(key));
    const onlaySet = new Set(fx.onlayOutline.map(key));
    expect(extSet.size).toBe(onlaySet.size);
    for (const k of onlaySet) expect(extSet.has(k)).toBe(true);
  });

  it('the extended ring is closed, on-mesh, and larger than the base outline', () => {
    const meshKeys = new Set<string>();
    for (let v = 0; v < fx.mesh.positions.length / 3; v++) {
      meshKeys.add(key([fx.mesh.positions[v * 3]!, fx.mesh.positions[v * 3 + 1]!, fx.mesh.positions[v * 3 + 2]!]));
    }
    for (const p of res.extendedOutline) expect(meshKeys.has(key(p))).toBe(true);
    // the extension moved the buccal run out to the crest, so it grew
    expect(res.extendedOutline.length).toBeGreaterThan(fx.inlayOutline.length);
    // no duplicate vertices in the ring
    expect(new Set(res.extendedOutline.map(key)).size).toBe(res.extendedOutline.length);
  });

  it('the rerouted buccal run lands on sound structure past the cusp (the crest)', () => {
    // base outline buccal run was the cavity rim (z = reductionTableZ); the
    // extended one is the coverage crest (z = covMarginZ, further buccal)
    const baseBuccalZ = fx.inlayOutline.filter((p) => p[1] < 0 && p[2] === fx.reductionTableZ);
    const extBuccalCrest = res.extendedOutline.filter((p) => p[1] === -fx.covMarginY && p[2] === fx.covMarginZ);
    expect(baseBuccalZ.length).toBeGreaterThan(0);
    expect(extBuccalCrest.length).toBeGreaterThan(0);
    expect(fx.covMarginZ).toBeGreaterThan(fx.reductionTableZ); // crest above the rim
  });

  it('is deterministic (byte-identical double run + committed sha256)', () => {
    const a = extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, fx.coveredCuspTriangleIndices);
    const b = extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, fx.coveredCuspTriangleIndices);
    const ha = sha256Points(a.extendedOutline);
    expect(ha).toBe(sha256Points(b.extendedOutline));
     
    console.log(`[CUSP COVERAGE GOLDEN] extendedOutline sha256 = ${ha} (len ${a.extendedOutline.length})`);
    expect(ha).toBe('c0f4ad5e37be55ac948c80fc9b30fe9f4ce81da7e81ec73653565f294de81734');
  });

  it('throws CoverageBoundaryError when the covered selection is disconnected from the cavity', () => {
    // a base triangle (all vertices on the gingival base, z = 0) is disconnected
    // from the cavity — the union is two components → two boundary loops.
    let baseTri = -1;
    for (let t = 0; t < fx.mesh.indices.length / 3; t++) {
      const a = fx.mesh.indices[t * 3]!, b = fx.mesh.indices[t * 3 + 1]!, c = fx.mesh.indices[t * 3 + 2]!;
      if (fx.mesh.positions[a * 3 + 2] === 0 && fx.mesh.positions[b * 3 + 2] === 0 && fx.mesh.positions[c * 3 + 2] === 0) { baseTri = t; break; }
    }
    expect(baseTri).toBeGreaterThanOrEqual(0);
    expect(() => extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, [baseTri])).toThrow(CoverageBoundaryError);
  });
});

describe('extendOutlineOverCusp — property (fc.pre-guarded)', () => {
  it('for any valid reduction/geometry: extension reproduces onlayOutline, closed + on-mesh', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 4.1, max: 6.4, noNaN: true }), // reductionTableZ (floorZ=4 < rtz < covMarginZ=7)
        fc.double({ min: 5.6, max: 6.4, noNaN: true }), // covMarginY (isthmusHalf=3 < y < halfWidth=6.5)
        (rtz, covY) => {
          fc.pre(rtz < 6.9 && rtz > 4.05);
          fc.pre(covY < 6.45 && covY > 3.1);
          const fx = modOnlayCavityMesh({ reductionTableZ: rtz, covMarginY: covY });
          const ext = extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, fx.coveredCuspTriangleIndices);
          const extSet = new Set(ext.extendedOutline.map(key));
          const onlaySet = new Set(fx.onlayOutline.map(key));
          expect(extSet.size).toBe(onlaySet.size);
          for (const k of onlaySet) expect(extSet.has(k)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });
});
