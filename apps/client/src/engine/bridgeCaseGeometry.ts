// apps/client/src/engine/bridgeCaseGeometry.ts
//
// Phase 9 Task 6 — the bridge built FROM THE CASE (ADR-022): the per-unit
// geometry `bridgeDesign.start()` consumes, computed by the registered worker
// jobs from what the case actually holds — the target (prep) scan, the
// confirmed abutment margin loops, the shared insertion axis and the gingiva
// scan — instead of the fixed 14-15-16 demonstration asset (bridgeGeometry.ts,
// kept as the explicit demo mode).
//
//   abutments  `bridgeAbutmentSurfaces` (every intaglio on the ONE shared axis,
//              + the shared-axis assessment over each prep and each surface's
//              margin fit) → per abutment `placeAnatomy` of the built-in
//              template → `constructShell` (the crown chain's own jobs);
//   pontic     `fitRidgeCrest` on the gingiva scan (Task 5) → the library body
//              for the pontic FDI (Task 4; built-in fallback, disclosed) →
//              `bridgePonticUnit`, once for all three styles (the base, and so
//              the unit, depends on the style);
//   connectors `placeBridgeConnectors` between the built units, per style.
//
// Assembly, framework and QC then run on this geometry through the same jobs
// the demonstration bridge uses (bridgeDesign.ts).
//
// ## Construction parameters (journaled by the controller)
//
// Geometric choices of THIS construction, not clinical gaps or thicknesses;
// every clinical value is read from the material profile (CLAUDE.md
// invariant 7). Where a construction choice sets a wall the QC gates measure,
// it is tied to the profile's minimum wall (`2 × minWallThicknessMm`) — the
// gates still judge the built result, never this number.
//
// Layer rule: engine → kernel-workers / state / shared-types /
// clinical-profiles only; payloads are matched structurally.
import { DEFAULT_OFFSET_VOXEL_PITCH_MM, type MaterialProfile } from '@dqcad/clinical-profiles';
import type { FdiTooth, Restoration, Vec3 } from '@dqcad/shared-types';
import type { RunnablePool } from './bridgeDesign';
import { abutmentMarginPoints, bridgeAbutmentTeeth } from './bridgeWorkflow';
import { builtinLibraryTooth, flattenLoop } from './crownGeometry';
import type { ResolvedAnatomy } from './toothLibrary';

type Buffers = { positions: Float64Array; indices: Uint32Array };
type PonticStyle = 'hygienic' | 'ridgeLap' | 'ovate';

export const BRIDGE_PONTIC_STYLES: readonly PonticStyle[] = ['hygienic', 'ridgeLap', 'ovate'];

/** C¹ blend width of the intaglio's gap transition (mm) — the crown chain's. */
const INNER_SURFACE_BLEND_WIDTH_MM = 0.3;
/** Gap kept between the pontic and each abutment along the arch (mm) — the
 * units meet only through their connectors (a touching union leaves sliver
 * self-intersections). */
const PONTIC_PROXIMAL_CLEARANCE_MM = 0.3;
/** The pontic's synthetic gingival seat ring (the cad-pipeline stage defaults). */
const PONTIC_SEAT_RING_RADIUS_MM = 1.5;
const PONTIC_SEAT_RING_SEGMENTS = 64;
/** The pontic base plate overhangs the body section by this much (mm). */
const PONTIC_FLANGE_MM = 0.2;
/** Discovery level floor above the crest (mm) for bases below the body. */
const PONTIC_SEAT_OFFSET_MM = 0.3;
/** The pontic base mesh / sample grid (the Phase 6 acceptance resolution). */
const PONTIC_BASE_RESOLUTION = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };
/** How far each connector end reaches into its unit (mm). */
const CONNECTOR_OVERLAP_MM = 0.5;
/** The default connector section — a circle (the editor's semi-axis). */
const CONNECTOR_DEFAULT_SEMI_AXIS_MM = 1.9;
const CONNECTOR_SEGMENTS = 48;
/** Slack on the intaglio fit-region bounds (mm): selects the intaglio off the
 * assembled solid without catching the outer surface. */
const FIT_REGION_SLACK_MM = 1e-3;

export class BridgeCaseInputError extends Error {
  readonly reason: 'layout' | 'noTargetScan' | 'noGingivaScan' | 'noMargin';
  constructor(reason: BridgeCaseInputError['reason'], message: string) {
    super(`bridge from the case: ${message}`);
    this.name = 'BridgeCaseInputError';
    this.reason = reason;
  }
}

/** One unit of the built geometry (structurally `BridgeSessionUnit`). */
export interface CaseBridgeUnit {
  label: string;
  kind: 'abutment' | 'pontic';
  insertionAxis: Vec3;
  marginFitMm: number;
  mesh: Buffers;
  inner: Buffers;
  outer: Buffers;
  marginLoop: Vec3[];
  fitRegion: { axisPointMm: Vec3; axis: Vec3; maxRadialMm: number; minAxialMm: number; maxAxialMm: number } | null;
  die: Buffers | null;
}

/** One connector frame + default profile (structurally `BridgeSessionConnector`). */
export interface CaseBridgeConnector {
  label: string;
  teeth: readonly [number, number];
  originMm: Vec3;
  axisMm: Vec3;
  spanMm: number;
  semiAxisMm: number;
  segments: number;
  profileFlat: number[];
}

export interface CaseBridgeStyleVariant {
  pontic: CaseBridgeUnit;
  connectors: CaseBridgeConnector[];
  configuredReliefMm: number;
  maxAbsDeviationMm: number;
  asBuiltDeviationMm: number;
}

export interface CaseBridgeGeometry {
  sharedAxis: {
    direction: Vec3;
    acceptable: boolean;
    perAbutment: { label: string; marginFitMm: number; undercutTriangleCount: number; maxDepthMm: number }[];
  };
  abutments: CaseBridgeUnit[];
  ponticTooth: number;
  /** Units in arch order, as labels (abutments and the pontic). */
  archOrder: string[];
  variants: Record<PonticStyle, CaseBridgeStyleVariant>;
  crestFit: { radialResidualMaxMm: number; radialResidualRmsMm: number; axisSpreadRad: number; faceCount: number };
  /** Content hashes of every case input the build consumed. */
  inputHashes: {
    targetScan: string;
    gingiva: string;
    marginLoops: Record<string, string>;
    ponticTemplate: string | null;
  };
  ponticTemplate: { origin: 'library'; meshChecksum: string; version: string } | { origin: 'builtin'; reason: string };
  /** The construction parameters, journaled with the stage ops. */
  construction: Record<string, unknown>;
}

export interface BridgeCaseInputs {
  restoration: Restoration;
  targetScan: { meshId: string } & Buffers;
  gingiva: { meshId: string } & Buffers;
  profile: MaterialProfile;
  /** The library tooth for the pontic FDI (never throws; null ⇒ built-in). */
  resolvePonticTemplate: (fdi: FdiTooth) => Promise<ResolvedAnatomy>;
  pitchMm?: number;
  onProgress?: (fraction: number) => void;
}

function position(tooth: number): number {
  return tooth % 10;
}
function quadrant(tooth: number): number {
  return Math.floor(tooth / 10);
}

/** Teeth in arch order: mesial → distal within one quadrant; across the
 * midline, the patient's right to left (quadrant 1/4 descending, then 2/3
 * ascending). */
export function archOrder(teeth: readonly number[]): number[] {
  const quadrants = new Set(teeth.map(quadrant));
  if (quadrants.size === 1) return [...teeth].sort((a, b) => position(a) - position(b));
  const right = teeth.filter((t) => quadrant(t) === 1 || quadrant(t) === 4).sort((a, b) => position(b) - position(a));
  const left = teeth.filter((t) => quadrant(t) === 2 || quadrant(t) === 3).sort((a, b) => position(a) - position(b));
  return [...right, ...left];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

function centroid(points: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}

/** Mean radial distance of the margin from its centroid, ⊥ `axis`. */
function marginRadius(points: readonly Vec3[], c: Vec3, axis: Vec3): number {
  let sum = 0;
  for (const p of points) {
    const d = sub(p, c);
    sum += Math.hypot(...sub(d, scale(axis, dot(d, axis))));
  }
  return sum / points.length;
}

/** The prep's height above the margin along `axis`: the highest scan vertex
 * inside the margin's lateral radius. */
function prepHeightMm(scan: Buffers, c: Vec3, axis: Vec3, radius: number): number {
  let top = 0;
  for (let i = 0; i < scan.positions.length; i += 3) {
    const d: Vec3 = [scan.positions[i]! - c[0], scan.positions[i + 1]! - c[1], scan.positions[i + 2]! - c[2]];
    const h = dot(d, axis);
    const lateral = Math.hypot(...sub(d, scale(axis, h)));
    if (lateral <= radius && h > top) top = h;
  }
  return top;
}

/** The intaglio's cylinder bounds about the margin centroid (construction
 * provenance for `extractFitPatch` on the assembled solid). */
function fitRegionOf(inner: Buffers, c: Vec3, axis: Vec3): NonNullable<CaseBridgeUnit['fitRegion']> {
  let maxRadial = 0;
  let minAxial = Infinity;
  let maxAxial = -Infinity;
  for (let i = 0; i < inner.positions.length; i += 3) {
    const d: Vec3 = [inner.positions[i]! - c[0], inner.positions[i + 1]! - c[1], inner.positions[i + 2]! - c[2]];
    const h = dot(d, axis);
    const r = Math.hypot(...sub(d, scale(axis, h)));
    if (r > maxRadial) maxRadial = r;
    if (h < minAxial) minAxial = h;
    if (h > maxAxial) maxAxial = h;
  }
  return {
    axisPointMm: c,
    axis,
    maxRadialMm: maxRadial + FIT_REGION_SLACK_MM,
    minAxialMm: minAxial - FIT_REGION_SLACK_MM,
    maxAxialMm: maxAxial + FIT_REGION_SLACK_MM,
  };
}

function ellipseProfileFlat(semiAxisMm: number, segments: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    out.push(semiAxisMm * Math.cos(th), semiAxisMm * Math.sin(th));
  }
  return out;
}

function loopFromFlat(flat: Float64Array): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return out;
}

/** The configured relief param of each style, from the profile. */
function styleParams(profile: MaterialProfile, style: PonticStyle): { params: Record<string, number>; configuredReliefMm: number } {
  if (style === 'hygienic') return { params: { clearanceMm: profile.ponticHygienicClearanceMm }, configuredReliefMm: profile.ponticHygienicClearanceMm };
  if (style === 'ridgeLap') return { params: { reliefMm: profile.ponticRidgeLapReliefMm }, configuredReliefMm: profile.ponticRidgeLapReliefMm };
  return { params: { depthMm: profile.ponticOvateDepthMm }, configuredReliefMm: profile.ponticOvateDepthMm };
}

/**
 * Builds the bridge geometry from the case — see this module's doc.
 *
 * @throws {BridgeCaseInputError} for an unsupported unit layout (this path
 * builds abutment · pontic · abutment) or a missing margin.
 * @throws the jobs' typed errors (an intaglio, shell, crest fit or pontic that
 * cannot be built) — the controller surfaces them, never a stand-in.
 */
export async function buildBridgeCaseGeometry(pool: RunnablePool, inputs: BridgeCaseInputs): Promise<CaseBridgeGeometry> {
  const { restoration, targetScan, gingiva, profile } = inputs;
  const progress = inputs.onProgress ?? (() => undefined);
  const order = archOrder(restoration.teeth);
  const pontics = new Set<number>(restoration.pontics);
  const abutmentTeeth = bridgeAbutmentTeeth(restoration);
  if (order.length !== 3 || abutmentTeeth.length !== 2 || !pontics.has(order[1]!) || pontics.has(order[0]!) || pontics.has(order[2]!)) {
    throw new BridgeCaseInputError(
      'layout',
      `this path builds a 3-unit bridge (abutment · pontic · abutment); the restoration is ${order.join('-')} with pontic(s) ${[...pontics].join(', ') || 'none'}`,
    );
  }
  const axis = normalize(restoration.insertionAxis);
  const pitchMm = inputs.pitchMm ?? DEFAULT_OFFSET_VOXEL_PITCH_MM;
  const mesialTooth = order[0]!;
  const ponticTooth = order[1]!;
  const distalTooth = order[2]!;

  const margins = [mesialTooth, distalTooth].map((tooth) => {
    const points = abutmentMarginPoints(restoration, tooth as FdiTooth);
    if (!points) throw new BridgeCaseInputError('noMargin', `abutment ${tooth} has no confirmed margin loop`);
    const c = centroid(points);
    return { tooth, points: [...points], c, radius: marginRadius(points, c, axis) };
  });
  const [mesial, distal] = margins as [(typeof margins)[number], (typeof margins)[number]];
  // The arch's mesiodistal direction across the bridge, ⊥ the shared axis.
  const mdRaw = sub(distal.c, mesial.c);
  const md = normalize(sub(mdRaw, scale(axis, dot(mdRaw, axis))));

  // Content hashes of the margin loops (flat xyz, no triangles).
  const marginLoops: Record<string, string> = {};
  for (const m of margins) {
    const { contentHash } = await pool.run('hashMesh', { positions: flattenLoop(m.points), indices: new Uint32Array(0) });
    marginLoops[String(m.tooth)] = contentHash;
  }

  // ---- abutments: intaglios on the shared axis ----------------------------
  const scanPositions = targetScan.positions.slice();
  const scanIndices = targetScan.indices.slice();
  await pool.run(
    'buildBvh',
    { contentHash: targetScan.meshId, positions: scanPositions, indices: scanIndices },
    { transfer: [scanPositions.buffer, scanIndices.buffer], affinityKey: targetScan.meshId },
  );
  const rp = profile.restorationParams;
  const surfaces = await pool.run(
    'bridgeAbutmentSurfaces',
    {
      contentHash: targetScan.meshId,
      pitchMm,
      marginalGapMm: rp.marginalGapMm,
      cementGapMm: rp.cementGapMm,
      spacerStartMm: rp.spacerStartMm,
      blendWidthMm: INNER_SURFACE_BLEND_WIDTH_MM,
      insertionAxis: axis,
      abutments: margins.map((m) => ({ tooth: m.tooth, marginLoop: flattenLoop(m.points) })),
      assess: true,
    },
    { affinityKey: targetScan.meshId, onProgress: (f) => progress(0.4 * f) },
  );

  // ---- abutments: anatomy + shell (the crown chain) -----------------------
  const cervicalEmergenceMm = 2 * rp.minWallThicknessMm;
  const abutments: CaseBridgeUnit[] = [];
  for (let i = 0; i < margins.length; i++) {
    const m = margins[i]!;
    const inner = surfaces.abutments[i]!;
    const height = prepHeightMm(targetScan, m.c, axis, m.radius);
    const heightMm = Math.max(height * 1.3 + 0.5, m.radius * 2);
    // The built-in template in its own frame (margin centre at the origin);
    // the placement maps it onto the margin along the shared axis.
    const template = builtinLibraryTooth(m.radius, 0, heightMm, rp.minWallThicknessMm * 2);
    // Mesiodistal references at the margin ± (radius + emergence): the
    // template emerges `cervicalEmergenceMm` beyond the margin.
    const reach = m.radius + cervicalEmergenceMm;
    const placed = await pool.run('placeAnatomy', {
      canonicalFrame: template.canonicalFrame,
      libraryPositions: template.positions,
      libraryIndices: template.indices,
      marginLoop: flattenLoop(m.points),
      insertionAxis: axis,
      mesialNeighborPositions: Float64Array.from(sub(m.c, scale(md, reach))),
      distalNeighborPositions: Float64Array.from(add(m.c, scale(md, reach))),
      antagonistPositions: null,
    });
    const shell = await pool.run('constructShell', {
      outerPositions: placed.positions,
      outerIndices: placed.indices,
      innerPositions: inner.positions,
      innerIndices: inner.indices,
      insertionAxis: axis,
      marginLoop: flattenLoop(m.points),
    });
    abutments.push({
      label: String(m.tooth),
      kind: 'abutment',
      insertionAxis: axis,
      marginFitMm: inner.marginFitMm ?? Number.POSITIVE_INFINITY,
      mesh: { positions: shell.positions, indices: shell.indices },
      inner: { positions: inner.positions, indices: inner.indices },
      outer: { positions: shell.outerUsedPositions, indices: shell.outerUsedIndices },
      marginLoop: m.points,
      fitRegion: fitRegionOf(inner, m.c, axis),
      // The prep scan carries every abutment die: it rides once.
      die: i === 0 ? { positions: targetScan.positions, indices: targetScan.indices } : null,
    });
    progress(0.4 + 0.15 * (i + 1));
  }

  // ---- pontic: crest from the gingiva, library body, unit per style -------
  const siteMm = scale(add(mesial.c, distal.c), 0.5);
  const freeGapMm = Math.hypot(...mdRaw) - mesial.radius - distal.radius;
  // FDI quadrants 1 and 3 have buccal = up × (mesial→distal); 2 and 4 the
  // opposite (the arch runs the other way round the patient).
  const ponticMesialSide = quadrant(mesialTooth) !== quadrant(ponticTooth) ? mesial : position(mesialTooth) < position(ponticTooth) ? mesial : distal;
  const ponticDistalSide = ponticMesialSide === mesial ? distal : mesial;
  const localMd = normalize(sub(ponticDistalSide.c, ponticMesialSide.c));
  const sign = quadrant(ponticTooth) === 1 || quadrant(ponticTooth) === 3 ? 1 : -1;
  const buccalHint = scale(cross(axis, localMd), sign);
  const crest = await pool.run('fitRidgeCrest', {
    gingivaPositions: gingiva.positions,
    gingivaIndices: gingiva.indices,
    siteMm,
    upHint: axis,
    buccalHint,
    regionRadiusMm: Math.max(freeGapMm / 2, 1),
  });
  progress(0.75);

  const resolved = await inputs.resolvePonticTemplate(ponticTooth as FdiTooth);
  const template = resolved.tooth ?? builtinLibraryTooth(PONTIC_SEAT_RING_RADIUS_MM * 2, 0, PONTIC_SEAT_RING_RADIUS_MM * 4.5, rp.minWallThicknessMm * 2);
  const mesialAbutment = abutments.find((u) => u.label === String(mesialTooth))!;
  const distalAbutment = abutments.find((u) => u.label === String(distalTooth))!;
  const plateThicknessMm = 2 * rp.minWallThicknessMm;
  const ponticBuild = await pool.run('bridgePonticUnit', {
    gingivaPositions: gingiva.positions,
    gingivaIndices: gingiva.indices,
    crest: crest.crest,
    canonicalFrame: template.canonicalFrame,
    libraryPositions: template.positions,
    libraryIndices: template.indices,
    insertionAxis: axis,
    mesialNeighborPositions: mesialAbutment.mesh.positions,
    distalNeighborPositions: distalAbutment.mesh.positions,
    antagonistPositions: null,
    proximalClearanceMm: PONTIC_PROXIMAL_CLEARANCE_MM,
    seatRingRadiusMm: PONTIC_SEAT_RING_RADIUS_MM,
    seatRingSegments: PONTIC_SEAT_RING_SEGMENTS,
    styles: BRIDGE_PONTIC_STYLES.map((style) => ({ style, params: styleParams(profile, style).params })),
    unit: {
      flangeMm: PONTIC_FLANGE_MM,
      plateThicknessMm,
      seatOffsetMm: PONTIC_SEAT_OFFSET_MM,
      resolution: PONTIC_BASE_RESOLUTION,
    },
  });
  progress(0.9);

  const variants = {} as Record<PonticStyle, CaseBridgeStyleVariant>;
  for (const built of ponticBuild.styles) {
    const style = built.style as PonticStyle;
    const pontic: CaseBridgeUnit = {
      label: String(ponticTooth),
      kind: 'pontic',
      insertionAxis: axis,
      marginFitMm: 0,
      mesh: { positions: built.solidPositions, indices: built.solidIndices },
      inner: { positions: built.undersidePositions, indices: built.undersideIndices },
      outer: { positions: built.outerPositions, indices: built.outerIndices },
      marginLoop: loopFromFlat(built.rimLoopFlat),
      fitRegion: null,
      die: null,
    };
    const unitsInOrder = [mesialAbutment, pontic, distalAbutment];
    const frames = await pool.run('placeBridgeConnectors', {
      units: unitsInOrder.map((u) => ({ positions: u.mesh.positions, indices: u.mesh.indices })),
      overlapMm: CONNECTOR_OVERLAP_MM,
    });
    const connectors: CaseBridgeConnector[] = frames.connectors.map((f, k) => {
      const a = Number(unitsInOrder[k]!.label);
      const b = Number(unitsInOrder[k + 1]!.label);
      return {
        label: `${a}–${b}`,
        teeth: [a, b] as const,
        originMm: f.originMm,
        axisMm: f.axisMm,
        spanMm: f.spanMm,
        semiAxisMm: CONNECTOR_DEFAULT_SEMI_AXIS_MM,
        segments: CONNECTOR_SEGMENTS,
        profileFlat: ellipseProfileFlat(CONNECTOR_DEFAULT_SEMI_AXIS_MM, CONNECTOR_SEGMENTS),
      };
    });
    variants[style] = {
      pontic,
      connectors,
      configuredReliefMm: styleParams(profile, style).configuredReliefMm,
      maxAbsDeviationMm: built.maxAbsDeviationMm,
      asBuiltDeviationMm: built.asBuiltDeviationMm,
    };
  }
  progress(1);

  const sharedAxis = surfaces.sharedAxis!;
  return {
    sharedAxis: {
      direction: axis,
      acceptable: sharedAxis.acceptable,
      perAbutment: abutments.map((u, i) => ({
        label: u.label,
        marginFitMm: u.marginFitMm,
        undercutTriangleCount: sharedAxis.perAbutment[i]!.undercutTriangleCount,
        maxDepthMm: sharedAxis.perAbutment[i]!.maxDepthMm,
      })),
    },
    abutments,
    ponticTooth,
    archOrder: order.map(String),
    variants,
    crestFit: {
      radialResidualMaxMm: crest.radialResidualMaxMm,
      radialResidualRmsMm: crest.radialResidualRmsMm,
      axisSpreadRad: crest.axisSpreadRad,
      faceCount: crest.faceCount,
    },
    inputHashes: {
      targetScan: targetScan.meshId,
      gingiva: gingiva.meshId,
      marginLoops,
      ponticTemplate: resolved.source.origin === 'library' ? resolved.source.meshChecksum : null,
    },
    ponticTemplate:
      resolved.source.origin === 'library'
        ? { origin: 'library', meshChecksum: resolved.source.meshChecksum, version: resolved.source.version }
        : { origin: 'builtin', reason: resolved.source.reason },
    construction: {
      pitchMm,
      blendWidthMm: INNER_SURFACE_BLEND_WIDTH_MM,
      abutmentTemplate: 'builtin',
      cervicalEmergenceMm,
      ponticProximalClearanceMm: PONTIC_PROXIMAL_CLEARANCE_MM,
      ponticSeatRingRadiusMm: PONTIC_SEAT_RING_RADIUS_MM,
      ponticFlangeMm: PONTIC_FLANGE_MM,
      ponticPlateThicknessMm: plateThicknessMm,
      ponticSeatOffsetMm: PONTIC_SEAT_OFFSET_MM,
      crestRegionRadiusMm: Math.max(freeGapMm / 2, 1),
      connectorOverlapMm: CONNECTOR_OVERLAP_MM,
    },
  };
}
