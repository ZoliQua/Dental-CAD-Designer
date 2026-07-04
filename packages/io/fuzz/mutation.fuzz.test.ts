// packages/io/fuzz/mutation.fuzz.test.ts
//
// Mutation fuzzing (task brief §1a): take valid small STL/PLY bytes, apply
// seeded byte-level flips/truncations/insertions, and assert the parser
// either throws a typed `IoParseError` or returns a structurally valid,
// all-finite result — NEVER hangs, NEVER throws a non-`IoParseError`, NEVER
// silently returns NaN/Infinity coordinates. See helpers.ts's
// `assertSafeParse` for the shared guardrail check and `applyEdits` for the
// mutation model.
//
// Seeded explicitly (not fast-check's auto-random seed) for reproducible
// CI runs — this task's guardrail requires "report seeds/run counts" in
// the final report; the seeds below ARE that report's source of truth.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../src/stl/parse.ts';
import { writeStlBinary } from '../src/stl/binary.ts';
import { parsePly } from '../src/ply/parse.ts';
import { writePlyBinaryLE } from '../src/ply/binary.ts';
import type { WritablePlyMesh } from '../src/ply/binary.ts';
import { applyEdits, assertFinitePlyMesh, assertFiniteStlSoup, assertSafeParse } from './helpers.ts';
import type { Edit } from './helpers.ts';

const MUTATION_RUNS = 8000;

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    kind: fc.constant('flip' as const),
    posFrac: fc.double({ min: 0, max: 0.999, noNaN: true }),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    kind: fc.constant('truncate' as const),
    lenFrac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    kind: fc.constant('insert' as const),
    posFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    bytes: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 16 }),
  }),
);
const editsArb = fc.array(editArb, { minLength: 1, maxLength: 8 });

function stlBinaryFixture(): Uint8Array {
  return writeStlBinary({
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]),
    normals: new Float64Array([0, 0, 1, 0, 0, -1]),
    triangleCount: 2,
  });
}

const stlAsciiFixture = () =>
  new TextEncoder().encode(
    [
      'solid fuzz-seed',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'facet normal 0 0 -1',
      'outer loop',
      'vertex 0 0 1',
      'vertex 1 0 1',
      'vertex 0 1 1',
      'endloop',
      'endfacet',
      'endsolid fuzz-seed',
    ].join('\n'),
  );

function plyBinaryFixture(): Uint8Array {
  const mesh: WritablePlyMesh = {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: null,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    faceCount: 2,
  };
  return writePlyBinaryLE(mesh);
}

const plyAsciiFixture = () =>
  new TextEncoder().encode(
    'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 2\nproperty list uchar int vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3\n',
  );

describe('mutation fuzzing: STL', () => {
  it(`binary STL (seed logged below) — ${MUTATION_RUNS} runs`, () => {
    const seed = 20260712;
    const base = stlBinaryFixture();
    fc.assert(
      fc.property(editsArb, (edits) => {
        const mutated = applyEdits(base, edits);
        assertSafeParse(
          mutated,
          parseStl,
          (result) => assertFiniteStlSoup(result.soup, 'stl-binary-mutation'),
          'stl-binary-mutation',
        );
      }),
      { seed, numRuns: MUTATION_RUNS },
    );
    // Logged for the task report's "seeds/run counts" requirement.
    expect(seed).toBe(20260712);
  });

  it(`ASCII STL (seed logged below) — ${MUTATION_RUNS} runs`, () => {
    const seed = 20260713;
    const base = stlAsciiFixture();
    fc.assert(
      fc.property(editsArb, (edits) => {
        const mutated = applyEdits(base, edits);
        assertSafeParse(
          mutated,
          parseStl,
          (result) => assertFiniteStlSoup(result.soup, 'stl-ascii-mutation'),
          'stl-ascii-mutation',
        );
      }),
      { seed, numRuns: MUTATION_RUNS },
    );
    expect(seed).toBe(20260713);
  });
});

describe('mutation fuzzing: PLY', () => {
  it(`binary_little_endian PLY (seed logged below) — ${MUTATION_RUNS} runs`, () => {
    const seed = 20260714;
    const base = plyBinaryFixture();
    fc.assert(
      fc.property(editsArb, (edits) => {
        const mutated = applyEdits(base, edits);
        assertSafeParse(
          mutated,
          parsePly,
          (mesh) => assertFinitePlyMesh(mesh, 'ply-binary-mutation'),
          'ply-binary-mutation',
        );
      }),
      { seed, numRuns: MUTATION_RUNS },
    );
    expect(seed).toBe(20260714);
  });

  it(`ASCII PLY (seed logged below) — ${MUTATION_RUNS} runs`, () => {
    const seed = 20260715;
    const base = plyAsciiFixture();
    fc.assert(
      fc.property(editsArb, (edits) => {
        const mutated = applyEdits(base, edits);
        assertSafeParse(
          mutated,
          parsePly,
          (mesh) => assertFinitePlyMesh(mesh, 'ply-ascii-mutation'),
          'ply-ascii-mutation',
        );
      }),
      { seed, numRuns: MUTATION_RUNS },
    );
    expect(seed).toBe(20260715);
  });
});
