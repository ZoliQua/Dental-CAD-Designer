// apps/server/src/crown-qc-fixture.testutil.ts
//
// Shared crown-QC test fixture for Task 11's server tests. Builds a GENUINE
// end-to-end synthetic crown (frustum prep die → kernel `buildInnerSurface`
// intaglio → enclosing outer dome → `runShellStage` watertight solid) plus a
// real T6 morph (measured contact residuals), exactly mirroring cad-pipeline's
// own `report.test.ts` fixture so the QcReport the server recomputes is the
// same one the client's `runCrownQc` produces. NOT a `.test.ts` — imported by
// the dual-validation + persistence suites, never run as a suite itself.
import { buildInnerSurface, KERNEL_VERSION, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import type { FdiTooth, QcReport } from '@dqcad/shared-types';
import {
  runMorphingStage,
  runShellStage,
  type ContactResidualInput,
  type PipelineContext,
  type PipelineMaterialProfile,
  type PipelineMeshHandle,
  type RestorationStageResult,
  type RunCrownQcInput,
} from '@dqcad/cad-pipeline';
import { hashMesh } from './journal-replay.js';

// --- geometry builders (ported verbatim from cad-pipeline/report.test.ts) ---
const MARGIN_R = 1.2,
  TOP_R = 0.8,
  MARGIN_Z = 0.5,
  TOP_Z = 2.0;
export const AXIS: Vec3 = [0, 0, 1];
export const TOOTH = 11 as FdiTooth;

function buildFrustum(
  mR: number,
  tR: number,
  mZ: number,
  tZ: number,
  seg: number,
  capTop: boolean,
  capBot: boolean,
): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const b: number[] = [],
    t: number[] = [];
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ));
  }
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ));
  }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) {
    const sn = (s + 1) % seg;
    tr.push(b[s]!, b[sn]!, t[sn]!);
    tr.push(b[s]!, t[sn]!, t[s]!);
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, b[sn]!, b[s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, t[s]!, t[sn]!);
    }
  }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}

function marginCircle(r: number, z: number, n: number): { closed: true; resampledPoints: Vec3[] } {
  const resampledPoints: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    resampledPoints.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return { closed: true, resampledPoints };
}

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min,
    [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function cylinderTooth(radius: number, height: number, rings: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = (height * r) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.cos(th), radius * Math.sin(th), z);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++)
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s,
        b = r * segments + s1,
        c = (r + 1) * segments + s,
        d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

export const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: {
    cementGapMm: 0.05,
    marginalGapMm: 0.02,
    spacerStartMm: 0.8,
    minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02,
    occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: 0.5,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5,
  onlayMinThicknessMm: 0.5,
  cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2,
  inlayMarginExclusionMm: 1.3,
  onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
  ponticRidgeLapReliefMm: 0.05,
  ponticOvateDepthMm: 1.0, veneeringSpaceMm: 1.0,
};

const die = (): IndexedMesh => buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
const outerDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);
const thinDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + 0.9, 96, true, false);

const MARGIN = marginCircle(MARGIN_R, MARGIN_Z, 240);

let INNER: IndexedMesh | null = null;
async function intaglio(): Promise<IndexedMesh> {
  if (!INNER) {
    INNER = (
      await buildInnerSurface(die(), {
        pitchMm: 0.08,
        marginalGapMm: 0.02,
        cementGapMm: 0.05,
        spacerStartMm: 0.8,
        blendWidthMm: 0.3,
        marginLoop: MARGIN.resampledPoints,
        insertionAxis: AXIS,
      })
    ).mesh;
  }
  return INNER;
}

function shellContext(): PipelineContext {
  return {
    restorationId: 'qc-accept',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('die', die()),
    marginLoops: { [TOOTH]: MARGIN },
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

/** A genuine T6 morph run (real measured contact residuals). */
function realContactResiduals(): { contacts: ContactResidualInput[]; contactClampWarning: boolean } {
  const R = 1.2,
    H = 5;
  const ctx: PipelineContext = {
    restorationId: 'qc-morph',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: handle('die', cylinderTooth(R, H - 1, 6, 16)),
    marginLoops: { [TOOTH]: marginCircle(R, 0, 48) },
    neighbors: {
      [12 as FdiTooth]: handle('nb-12', outwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7])),
      [21 as FdiTooth]: handle('nb-21', outwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7])),
    },
    antagonist: handle('anta', outwardBox([-2, -2, H + 0.1], [2, 2, H + 2])),
    stages: { anatomyPlacement: 'placed-11' },
  };
  const placed = handle('placed-11', cylinderTooth(R, H, 11, 24));
  const result = runMorphingStage(ctx, TOOTH, {
    placedMesh: placed,
    hashMesh,
    morphOptions: { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 },
  });
  const contacts = (result.params['contacts'] as ContactResidualInput[]).map((c) => ({
    kind: c.kind,
    targetPenetrationMm: c.targetPenetrationMm,
    achievedSignedDistanceMm: c.achievedSignedDistanceMm,
    contactResidualMm: c.contactResidualMm,
    regionResidualMm: c.regionResidualMm,
    clampBound: c.clampBound,
  }));
  return { contacts, contactClampWarning: result.params['contactClampWarning'] as boolean };
}

export interface BuiltShell {
  readonly inner: IndexedMesh;
  readonly outer: IndexedMesh;
  readonly innerHandle: PipelineMeshHandle;
  readonly outerHandle: PipelineMeshHandle;
  readonly context: PipelineContext;
  readonly result: RestorationStageResult;
}

/** Builds the shell (crown solid) from the intaglio + a given outer surface,
 * returning everything the replay test needs (context + input handles + the
 * stage result carrying the canonical-`hashMesh` output content hash). */
export async function buildShell(variant: 'standin' | 'thin'): Promise<BuiltShell> {
  const inner = await intaglio();
  const outer = variant === 'thin' ? thinDome(0.3) : outerDome(1.0);
  const innerHandle = handle(hashMesh(inner), inner);
  const outerHandle = handle(hashMesh(outer), outer);
  const context = shellContext();
  const result = await runShellStage(context, TOOTH, {
    outerAnatomyMesh: outerHandle,
    innerSurfaceMesh: innerHandle,
    hashMesh,
  });
  return { inner, outer, innerHandle, outerHandle, context, result };
}

/** Assembles a full `RunCrownQcInput` for the given crown variant. */
export async function buildCrownQcInput(
  variant: 'standin' | 'thin',
  overrides?: Partial<RunCrownQcInput>,
): Promise<RunCrownQcInput> {
  const shell = await buildShell(variant);
  const { contacts, contactClampWarning } = realContactResiduals();
  return {
    crownSolid: shell.result.mesh!,
    innerSurfaceMesh: shell.inner,
    outerSurfaceMesh: shell.outer,
    dieSolid: die(),
    marginResampledPoints: MARGIN.resampledPoints,
    insertionAxis: AXIS,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.anteriorMm2,
    contacts,
    contactClampWarning,
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: 'journal-hash-fixed',
    ...overrides,
  };
}

/** Serializes a `RunCrownQcInput` into the `POST .../validate-qc` JSON body.
 * `Array.from` on the Float64/Uint32 arrays yields plain numbers that JSON
 * round-trips exactly (shortest-round-trip Number↔String). */
export function toValidateQcBody(
  input: RunCrownQcInput,
  extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
): Record<string, unknown> {
  const mesh = (m: IndexedMesh): { positions: number[]; indices: number[] } => ({
    positions: Array.from(m.positions),
    indices: Array.from(m.indices),
  });
  return {
    crownSolid: mesh(input.crownSolid),
    innerSurfaceMesh: mesh(input.innerSurfaceMesh),
    outerSurfaceMesh: mesh(input.outerSurfaceMesh),
    dieSolid: mesh(input.dieSolid),
    marginResampledPoints: input.marginResampledPoints.map((p) => [...p]),
    insertionAxis: [...input.insertionAxis],
    minWallThicknessMm: input.minWallThicknessMm,
    occlusalMinWallThicknessMm: input.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: input.connectorAreaTargetMm2,
    contacts: input.contacts.map((c) => ({ ...c })),
    contactClampWarning: input.contactClampWarning,
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    ...(input.acknowledgedGates ? { acknowledgedGates: [...input.acknowledgedGates] } : {}),
    ...(extra?.acknowledgedGates ? { acknowledgedGates: [...extra.acknowledgedGates] } : {}),
    ...(extra?.clientReport ? { clientReport: extra.clientReport } : {}),
  };
}
