// test/golden/stl-reader.ts
//
// Minimal, independent binary-STL reader used only by the golden tests.
// Deliberately separate code from scripts/generate-fixtures.ts's writer —
// re-parsing the raw bytes (rather than trusting the in-memory Mesh the
// writer produced) is what makes the structural-integrity check in
// golden.test.ts a real check on the checked-in files, not a tautology.
// Script-local test tooling only: packages/io gets the real STL/PLY parsers
// starting Phase 1.

export interface ParsedStlMesh {
  readonly triangleCount: number;
  readonly bbox: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly volumeMm3: number;
  readonly areaMm2: number;
}

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/**
 * A missing `git lfs pull` leaves a small text pointer file in place of the
 * real binary object. Detect that up front and fail with an actionable
 * message instead of a confusing "invalid STL" / hash-mismatch error deep
 * inside a parser.
 */
export function assertNotLfsPointer(buffer: Buffer, filePath: string): void {
  const probe = buffer.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8');
  if (probe === LFS_POINTER_PREFIX) {
    throw new Error(
      `${filePath} is a Git LFS pointer file, not the real binary content — ` +
        'the fixture has not been fetched. Run `git lfs pull` (or `git lfs install && ' +
        'git lfs fetch --all && git lfs checkout`) to materialize test-fixtures/ before ' +
        'running golden tests.',
    );
  }
}

export function parseBinaryStl(buffer: Buffer, filePath: string): ParsedStlMesh {
  assertNotLfsPointer(buffer, filePath);

  if (buffer.length < 84) {
    throw new Error(`${filePath} is too small to be a binary STL file (${buffer.length} bytes)`);
  }

  const triangleCount = buffer.readUInt32LE(80);
  const expectedLength = 84 + triangleCount * 50;
  if (buffer.length !== expectedLength) {
    throw new Error(
      `${filePath}: byte length ${buffer.length} does not match the binary STL layout for ` +
        `${triangleCount} triangles (expected ${expectedLength} bytes)`,
    );
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let volumeAcc = 0;
  let areaAcc = 0;

  for (let i = 0; i < triangleCount; i++) {
    const base = 84 + i * 50 + 12; // 84-byte preamble, +12 to skip the stored normal
    const v0: readonly [number, number, number] = [
      buffer.readFloatLE(base),
      buffer.readFloatLE(base + 4),
      buffer.readFloatLE(base + 8),
    ];
    const v1: readonly [number, number, number] = [
      buffer.readFloatLE(base + 12),
      buffer.readFloatLE(base + 16),
      buffer.readFloatLE(base + 20),
    ];
    const v2: readonly [number, number, number] = [
      buffer.readFloatLE(base + 24),
      buffer.readFloatLE(base + 28),
      buffer.readFloatLE(base + 32),
    ];

    for (const v of [v0, v1, v2]) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] > maxZ) maxZ = v[2];
    }

    // Signed tetrahedron volume from the origin (divergence theorem) —
    // translation-invariant for a closed, consistently outward-oriented
    // mesh, so valid regardless of where the shape sits in space.
    volumeAcc +=
      (v0[0] * (v1[1] * v2[2] - v1[2] * v2[1]) -
        v0[1] * (v1[0] * v2[2] - v1[2] * v2[0]) +
        v0[2] * (v1[0] * v2[1] - v1[1] * v2[0])) /
      6;

    const e1: readonly [number, number, number] = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2: readonly [number, number, number] = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const crossX = e1[1] * e2[2] - e1[2] * e2[1];
    const crossY = e1[2] * e2[0] - e1[0] * e2[2];
    const crossZ = e1[0] * e2[1] - e1[1] * e2[0];
    areaAcc += Math.sqrt(crossX ** 2 + crossY ** 2 + crossZ ** 2) / 2;
  }

  return {
    triangleCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    volumeMm3: volumeAcc,
    areaMm2: areaAcc,
  };
}
