// packages/tooth-library/src/generate/molar.ts
//
// Deterministic parametric molar crown generator — one posterior starter
// asset (FDI 16, upper right first molar; see toothParams.ts's
// `MOLAR_FDI_PARAMS` for how to add another FDI). PLACEHOLDER ANATOMY —
// see toothParams.ts's module doc and README.md.
//
// Shape model: an axial WALL (a symmetric elliptical ring stack, cervical
// to the base of the occlusal table — same ring/stitch machinery the
// incisor generator uses) topped by an OCCLUSAL TABLE built as several
// concentric contour rings shrinking from the wall's own top ring (reused
// verbatim as the table's outer boundary — no seam duplication) inward to
// a single center vertex. Each contour ring's elevation is a function of
// its radial position `s` (0 at the wall boundary, 1 at the center) and
// angle `theta`: a general dome rise, four Gaussian cusp bumps at the
// mesiobuccal/distobuccal/mesiolingual/distolingual quadrant angles, two
// mesial/distal marginal-ridge bumps near the table's rim, and a central-
// fossa Gaussian dip peaked at the very center — so "4 cusp-tip landmarks"
// and "a central fossa" both fall out of the same elevation formula, at
// specific, exactly-known (ring, angle) grid points (never found by
// search — see `generateMolarAsset`'s landmark picks).
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { CanonicalFrame, MorphTarget, ToothLandmarks, ToothType } from '../schema.ts';
import {
  addRing,
  addVertex,
  angularWindow,
  capBottom,
  capTop,
  createMeshBuilder,
  gaussianBump,
  mix,
  nearestRingIndex,
  smoothstep,
  stitchRings,
  toIndexedMesh,
  vertexAt,
  type MeshBuilder,
} from '../geometry/ringMesh.ts';
import { MOLAR_FDI_PARAMS, type MolarParams } from './toothParams.ts';

const SEGMENTS = 72;
/** Wall rings from the cervical margin (i=0, v=0) up to AND INCLUDING the
 * occlusal table's own outer boundary (i=WALL_RING_COUNT-1, v=1) — unlike
 * the incisor generator, the last wall ring is reused directly as the
 * cap's own outer contour (see this file's header doc: "no seam
 * duplication"). */
const WALL_RING_COUNT = 14;
/** Interior occlusal-table contour rings, `s = m / CAP_STEPS` for
 * `m = 1 .. CAP_STEPS - 1` (`s = 0` is the reused wall-top ring, `s = 1` is
 * the single center vertex — neither is a member of this range). */
const CAP_STEPS = 10;

const CUSP_ANGLES_RAD = {
  distobuccal: 45 * (Math.PI / 180),
  mesiobuccal: 135 * (Math.PI / 180),
  mesiolingual: 225 * (Math.PI / 180),
  distolingual: 315 * (Math.PI / 180),
} as const;

export interface MolarAsset {
  fdi: FdiTooth;
  toothType: ToothType;
  mesh: IndexedMesh;
  landmarks: ToothLandmarks;
  canonicalFrame: CanonicalFrame;
  morphTargets: readonly MorphTarget[];
}

const IDENTITY_FRAME: CanonicalFrame = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

function wallCrossSection(params: MolarParams, v: number): (theta: number) => { x: number; y: number } {
  const rx = mix(params.rxCervicalMm, params.rxWallTopMm, smoothstep(0, 1, v))
    + params.rxContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  const ry = mix(params.ryCervicalMm, params.ryWallTopMm, smoothstep(0, 1, v))
    + params.ryContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  return (theta: number) => ({ x: rx * Math.cos(theta), y: ry * Math.sin(theta) });
}

/** Occlusal-table elevation above `wallTopZ` at radial position `s` in
 * `(0, 1)` and angle `theta` — see this file's header doc for the formula's
 * anatomical reading (dome + 4 cusp bumps + 2 marginal-ridge bumps - 1
 * central-fossa dip). Not used at `s === 0` (the reused wall-top ring) or
 * `s === 1` (the center vertex, handled separately by `centerElevation`). */
function tableElevation(params: MolarParams, s: number, theta: number): number {
  const dome = params.occlusalTableReliefMm * Math.sin(Math.PI * s);
  let cuspBump = 0;
  for (const angle of Object.values(CUSP_ANGLES_RAD)) {
    cuspBump += angularWindow(theta, angle, params.cuspAngularHalfWidthRad);
  }
  cuspBump *= params.cuspHeightMm * gaussianBump(s, params.sCusp, params.sigmaSCusp);
  const ridgeBump =
    params.ridgeHeightMm
    * gaussianBump(s, params.sRidge, params.sigmaSRidge)
    * (angularWindow(theta, 0, params.ridgeAngularHalfWidthRad)
      + angularWindow(theta, Math.PI, params.ridgeAngularHalfWidthRad));
  const fossaDip = params.fossaDepthMm * gaussianBump(s, 1, params.sigmaSFossa);
  return dome + cuspBump + ridgeBump - fossaDip;
}

/** The center vertex's elevation above `wallTopZ` — evaluated directly
 * (not via `tableElevation(params, 1, theta)`) because at `s === 1` the
 * table collapses to a single point with no meaningful `theta`; residual
 * cusp/ridge Gaussian tails at `s === 1` are negligible (see this file's
 * module doc) but would otherwise make a single vertex's height
 * theta-dependent, which is meaningless for a point. */
function centerElevation(params: MolarParams): number {
  return params.occlusalTableReliefMm * Math.sin(Math.PI) - params.fossaDepthMm * gaussianBump(1, 1, params.sigmaSFossa);
}

function addCapRing(builder: MeshBuilder, params: MolarParams, s: number, wallTopZ: number): number[] {
  const rx = params.rxWallTopMm * Math.pow(1 - s, params.radialShrinkPower);
  const ry = params.ryWallTopMm * Math.pow(1 - s, params.radialShrinkPower);
  const ring: number[] = new Array(SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) {
    const theta = (2 * Math.PI * i) / SEGMENTS;
    const x = rx * Math.cos(theta);
    const y = ry * Math.sin(theta);
    const z = wallTopZ + tableElevation(params, s, theta);
    ring[i] = addVertex(builder, x, y, z);
  }
  return ring;
}

/**
 * Pure per-vertex morph deltas — a function of each vertex's own final
 * (x, y, z) alone (see incisor.ts's `incisorMorphTargets` doc for why this
 * matters: `assets.ts` re-derives a starter asset's shipped `morphTargets`
 * against the CANONICAL mesh from re-parsing+re-welding its own STL bytes,
 * which numbers vertices differently than this generator's own build
 * order — a purely positional formula is what makes that re-derivation
 * valid).
 */
export function molarMorphTargets(positions: Float64Array, params: MolarParams, wallTopZ: number): MorphTarget[] {
  const vertexCount = positions.length / 3;
  const cuspHeightDeltas = new Array<number>(vertexCount * 3).fill(0);
  const tableWidthDeltas = new Array<number>(vertexCount * 3).fill(0);
  // At weight 1: cusp regions rise by this extra mm; occlusal-table
  // vertices (at/above the wall top) widen mesiodistally by this fraction.
  const CUSP_HEIGHT_MORPH_MM = 0.8;
  const TABLE_WIDTH_MORPH_FRACTION = 0.1;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (z < wallTopZ - 1e-9) continue; // axial wall vertex: neither morph touches it.
    const theta = Math.atan2(y, x);
    let cuspWeight = 0;
    for (const angle of Object.values(CUSP_ANGLES_RAD)) {
      cuspWeight += angularWindow(theta, angle, params.cuspAngularHalfWidthRad);
    }
    cuspHeightDeltas[i * 3 + 2] = Math.min(1, cuspWeight) * CUSP_HEIGHT_MORPH_MM;
    tableWidthDeltas[i * 3] = x * TABLE_WIDTH_MORPH_FRACTION;
  }
  return [
    { name: 'cuspHeight', vertexDeltas: cuspHeightDeltas },
    { name: 'occlusalTableWidth', vertexDeltas: tableWidthDeltas },
  ];
}

function capRingIndexNearS(s: number): number {
  return Math.min(CAP_STEPS - 1, Math.max(1, Math.round(s * CAP_STEPS)));
}

/**
 * Generates a watertight, deterministic molar crown for `fdi` (must be a
 * key of `MOLAR_FDI_PARAMS` — this task ships FDI 16 only, see that
 * table's doc). Pure function: same `fdi` always produces byte-identical
 * output (no `Math.random`, no clock/env dependence).
 */
export function generateMolarAsset(fdi: FdiTooth): MolarAsset {
  const params = MOLAR_FDI_PARAMS[fdi];
  if (!params) {
    throw new RangeError(`generateMolarAsset: fdi ${fdi} is not a supported molar (see MOLAR_FDI_PARAMS)`);
  }

  const builder = createMeshBuilder();
  const wallRings: number[][] = [];
  for (let i = 0; i < WALL_RING_COUNT; i++) {
    const v = i / (WALL_RING_COUNT - 1);
    const z = v * params.crownHeightMm;
    wallRings.push(addRing(builder, wallCrossSection(params, v), z, SEGMENTS));
  }
  for (let i = 0; i < WALL_RING_COUNT - 1; i++) {
    stitchRings(builder, wallRings[i]!, wallRings[i + 1]!);
  }
  capBottom(builder, wallRings[0]!, 0);

  const wallTopZ = params.crownHeightMm;
  const wallTopRing = wallRings[WALL_RING_COUNT - 1]!;

  const capRings: number[][] = [];
  for (let m = 1; m < CAP_STEPS; m++) {
    capRings.push(addCapRing(builder, params, m / CAP_STEPS, wallTopZ));
  }
  stitchRings(builder, wallTopRing, capRings[0]!);
  for (let m = 0; m < capRings.length - 1; m++) {
    stitchRings(builder, capRings[m]!, capRings[m + 1]!);
  }
  const centerZ = wallTopZ + centerElevation(params);
  const centerIndex = capTop(builder, capRings[capRings.length - 1]!, centerZ);

  const cuspRing = capRings[capRingIndexNearS(params.sCusp) - 1]!;
  const ridgeRing = capRings[capRingIndexNearS(params.sRidge) - 1]!;

  const landmarks: Record<string, Vec3> = {
    mesiobuccalCusp: vertexAt(builder, cuspRing[nearestRingIndex(CUSP_ANGLES_RAD.mesiobuccal, SEGMENTS)]!),
    distobuccalCusp: vertexAt(builder, cuspRing[nearestRingIndex(CUSP_ANGLES_RAD.distobuccal, SEGMENTS)]!),
    mesiolingualCusp: vertexAt(builder, cuspRing[nearestRingIndex(CUSP_ANGLES_RAD.mesiolingual, SEGMENTS)]!),
    distolingualCusp: vertexAt(builder, cuspRing[nearestRingIndex(CUSP_ANGLES_RAD.distolingual, SEGMENTS)]!),
    centralFossa: vertexAt(builder, centerIndex),
    mesialMarginalRidge: vertexAt(builder, ridgeRing[nearestRingIndex(Math.PI, SEGMENTS)]!),
    distalMarginalRidge: vertexAt(builder, ridgeRing[nearestRingIndex(0, SEGMENTS)]!),
  };

  const mesh = toIndexedMesh(builder);

  return {
    fdi,
    toothType: 'molar',
    mesh,
    landmarks,
    canonicalFrame: IDENTITY_FRAME,
    morphTargets: molarMorphTargets(mesh.positions, params, wallTopZ),
  };
}

export const MOLAR_FDI_CODES: readonly FdiTooth[] = [16];
