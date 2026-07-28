// packages/kernel/src/bridge/bridge.fixture.test.ts
//
// Phase 6 Task 1: closed-form assertions for the analytic 3-unit bridge fixture
// (bridge.test-fixtures.ts) — the fixture every later Phase 6 task tests
// against, so its guarantees are pinned HERE. The exactness policy is asserted
// EXACTLY as the module doc states it: BITWISE where the construction is exact
// (local ring, margin plane under pure translation, shared axis at tilt 0, crest
// on the analytic cylinder), BOUNDED where a coordinate sum or rotation rounds
// (world radius), and FALSIFIABLE for the tilt knob (a genuine non-parallel axis).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { analyzeMesh } from '../intake/analyze.ts';
import { bridgeFixture, type BridgeFixtureOptions } from './bridge.test-fixtures.ts';

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

// ===========================================================================
// Component topology
// ===========================================================================
describe('bridgeFixture — every component is a clean closed solid', () => {
  const f = bridgeFixture();

  it.each([
    ['mesial die', () => f.mesial.mesh],
    ['distal die', () => f.distal.mesh],
    ['ridge', () => f.ridge.mesh],
  ])('%s is watertight, 2-manifold, single-component, positive-volume, degenerate-free', (_label, get) => {
    const stats = analyzeMesh(get());
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
  });

  it('the tilted-distal-die variant is also a clean closed solid (rigid transform preserves topology)', () => {
    const tilted = bridgeFixture({ tiltDeg: 20 });
    const stats = analyzeMesh(tilted.distal.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
  });

  it('the optional antagonist slab is a clean closed solid when requested', () => {
    const withAnt = bridgeFixture({ withAntagonist: true });
    expect(withAnt.antagonist).not.toBeNull();
    const stats = analyzeMesh(withAnt.antagonist!);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(bridgeFixture().antagonist).toBeNull(); // default off
  });
});

// ===========================================================================
// Die placement + the margin-ring exactness policy
// ===========================================================================
describe('bridgeFixture — dies sit at closed-form positions', () => {
  const f = bridgeFixture({ spanMm: 14 });

  it('the die axes are span/2 apart on X (world margin centres)', () => {
    expect(f.mesial.worldMarginCenterMm[0]).toBeCloseTo(-7, 12);
    expect(f.distal.worldMarginCenterMm[0]).toBeCloseTo(+7, 12);
    // pontic site at the origin, dies flanking it
    expect(f.mesial.worldMarginCenterMm[0]).toBeLessThan(0);
    expect(f.distal.worldMarginCenterMm[0]).toBeGreaterThan(0);
  });

  it('BITWISE: each die local margin ring lies exactly on its analytic circle (shoulderPrepMesh exact ring)', () => {
    for (const die of [f.mesial, f.distal]) {
      for (const s of [0, 1, 7, 31, 63]) {
        const theta = (2 * Math.PI * s) / 128;
        const expected: Vec3 = [
          die.marginRadiusMm * Math.cos(theta),
          die.marginRadiusMm * Math.sin(theta),
          die.marginHeightMm,
        ];
        // strict bitwise equality — the ring is placed directly from the formula
        expect(die.localMarginRing[s]).toEqual(expected);
      }
    }
  });

  it('BITWISE: every WORLD margin-ring vertex is exactly a vertex of its die mesh', () => {
    for (const die of [f.mesial, f.distal]) {
      const keys = meshVertexKeys(die.mesh.positions);
      for (const p of die.worldMarginRing) expect(keys.has(key(p))).toBe(true);
    }
  });

  it('BITWISE: under pure translation (tilt 0) the margin PLANE is untouched — every world ring Z === marginHeightMm', () => {
    for (const die of [f.mesial, f.distal]) {
      for (const p of die.worldMarginRing) {
        expect(p[2]).toBe(die.marginHeightMm); // strict === : translation never touches Z
      }
    }
  });

  it('BOUNDED: the world ring radius equals marginRadiusMm to 1e-14 mm (a single coordinate-sum rounding, NOT bitwise; true error ~ a few ULPs ≈ 4e-16 — reviewer-verified)', () => {
    for (const die of [f.mesial, f.distal]) {
      const [cx, cy] = die.worldMarginCenterMm;
      for (const p of die.worldMarginRing) {
        const r = Math.hypot(p[0] - cx, p[1] - cy);
        expect(Math.abs(r - die.marginRadiusMm)).toBeLessThan(1e-14);
      }
    }
  });
});

// ===========================================================================
// The shared insertion axis + the falsifiable tilt knob
// ===========================================================================
describe('bridgeFixture — shared insertion axis (Task 2 currency)', () => {
  it('BITWISE parallel at tiltDeg 0: both die axes === [0,0,1] (a shared axis exists)', () => {
    const f = bridgeFixture({ tiltDeg: 0 });
    expect(f.mesial.insertionAxis).toEqual([0, 0, 1]);
    expect(f.distal.insertionAxis).toEqual([0, 0, 1]);
    expect(f.mesial.insertionAxis).toEqual(f.distal.insertionAxis);
  });

  it('FALSIFIABLE: tiltDeg > 0 makes the distal axis genuinely non-parallel by exactly tiltDeg', () => {
    for (const tiltDeg of [5, 12, 20]) {
      const f = bridgeFixture({ tiltDeg });
      const m = f.mesial.insertionAxis;
      const d = f.distal.insertionAxis;
      const dot = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
      const angleDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
      expect(angleDeg).toBeCloseTo(tiltDeg, 9); // analytic: the between-axis angle IS tiltDeg
      expect(angleDeg).toBeGreaterThan(0); // no shared undercut-free axis
      // the distal axis is exactly [sin, 0, cos]
      const tiltRad = (tiltDeg * Math.PI) / 180;
      expect(d).toEqual([Math.sin(tiltRad), 0, Math.cos(tiltRad)]);
    }
  });
});

// ===========================================================================
// The pontic-site gingiva ridge — closed-form crest on an analytic cylinder
// ===========================================================================
describe('bridgeFixture — the pontic ridge is closed-form', () => {
  const f = bridgeFixture({ ridgeCrestRadiusMm: 3, ridgeCrestCenterZMm: 1, ridgeHalfLengthMm: 2.5 });
  const r = f.ridge;

  it('the bounding box matches the crest cylinder + base closed-form', () => {
    const { bbox } = analyzeMesh(r.mesh);
    expect(bbox.min[0]).toBeCloseTo(-r.halfLengthMm, 10);
    expect(bbox.max[0]).toBeCloseTo(+r.halfLengthMm, 10);
    expect(bbox.min[1]).toBeCloseTo(-r.crestRadiusMm, 10);
    expect(bbox.max[1]).toBeCloseTo(+r.crestRadiusMm, 10);
    expect(bbox.min[2]).toBeCloseTo(0, 10); // flat base
    expect(bbox.max[2]).toBe(r.crestApexZMm); // apex is a bitwise-exact vertex
    expect(r.crestApexZMm).toBe(r.crestCenterZMm + r.crestRadiusMm);
  });

  it('BITWISE: the crest apex line (x, 0, apexZ) is a mesh vertex at every station', () => {
    const keys = meshVertexKeys(r.mesh.positions);
    for (const x of r.apexStationsX) {
      expect(keys.has(key([x, 0, r.crestApexZMm]))).toBe(true);
    }
  });

  it('BITWISE: every crest vertex (z > base) lies exactly on the analytic cylinder z = zc + sqrt(R^2 - y^2)', () => {
    const p = r.mesh.positions;
    let crestChecked = 0;
    for (let i = 0; i < p.length; i += 3) {
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (z === 0) continue; // base ring vertices
      const expected = y === 0 ? r.crestCenterZMm + r.crestRadiusMm : r.crestCenterZMm + Math.sqrt(r.crestRadiusMm * r.crestRadiusMm - y * y);
      expect(z).toBe(expected); // strict bitwise: the crest is placed directly from the cylinder formula
      crestChecked++;
    }
    expect(crestChecked).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Determinism
// ===========================================================================
describe('bridgeFixture — determinism', () => {
  it('two default builds are byte-identical for every component', () => {
    const a = bridgeFixture();
    const b = bridgeFixture();
    for (const pick of [(f: ReturnType<typeof bridgeFixture>) => f.mesial.mesh, (f: ReturnType<typeof bridgeFixture>) => f.distal.mesh, (f: ReturnType<typeof bridgeFixture>) => f.ridge.mesh]) {
      expect(hashMesh(pick(a).positions, pick(a).indices)).toBe(hashMesh(pick(b).positions, pick(b).indices));
    }
  });

  it('the tilted + antagonist variant is deterministic too', () => {
    const a = bridgeFixture({ tiltDeg: 17, withAntagonist: true });
    const b = bridgeFixture({ tiltDeg: 17, withAntagonist: true });
    expect(hashMesh(a.distal.mesh.positions, a.distal.mesh.indices)).toBe(hashMesh(b.distal.mesh.positions, b.distal.mesh.indices));
    expect(hashMesh(a.antagonist!.positions, a.antagonist!.indices)).toBe(hashMesh(b.antagonist!.positions, b.antagonist!.indices));
  });
});

// ===========================================================================
// Documented invariants (rejects invalid params)
// ===========================================================================
describe('bridgeFixture — rejects geometrically-invalid parameters', () => {
  it.each([
    ['negative span', { spanMm: -1 }, /spanMm must be > 0/],
    ['tilt at/over 90deg', { tiltDeg: 90 }, /tiltDeg must be in/],
    ['negative tilt', { tiltDeg: -5 }, /tiltDeg must be in/],
    ['zero crest radius', { ridgeCrestRadiusMm: 0 }, /ridgeCrestRadiusMm must be > 0/],
    ['crest feet below base', { ridgeCrestCenterZMm: 0 }, /ridgeCrestCenterZMm must be > 0/],
    ['zero ridge length', { ridgeHalfLengthMm: 0 }, /ridgeHalfLengthMm must be > 0/],
    ['odd crest segments (no exact apex)', { ridgeCrestSegments: 31 }, /even integer/],
  ])('throws for %s', (_label, opts: BridgeFixtureOptions, re) => {
    expect(() => bridgeFixture(opts)).toThrow(re);
  });
});

// ===========================================================================
// Property tests over the parameter space (fc.pre-guarded)
// ===========================================================================
describe('bridgeFixture — property tests', () => {
  it('every component stays a clean closed solid with an on-mesh margin ring and a well-defined axis angle', () => {
    fc.assert(
      fc.property(
        fc.record({
          spanMm: fc.double({ min: 10, max: 20, noNaN: true }),
          tiltDeg: fc.double({ min: 0, max: 40, noNaN: true }),
          ridgeCrestRadiusMm: fc.double({ min: 1.5, max: 4, noNaN: true }),
          ridgeCrestCenterZMm: fc.double({ min: 0.5, max: 2, noNaN: true }),
          ridgeHalfLengthMm: fc.double({ min: 1.5, max: 4, noNaN: true }),
          ridgeCrestSegments: fc.integer({ min: 2, max: 12 }).map((n) => n * 2), // always even
          ridgeStations: fc.integer({ min: 2, max: 6 }),
        }),
        (o: BridgeFixtureOptions) => {
          fc.pre((o.spanMm ?? 14) > 2 * (o.ridgeHalfLengthMm ?? 2.5)); // dies flank, do not straddle, the ridge
          const f = bridgeFixture(o);
          for (const mesh of [f.mesial.mesh, f.distal.mesh, f.ridge.mesh]) {
            const stats = analyzeMesh(mesh);
            expect(stats.watertight).toBe(true);
            expect(stats.componentCount).toBe(1);
            expect(stats.degenerateCount).toBe(0);
            expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
          }
          // world margin ring is always on the die mesh (bitwise)
          for (const die of [f.mesial, f.distal]) {
            const keys = meshVertexKeys(die.mesh.positions);
            for (const p of die.worldMarginRing) expect(keys.has(key(p))).toBe(true);
          }
          // the between-axis angle is exactly tiltDeg
          const d = f.distal.insertionAxis;
          const angleDeg = (Math.acos(Math.min(1, Math.max(-1, d[2]))) * 180) / Math.PI;
          expect(angleDeg).toBeCloseTo(o.tiltDeg ?? 0, 6);
        },
      ),
      { numRuns: 40 },
    );
  });
});
