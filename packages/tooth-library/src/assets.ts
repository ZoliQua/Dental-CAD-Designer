// packages/tooth-library/src/assets.ts
//
// The STARTER tooth asset set (PLAN.md's Phase 4 tooth-library task):
// FDI 12/11/21/22 (the 4 upper incisors the real `arch-case-01` fixture
// needs first) + FDI 16 (one posterior, for later coverage) — see
// generate/README.md for the full provenance/licensing-risk note (every
// asset's `provenance` field states, verbatim, that it is procedurally
// generated placeholder anatomy).
//
// Built ONCE, at module import time, by serializing each generator's
// `IndexedMesh` to binary STL bytes (this format's content-addressing
// currency — see schema.ts's module doc) and assembling+checksumming the
// matching `ToothAssetMetadata`. Synchronous and side-effect-free (mirrors
// `@dqcad/clinical-profiles`' `profiles.ts`: "loaded/validated at startup"
// — any code that imports this module transitively runs generation AND
// `loadToothAssetMetadata` validation immediately, so a generator bug that
// produced a shape-invalid or non-watertight-adjacent metadata value would
// throw at import time, not lazily on first use).
//
// ## Why `morphTargets` is recomputed against a CANONICALIZED mesh
//
// Binary STL (this format's mesh-bytes currency) carries triangle corner
// positions only — no vertex-index channel, and Float32 coordinates (a
// documented lossy boundary, same one `MeshAsset.fileHash`'s doc in
// shared-types describes). `loader.ts`'s generic bytes-in path
// necessarily re-derives an `IndexedMesh` by re-welding the parsed soup,
// and that welded vertex NUMBERING depends on triangle/corner visit order,
// not on whatever internal order a generator happened to build vertices
// in. So a `morphTargets[*].vertexDeltas` array computed against a
// generator's OWN `IndexedMesh` (as `generateIncisorAsset`/
// `generateMolarAsset` return) would silently misalign once a caller goes
// through `writeStlBinary` -> `parseStl` -> re-weld.
//
// The fix: this module performs that exact round trip itself, ONCE, at
// build time, and recomputes `morphTargets` against the RESULT — the same
// canonical weld `loader.ts` will always reproduce from these exact bytes
// (deterministic: same bytes, same weld epsilon, same algorithm). Both
// `incisorMorphTargets`/`molarMorphTargets` are pure functions of a
// vertex's own (x, y, z) (see their own doc comments), so re-applying them
// to the canonical mesh's positions — in whatever order THAT mesh numbers
// them — produces an equally correct, now round-trip-stable, result.
// `landmarks` needs no such treatment: it stores absolute positions, never
// vertex indices, so it is canonicalization-agnostic by construction.
import { intake, indexedToSoup } from '@dqcad/kernel';
import { parseStl, writeStlBinary } from '@dqcad/io';
import type { FdiTooth } from '@dqcad/shared-types';
import { generateIncisorAsset, incisorMorphTargets, INCISOR_FDI_CODES } from './generate/incisor.ts';
import { generateMolarAsset, molarMorphTargets, MOLAR_FDI_CODES } from './generate/molar.ts';
import { INCISOR_FDI_PARAMS, MOLAR_FDI_PARAMS } from './generate/toothParams.ts';
import {
  PLACEHOLDER_PROVENANCE_PREFIX,
  computeMeshChecksum,
  computeToothAssetMetadataChecksum,
  loadToothAssetMetadata,
  type MorphTarget,
  type ToothAssetMetadata,
  type ToothLandmarks,
  type ToothType,
} from './schema.ts';

/** The starter set's shared version — bump on ANY change to a generator's
 * output (shape params, ring/segment counts, landmark picks) per this
 * format's "version bumps on any value change" audit convention (mirrors
 * `MaterialProfile.version`'s doc). */
export const STARTER_ASSET_VERSION = '1.0.0';

function provenanceFor(kind: ToothType): string {
  return (
    `${PLACEHOLDER_PROVENANCE_PREFIX} procedurally generated ${kind} crown (parametric, ` +
    'deterministic, no scan/atlas source) — see @dqcad/tooth-library/src/generate/README.md. ' +
    'Dimensions are rough textbook-average adult tooth figures for pipeline development only; ' +
    'replace with a real anatomical asset before any clinical use (PLAN.md Phase 4 §9).'
  );
}

/** One fully-assembled starter asset: mesh bytes (binary STL) + its
 * checksum-verified metadata. `mesh` is the CANONICAL (post-round-trip)
 * `IndexedMesh` `morphTargets` is aligned against — see this module's
 * header doc — exposed so `loader.ts`'s in-process path can reuse it
 * directly rather than re-parsing `meshBytes` a second time. */
export interface StarterToothAsset {
  metadata: ToothAssetMetadata;
  meshBytes: Uint8Array;
  mesh: { positions: Float64Array; indices: Uint32Array };
}

interface GeneratedAsset {
  fdi: FdiTooth;
  toothType: ToothType;
  mesh: { positions: Float64Array; indices: Uint32Array };
  landmarks: ToothLandmarks;
  canonicalFrame: ToothAssetMetadata['canonicalFrame'];
}

function buildStarterAsset(generated: GeneratedAsset, morphTargetsFor: (positions: Float64Array) => MorphTarget[]): StarterToothAsset {
  const meshBytes = writeStlBinary(indexedToSoup(generated.mesh));

  // Canonicalize: re-parse the EXACT bytes just written and re-weld, so
  // `morphTargets` (recomputed below, against THIS mesh) always matches
  // what `loader.ts` reconstructs from these same bytes later. See this
  // module's header doc.
  const { soup } = parseStl(meshBytes);
  const { mesh: canonicalMesh, stats } = intake({ kind: 'soup', soup });
  if (!stats.watertight || stats.degenerateCount > 0) {
    // Unreachable for this task's own generators (verified by
    // assets.test.ts) — a defensive, loud failure if a future generator
    // change ever regresses this invariant, rather than silently shipping
    // a broken starter asset.
    throw new Error(
      `buildStarterAsset: FDI ${generated.fdi} canonical mesh failed watertight/degenerate check ` +
        `(watertight=${stats.watertight}, degenerateCount=${stats.degenerateCount})`,
    );
  }

  const meshChecksum = computeMeshChecksum(meshBytes);
  const morphTargets = morphTargetsFor(canonicalMesh.positions);

  const withoutChecksum = {
    fdi: generated.fdi,
    version: STARTER_ASSET_VERSION,
    toothType: generated.toothType,
    provenance: provenanceFor(generated.toothType),
    landmarks: generated.landmarks,
    canonicalFrame: generated.canonicalFrame,
    morphTargets,
    meshChecksum,
  };
  const metadataChecksum = computeToothAssetMetadataChecksum(withoutChecksum);
  const rawMetadata = { ...withoutChecksum, metadataChecksum };

  // Round-trips through the real validator (not just object-literal trust)
  // — a generator bug that produced e.g. a non-orthonormal frame or a
  // mismatched vertexDeltas length throws HERE, at module-import time.
  const vertexCount = canonicalMesh.positions.length / 3;
  const metadata = loadToothAssetMetadata(rawMetadata, vertexCount);

  return { metadata, meshBytes, mesh: canonicalMesh };
}

function buildIncisorStarterAsset(fdi: FdiTooth): StarterToothAsset {
  const generated = generateIncisorAsset(fdi);
  const crownHeightMm = INCISOR_FDI_PARAMS[fdi]!.crownHeightMm;
  return buildStarterAsset(generated, (positions) => incisorMorphTargets(positions, crownHeightMm));
}

function buildMolarStarterAsset(fdi: FdiTooth): StarterToothAsset {
  const generated = generateMolarAsset(fdi);
  const params = MOLAR_FDI_PARAMS[fdi]!;
  return buildStarterAsset(generated, (positions) => molarMorphTargets(positions, params, params.crownHeightMm));
}

/** FDI -> starter asset, built once at import time. Ordered 12, 11, 21, 22,
 * 16 — the 4 incisors first (the real case's immediate need), then the
 * posterior. */
export const STARTER_TOOTH_ASSETS: ReadonlyMap<FdiTooth, StarterToothAsset> = new Map([
  ...INCISOR_FDI_CODES.map((fdi) => [fdi, buildIncisorStarterAsset(fdi)] as const),
  ...MOLAR_FDI_CODES.map((fdi) => [fdi, buildMolarStarterAsset(fdi)] as const),
]);

/** Every FDI code the starter set currently ships, in the order above —
 * `assets.test.ts` and the server's seeding routine both iterate this
 * rather than re-deriving the list. */
export const STARTER_FDI_CODES: readonly FdiTooth[] = [...STARTER_TOOTH_ASSETS.keys()];
