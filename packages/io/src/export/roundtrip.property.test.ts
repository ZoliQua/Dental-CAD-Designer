// packages/io/src/export/roundtrip.property.test.ts
//
// Property-based round-trip law for the export entries (fast-check, seeded
// — determinism constraint): for ANY valid watertight outward tetrahedron,
//
//   parseStl(exportStlBinary(M)).soup.positions
//     === fround(expand-per-triangle(M.positions))   (bit-exact)
//
// i.e. the STL byte round trip is EXACTLY the float32 narrowing function
// and nothing else — the format's documented precision floor (see
// stl.ts's @errorBound). The PLY round trip is the identity (float64 on
// disk). Random tetrahedra are the smallest watertight solids, so the
// export validation (topology + orientation) runs on every sample too.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../stl/parse.ts';
import { parsePly } from '../ply/parse.ts';
import type { ExportableMesh } from './types.ts';
import { exportStlBinary } from './stl.ts';
import { exportPlyBinary } from './ply.ts';
import { f32UlpAt, measureF32NarrowingError } from './narrowing.ts';

const PROPERTY_SEED = 987654321;

/** Signed volume of the tetrahedron (a, b, c, d) — det/6, closed form. */
function tetSignedVolume(p: readonly number[]): number {
  const [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz] = p as [
    number, number, number, number, number, number,
    number, number, number, number, number, number,
  ];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const wx = dx - ax, wy = dy - ay, wz = dz - az;
  return (
    (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6
  );
}

/** Outward-oriented tetrahedron over 4 points (orientation fixed by the
 * sign of the closed-form volume; near-degenerate samples are filtered by
 * the caller's fc.pre). */
function tetMesh(p: readonly number[]): ExportableMesh {
  const positions = new Float64Array(p);
  const positive = tetSignedVolume(p) > 0;
  // For a positively-oriented point tuple (d on the +side of triangle
  // (a,b,c) wound CCW seen from outside opposite d), the outward faces are:
  const indices = positive
    ? new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])
    : new Uint32Array([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3]);
  return { positions, indices };
}

const coordF64 = fc.double({ noNaN: true, min: -200, max: 200 });
const coordF32 = fc.float({ noNaN: true, min: Math.fround(-200), max: Math.fround(200) });

/** The suite's stated validity conditions, ENFORCED by construction (not
 * left to seed luck — Task 2 review finding 2): nonzero f64 volume AND the
 * f32-narrowed volume keeps the same sign (`exportStlBinary` itself
 * rejects narrowing-inverted solids with `'inward-orientation-narrowed'`;
 * that rejection path has its own dedicated regression test in
 * stl.export.test.ts, built from the review's adversarial tetrahedron). */
function isValidTet(p: readonly number[]): boolean {
  const v64 = tetSignedVolume(p);
  if (Math.abs(v64) <= 1e-3) return false;
  const v32 = tetSignedVolume(p.map(Math.fround));
  return Math.sign(v32) === Math.sign(v64);
}

function tetArb(coord: fc.Arbitrary<number>): fc.Arbitrary<readonly number[]> {
  return fc.array(coord, { minLength: 12, maxLength: 12 }).filter(isValidTet);
}

/** Expands an indexed mesh into per-triangle vertex order — the documented
 * export triangle-ordering rule, reimplemented independently here. */
function expandPositions(mesh: ExportableMesh): Float64Array {
  const triangleCount = mesh.indices.length / 3;
  const out = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.indices[t * 3 + corner]! * 3;
      out.set([mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!], t * 9 + corner * 3);
    }
  }
  return out;
}

describe('export round-trip law (property)', () => {
  it('STL: byte round trip IS the f32 narrowing function, bit-exactly', () => {
    fc.assert(
      fc.property(tetArb(coordF64), (p) => {
        const mesh = tetMesh(p);
        const { soup, diagnostics } = parseStl(exportStlBinary(mesh));
        expect(diagnostics.warnings).toHaveLength(0);
        expect(soup.triangleCount).toBe(4);
        const expected = expandPositions(mesh);
        for (let i = 0; i < expected.length; i++) {
          expect(soup.positions[i]).toBe(Math.fround(expected[i]!));
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('STL: measured narrowing error obeys the documented @errorBound on every sample', () => {
    fc.assert(
      fc.property(tetArb(coordF64), (p) => {
        const mesh = tetMesh(p);
        const { soup } = parseStl(exportStlBinary(mesh));
        const expected = expandPositions(mesh);
        let maxError = 0;
        for (let i = 0; i < expected.length; i++) {
          maxError = Math.max(maxError, Math.abs(expected[i]! - soup.positions[i]!));
        }
        const report = measureF32NarrowingError(mesh.positions);
        expect(maxError).toBeLessThanOrEqual(report.maxHalfUlpBoundMm);
        // And the bound itself is what the TSDoc promises: half the f32 ULP
        // at the largest coordinate magnitude present.
        expect(report.maxHalfUlpBoundMm).toBeLessThanOrEqual(f32UlpAt(report.maxAbsCoordinateMm) / 2);
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('STL: float32-representable input round-trips losslessly (narrowing is the identity)', () => {
    fc.assert(
      fc.property(tetArb(coordF32), (p) => {
        const mesh = tetMesh(p);
        const { soup } = parseStl(exportStlBinary(mesh));
        const expected = expandPositions(mesh);
        expect(Array.from(soup.positions)).toEqual(Array.from(expected));
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('PLY: byte round trip is the identity on positions and indices (float64 on disk)', () => {
    fc.assert(
      fc.property(tetArb(coordF64), (p) => {
        const mesh = tetMesh(p);
        const parsed = parsePly(exportPlyBinary(mesh));
        // The parser reports the deterministic units-marker comment as its
        // single diagnostics entry.
        expect(parsed.diagnostics.warnings).toHaveLength(1);
        expect(Array.from(parsed.positions)).toEqual(Array.from(mesh.positions));
        expect(Array.from(parsed.indices)).toEqual(Array.from(mesh.indices));
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });
});
