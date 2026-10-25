// jobs/bridgeCaseGeometry.ts — the worker jobs of the bridge built from the
// case (Phase 9 Task 6): the ridge crest fitted from the gingiva scan
// (`fitRidgeCrest`), the closed pontic unit per style (`bridgePonticUnit`) and
// the connector frames between the built units (`placeBridgeConnectors`). Thin
// drivers over @dqcad/kernel ops — no value is computed here that the ops do
// not compute, so a payload is byte-identical to direct kernel calls.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  buildBvh,
  buildPlacementTransform,
  buildPonticUnit,
  computePseudonormals,
  fitRidgeCrestCylinder,
  measurePonticRelief,
  placeConnectorBetweenUnits,
  placeMesh,
  raycast,
  rescalePlacement,
  solveAnatomyPlacement,
  synthPonticSeatRing,
  type CanonicalFrameAxes,
  type PonticBaseFootprint,
  type PonticInterfaceParams,
  type PonticInterfaceStyle,
  type PonticReliefPatchStats,
  type PonticUnitParams,
  type RidgeCrestCylinder,
  type RidgeCrestFit,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

// ---------------------------------------------------------------------------
// fitRidgeCrest
// ---------------------------------------------------------------------------

export interface FitRidgeCrestPayload {
  gingivaPositions: Float64Array;
  gingivaIndices: Uint32Array;
  /** A point above the pontic site (e.g. between the abutment margins). */
  siteMm: Vec3;
  /** The occlusal direction (the bridge's shared insertion axis). */
  upHint: Vec3;
  /** Any vector pointing buccally. */
  buccalHint: Vec3;
  /** Ball radius of the crest window around the site's crest point (mm). */
  regionRadiusMm: number;
  minUpCos?: number;
}

export interface FitRidgeCrestResult extends RidgeCrestFit {
  /** Where the site's vertical line meets the gingiva — the window centre. */
  crestPointMm: Vec3;
}

/** Thrown when the vertical line through the pontic site misses the gingiva. */
export class RidgeSiteMissError extends Error {
  constructor() {
    super('fitRidgeCrest: the line through the pontic site along the insertion axis does not meet the gingiva scan');
    this.name = 'RidgeSiteMissError';
  }
}

/** How far above the site (mm) the downward ray starts — far enough to clear
 * any ridge, a construction length, not a clinical value. */
const SITE_RAY_LIFT_MM = 100;

export const fitRidgeCrestJob = async (payload: FitRidgeCrestPayload, ctx: JobContext): Promise<FitRidgeCrestResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const mesh = { positions: payload.gingivaPositions, indices: payload.gingivaIndices };
  const up = payload.upHint;
  const l = Math.hypot(up[0], up[1], up[2]);
  if (!(l > 0)) throw new TypeError('fitRidgeCrest: upHint must be non-zero');
  const u: Vec3 = [up[0] / l, up[1] / l, up[2] / l];
  const origin: Vec3 = [
    payload.siteMm[0] + SITE_RAY_LIFT_MM * u[0],
    payload.siteMm[1] + SITE_RAY_LIFT_MM * u[1],
    payload.siteMm[2] + SITE_RAY_LIFT_MM * u[2],
  ];
  const hit = raycast(mesh, buildBvh(mesh), origin, [-u[0], -u[1], -u[2]]);
  if (!hit) throw new RidgeSiteMissError();
  const crestPointMm: Vec3 = [hit.point[0], hit.point[1], hit.point[2]];
  const fit = fitRidgeCrestCylinder(
    mesh,
    { centerMm: crestPointMm, radiusMm: payload.regionRadiusMm },
    { upHint: payload.upHint, buccalHint: payload.buccalHint, ...(payload.minUpCos !== undefined ? { minUpCos: payload.minUpCos } : {}) },
  );
  ctx.progress(1);
  return { ...fit, crestPointMm };
};

// ---------------------------------------------------------------------------
// bridgePonticUnit
// ---------------------------------------------------------------------------

export interface BridgePonticUnitStylePayload {
  style: PonticInterfaceStyle;
  params: PonticInterfaceParams;
}

export interface BridgePonticUnitPayload {
  gingivaPositions: Float64Array;
  gingivaIndices: Uint32Array;
  crest: RidgeCrestCylinder;
  canonicalFrame: CanonicalFrameAxes;
  libraryPositions: Float64Array;
  libraryIndices: Uint32Array;
  insertionAxis: Vec3;
  /** The built abutment units on each side (placement references). */
  mesialNeighborPositions: Float64Array;
  distalNeighborPositions: Float64Array;
  antagonistPositions: Float64Array | null;
  /** Gap (mm) kept between the pontic body and each neighbour along the arch,
   * so the units meet only through their connectors. */
  proximalClearanceMm: number;
  seatRingRadiusMm: number;
  seatRingSegments: number;
  styles: readonly BridgePonticUnitStylePayload[];
  unit: PonticUnitParams;
}

export interface BridgePonticUnitStyleResult {
  style: PonticInterfaceStyle;
  solidPositions: Float64Array;
  solidIndices: Uint32Array;
  undersidePositions: Float64Array;
  undersideIndices: Uint32Array;
  outerPositions: Float64Array;
  outerIndices: Uint32Array;
  /** The base footprint's boundary, flat xyz (the unit's rim polyline). */
  rimLoopFlat: Float64Array;
  footprint: PonticBaseFootprint;
  /** Design relief on the primary patch, measured against the gingiva. */
  primary: PonticReliefPatchStats;
  /** Distance from the design base to the as-built underside (mm). */
  asBuiltDeviationMm: number;
  /** The relief gate value: design deviation + as-built deviation (mm). */
  maxAbsDeviationMm: number;
  primaryTargetMm: number;
  /** The base construction's crest-sagitta @errorBound (mm). */
  errorBoundMm: number;
}

export interface BridgePonticUnitResult {
  bodyPositions: Float64Array;
  bodyIndices: Uint32Array;
  scaleMesialDistal: number;
  proximalScale: number;
  usedProximalGap: boolean;
  styles: readonly BridgePonticUnitStyleResult[];
}

function flatLoop(loop: readonly Vec3[]): Float64Array {
  const out = new Float64Array(loop.length * 3);
  for (let i = 0; i < loop.length; i++) {
    out[i * 3] = loop[i]![0];
    out[i * 3 + 1] = loop[i]![1];
    out[i * 3 + 2] = loop[i]![2];
  }
  return out;
}

export const bridgePonticUnitJob = async (
  payload: BridgePonticUnitPayload,
  ctx: JobContext,
): Promise<BridgePonticUnitResult> => {
  if (payload.styles.length === 0) throw new TypeError('bridgePonticUnit: at least one style is required');
  if (!(Number.isFinite(payload.proximalClearanceMm) && payload.proximalClearanceMm >= 0)) {
    throw new TypeError(`bridgePonticUnit: proximalClearanceMm must be finite and >= 0, got ${payload.proximalClearanceMm}`);
  }
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  // PLACEMENT — the bridgePontic job's construction (seat ring on the crest
  // apex at the window centre, station 0), then shrunk about its seat so the
  // body clears each neighbour by `proximalClearanceMm` along the arch.
  const seatRing = synthPonticSeatRing(payload.crest, 0, payload.seatRingRadiusMm, payload.seatRingSegments);
  const libraryMesh = { positions: payload.libraryPositions, indices: payload.libraryIndices };
  const solution = solveAnatomyPlacement({
    canonicalFrame: payload.canonicalFrame,
    libraryMesh,
    marginLoop: seatRing,
    insertionAxis: payload.insertionAxis,
    mesialNeighborPositions: payload.mesialNeighborPositions,
    distalNeighborPositions: payload.distalNeighborPositions,
    antagonistPositions: payload.antagonistPositions,
  });
  const width = solution.measurements.targetMesialDistalWidthMm;
  const proximalScale = (width - 2 * payload.proximalClearanceMm) / width;
  if (!(proximalScale > 0)) {
    throw new TypeError(`bridgePonticUnit: the ${width.toFixed(3)} mm pontic space cannot keep ${payload.proximalClearanceMm} mm to each neighbour`);
  }
  const frame = rescalePlacement(solution.frame, { md: proximalScale, bl: proximalScale, og: proximalScale });
  const body = placeMesh(libraryMesh, buildPlacementTransform(frame, payload.canonicalFrame));
  ctx.progress(0.1);

  const gingiva = { positions: payload.gingivaPositions, indices: payload.gingivaIndices };
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  const styles: BridgePonticUnitStyleResult[] = [];
  for (let i = 0; i < payload.styles.length; i++) {
    if (await ctx.cancelled()) throw new JobCancelledError();
    const { style, params } = payload.styles[i]!;
    const unit = await buildPonticUnit(body, payload.crest, style, params, payload.unit);
    const relief = measurePonticRelief(gingiva, bvh, pn, unit.base.samples, payload.crest);
    styles.push({
      style,
      solidPositions: unit.solid.positions,
      solidIndices: unit.solid.indices,
      undersidePositions: unit.underside.positions,
      undersideIndices: unit.underside.indices,
      outerPositions: unit.outer.positions,
      outerIndices: unit.outer.indices,
      rimLoopFlat: flatLoop(unit.rimLoop),
      footprint: unit.footprint,
      primary: relief.primary,
      asBuiltDeviationMm: unit.asBuiltDeviationMm,
      maxAbsDeviationMm: relief.primary.maxAbsDeviationMm + unit.asBuiltDeviationMm,
      primaryTargetMm: unit.base.primaryTargetMm,
      errorBoundMm: unit.base.errorBoundMm,
    });
    ctx.progress(0.1 + (0.9 * (i + 1)) / payload.styles.length);
  }
  return {
    bodyPositions: body.positions,
    bodyIndices: body.indices,
    scaleMesialDistal: frame.scaleMesialDistal,
    proximalScale,
    usedProximalGap: solution.measurements.usedProximalGap,
    styles,
  };
};

// ---------------------------------------------------------------------------
// placeBridgeConnectors
// ---------------------------------------------------------------------------

export interface PlaceBridgeConnectorsPayload {
  /** The built unit solids in arch order (mesial → distal). */
  units: readonly { positions: Float64Array; indices: Uint32Array }[];
  /** How far each connector end reaches into its unit (mm). */
  overlapMm: number;
}

export interface PlaceBridgeConnectorsResult {
  /** One frame per adjacent pair (units i, i+1). */
  connectors: readonly { originMm: Vec3; axisMm: Vec3; spanMm: number; exitAMm: number; entryBMm: number }[];
}

export const placeBridgeConnectorsJob = async (
  payload: PlaceBridgeConnectorsPayload,
  ctx: JobContext,
): Promise<PlaceBridgeConnectorsResult> => {
  if (payload.units.length < 2) throw new TypeError('placeBridgeConnectors: at least two units are required');
  if (await ctx.cancelled()) throw new JobCancelledError();
  const connectors: PlaceBridgeConnectorsResult['connectors'][number][] = [];
  for (let i = 0; i + 1 < payload.units.length; i++) {
    const placed = placeConnectorBetweenUnits(payload.units[i]!, payload.units[i + 1]!, payload.overlapMm);
    connectors.push({
      originMm: placed.originMm,
      axisMm: placed.axisMm,
      spanMm: placed.spanMm,
      exitAMm: placed.exitAMm,
      entryBMm: placed.entryBMm,
    });
    ctx.progress((i + 1) / (payload.units.length - 1));
  }
  return { connectors };
};
