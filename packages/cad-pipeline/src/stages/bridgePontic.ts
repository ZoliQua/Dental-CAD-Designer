// packages/cad-pipeline/src/stages/bridgePontic.ts
//
// Phase 6 Task 3 — the BRIDGE PONTIC + GINGIVAL INTERFACE stage. A pontic is a
// suspended library tooth whose BASE is shaped against the edentulous-ridge
// (gingiva) mesh per clinical STYLE (hygienic / modified ridge-lap / ovate) at
// the CONFIGURED relief, with the PLAN acceptance that the measured
// pontic-gingiva relation matches the configured value within ±20 µm per style.
//
// This stage orchestrates:
//   1. PLACEMENT — the P4 `solveAnatomyPlacement` machinery places the library
//      pontic at the site (neighbours = the two abutment units, shared insertion
//      axis). A pontic has NO prep margin, so the cervical seat used as the
//      placement origin is a SYNTHETIC ring on the ridge crest over the site (the
//      pontic's gingival seat) — built deterministically from the crest frame.
//   2. INTERFACE — the kernel `shapePonticBase` shapes the base against the crest
//      per style at the CONFIGURED relief (read from the material profile — never
//      hardcoded, CLAUDE.md invariant 7).
//   3. MEASUREMENT — `measurePonticRelief` (the blend-independent instrument)
//      measures the base ↔ gingiva relief; the ±20 µm gate is CONSUMED by Task 6's
//      whole-bridge QC (this stage produces the geometry + the measured field).
//
// ## Guard rail (Phase 5 Task 1 pattern) + the gingiva-mesh gate
//
// `assertBridgeContext` at entry (bridge-only stage). `context.gingivaMesh` must
// be present (non-null) — a pontic cannot be shaped without the ridge; a `null`
// gingiva mesh is THIS stage's own gate (like a missing antagonist is the
// occlusal stages').
//
// ## The crest descriptor (fixture = analytic cylinder; real scan = tracked)
//
// The kernel op parametrizes the base against the ridge crest CYLINDER (the
// fixture's closed-form crest). The caller supplies the `RidgeCrestCylinder`
// (fixture: the known analytic params; a real edentulous-ridge scan would derive
// it by PCA over the ridge-crest region — a tracked-pending generalization). The
// MEASUREMENT reads only the gingiva MESH (scan-general).
//
// ## Journaling: ONE op (style + configured relief journaled — a design decision)
//
// The pontic is placed AND shaped in one coupled stage; a style/relief change is
// a design decision. This stage emits ONE journaled op (`bridge.ponticInterface`)
// whose `params` carry the placement transform + the style + the configured
// relief params + the crest/footprint/resolution, and whose `outputHashes` are
// the placed body mesh + the shaped base mesh (in that order). Replay reproduces
// both bit-identically.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  buildBvh,
  computePseudonormals,
  buildPlacementTransform,
  placeMesh,
  solveAnatomyPlacement,
  shapePonticBase,
  synthPonticSeatRing,
  measurePonticRelief,
  type IndexedMesh,
  type PlacementFrame,
  type PonticInterfaceStyle,
  type PonticInterfaceParams,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type RidgeCrestCylinder,
  type PonticReliefMeasurement,
} from '@dqcad/kernel';
import type { BridgePipelineContext } from '../pipeline/context.ts';
import { assertBridgeContext } from '../pipeline/context.ts';
import type { PipelineToothAsset } from './anatomyPlacement.ts';
import { identifyNeighbors } from './anatomyPlacement.ts';

/** Thrown when the bridge context has no gingiva (ridge) mesh — a pontic base
 * cannot be shaped without the ridge to shape it against. */
export class MissingGingivaMeshError extends Error {
  constructor() {
    super('bridgePontic stage: context.gingivaMesh is null — the edentulous-ridge (gingiva) mesh is required to shape a pontic base');
    this.name = 'MissingGingivaMeshError';
  }
}

/** Thrown when the required configured pontic relief param for the chosen style
 * is missing/non-finite on the material profile — never defaulted (invariant 7). */
export class MissingPonticParamError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `bridgePontic stage: required configured param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile.`,
    );
    this.name = 'MissingPonticParamError';
  }
}

export interface BridgePonticStageOptions {
  /** The pontic tooth (an entry of `context.ponticSites`). */
  readonly ponticTooth: FdiTooth;
  /** The library tooth asset for the pontic (loaded by the caller — the P4
   * molar-16 asset for the posterior site; a premolar generator would be added
   * for a premolar site — the placeholder-provenance discipline). */
  readonly asset: PipelineToothAsset;
  /** The interface style — a JOURNALED design decision. */
  readonly style: PonticInterfaceStyle;
  /** The ridge crest descriptor (fixture: analytic; real scan: PCA-derived —
   * tracked). */
  readonly ridgeCrest: RidgeCrestCylinder;
  /** The base footprint over the ridge (the caller derives it from the placed
   * pontic's ridge-projected extent; explicit here so this stage stays a pure
   * orchestration of the kernel op). */
  readonly footprint: PonticBaseFootprint;
  /** Base-mesh + sample-grid resolution. */
  readonly resolution: PonticBaseResolution;
  /** Radius (mm) of the synthetic gingival seat ring used as the placement
   * origin (a pontic has no prep margin). Default 1.5. */
  readonly seatRingRadiusMm?: number;
  /** Number of segments in the synthetic seat ring. Default 64. */
  readonly seatRingSegments?: number;
  /** Optional per-style geometric shaping params (opening / seat angle /
   * emergence) — the configured RELIEF always comes from the profile below. */
  readonly shaping?: Pick<
    PonticInterfaceParams,
    'lingualOpeningMm' | 'contactTransitionHalfAngleRad' | 'seatHalfAngleRad' | 'emergenceMm'
  >;
  /** Content-hash function for a produced mesh — injected by the caller. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

export interface BridgePonticStageResult {
  readonly stage: 'anatomyPlacement';
  /** The placed library pontic BODY (library-shaped; T4 connects, T6 assembles). */
  readonly ponticBodyMesh: IndexedMesh;
  readonly ponticBodyContentHash: string;
  /** The shaped base interface surface (open patch). */
  readonly baseMesh: IndexedMesh;
  readonly baseContentHash: string;
  /** The measured relief field (the ±20 µm acceptance evidence — consumed by
   * Task 6 QC). */
  readonly relief: PonticReliefMeasurement;
  /** The configured PRIMARY-patch relief target (mm, signed). */
  readonly configuredTargetMm: number;
  /** The construction @errorBound (mm). */
  readonly errorBoundMm: number;
  readonly operationName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
}

/** Resolve the configured relief params for `style` from the material profile
 * (never defaulted — invariant 7), merged with the geometric shaping opts. */
function resolvePonticParams(
  context: BridgePipelineContext,
  style: PonticInterfaceStyle,
  shaping: BridgePonticStageOptions['shaping'],
): { params: PonticInterfaceParams; configuredName: string; configuredValue: number } {
  const mp = context.materialProfile;
  if (style === 'hygienic') {
    const v = mp.ponticHygienicClearanceMm;
    if (!Number.isFinite(v)) throw new MissingPonticParamError('ponticHygienicClearanceMm', v);
    return { params: { clearanceMm: v }, configuredName: 'ponticHygienicClearanceMm', configuredValue: v };
  }
  if (style === 'ridgeLap') {
    const v = mp.ponticRidgeLapReliefMm;
    if (!Number.isFinite(v)) throw new MissingPonticParamError('ponticRidgeLapReliefMm', v);
    return {
      params: { reliefMm: v, lingualOpeningMm: shaping?.lingualOpeningMm, contactTransitionHalfAngleRad: shaping?.contactTransitionHalfAngleRad },
      configuredName: 'ponticRidgeLapReliefMm',
      configuredValue: v,
    };
  }
  const v = mp.ponticOvateDepthMm;
  if (!Number.isFinite(v)) throw new MissingPonticParamError('ponticOvateDepthMm', v);
  return {
    params: { depthMm: v, seatHalfAngleRad: shaping?.seatHalfAngleRad, emergenceMm: shaping?.emergenceMm },
    configuredName: 'ponticOvateDepthMm',
    configuredValue: v,
  };
}

/**
 * Runs the bridge pontic + gingival-interface stage — see this file's doc.
 * Deterministic: same context + options → byte-identical placed body + base +
 * hashes. Returns the placed pontic body, the shaped base surface, the measured
 * relief field, and ONE journaled op.
 *
 * @throws {RestorationTypeMismatchError}/{BridgeContextIncompleteError} via
 * `assertBridgeContext`.
 * @throws {MissingGingivaMeshError} if `context.gingivaMesh` is null.
 * @throws {MissingPonticParamError} if the style's configured relief is missing.
 * @throws {InsufficientNeighborsError} (anatomyPlacement) if the site lacks two
 * neighbours; propagates `solveAnatomyPlacement`'s / `shapePonticBase`'s errors.
 */
export function runBridgePonticStage(
  context: BridgePipelineContext,
  options: BridgePonticStageOptions,
): BridgePonticStageResult {
  assertBridgeContext(context); // bridge-only stage — guard rail
  const gingiva = context.gingivaMesh;
  if (!gingiva) throw new MissingGingivaMeshError();

  const { ponticTooth, asset, style, ridgeCrest, footprint, resolution } = options;
  const { params, configuredName, configuredValue } = resolvePonticParams(context, style, options.shaping);

  // The site centre station (mm along md) = midpoint of the footprint span.
  const siteStationMm = (footprint.stationMinMm + footprint.stationMaxMm) / 2;
  const seatRing = synthPonticSeatRing(
    ridgeCrest,
    siteStationMm,
    options.seatRingRadiusMm ?? 1.5,
    options.seatRingSegments ?? 64,
  );

  // PLACEMENT — neighbours = the two abutment units, shared insertion axis.
  const { mesial, distal } = identifyNeighbors(ponticTooth, context.neighbors);
  const mesialHandle = context.neighbors[mesial]!;
  const distalHandle = context.neighbors[distal]!;
  const solution = solveAnatomyPlacement({
    canonicalFrame: asset.canonicalFrame,
    libraryMesh: asset.mesh,
    marginLoop: seatRing,
    insertionAxis: context.insertionAxis,
    mesialNeighborPositions: mesialHandle.mesh.positions,
    distalNeighborPositions: distalHandle.mesh.positions,
    antagonistPositions: context.antagonist ? context.antagonist.mesh.positions : null,
  });
  const frame: PlacementFrame = solution.frame;
  const transform = buildPlacementTransform(frame, asset.canonicalFrame);
  const ponticBodyMesh = placeMesh(asset.mesh, transform);
  const ponticBodyContentHash = options.hashMesh(ponticBodyMesh);

  // INTERFACE — shape the base against the crest per style at the configured relief.
  const shaped = shapePonticBase(ridgeCrest, style, params, footprint, resolution);
  const baseContentHash = options.hashMesh(shaped.mesh);

  // MEASUREMENT — the blend-independent instrument (± 20 µm evidence for T6 QC).
  const bvh = buildBvh(gingiva.mesh);
  const pn = computePseudonormals(gingiva.mesh);
  const relief = measurePonticRelief(gingiva.mesh, bvh, pn, shaped.samples, ridgeCrest);

  const inputHashes = [asset.contentHash, gingiva.contentHash, mesialHandle.contentHash, distalHandle.contentHash];
  if (context.antagonist) inputHashes.push(context.antagonist.contentHash);

  return {
    stage: 'anatomyPlacement',
    ponticBodyMesh,
    ponticBodyContentHash,
    baseMesh: shaped.mesh,
    baseContentHash,
    relief,
    configuredTargetMm: shaped.primaryTargetMm,
    errorBoundMm: shaped.errorBoundMm,
    operationName: 'bridge.ponticInterface',
    params: {
      ponticTooth,
      style,
      configuredParamName: configuredName,
      configuredParamValueMm: configuredValue,
      mesialNeighborFdi: mesial,
      distalNeighborFdi: distal,
      insertionAxis: context.insertionAxis,
      transform,
      ridgeCrest,
      footprint,
      resolution,
      shaping: options.shaping ?? null,
      seatRingRadiusMm: options.seatRingRadiusMm ?? 1.5,
      seatRingSegments: options.seatRingSegments ?? 64,
      antagonistPresent: context.antagonist !== null,
    },
    inputHashes,
    outputHashes: [ponticBodyContentHash, baseContentHash],
  };
}
