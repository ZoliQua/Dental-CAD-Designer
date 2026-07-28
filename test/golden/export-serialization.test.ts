// test/golden/export-serialization.test.ts
//
// Phase 7 Task 2 — export-grade mesh serialization, proven on the REAL
// fixture restorations: the P4 crown (standin, coupled lineage), the P5
// inlay (MOD cavity shell), and the P6 bridge (fused full-contour solid).
// Three claims per fixture, plus a seeded property-law describe:
//
//  1. BYTE-PINNED DETERMINISM: `exportStlBinary` / `exportPlyBinary` over
//     the assembled restoration produce bytes whose SHA-256 matches the
//     pinned golden below — same mesh + same options + same KERNEL_VERSION
//     ⇒ bit-identical export bytes (the plan's export-determinism global
//     constraint). Pins are KERNEL_VERSION- + manifold-3d-version-guarded
//     exactly like crown-acceptance.test.ts's stage-hash pins.
//
//  2. RE-IMPORT IDENTITY, precisely defined (the Task 2 equivalence):
//     Let M be the canonical source mesh, `narrow32(M)` = M with every
//     coordinate `Math.fround`ed (same indices), and `canon(M)` =
//     `weldVertices(indexedToSoup(M))` — the deterministic first-occurrence
//     re-indexing of M into triangle-scan order.
//       (a) EXACT, unconditional: parseStl(exportStlBinary(M)).soup
//           .positions is BIT-IDENTICAL to indexedToSoup(narrow32(M))
//           .positions — writing fround(x) as float32 then widening back
//           to float64 is the identity on float32-representable values, so
//           the byte round trip IS the narrowing function, nothing else.
//       (b) CONDITIONAL on narrowing being topology-safe for M — (i) no
//           two canon-distinct vertices come within the weld epsilon
//           (1e-6 mm) after narrowing, (ii) no triangle degenerates,
//           (iii) winding stays consistent with positive volume. Then:
//           intake(parsed soup).mesh EQUALS narrow32(canon(M)) exactly —
//           indices byte-identical (the weld REPRODUCES the source
//           topology), positions byte-identical to the narrowed canon —
//           hence hashMesh(reimport) === hashMesh(narrow32(canon(M))).
//           Conditions (i)-(iii) are ASSERTED per fixture (weld/drop/orient
//           step counts), not assumed — if a future restoration violated
//           them, this suite fails loudly instead of hiding it.
//
//  3. MEASURED f32 NARROWING (the format's precision floor, deliverable 4):
//     max |x - fround(x)| measured over the fixture's coordinates, asserted
//     within the analytic half-ULP bound, and console-reported (these
//     numbers feed the Task 5 traceability document).
//
// PLY is lossless float64: export → parse reproduces positions/indices
// byte-identically (equivalence with narrow32 = identity, no weld needed).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  KERNEL_VERSION,
  indexedToSoup,
  intake,
  weldVertices,
  type IndexedMesh,
} from '@dqcad/kernel';
import { exportPlyBinary, exportStlBinary, measureF32NarrowingError, parsePly, parseStl } from '@dqcad/io';
import { assembleCrown, hashMesh, resetCrownCaches, type AssembledCrown } from '../../scripts/crown-journal-lib.ts';
import { assembleCavity, resetCavityCaches, type AssembledCavity } from '../../scripts/cavity-journal-lib.ts';
import { assembleBridgeCase, resetBridgeCaches, type AssembledBridge } from '../../scripts/bridge-journal-lib.ts';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';

const µm = (mm: number): string => `${(mm * 1000).toFixed(6)} µm`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (a: Float64Array | Uint32Array): Buffer =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength);

// ---------------------------------------------------------------------------
// Version guard — the byte pins below hash EXPORTED BYTES of kernel-built
// restorations, so they are valid only for this exact kernel + manifold-3d
// WASM version (the crown/bridge chains run WASM booleans). A bump to either
// is a DELIBERATE golden change (bump + changelog + regenerate), never a
// silent regen — same mechanics as crown-acceptance.test.ts.
// ---------------------------------------------------------------------------
const EXPECTED_KERNEL_VERSION = '0.26.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';

function installedManifoldVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

// The byte-pinned SHA-256 of the exported bytes per fixture restoration —
// NEW pins introduced by Phase 7 Task 2 (no existing golden moved). Change
// ONLY with a deliberate kernel/manifold version bump + changelog entry, or
// a deliberate, documented export-format change.
const STL_BYTE_PINS = {
  crown: 'f96ee10be2949a75bc97efde70a0a1775605abf5c139cfae70ac4881ed7f1ef9',
  inlay: 'f905e727595dff610c0bcb7360eb5b62308be3f44f47702d4510f0aef1d72094',
  bridge: '390e52af1df3a30e803cd2855d88b224845e493f7d5762ff501eb95d90068df2',
} as const;
const PLY_BYTE_PINS = {
  crown: '63d7d2b9c62ec28d31af60764d26e2ae6c3989062c80d691ee6f3df6cc314f3b',
  inlay: '0d35d9f2bc16e2b6768c094c3612c43fa98f3d056e8c800cb590a3912ee24c53',
  bridge: 'ac302820c46591a29576644688c5cbf91311f24a120bd88faa725af02420904f',
} as const;

describe('export-serialization: version guard', () => {
  it(`byte pins are valid only for KERNEL_VERSION ${EXPECTED_KERNEL_VERSION} + manifold-3d ${EXPECTED_MANIFOLD_VERSION}`, () => {
    expect(KERNEL_VERSION).toBe(EXPECTED_KERNEL_VERSION);
    expect(installedManifoldVersion()).toBe(EXPECTED_MANIFOLD_VERSION);
  });
});

// ---------------------------------------------------------------------------
// The equivalence battery (module doc claims 2 + 3) — shared by all three
// fixtures and the property law below.
// ---------------------------------------------------------------------------

/** `M` with every coordinate narrowed through `Math.fround` (indices
 * unchanged) — the format's precision floor as a mesh transform. */
function narrow32(mesh: IndexedMesh): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i++) {
    positions[i] = Math.fround(mesh.positions[i]!);
  }
  return { positions, indices: mesh.indices.slice() };
}

/** Deterministic first-occurrence canonicalization: expand per-triangle,
 * re-weld with the standard epsilon. Idempotent re-indexing of a mesh into
 * triangle-scan vertex order — the ordering the re-imported mesh will have. */
function canon(mesh: IndexedMesh): IndexedMesh {
  return weldVertices(indexedToSoup(mesh));
}

interface ReimportEvidence {
  narrowing: ReturnType<typeof measureF32NarrowingError>;
  reimportTriangleCount: number;
  reimportVertexCount: number;
}

function assertStlReimportIdentity(mesh: IndexedMesh): ReimportEvidence {
  const triangleCount = mesh.indices.length / 3;
  const bytes = exportStlBinary(mesh);
  const { soup, diagnostics } = parseStl(bytes);
  expect(diagnostics.format).toBe('stl-binary');
  expect(diagnostics.warnings).toHaveLength(0);
  expect(soup.triangleCount).toBe(triangleCount);

  // (2a) EXACT: the byte round trip IS the f32 narrowing of the
  // per-triangle expansion — bit-identical Float64 buffers.
  const refSoup = indexedToSoup(narrow32(mesh));
  expect(bytesOf(soup.positions).equals(bytesOf(refSoup.positions))).toBe(true);

  // (2b) conditions (i)-(iii), ASSERTED: intake's own step reports say the
  // weld merged nothing beyond the source dedup, dropped nothing, flipped
  // nothing.
  const sourceCanon = canon(mesh);
  const reimport = intake({ kind: 'soup', soup });
  const steps = Object.fromEntries(reimport.report.steps.map((s) => [s.step, s]));
  expect(steps['weld']!.after.vertexCount).toBe(sourceCanon.positions.length / 3);
  expect(steps['dropDegenerateTriangles']!.details['degenerateCount']).toBe(0);
  expect(steps['dropDegenerateTriangles']!.details['duplicateIndexCount']).toBe(0);
  expect(steps['orientNormalsConsistently']!.details['flippedCount']).toBe(0);
  expect(steps['orientNormalsConsistently']!.details['ambiguousComponentCount']).toBe(0);

  // (2b) the equivalence itself: the re-import EQUALS the narrowed
  // canonicalized source — topology byte-identical, positions
  // byte-identical, canonical hashes equal.
  const narrowedCanon = narrow32(sourceCanon);
  expect(bytesOf(reimport.mesh.indices).equals(bytesOf(narrowedCanon.indices))).toBe(true);
  expect(bytesOf(reimport.mesh.positions).equals(bytesOf(narrowedCanon.positions))).toBe(true);
  expect(hashMesh(reimport.mesh)).toBe(hashMesh(narrowedCanon));

  // Determinism cross-check: intake over the bit-identical reference soup
  // reproduces the same canonical hash (pure function of its input).
  expect(hashMesh(intake({ kind: 'soup', soup: refSoup }).mesh)).toBe(hashMesh(reimport.mesh));

  // The re-imported restoration is watertight/manifold with positive
  // (outward) volume — the Phase 7 acceptance-1 property, proven per mesh.
  expect(reimport.stats.watertight).toBe(true);
  expect(reimport.stats.manifoldEdges).toBe(true);
  expect(reimport.stats.signedVolumeMm3).not.toBeNull();
  expect(reimport.stats.signedVolumeMm3!).toBeGreaterThan(0);

  // (3) measured narrowing within the analytic bound.
  const narrowing = measureF32NarrowingError(mesh.positions);
  expect(narrowing.maxAbsErrorMm).toBeLessThanOrEqual(narrowing.maxHalfUlpBoundMm);

  return {
    narrowing,
    reimportTriangleCount: reimport.mesh.indices.length / 3,
    reimportVertexCount: reimport.mesh.positions.length / 3,
  };
}

function assertPlyReimportIdentity(mesh: IndexedMesh): void {
  const parsed = parsePly(exportPlyBinary(mesh));
  // Lossless float64: byte-identical geometry, identical canonical hash —
  // the PLY equivalence is exact (narrow32 = identity, no weld involved).
  expect(bytesOf(parsed.positions).equals(bytesOf(mesh.positions))).toBe(true);
  expect(bytesOf(parsed.indices).equals(bytesOf(mesh.indices))).toBe(true);
  const reimport = intake({ kind: 'indexed', mesh: { positions: parsed.positions, indices: parsed.indices } });
  expect(hashMesh(reimport.mesh)).toBe(hashMesh(mesh));
  expect(reimport.stats.watertight).toBe(true);
}

function logEvidence(label: string, evidence: ReimportEvidence): void {
  const { narrowing } = evidence;
  console.log(
    `[EXPORT T2 ${label}] f32-narrowing: measured-max=${µm(narrowing.maxAbsErrorMm)} | ` +
      `half-ULP-bound=${µm(narrowing.maxHalfUlpBoundMm)} | max-|coord|=${narrowing.maxAbsCoordinateMm.toFixed(3)} mm | ` +
      `re-import: ${evidence.reimportTriangleCount} tris / ${evidence.reimportVertexCount} verts`,
  );
}

// ---------------------------------------------------------------------------
// P4 crown (standin, the coupled morph→heal→shell→sculpt lineage)
// ---------------------------------------------------------------------------
describe('export-serialization: P4 crown fixture', () => {
  let crown: AssembledCrown;
  let crownSolid: IndexedMesh;

  beforeAll(async () => {
    resetCrownCaches();
    crown = await assembleCrown('standin');
    crownSolid = crown.sculpt.mesh!;
  }, 300_000);

  it('exports deterministic, byte-pinned STL bytes', () => {
    const a = exportStlBinary(crownSolid);
    const b = exportStlBinary(crownSolid);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(sha256(a)).toBe(STL_BYTE_PINS.crown);
  });

  it('exports deterministic, byte-pinned PLY bytes', () => {
    expect(sha256(exportPlyBinary(crownSolid))).toBe(PLY_BYTE_PINS.crown);
  });

  it('re-imports to the narrowed canonical source (the Task 2 equivalence) with measured narrowing in bound', () => {
    expect(crown.measured.crownWatertight).toBe(true);
    const evidence = assertStlReimportIdentity(crownSolid);
    logEvidence('crown', evidence);
  });

  it('PLY re-import is exactly lossless', () => {
    assertPlyReimportIdentity(crownSolid);
  });
});

// ---------------------------------------------------------------------------
// P5 inlay (MOD cavity shell)
// ---------------------------------------------------------------------------
describe('export-serialization: P5 inlay fixture', () => {
  let inlay: AssembledCavity;

  beforeAll(async () => {
    resetCavityCaches();
    inlay = await assembleCavity('inlay');
  }, 300_000);

  it('exports deterministic, byte-pinned STL bytes', () => {
    const a = exportStlBinary(inlay.shellMesh);
    expect(Buffer.from(a).equals(Buffer.from(exportStlBinary(inlay.shellMesh)))).toBe(true);
    expect(sha256(a)).toBe(STL_BYTE_PINS.inlay);
  });

  it('exports deterministic, byte-pinned PLY bytes', () => {
    expect(sha256(exportPlyBinary(inlay.shellMesh))).toBe(PLY_BYTE_PINS.inlay);
  });

  it('re-imports to the narrowed canonical source (the Task 2 equivalence) with measured narrowing in bound', () => {
    const evidence = assertStlReimportIdentity(inlay.shellMesh);
    logEvidence('inlay', evidence);
  });

  it('PLY re-import is exactly lossless', () => {
    assertPlyReimportIdentity(inlay.shellMesh);
  });
});

// ---------------------------------------------------------------------------
// P6 bridge (full-contour fused solid)
// ---------------------------------------------------------------------------
describe('export-serialization: P6 bridge fixture', () => {
  let bridge: AssembledBridge;

  beforeAll(async () => {
    resetBridgeCaches();
    bridge = await assembleBridgeCase('full');
  }, 600_000);

  it('exports deterministic, byte-pinned STL bytes', () => {
    const a = exportStlBinary(bridge.assembly.assembledSolid);
    expect(Buffer.from(a).equals(Buffer.from(exportStlBinary(bridge.assembly.assembledSolid)))).toBe(true);
    expect(sha256(a)).toBe(STL_BYTE_PINS.bridge);
  });

  it('exports deterministic, byte-pinned PLY bytes', () => {
    expect(sha256(exportPlyBinary(bridge.assembly.assembledSolid))).toBe(PLY_BYTE_PINS.bridge);
  });

  it('re-imports to the narrowed canonical source (the Task 2 equivalence) with measured narrowing in bound', () => {
    expect(bridge.measured.assembledWatertight).toBe(true);
    const evidence = assertStlReimportIdentity(bridge.assembly.assembledSolid);
    logEvidence('bridge', evidence);
  });

  it('PLY re-import is exactly lossless', () => {
    assertPlyReimportIdentity(bridge.assembly.assembledSolid);
  });
});

// ---------------------------------------------------------------------------
// Property law: the equivalence holds for arbitrary watertight tetrahedra
// whose geometry is safely away from the narrowing/weld condition edges
// (seeded — determinism).
// ---------------------------------------------------------------------------
describe('export-serialization: re-import equivalence property (seeded)', () => {
  const PROPERTY_SEED = 424242;

  function tetVolume(p: readonly number[]): number {
    const u = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
    const v = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
    const w = [p[9]! - p[0]!, p[10]! - p[1]!, p[11]! - p[2]!];
    return (
      (u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) -
        u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) +
        u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6
    );
  }

  function minPairwiseDistance(p: readonly number[]): number {
    let min = Infinity;
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const dx = p[i * 3]! - p[j * 3]!;
        const dy = p[i * 3 + 1]! - p[j * 3 + 1]!;
        const dz = p[i * 3 + 2]! - p[j * 3 + 2]!;
        min = Math.min(min, Math.hypot(dx, dy, dz));
      }
    }
    return min;
  }

  const tetArb = fc
    .array(fc.double({ noNaN: true, min: -50, max: 50 }), { minLength: 12, maxLength: 12 })
    .filter((p) => Math.abs(tetVolume(p)) > 1e-3 && minPairwiseDistance(p) > 1e-2);

  it('holds for random outward-oriented tetrahedra (STL + PLY)', () => {
    fc.assert(
      fc.property(tetArb, (p) => {
        const positive = tetVolume(p) > 0;
        const mesh: IndexedMesh = {
          positions: new Float64Array(p),
          indices: positive
            ? new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])
            : new Uint32Array([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3]),
        };
        assertStlReimportIdentity(mesh);
        assertPlyReimportIdentity(mesh);
      }),
      { seed: PROPERTY_SEED, numRuns: 60 },
    );
  });
});
