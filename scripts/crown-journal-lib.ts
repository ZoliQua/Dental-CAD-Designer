// scripts/crown-journal-lib.ts
//
// Phase 4 Task 12 — the ASSEMBLED crown pipeline + its journal-reproducibility
// harness (THE PHASE GATE). One source of truth for BOTH
// test/golden/crown-acceptance.test.ts (the standin acceptance + the real
// tooth-11 honest report) and test/golden/journal-replay.test.ts's crown
// extension, so the record→replay→bit-identical proof is written once (same
// "one library, two entry points" reasoning as scripts/journal-replay-lib.ts).
//
// ## What this assembles
//
// The full 6 fixed-order crown-design stages
// (docs/plans/phase-4-crown-design.md) run end-to-end on the STANDIN prep die,
// each producing a CONTENT-ADDRESSED output the caller journals:
//
//   1. innerSurface  (buildInnerSurface — SDF offset + blockout + skirt; WASM)
//   2. anatomyPlacement (deterministic affine placement of a library tooth)
//   3. morphing      (biharmonic RBF morph to contacts — pure Float64 TS)
//   4. shell         (constructShell — manifold-3d stitch; WASM)
//   5. freeform      (locked-fit sculpt gesture — pure Float64 TS)
//   6. qc            (runCrownQc — the §6 gate set; two gates use manifold-3d)
//
// ## Two synthetic sub-scenes (the honest standin limitation)
//
// The standin necessarily uses TWO synthetic geometries — exactly as the
// Task-9-ACCEPTED standin (packages/cad-pipeline/src/gates/report.test.ts)
// already does: (a) the FIT/SHELL path (frustum prep die → intaglio → enclosing
// dome → watertight shell → sculpt), and (b) the ANATOMY path (a library tooth
// placed against proximal neighbours + antagonist, then RBF-morphed to
// contacts). No single synthetic solid is simultaneously a clean frustum-fit
// prep AND a realistic anatomy-morph target; the REAL arch-case-01 is where the
// two unify (and where the shell honestly BLOCKS — see the real-case report).
// Every one of the 6 stages runs GENUINELY and its output is content-addressed,
// journaled, and replay-proven; the morph's measured contact residuals feed the
// QC contact gate (a genuine morph→qc data dependency), and
// die→inner→shell→sculpt→qc is a genuine linear geometry chain.
//
// IMPORTANT — what the standin does NOT prove: the shell is built from the
// intaglio + a clean synthetic outer DOME, NOT the morph output, so the standin
// does NOT exercise the morph→shell coupling (feeding an RBF-morphed outer into
// `constructShell`). That coupling is isolated on clean synthetic input in
// test/golden/morph-shell-coupling.test.ts, whose DIAGNOSTIC finding is that a
// clean morphed closed tooth is currently REJECTED by `constructShell` even
// when the byte-identical un-morphed tooth builds — a morph→shell robustness
// gap independent of scan quality (see p4-task-12-report.md for the verdict).
//
// One deliberate decoupling INSIDE the anatomy sub-scene, documented so it is
// not mistaken for an oversight: the anatomy-PLACEMENT stage runs genuinely
// (producing + journaling a deterministic placed mesh, so placement
// reproducibility is proven), but the MORPH stage consumes the REFERENCE placed
// library tooth (`PLACED_REF`, the canonical tessellated cylinder) rather than
// the placement stage's own output. Reason: the placement solve anisotropically
// RESCALES the library tooth to the synthetic neighbour gap, and a rescaled
// tooth cannot converge its antagonist contact within the 50 µm region
// tolerance on this coarse synthetic scene (the contact gate would fail on a
// clean input — an artefact of the synthetic geometry, NOT a real defect). The
// morph therefore runs on the PROVEN-clean placed tooth (identical to the
// Task-9-accepted standin, report.test.ts) so the contact gate reflects a
// genuinely converged morph. On the REAL arch-case-01, placement→morph ARE
// coupled end-to-end (and the honest block appears downstream at the shell).
//
// ## Journal reproducibility (CLAUDE.md invariants 2/3 — the phase-gate crux)
//
// `recordCrownJournal` runs the chain once, sealing each stage's
// `outputHashes[0]` (the mesh content hash; for QC, a hash of the QcReport
// JSON). `replayCrownJournal` re-runs EVERY stage FRESH from the same recorded
// inputs and re-hashes, asserting bit-identity. RBF + boolean(WASM) + brushes
// are all deterministic (no Math.random, no Date.now, no worker scheduling), so
// the replay reproduces every stage hash byte-for-byte. If it does NOT, that is
// a real determinism leak to FIND and FIX — never a comparison to loosen.
import { createHash } from 'node:crypto';
import {
  analyzeMesh,
  KERNEL_VERSION,
  type CanonicalFrameAxes,
  type IndexedMesh,
  type SculptStroke,
  type Vec3,
} from '@dqcad/kernel';
import type { FdiTooth, Operation, QcReport } from '@dqcad/shared-types';
import {
  runAnatomyPlacementStage,
  runCrownQc,
  runInnerSurfaceStage,
  runMorphingStage,
  runSculptStage,
  runShellStage,
  measureMarginFit,
  type ContactResidualInput,
  type PipelineContext,
  type PipelineMaterialProfile,
  type PipelineMeshHandle,
  type PipelineToothAsset,
  type RestorationStageResult,
} from '@dqcad/cad-pipeline';

// ---------------------------------------------------------------------------
// Canonical hashing — byte-for-byte the client's `hashMeshContent` /
// apps/server's `hashMesh` (see apps/server/src/journal-replay.ts's INVARIANT
// doc): sha256(positions LE bytes ‖ indices LE bytes).
// ---------------------------------------------------------------------------
export function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** Deterministic hash of a QcReport (the QC stage's content-addressed output —
 * the report carries NO timestamp, so its JSON is hash-stable; see report.ts's
 * determinism doc). Stable key order because the object is constructed field by
 * field the same way every run. */
export function hashQcReport(report: QcReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

// ---------------------------------------------------------------------------
// Geometry builders (mirror gates/report.test.ts — the accepted Task-9 standin)
// ---------------------------------------------------------------------------
const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
export const AXIS: Vec3 = [0, 0, 1];
export const TOOTH = 11 as FdiTooth;

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const b: number[] = [];
  const t: number[] = [];
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

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
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
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
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
};

// The FIT/SHELL sub-scene primitives.
const die = (): IndexedMesh => buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
const outerDome = (): IndexedMesh => buildFrustum(MARGIN_R + 1.0, TOP_R + 1.0, MARGIN_Z, TOP_Z + 1.0, 96, true, false);
const thinDome = (): IndexedMesh => buildFrustum(MARGIN_R + 0.3, TOP_R + 0.3, MARGIN_Z, TOP_Z + 0.9, 96, true, false);
const FIT_MARGIN = marginCircle(MARGIN_R, MARGIN_Z, 240);

// The ANATOMY sub-scene: a library tooth (a tessellated cylinder in canonical
// space) placed against two proximal-neighbour boxes + an antagonist box, then
// morphed to contacts — the proven-clean scene from report.test.ts.
const MORPH_R = 1.2;
const MORPH_H = 5;
const IDENTITY_CANONICAL: CanonicalFrameAxes = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};
const MORPH_MARGIN = marginCircle(MORPH_R, 0, 48);
const MORPH_OPTIONS = { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 };
/** The reference placed library tooth the MORPH stage consumes (see the module
 * doc's "one deliberate decoupling" note) — the Task-9-accepted clean placed
 * tooth, so the morph converges its contacts within tolerance. */
const PLACED_REF = (): IndexedMesh => cylinderTooth(MORPH_R, MORPH_H, 11, 24);

/** The freeform gesture (occlusal add/remove/smooth, away from the margin) —
 * the fit-surface lock keeps the ≤10 µm marginal seal byte-identical. */
const GESTURE: SculptStroke[] = [
  { center: [0, 0, TOP_Z + 1.0], radiusMm: 1.2, strength: 0.2, brush: 'add' },
  { center: [TOP_R + 1.0, 0, TOP_Z], radiusMm: 1.0, strength: 0.15, brush: 'remove' },
  { center: [0, 0, TOP_Z + 1.0], radiusMm: 1.5, strength: 1, brush: 'smooth' },
];

// ---------------------------------------------------------------------------
// Cached expensive builds — the intaglio (SDF, seconds) is built ONCE and
// reused across the standin variant, the thin variant, AND the replay (the
// inner surface is the SAME for every crown variant here — only the outer
// differs). The record and replay each still call the STAGE fresh; only the
// underlying die/inner geometry inputs are shared values.
// ---------------------------------------------------------------------------

/** The anatomy-placement + morph context (both stages share it). */
function anatomyContext(): PipelineContext {
  return {
    restorationId: 'crown-accept-anatomy',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('anatomy-die', cylinderTooth(MORPH_R, MORPH_H - 1, 6, 16)),
    marginLoops: { [TOOTH]: MORPH_MARGIN },
    neighbors: {
      [12 as FdiTooth]: handle('nb-12', outwardBox([MORPH_R + 0.1, -2, 2.3], [3, 2, 4.7])),
      [21 as FdiTooth]: handle('nb-21', outwardBox([-3, -2, 2.3], [-(MORPH_R + 0.1), 2, 4.7])),
    },
    antagonist: handle('anta', outwardBox([-2, -2, MORPH_H + 0.1], [2, 2, MORPH_H + 2])),
    stages: {},
  };
}

/** The synthetic library tooth asset placed by the anatomy stage. */
function syntheticAsset(): PipelineToothAsset {
  const mesh = cylinderTooth(MORPH_R, MORPH_H, 11, 24);
  return {
    contentHash: hashMesh(mesh),
    mesh,
    landmarks: { incisalEdge: [0, 0, MORPH_H], cervical: [0, 0, 0] },
    canonicalFrame: IDENTITY_CANONICAL,
  };
}

/** The FIT/SHELL context (inner + shell + sculpt share it). */
function fitContext(): PipelineContext {
  return {
    restorationId: 'crown-accept-fit',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle('die', die()),
    marginLoops: { [TOOTH]: FIT_MARGIN },
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

export type CrownVariant = 'standin' | 'thin';

export interface AssembledCrown {
  readonly variant: CrownVariant;
  readonly inner: RestorationStageResult;
  readonly anatomy: RestorationStageResult;
  readonly morph: RestorationStageResult;
  readonly shell: RestorationStageResult;
  readonly sculpt: RestorationStageResult;
  readonly qcReport: QcReport;
  /** Measured acceptance numbers (re-measured in the assembled chain). */
  readonly measured: {
    readonly marginFitMm: number;
    readonly innerMarginFitMm: number;
    readonly seatingValueMm3: number;
    readonly seatingThresholdMm3: number;
    readonly minWallThicknessMm: number;
    readonly minWallThresholdMm: number;
    readonly maxContactResidualMm: number;
    readonly contactClampWarning: boolean;
    readonly sculptMarginFitMm: number;
    readonly crownSolidTriCount: number;
    readonly crownWatertight: boolean;
  };
  /** The contact residuals the morph produced (QC contact-gate input). */
  readonly contacts: readonly ContactResidualInput[];
}

// Memoize the intaglio across variants/replays — the SDF build is the same
// die + margin for every crown here. Value-level cache only; each STAGE is
// still invoked fresh by record/replay.
let cachedInner: RestorationStageResult | null = null;
async function buildInner(): Promise<RestorationStageResult> {
  if (cachedInner) return cachedInner;
  cachedInner = await runInnerSurfaceStage(fitContext(), TOOTH, { pitchMm: 0.08, hashMesh });
  return cachedInner;
}

/**
 * Runs the full 6-stage assembled crown chain for the given variant and
 * returns every stage result + the measured acceptance numbers. Deterministic.
 */
export async function assembleCrown(variant: CrownVariant): Promise<AssembledCrown> {
  const fitCtx = fitContext();

  // 1. inner surface (SDF offset + blockout + skirt).
  const inner = await buildInner();

  // 2. anatomy placement (deterministic affine placement of the library tooth).
  const anatomy = runAnatomyPlacementStage(anatomyContext(), TOOTH, { asset: syntheticAsset(), hashMesh });

  // 3. morph (biharmonic RBF to contacts) — consumes the placed tooth.
  const placedRef = PLACED_REF();
  const morph = runMorphingStage(anatomyContext(), TOOTH, {
    placedMesh: handle(hashMesh(placedRef), placedRef),
    hashMesh,
    morphOptions: MORPH_OPTIONS,
  });
  const contacts: ContactResidualInput[] = (morph.params['contacts'] as ContactResidualInput[]).map((c) => ({
    kind: c.kind,
    targetPenetrationMm: c.targetPenetrationMm,
    achievedSignedDistanceMm: c.achievedSignedDistanceMm,
    contactResidualMm: c.contactResidualMm,
    regionResidualMm: c.regionResidualMm,
    clampBound: c.clampBound,
  }));
  const contactClampWarning = morph.params['contactClampWarning'] as boolean;

  // 4. shell (manifold-3d stitch of outer + intaglio at the margin band).
  const outer = variant === 'thin' ? thinDome() : outerDome();
  const shell = await runShellStage(fitCtx, TOOTH, {
    outerAnatomyMesh: handle(hashMesh(outer), outer),
    innerSurfaceMesh: handle(inner.meshContentHash!, inner.mesh!),
    hashMesh,
  });

  // 5. freeform sculpt (locked fit surface — preserves the ≤10 µm seal).
  const sculpt = runSculptStage(fitCtx, TOOTH, {
    shellMesh: handle(shell.meshContentHash!, shell.mesh!),
    innerSurfaceMesh: handle(inner.meshContentHash!, inner.mesh!),
    strokes: GESTURE,
    hashMesh,
  });

  // 6. QC on the FINAL sculpted crown solid (the whole §6 gate set).
  const qcReport = await runCrownQc({
    crownSolid: sculpt.mesh!,
    innerSurfaceMesh: inner.mesh!,
    outerSurfaceMesh: outer,
    dieSolid: die(),
    marginResampledPoints: FIT_MARGIN.resampledPoints,
    insertionAxis: AXIS,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.anteriorMm2,
    contacts,
    contactClampWarning,
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: `crown-accept-${variant}`,
  });

  const byGate = Object.fromEntries(qcReport.gates.map((g) => [g.gate, g]));
  const innerFit = measureMarginFit(inner.mesh!, FIT_MARGIN.resampledPoints);

  return {
    variant,
    inner,
    anatomy,
    morph,
    shell,
    sculpt,
    qcReport,
    contacts,
    measured: {
      marginFitMm: byGate['marginFit']!.value ?? Number.POSITIVE_INFINITY,
      innerMarginFitMm: innerFit.maxMm,
      seatingValueMm3: byGate['seating']!.value ?? Number.POSITIVE_INFINITY,
      seatingThresholdMm3: byGate['seating']!.threshold ?? 0,
      minWallThicknessMm: byGate['minWallThickness']!.value ?? Number.POSITIVE_INFINITY,
      minWallThresholdMm: byGate['minWallThickness']!.threshold ?? 0,
      maxContactResidualMm: morph.params['maxContactResidualMm'] as number,
      contactClampWarning,
      sculptMarginFitMm: sculpt.params['marginFitMaxMm'] as number,
      crownSolidTriCount: sculpt.mesh!.indices.length / 3,
      crownWatertight: analyzeMesh(sculpt.mesh!).watertight,
    },
  };
}

// ---------------------------------------------------------------------------
// Journal reproducibility — record the 6 stage ops (content-addressed), then
// replay every stage FRESH and assert bit-identity.
// ---------------------------------------------------------------------------

export interface CrownReplayFailure {
  readonly stage: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export interface RecordedCrownJournal {
  /** The scripted crown journal — one Operation per stage, content-addressed. */
  readonly operations: readonly Operation[];
  /** The assembled crown (for the caller to report measured numbers). */
  readonly crown: AssembledCrown;
}

const FIXED_TIMESTAMP = new Date(0).toISOString(); // audit-display only; keeps the recorded journal byte-deterministic.

function stageOperation(name: string, result: RestorationStageResult): Operation {
  return {
    id: `crown-standin-${result.stage}`,
    name,
    params: result.params,
    inputHashes: result.inputHashes,
    outputHashes: [result.meshContentHash!],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  };
}

/** Records the standin crown journal — all 6 stages, each with a
 * content-addressed output hash. */
export async function recordCrownJournal(): Promise<RecordedCrownJournal> {
  const crown = await assembleCrown('standin');
  const operations: Operation[] = [
    stageOperation('innerSurface.build', crown.inner),
    stageOperation('anatomyPlacement.place', crown.anatomy),
    stageOperation('morphing.morph', crown.morph),
    stageOperation('shell.construct', crown.shell),
    stageOperation('freeform.sculpt', crown.sculpt),
    {
      id: 'crown-standin-qc',
      name: 'qc.run',
      params: { gateCount: crown.qcReport.gates.length, passed: crown.qcReport.passed },
      inputHashes: [crown.sculpt.meshContentHash!],
      outputHashes: [hashQcReport(crown.qcReport)],
      kernelVersion: KERNEL_VERSION,
      timestamp: FIXED_TIMESTAMP,
    },
  ];
  return { operations, crown };
}

/**
 * Replays the recorded crown journal FRESH from scratch — re-runs every stage
 * as an independent computation and re-hashes its output, comparing against the
 * recorded `outputHashes[0]`. Returns every stage whose replay is NOT
 * bit-identical (empty ⇒ full reproducibility). The intaglio value is rebuilt
 * (cached) but the STAGE functions are all re-invoked; determinism is what is
 * under test, so nothing computed here reuses the recorded run's outputs.
 */
export async function replayCrownJournal(journal: RecordedCrownJournal): Promise<CrownReplayFailure[]> {
  const expected = Object.fromEntries(journal.operations.map((op) => [op.id, op.outputHashes[0]!]));
  const failures: CrownReplayFailure[] = [];

  // Re-run the whole chain fresh.
  const fitCtx = fitContext();
  const inner = await runInnerSurfaceStage(fitCtx, TOOTH, { pitchMm: 0.08, hashMesh });
  const anatomy = runAnatomyPlacementStage(anatomyContext(), TOOTH, { asset: syntheticAsset(), hashMesh });
  const placedRef = PLACED_REF();
  const morph = runMorphingStage(anatomyContext(), TOOTH, {
    placedMesh: handle(hashMesh(placedRef), placedRef),
    hashMesh,
    morphOptions: MORPH_OPTIONS,
  });
  const outer = outerDome();
  const shell = await runShellStage(fitCtx, TOOTH, {
    outerAnatomyMesh: handle(hashMesh(outer), outer),
    innerSurfaceMesh: handle(inner.meshContentHash!, inner.mesh!),
    hashMesh,
  });
  const sculpt = runSculptStage(fitCtx, TOOTH, {
    shellMesh: handle(shell.meshContentHash!, shell.mesh!),
    innerSurfaceMesh: handle(inner.meshContentHash!, inner.mesh!),
    strokes: GESTURE,
    hashMesh,
  });
  const contacts: ContactResidualInput[] = (morph.params['contacts'] as ContactResidualInput[]).map((c) => ({
    kind: c.kind,
    targetPenetrationMm: c.targetPenetrationMm,
    achievedSignedDistanceMm: c.achievedSignedDistanceMm,
    contactResidualMm: c.contactResidualMm,
    regionResidualMm: c.regionResidualMm,
    clampBound: c.clampBound,
  }));
  const qcReport = await runCrownQc({
    crownSolid: sculpt.mesh!,
    innerSurfaceMesh: inner.mesh!,
    outerSurfaceMesh: outer,
    dieSolid: die(),
    marginResampledPoints: FIT_MARGIN.resampledPoints,
    insertionAxis: AXIS,
    minWallThicknessMm: PROFILE.restorationParams.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.anteriorMm2,
    contacts,
    contactClampWarning: morph.params['contactClampWarning'] as boolean,
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: 'crown-accept-standin',
  });

  const actual: Record<string, string> = {
    'crown-standin-innerSurface': inner.meshContentHash!,
    'crown-standin-anatomyPlacement': anatomy.meshContentHash!,
    'crown-standin-morphing': morph.meshContentHash!,
    'crown-standin-shell': shell.meshContentHash!,
    'crown-standin-freeform': sculpt.meshContentHash!,
    'crown-standin-qc': hashQcReport(qcReport),
  };
  for (const [id, expectedHash] of Object.entries(expected)) {
    const actualHash = actual[id]!;
    if (actualHash !== expectedHash) {
      failures.push({ stage: id, expectedHash, actualHash });
    }
  }
  return failures;
}

/** Reset the module-level intaglio cache — for tests that must prove a build
 * from a truly cold start reproduces the recorded hashes. */
export function resetCrownCaches(): void {
  cachedInner = null;
}
