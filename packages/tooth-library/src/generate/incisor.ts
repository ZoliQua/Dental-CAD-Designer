// packages/tooth-library/src/generate/incisor.ts
//
// Deterministic parametric incisor crown generator — one generator shared
// by FDI 12/11/21/22 (guardrail: "share the incisor generator, differ by
// FDI-specific size params" — see toothParams.ts's `INCISOR_FDI_PARAMS`).
// PLACEHOLDER ANATOMY — see toothParams.ts's module doc and README.md.
//
// Shape model: a stack of closed rings from the cervical margin (v=0, z=0)
// up toward the incisal edge, each ring an asymmetric closed curve —
// convex buccal (labial) half, and a lingual half carrying an additive
// cingulum bulge (near the cervical third) and a lingual-fossa concavity
// (mid-crown), both confined to the lingual arc by `angularWindow` so the
// mesial/distal marginal ridges (the UNMODIFIED lingual baseline right at
// the line angles) read as raised relative to the dipped fossa between
// them — exactly the anatomical relationship the brief calls for
// ("marginal ridges" bounding a "lingual concavity"). The stack is capped
// at the cervical end with a flat fan (`capBottom`) and at the incisal end
// with a single apex vertex (`capTop`) — the unique highest point of the
// entire mesh, so "incisal edge = the most-occlusal landmark" holds by
// construction, not by search (see this file's `generateIncisorAsset`
// return value and its test's analytic check).
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import type { IndexedMesh } from '@dqcad/kernel';
import type { CanonicalFrame, MorphTarget, ToothLandmarks, ToothType } from '../schema.ts';
import {
  addRing,
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
} from '../geometry/ringMesh.ts';
import { INCISOR_FDI_PARAMS, type IncisorTypeParams } from './toothParams.ts';

/** Ring tessellation density — divisible by 4 and 8 so every cardinal
 * landmark angle (0/45/90/135/180/225/270/315 degrees) lands on an EXACT
 * ring sample (5-degree steps); the marginal-ridge offset angles
 * (`marginalRidgeOffsetRad` = 65 degrees, landing on 205/335 degrees) are
 * likewise exact 5-degree multiples. */
const SEGMENTS = 72;
/** Height rings from the cervical margin (i=0, v=0) up to (but not
 * including) the incisal apex — the apex is a separate single vertex
 * (`capTop`) above the last ring, not ring `RING_COUNT`. */
const RING_COUNT = 24;
/** How far above the last ring's own z the incisal apex sits — a small
 * extra rise so the apex is unambiguously the mesh's unique max-Z vertex
 * (not merely tied with the last ring). */
const APEX_RISE_FRACTION = 1 / RING_COUNT;

export interface IncisorAsset {
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

function crossSection(
  params: IncisorTypeParams,
  v: number,
): (theta: number) => { x: number; y: number } {
  const rx = mix(params.rxCervicalMm, params.rxIncisalMm, smoothstep(0, 1, v))
    + params.rxContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  const ryBuccal = mix(params.ryBuccalCervicalMm, params.ryBuccalIncisalMm, smoothstep(0, 1, v))
    + params.ryBuccalContactBulgeMm * gaussianBump(v, params.vContact, params.sigmaContactV);
  const ryLingualBaseline = mix(params.ryLingualCervicalMm, params.ryLingualIncisalMm, smoothstep(0, 1, v));

  return (theta: number) => {
    const x = rx * Math.cos(theta);
    if (Math.sin(theta) >= 0) {
      return { x, y: ryBuccal * Math.sin(theta) };
    }
    const w = angularWindow(theta, 1.5 * Math.PI, params.lingualAngularHalfWidthRad);
    const ryLingual =
      ryLingualBaseline
      + params.cingulumBulgeMm * gaussianBump(v, params.vCingulum, params.sigmaCingulumV) * w
      - params.fossaDepthMm * gaussianBump(v, params.vFossa, params.sigmaFossaV) * w;
    return { x, y: ryLingual * Math.sin(theta) };
  };
}

function ringIndexNearV(v: number): number {
  return Math.min(RING_COUNT - 1, Math.max(0, Math.round(v * RING_COUNT)));
}

/**
 * Pure per-vertex morph deltas — a function of EACH vertex's own final
 * (x, y, z) alone, never of generation-time bookkeeping (which ring/angle
 * index it came from). This is deliberate, not just simple: it means the
 * exact same formula can be re-applied to ANY mesh representing the same
 * shape regardless of vertex ORDER — in particular, `assets.ts` re-derives
 * a starter asset's shipped `morphTargets` against the CANONICAL mesh
 * produced by re-parsing+re-welding its own binary-STL bytes (see that
 * module's doc), which numbers vertices differently than this generator's
 * own internal build order (binary STL carries no vertex-index channel, so
 * "the same mesh" read back from bytes is only ever guaranteed same
 * TOPOLOGY/positions, never the same per-vertex index numbering) —
 * `incisorMorphTargets` being purely positional is what makes that
 * re-derivation produce an equally-valid, equally-meaningful result.
 */
export function incisorMorphTargets(positions: Float64Array, crownHeightMm: number): MorphTarget[] {
  const vertexCount = positions.length / 3;
  const widthDeltas = new Array<number>(vertexCount * 3).fill(0);
  const heightDeltas = new Array<number>(vertexCount * 3).fill(0);
  // Full crown-width scaling at weight 1: mesiodistal (x) extent grows by
  // this fraction — chosen small enough to stay a plausible "wider crown"
  // variant, not a different tooth.
  const WIDTH_MORPH_FRACTION = 0.15;
  // Extra incisal rise (mm) applied AT the apex when weight = 1, tapering
  // to zero at the cervical margin.
  const INCISAL_HEIGHT_MORPH_MM = 1.0;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!;
    const z = positions[i * 3 + 2]!;
    widthDeltas[i * 3] = x * WIDTH_MORPH_FRACTION;
    const heightWeight = smoothstep(0, crownHeightMm, z);
    heightDeltas[i * 3 + 2] = heightWeight * INCISAL_HEIGHT_MORPH_MM;
  }
  return [
    { name: 'cuspWidth', vertexDeltas: widthDeltas },
    { name: 'cuspHeight', vertexDeltas: heightDeltas },
  ];
}

/**
 * Generates a watertight, deterministic incisor crown for `fdi` (must be
 * one of 12/11/21/22 — `INCISOR_FDI_PARAMS`'s domain). Pure function: same
 * `fdi` always produces byte-identical `mesh.positions`/`mesh.indices` and
 * identical landmark/frame/morph-target values (no `Math.random`, no
 * clock/env dependence — see CLAUDE.md invariant 2).
 */
export function generateIncisorAsset(fdi: FdiTooth): IncisorAsset {
  const params = INCISOR_FDI_PARAMS[fdi];
  if (!params) {
    throw new RangeError(`generateIncisorAsset: fdi ${fdi} is not a supported incisor (12/11/21/22)`);
  }

  const builder = createMeshBuilder();
  const rings: number[][] = [];
  for (let i = 0; i < RING_COUNT; i++) {
    const v = i / RING_COUNT;
    const z = v * params.crownHeightMm;
    rings.push(addRing(builder, crossSection(params, v), z, SEGMENTS));
  }
  for (let i = 0; i < RING_COUNT - 1; i++) {
    stitchRings(builder, rings[i]!, rings[i + 1]!);
  }
  capBottom(builder, rings[0]!, 0);
  const apexZ = params.crownHeightMm * (1 + APEX_RISE_FRACTION);
  const apexIndex = capTop(builder, rings[RING_COUNT - 1]!, apexZ);

  const contactRing = rings[ringIndexNearV(params.vContact)]!;
  const cingulumRing = rings[ringIndexNearV(params.vCingulum)]!;
  const ridgeRing = rings[ringIndexNearV(params.vFossa)]!;

  const landmarks: Record<string, Vec3> = {
    incisalEdge: vertexAt(builder, apexIndex),
    cingulum: vertexAt(builder, cingulumRing[nearestRingIndex(1.5 * Math.PI, SEGMENTS)]!),
    mesialMarginalRidge: vertexAt(
      builder,
      ridgeRing[nearestRingIndex(Math.PI + params.marginalRidgeOffsetRad, SEGMENTS)]!,
    ),
    distalMarginalRidge: vertexAt(
      builder,
      ridgeRing[nearestRingIndex(2 * Math.PI - params.marginalRidgeOffsetRad, SEGMENTS)]!,
    ),
    mesialContact: vertexAt(builder, contactRing[nearestRingIndex(Math.PI, SEGMENTS)]!),
    distalContact: vertexAt(builder, contactRing[nearestRingIndex(0, SEGMENTS)]!),
  };

  const mesh = toIndexedMesh(builder);

  return {
    fdi,
    toothType: 'incisor',
    mesh,
    landmarks,
    canonicalFrame: IDENTITY_FRAME,
    morphTargets: incisorMorphTargets(mesh.positions, params.crownHeightMm),
  };
}

export const INCISOR_FDI_CODES: readonly FdiTooth[] = [12, 11, 21, 22];
