// packages/tooth-library/src/generate/posterior.ts
//
// Shared POSTERIOR crown builder (Phase 9 Task 4): the molar generator's
// wall + occlusal-table machinery, parameterized by the cusp set so the
// premolar (two cusps) reuses it. Extracted from molar.ts unchanged — the
// molar passes its four cusps in the original summation order with height
// scale 1, so FDI 16's mesh is byte-identical to the pre-extraction
// generator (pinned in molar.test.ts). PLACEHOLDER ANATOMY — see
// toothParams.ts's module doc and README.md.
import type { Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { MorphTarget, ToothLandmarks } from '../schema.ts';
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
import type { MolarParams } from './toothParams.ts';

export const SEGMENTS = 72;
/** Wall rings from the cervical margin (i=0, v=0) up to AND INCLUDING the
 * occlusal table's own outer boundary (i=WALL_RING_COUNT-1, v=1) — the last
 * wall ring is reused directly as the cap's own outer contour. */
const WALL_RING_COUNT = 14;
/** Interior occlusal-table contour rings, `s = m / CAP_STEPS` for
 * `m = 1 .. CAP_STEPS - 1`. */
const CAP_STEPS = 10;

/** One cusp: its landmark name, angle in the table (0 = distal, 90° =
 * buccal), and its height relative to `MolarParams.cuspHeightMm`. */
export interface PosteriorCusp {
  readonly name: string;
  readonly angleRad: number;
  readonly heightScale: number;
}

function wallCrossSection(
  params: MolarParams,
  v: number,
): (theta: number) => { x: number; y: number } {
  const rx =
    mix(params.rxCervicalMm, params.rxWallTopMm, smoothstep(0, 1, v)) +
    params.rxContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  const ry =
    mix(params.ryCervicalMm, params.ryWallTopMm, smoothstep(0, 1, v)) +
    params.ryContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  return (theta: number) => ({ x: rx * Math.cos(theta), y: ry * Math.sin(theta) });
}

/** Occlusal-table elevation above `wallTopZ` at radial position `s` in
 * `(0, 1)` and angle `theta`: dome + cusp bumps + 2 marginal-ridge bumps −
 * the central-fossa dip. */
function tableElevation(
  params: MolarParams,
  cusps: readonly PosteriorCusp[],
  s: number,
  theta: number,
): number {
  const dome = params.occlusalTableReliefMm * Math.sin(Math.PI * s);
  let cuspBump = 0;
  for (const cusp of cusps) {
    cuspBump +=
      cusp.heightScale * angularWindow(theta, cusp.angleRad, params.cuspAngularHalfWidthRad);
  }
  cuspBump *= params.cuspHeightMm * gaussianBump(s, params.sCusp, params.sigmaSCusp);
  const ridgeBump =
    params.ridgeHeightMm *
    gaussianBump(s, params.sRidge, params.sigmaSRidge) *
    (angularWindow(theta, 0, params.ridgeAngularHalfWidthRad) +
      angularWindow(theta, Math.PI, params.ridgeAngularHalfWidthRad));
  const fossaDip = params.fossaDepthMm * gaussianBump(s, 1, params.sigmaSFossa);
  return dome + cuspBump + ridgeBump - fossaDip;
}

/** The center vertex's elevation above `wallTopZ` (evaluated directly — at
 * `s === 1` the table collapses to a point with no meaningful `theta`). */
function centerElevation(params: MolarParams): number {
  return (
    params.occlusalTableReliefMm * Math.sin(Math.PI) -
    params.fossaDepthMm * gaussianBump(1, 1, params.sigmaSFossa)
  );
}

function addCapRing(
  builder: MeshBuilder,
  params: MolarParams,
  cusps: readonly PosteriorCusp[],
  s: number,
  wallTopZ: number,
): number[] {
  const rx = params.rxWallTopMm * Math.pow(1 - s, params.radialShrinkPower);
  const ry = params.ryWallTopMm * Math.pow(1 - s, params.radialShrinkPower);
  const ring: number[] = new Array(SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) {
    const theta = (2 * Math.PI * i) / SEGMENTS;
    const x = rx * Math.cos(theta);
    const y = ry * Math.sin(theta);
    const z = wallTopZ + tableElevation(params, cusps, s, theta);
    ring[i] = addVertex(builder, x, y, z);
  }
  return ring;
}

/** Pure per-vertex morph deltas — a function of each vertex's own final
 * (x, y, z) alone (see incisor.ts's `incisorMorphTargets` doc for why). */
export function posteriorMorphTargets(
  positions: Float64Array,
  params: MolarParams,
  wallTopZ: number,
  cusps: readonly PosteriorCusp[],
): MorphTarget[] {
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
    for (const cusp of cusps) {
      cuspWeight += angularWindow(theta, cusp.angleRad, params.cuspAngularHalfWidthRad);
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
 * Builds a watertight posterior crown: the axial wall, the occlusal table
 * with `cusps` (summed in array order), the central fossa and the two
 * marginal ridges. Landmarks are emitted in `landmarkOrder` (cusp names,
 * then `centralFossa`, `mesialMarginalRidge`, `distalMarginalRidge`).
 * Pure and deterministic.
 */
export function buildPosteriorCrown(
  params: MolarParams,
  cusps: readonly PosteriorCusp[],
  landmarkOrder: readonly string[],
): { mesh: IndexedMesh; landmarks: ToothLandmarks; wallTopZ: number; cervicalRing: number[] } {
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
    capRings.push(addCapRing(builder, params, cusps, m / CAP_STEPS, wallTopZ));
  }
  stitchRings(builder, wallTopRing, capRings[0]!);
  for (let m = 0; m < capRings.length - 1; m++) {
    stitchRings(builder, capRings[m]!, capRings[m + 1]!);
  }
  const centerZ = wallTopZ + centerElevation(params);
  const centerIndex = capTop(builder, capRings[capRings.length - 1]!, centerZ);

  const cuspRing = capRings[capRingIndexNearS(params.sCusp) - 1]!;
  const ridgeRing = capRings[capRingIndexNearS(params.sRidge) - 1]!;

  const byName: Record<string, Vec3> = {
    centralFossa: vertexAt(builder, centerIndex),
    mesialMarginalRidge: vertexAt(builder, ridgeRing[nearestRingIndex(Math.PI, SEGMENTS)]!),
    distalMarginalRidge: vertexAt(builder, ridgeRing[nearestRingIndex(0, SEGMENTS)]!),
  };
  for (const cusp of cusps) {
    byName[cusp.name] = vertexAt(builder, cuspRing[nearestRingIndex(cusp.angleRad, SEGMENTS)]!);
  }
  const landmarks: Record<string, Vec3> = {};
  for (const name of landmarkOrder) landmarks[name] = byName[name]!;

  // The cervical ring: the lowest wall ring (Phase 10 Task 4, the fit's ring).
  return { mesh: toIndexedMesh(builder), landmarks, wallTopZ, cervicalRing: wallRings[0]! };
}
