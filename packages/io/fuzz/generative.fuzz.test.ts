// packages/io/fuzz/generative.fuzz.test.ts
//
// Generative fuzzing (task brief §1b): build random VALID files — random
// header property layouts (PLY) and random valid ASCII text shapes (STL) —
// with known ground truth, parse them, and assert the parse matches that
// ground truth exactly. Unlike mutation fuzzing (which explores the space
// of BROKEN inputs), this explores the space of the format's own
// flexibility (property order, endianness, vertex/face counts, tolerant
// ASCII whitespace/case) to catch "parses successfully but wrong" bugs
// that mutation fuzzing's IoParseError-or-finite check wouldn't detect on
// its own.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../src/stl/parse.ts';
import { parsePly } from '../src/ply/parse.ts';
import type { PlyFormat } from '../src/ply/types.ts';
import { exportStlBinary } from '../src/export/stl.ts';
import { exportPlyBinary } from '../src/export/ply.ts';
import type { ExportableMesh } from '../src/export/types.ts';

const GENERATIVE_RUNS = 1500;

// ---------------------------------------------------------------------------
// PLY: random property layout x random format x random vertex/face counts
// x random (finite, float64-exact-round-trippable) values.
// ---------------------------------------------------------------------------

/** A handful of concrete property orderings, each a permutation of x/y/z
 * optionally interleaved with a normal triple and/or a color triple —
 * covers "any header order is valid" (plan.ts resolves purely by name)
 * more directly than reusing the STL/PLY writers' own fixed emission
 * order. Colors are declared as `float64` (not the conventional `uchar`)
 * specifically so the ground-truth comparison can be an EXACT equality
 * check, independent of scalars.ts's uchar-quantization behavior (that
 * lossy path is already covered by ply/binary.test.ts's dedicated tests). */
const PLY_LAYOUTS: readonly { properties: readonly string[]; hasNormals: boolean; hasColors: boolean }[] = [
  { properties: ['x', 'y', 'z'], hasNormals: false, hasColors: false },
  { properties: ['z', 'y', 'x'], hasNormals: false, hasColors: false },
  { properties: ['x', 'y', 'z', 'nx', 'ny', 'nz'], hasNormals: true, hasColors: false },
  { properties: ['nx', 'ny', 'nz', 'x', 'y', 'z'], hasNormals: true, hasColors: false },
  { properties: ['x', 'nx', 'y', 'ny', 'z', 'nz'], hasNormals: true, hasColors: false },
  { properties: ['x', 'y', 'z', 'red', 'green', 'blue'], hasNormals: false, hasColors: true },
  { properties: ['red', 'x', 'green', 'y', 'blue', 'z'], hasNormals: false, hasColors: true },
  {
    properties: ['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue'],
    hasNormals: true,
    hasColors: true,
  },
  {
    properties: ['blue', 'green', 'red', 'nz', 'ny', 'nx', 'z', 'y', 'x'],
    hasNormals: true,
    hasColors: true,
  },
];

const PLY_FORMATS: readonly PlyFormat[] = ['ascii', 'binary_little_endian', 'binary_big_endian'];

// `-0` is excluded: `(-0).toString() === '0'` per the ECMAScript spec (the
// sign is lost in text form), so an ASCII round trip of exactly `-0`
// legitimately comes back as `+0` — a real, harmless property of decimal
// text serialization, not a parser bug, but one that would make an
// `Object.is`-sensitive ground-truth equality check flaky/wrong here.
const finiteValueArb = fc
  .double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 })
  .filter((v) => !Object.is(v, -0));

interface PlyGroundTruth {
  format: PlyFormat;
  layout: (typeof PLY_LAYOUTS)[number];
  vertexValues: Map<string, number>[]; // one map per vertex, keyed by property name
  triangleIndices: readonly (readonly [number, number, number])[];
}

function buildPlyBytes(gt: PlyGroundTruth): Uint8Array {
  const headerLines = ['ply', `format ${gt.format} 1.0`];
  headerLines.push(`element vertex ${gt.vertexValues.length}`);
  for (const name of gt.layout.properties) {
    headerLines.push(`property float64 ${name}`);
  }
  headerLines.push(`element face ${gt.triangleIndices.length}`);
  headerLines.push('property list uchar uint32 vertex_indices');
  headerLines.push('end_header');
  const headerText = headerLines.join('\n') + '\n';
  const headerBytes = new TextEncoder().encode(headerText);

  if (gt.format === 'ascii') {
    const rows: string[] = [];
    for (const vertex of gt.vertexValues) {
      rows.push(gt.layout.properties.map((name) => String(vertex.get(name))).join(' '));
    }
    for (const [a, b, c] of gt.triangleIndices) {
      rows.push(`3 ${a} ${b} ${c}`);
    }
    const bodyText = rows.length > 0 ? rows.join('\n') + '\n' : '';
    const bodyBytes = new TextEncoder().encode(bodyText);
    const out = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
    out.set(headerBytes, 0);
    out.set(bodyBytes, headerBytes.byteLength);
    return out;
  }

  const littleEndian = gt.format === 'binary_little_endian';
  const vertexRowBytes = gt.layout.properties.length * 8;
  const faceRowBytes = 1 + 3 * 4;
  const bodyBytes = gt.vertexValues.length * vertexRowBytes + gt.triangleIndices.length * faceRowBytes;
  const out = new Uint8Array(headerBytes.byteLength + bodyBytes);
  out.set(headerBytes, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let offset = headerBytes.byteLength;
  for (const vertex of gt.vertexValues) {
    for (const name of gt.layout.properties) {
      view.setFloat64(offset, vertex.get(name)!, littleEndian);
      offset += 8;
    }
  }
  for (const [a, b, c] of gt.triangleIndices) {
    view.setUint8(offset, 3);
    offset += 1;
    view.setUint32(offset, a, littleEndian);
    view.setUint32(offset + 4, b, littleEndian);
    view.setUint32(offset + 8, c, littleEndian);
    offset += 12;
  }
  return out;
}

const plyGroundTruthArb: fc.Arbitrary<PlyGroundTruth> = fc
  .record({
    format: fc.constantFrom(...PLY_FORMATS),
    layout: fc.constantFrom(...PLY_LAYOUTS),
    vertexCount: fc.integer({ min: 3, max: 12 }),
  })
  .chain(({ format, layout, vertexCount }) =>
    fc
      .array(
        fc.tuple(...layout.properties.map(() => finiteValueArb)) as fc.Arbitrary<readonly number[]>,
        { minLength: vertexCount, maxLength: vertexCount },
      )
      .chain((rows) =>
        fc
          .array(
            fc.tuple(
              fc.integer({ min: 0, max: vertexCount - 1 }),
              fc.integer({ min: 0, max: vertexCount - 1 }),
              fc.integer({ min: 0, max: vertexCount - 1 }),
            ),
            { minLength: 0, maxLength: 6 },
          )
          .map((triangleIndices) => ({
            format,
            layout,
            vertexValues: rows.map(
              (values) => new Map(layout.properties.map((name, i) => [name, values[i]!])),
            ),
            triangleIndices,
          })),
      ),
  );

describe('generative fuzzing: PLY (random property layouts x formats x counts)', () => {
  it(`random valid PLY files parse to exactly their ground truth — ${GENERATIVE_RUNS} runs`, () => {
    const seed = 20260716;
    fc.assert(
      fc.property(plyGroundTruthArb, (gt) => {
        const bytes = buildPlyBytes(gt);
        const mesh = parsePly(bytes);

        expect(mesh.diagnostics.format).toBe(
          gt.format === 'ascii' ? 'ply-ascii' : gt.format === 'binary_little_endian' ? 'ply-binary-le' : 'ply-binary-be',
        );
        expect(mesh.vertexCount).toBe(gt.vertexValues.length);
        expect(mesh.faceCount).toBe(gt.triangleIndices.length);

        const expectedPositions: number[] = [];
        const expectedNormals: number[] = [];
        const expectedColors: number[] = [];
        for (const vertex of gt.vertexValues) {
          expectedPositions.push(vertex.get('x')!, vertex.get('y')!, vertex.get('z')!);
          if (gt.layout.hasNormals) {
            expectedNormals.push(vertex.get('nx')!, vertex.get('ny')!, vertex.get('nz')!);
          }
          if (gt.layout.hasColors) {
            expectedColors.push(vertex.get('red')!, vertex.get('green')!, vertex.get('blue')!);
          }
        }
        expect(Array.from(mesh.positions)).toEqual(expectedPositions);
        if (gt.layout.hasNormals) {
          expect(Array.from(mesh.normals!)).toEqual(expectedNormals);
        } else {
          expect(mesh.normals).toBeNull();
        }
        if (gt.layout.hasColors) {
          expect(Array.from(mesh.colors!)).toEqual(expectedColors);
        } else {
          expect(mesh.colors).toBeNull();
        }
        const expectedIndices = gt.triangleIndices.flat();
        expect(Array.from(mesh.indices)).toEqual(expectedIndices);
      }),
      { seed, numRuns: GENERATIVE_RUNS },
    );
    expect(seed).toBe(20260716);
  });
});

// ---------------------------------------------------------------------------
// STL: random valid ASCII text (random facet count/values, random tolerant
// whitespace + keyword casing) compared against ground truth.
// ---------------------------------------------------------------------------

interface StlAsciiGroundTruth {
  triangles: readonly {
    normal: readonly [number, number, number];
    v0: readonly [number, number, number];
    v1: readonly [number, number, number];
    v2: readonly [number, number, number];
  }[];
  keywordCase: 'lower' | 'upper' | 'mixed';
  extraSpaces: number;
}

function applyCase(word: string, mode: StlAsciiGroundTruth['keywordCase']): string {
  if (mode === 'lower') return word.toLowerCase();
  if (mode === 'upper') return word.toUpperCase();
  return word
    .split('')
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join('');
}

function buildStlAsciiText(gt: StlAsciiGroundTruth): string {
  const pad = ' '.repeat(gt.extraSpaces);
  const kw = (w: string) => applyCase(w, gt.keywordCase);
  const lines: string[] = [`${kw('solid')}${pad} fuzz-generated`];
  for (const t of gt.triangles) {
    lines.push(`${kw('facet')}${pad} ${kw('normal')}${pad} ${t.normal.join(' ')}`);
    lines.push(`${kw('outer')}${pad} ${kw('loop')}`);
    lines.push(`${kw('vertex')}${pad} ${t.v0.join(' ')}`);
    lines.push(`${kw('vertex')}${pad} ${t.v1.join(' ')}`);
    lines.push(`${kw('vertex')}${pad} ${t.v2.join(' ')}`);
    lines.push(kw('endloop'));
    lines.push(kw('endfacet'));
  }
  lines.push(`${kw('endsolid')}${pad} fuzz-generated`);
  return lines.join('\n');
}

const vec3Arb = fc.tuple(finiteValueArb, finiteValueArb, finiteValueArb);
const triangleArb = fc.record({ normal: vec3Arb, v0: vec3Arb, v1: vec3Arb, v2: vec3Arb });
const stlAsciiGroundTruthArb: fc.Arbitrary<StlAsciiGroundTruth> = fc.record({
  triangles: fc.array(triangleArb, { minLength: 0, maxLength: 10 }),
  keywordCase: fc.constantFrom('lower', 'upper', 'mixed'),
  extraSpaces: fc.integer({ min: 0, max: 4 }),
});

describe('generative fuzzing: STL ASCII (random facet count/values x whitespace/case)', () => {
  it(`random valid ASCII STL text parses to exactly its ground truth — ${GENERATIVE_RUNS} runs`, () => {
    const seed = 20260717;
    fc.assert(
      fc.property(stlAsciiGroundTruthArb, (gt) => {
        const bytes = new TextEncoder().encode(buildStlAsciiText(gt));
        const { soup, diagnostics } = parseStl(bytes);
        expect(diagnostics.format).toBe('stl-ascii');
        expect(soup.triangleCount).toBe(gt.triangles.length);
        const expectedPositions = gt.triangles.flatMap((t) => [...t.v0, ...t.v1, ...t.v2]);
        const expectedNormals = gt.triangles.flatMap((t) => [...t.normal]);
        expect(Array.from(soup.positions)).toEqual(expectedPositions);
        expect(Array.from(soup.normals!)).toEqual(expectedNormals);
      }),
      { seed, numRuns: GENERATIVE_RUNS },
    );
    expect(seed).toBe(20260717);
  });
});

// ---------------------------------------------------------------------------
// Export entries (Phase 7 Task 2): the manufacturing writers' output fed
// straight through this package's own parsers — random valid watertight
// tetrahedra (the smallest closed solids) exported and re-parsed. Extends
// the corpus hookup in the cheapest honest way: every sample also exercises
// the export-side solid validation (topology + outward orientation).
// ---------------------------------------------------------------------------

/** det/6 of the tetrahedron spanned by the 4 points in `p` (12 values). */
function tetSignedVolume(p: readonly number[]): number {
  const ux = p[3]! - p[0]!, uy = p[4]! - p[1]!, uz = p[5]! - p[2]!;
  const vx = p[6]! - p[0]!, vy = p[7]! - p[1]!, vz = p[8]! - p[2]!;
  const wx = p[9]! - p[0]!, wy = p[10]! - p[1]!, wz = p[11]! - p[2]!;
  return (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
}

const tetPointsArb = fc
  .array(fc.double({ noNaN: true, min: -100, max: 100 }), { minLength: 12, maxLength: 12 })
  .filter((p) => Math.abs(tetSignedVolume(p)) > 1e-3);

function outwardTetMesh(p: readonly number[]): ExportableMesh {
  return {
    positions: new Float64Array(p),
    indices:
      tetSignedVolume(p) > 0
        ? new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])
        : new Uint32Array([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3]),
  };
}

describe('generative fuzzing: export writers feed cleanly back through the parsers', () => {
  it('exportStlBinary output always parses as binary STL with zero warnings and finite values — 400 runs', () => {
    const seed = 20260718;
    fc.assert(
      fc.property(tetPointsArb, (p) => {
        const { soup, diagnostics } = parseStl(exportStlBinary(outwardTetMesh(p)));
        expect(diagnostics.format).toBe('stl-binary');
        expect(diagnostics.warnings).toHaveLength(0);
        expect(soup.triangleCount).toBe(4);
        for (let i = 0; i < soup.positions.length; i++) {
          expect(Number.isFinite(soup.positions[i]!)).toBe(true);
        }
      }),
      { seed, numRuns: 400 },
    );
    expect(seed).toBe(20260718);
  });

  it('exportPlyBinary output always parses as binary-LE PLY with lossless geometry — 400 runs', () => {
    const seed = 20260718;
    fc.assert(
      fc.property(tetPointsArb, (p) => {
        const mesh = outwardTetMesh(p);
        const parsed = parsePly(exportPlyBinary(mesh));
        expect(parsed.diagnostics.format).toBe('ply-binary-le');
        expect(Array.from(parsed.positions)).toEqual(Array.from(mesh.positions));
        expect(Array.from(parsed.indices)).toEqual(Array.from(mesh.indices));
      }),
      { seed, numRuns: 400 },
    );
    expect(seed).toBe(20260718);
  });
});
