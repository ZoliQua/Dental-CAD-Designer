// packages/io/src/stl/roundtrip.property.test.ts
//
// Property-based round-trip test (fast-check): writeStlBinary -> parseStl
// must preserve triangle positions bit-exactly. Binary STL's on-disk
// coordinate representation is IEEE-754 float32 (see binary.ts's module
// doc), so the property is scoped to float32-representable input values —
// generating with `fc.float()` (which samples exact float32 values,
// losslessly widened to JS's float64 number type) makes the round trip a
// real bit-exactness claim rather than one silently laundered through
// float32 rounding.
//
// Seeded explicitly (not left to fast-check's auto-random seed) so CI runs
// are reproducible — see docs/plans/phase-1-import-viewer.md's
// determinism constraint and this task's "pristine, seeded" guardrail.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RawTriangleSoup } from '../types.ts';
import { writeStlBinary } from './binary.ts';
import { parseStl } from './parse.ts';

const PROPERTY_SEED = 1234567890;

const finiteFloat32 = fc.float({ noNaN: true, noDefaultInfinity: true });
const vec3Arb = fc.tuple(finiteFloat32, finiteFloat32, finiteFloat32);
const triangleArb = fc.record({
  normal: vec3Arb,
  v0: vec3Arb,
  v1: vec3Arb,
  v2: vec3Arb,
});

interface Triangle {
  normal: readonly [number, number, number];
  v0: readonly [number, number, number];
  v1: readonly [number, number, number];
  v2: readonly [number, number, number];
}

function soupFromTriangles(triangles: readonly Triangle[]): RawTriangleSoup {
  const triangleCount = triangles.length;
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  triangles.forEach((t, i) => {
    normals.set(t.normal, i * 3);
    positions.set([...t.v0, ...t.v1, ...t.v2], i * 9);
  });
  return { positions, normals, triangleCount };
}

describe('writeStlBinary -> parseStl round trip (property)', () => {
  it('preserves triangle positions bit-exactly for float32-representable coordinates', () => {
    fc.assert(
      fc.property(fc.array(triangleArb, { maxLength: 30 }), (triangles) => {
        const soup = soupFromTriangles(triangles);
        const bytes = writeStlBinary(soup);
        const { soup: parsed } = parseStl(bytes);

        expect(parsed.triangleCount).toBe(soup.triangleCount);
        expect(Array.from(parsed.positions)).toEqual(Array.from(soup.positions));
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });

  it('preserves stored normals bit-exactly when useSourceNormals is set', () => {
    fc.assert(
      fc.property(fc.array(triangleArb, { minLength: 1, maxLength: 30 }), (triangles) => {
        const soup = soupFromTriangles(triangles);
        const bytes = writeStlBinary(soup, { useSourceNormals: true });
        const { soup: parsed } = parseStl(bytes);

        expect(Array.from(parsed.normals!)).toEqual(Array.from(soup.normals!));
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});
