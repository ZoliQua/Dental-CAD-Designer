// scripts/cavity-journal-lib.ts
//
// Phase 5 Task 10 — the ASSEMBLED inlay/onlay pipeline + its journal-
// reproducibility harness (THE PHASE GATE). The cavity analogue of
// scripts/crown-journal-lib.ts (Phase 4 Task 12/12b): one source of truth for
// test/golden/cavity-acceptance.test.ts, so the complete-pipeline acceptance
// AND the record→replay→bit-identical proof are written once.
//
// ## What this assembles — the GENUINELY COUPLED cavity chain (the T12b lesson)
//
// The full fixed-order cavity-design stages run end-to-end on the analytic MOD
// cavity fixture, each producing a CONTENT-ADDRESSED output the caller journals.
// NO decoupled stand-ins: the fit surface that is welded is the fit surface the
// margin gate measures; the patch that is contact-adapted is the patch that is
// shelled is the patch that seats; the extended outline the cuspCoverage stage
// selects IS the outline the fit/patch/shell are all built on.
//
//   INLAY chain (5 ops):
//     1. cavityInnerSurface.build  (buildCavityInnerSurface — SDF/MC offset +
//        blockout + skirt-to-outline; pure Float64 TS marching cubes)
//     2. cavityOcclusalPatch.build (buildOcclusalPatch — cubic-Hermite G1 blend;
//        measures the seam dihedral)
//     3. cavityProximalContact.adapt (adaptProximalContacts — per-box Newton bump
//        to the neighbour; re-measures seam G1 after)
//     4. cavityShell.construct (constructInlayShell — the direct deterministic
//        WELD along the shared bit-exact outline ring; manifold-3d cleanup/WASM)
//     5. qc (runInlayQc — the §6 cavity gate set; seating + selfIntersection use
//        manifold-3d)
//
//   ONLAY chain (6 ops): a `cuspCoverage.select` op FIRST (extendOutlineOverCusp
//   — the design decision that extends the outline over the covered buccal cusp),
//   then the SAME 5 ops on the EXTENDED outline, with the region-scoped
//   cuspCoverageThickness gate added and onlay thickness minimums.
//
// ## The honest acceptance framing (the T7/T9 carry-flag — NON-NEGOTIABLE)
//
// The INLAY meets PLAN §3 "seating clean": 0 mm³, empty intersection (T6). The
// ONLAY's `report.passed = true` RESTS ON THE ACKNOWLEDGED seating — a bounded
// (~0.06 mm³ < 0.1) + localized (≥90% at the bevel↔wall junction band) T7
// artifact: the seating gate itself is `passed=false` + `acknowledged=true`
// (invariant 4: journaled, reported, threshold NEVER weakened). The harness
// asserts EXACTLY that state; the acceptance table states it explicitly, never
// "clean".
//
// ## Journal reproducibility (CLAUDE.md invariants 2/3 — the phase-gate crux)
//
// `recordCavityJournal(type)` runs the chain once, sealing each stage's
// content-addressed output (the mesh content hash; for cuspCoverage the extended-
// outline hash; for QC a hash of the QcReport JSON). `replayCavityJournal` re-runs
// the ENTIRE coupled chain FRESH (cold caches) and re-hashes, asserting bit-
// identity. SDF/MC + Hermite + per-box Newton + weld + WASM gates are all
// deterministic (no Math.random, no Date.now, no worker scheduling), so replay
// reproduces every stage hash byte-for-byte. If it does NOT, that is a real
// determinism leak to FIND and FIX — never a comparison to loosen.
import { createHash } from 'node:crypto';
import {
  analyzeMesh,
  intersect,
  KERNEL_VERSION,
  type IndexedMesh,
  type Vec3,
} from '@dqcad/kernel';
import type { FdiTooth, Operation, QcReport } from '@dqcad/shared-types';
import {
  runCavityInnerSurfaceStage,
  runCavityOcclusalPatchStage,
  runCavityProximalContactStage,
  runCavityCuspCoverageStage,
  runCavityShellStage,
  runInlayQc,
  type CavityCuspCoverageStageResult,
  type CavityOcclusalPatchStageResult,
  type CavityProximalContactStageResult,
  type CavityShellStageResult,
  type ContactResidualInput,
  type PipelineContext,
  type PipelineMaterialProfile,
  type PipelineMeshHandle,
  type RestorationStageResult,
  type RunInlayQcInput,
} from '@dqcad/cad-pipeline';
import { modCavityMesh, modOnlayCavityMesh } from '../packages/kernel/src/cavity/cavity.test-fixtures.ts';

// ---------------------------------------------------------------------------
// Canonical hashing — byte-for-byte the client's `hashMeshContent` /
// apps/server's `hashMesh`: sha256(positions LE bytes ‖ indices LE bytes). Same
// function scripts/crown-journal-lib.ts uses.
// ---------------------------------------------------------------------------
export function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** Deterministic hash of an outline point list (the cuspCoverage stage's
 * content-addressed output — no mesh, just the extended-outline ring). Float64
 * LE bytes, mirroring the onlay-stage test's `hashOutline`. */
export function hashOutline(points: readonly Vec3[]): string {
  return createHash('sha256')
    .update(Buffer.from(new Float64Array(points.flatMap((p) => [p[0], p[1], p[2]])).buffer))
    .digest('hex');
}

/** Deterministic hash of a QcReport (the QC stage's content-addressed output —
 * the report carries NO timestamp, so its JSON is hash-stable). Same as
 * crown-journal-lib's `hashQcReport`. */
export function hashQcReport(report: QcReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function handle(contentHash: string, mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash, mesh };
}

// ---------------------------------------------------------------------------
// Fixed params — the SAME clinical/algorithm constants the T6 inlay + T7 onlay
// acceptance suites use (assembled, not duplicated). Determinism: no random, no
// Date.now.
// ---------------------------------------------------------------------------
export const AXIS: Vec3 = [0, 0, 1];
export const TOOTH = 36 as FdiTooth; // a posterior (lower-left first molar); neighbours 35 / 37
const MESIAL_FDI = 35 as FdiTooth;
const DISTAL_FDI = 37 as FdiTooth;

const PITCH = 0.06;
const PEN = 0.02;
const BLEND_WIDTH = 0.3;

// Inlay clinical currency (T6): tighter gaps, 1.3 mm convergence band.
const INLAY_GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8 };
const INLAY_MIN = 1.0; // e.max IFU inlay isthmus/occlusal minimum
const INLAY_MARGIN_EXCL = 1.3;

// Onlay clinical currency (T7): gap 0.08 > pitch 0.06 (convex covered-cusp
// clearance — T7 finding #3); 1.8 mm convergence band (broad covered cusp).
const ONLAY_GAP = { marginalGapMm: 0.03, cementGapMm: 0.08, spacerStartMm: 0.8 };
const ONLAY_MIN = 1.0;
const CUSP_COVERAGE_MIN = 1.5;
const ONLAY_MARGIN_EXCL = 1.8;

/** The onlay seating gate is ACKNOWLEDGED (invariant 4 — journaled, reported,
 * NEVER threshold-weakened): the T7 bounded + localized junction artifact. */
export const ONLAY_ACKNOWLEDGED_GATES = ['seating'] as const;
/** The T7 acknowledgment scope (documented bounds — asserted in the harness). */
export const ACK_MAX_INTERFERENCE_MM3 = 0.1;
export const JUNCTION_BAND = { yMin: -2.0, yMax: -0.9, zMin: 3.0, zMax: 4.3 };
export const JUNCTION_BAND_MIN_FRACTION = 0.9;

function baseRestorationParams(gap: { marginalGapMm: number; cementGapMm: number; spacerStartMm: number }) {
  return {
    cementGapMm: gap.cementGapMm,
    marginalGapMm: gap.marginalGapMm,
    spacerStartMm: gap.spacerStartMm,
    minWallThicknessMm: 0.5, // crown-only field; the cavity min-wall reads thicknessMinimums
    proximalContactPenetrationMm: PEN,
    occlusalContactMm: 0,
  };
}

/** The inlay material profile (gaps + proximal-contact target the stages read). */
export const INLAY_PROFILE: PipelineMaterialProfile = {
  id: 'e-max-inlay',
  version: '1.0.0',
  restorationParams: baseRestorationParams(INLAY_GAP),
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: INLAY_MIN,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: INLAY_MIN,
  onlayMinThicknessMm: ONLAY_MIN,
  cuspCoverageMinThicknessMm: CUSP_COVERAGE_MIN,
  marginExclusionMm: INLAY_MARGIN_EXCL,
  // Phase 6 Task 1: the promoted cavity marginal-transition bands live on the
  // profile now (bit-identical to the former engine constants — the caller below
  // reads these instead of the INLAY_MARGIN_EXCL/ONLAY_MARGIN_EXCL locals).
  inlayMarginExclusionMm: INLAY_MARGIN_EXCL,
  onlayMarginExclusionMm: ONLAY_MARGIN_EXCL,
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
  ponticRidgeLapReliefMm: 0.05,
  ponticOvateDepthMm: 1.0,
};

/** The onlay material profile (wider gaps for the convex covered cusp). */
export const ONLAY_PROFILE: PipelineMaterialProfile = {
  ...INLAY_PROFILE,
  id: 'e-max-onlay',
  restorationParams: baseRestorationParams(ONLAY_GAP),
  marginExclusionMm: ONLAY_MARGIN_EXCL,
};

// ---------------------------------------------------------------------------
// Neighbour boxes — flanking the fixture's ±halfLen proximal faces so the
// proximal-contact stage's GEOMETRIC face↔neighbour pairing resolves cleanly
// (one box per face; never AmbiguousProximalPairingError). Keyed by FDI so
// `identifyNeighbors(36)` → mesial 35 / distal 37; the -x box (35) pairs with
// the -x face, the +x box (37) with the +x face. SAME boxes the T6/T7 suites
// use, keyed for the stage.
// ---------------------------------------------------------------------------
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function neighborHandles(halfLen: number, yHalf: number): Partial<Record<FdiTooth, PipelineMeshHandle>> {
  const gap = 0.1;
  const mesial = outwardBox([-halfLen - gap - 2, -yHalf, -1], [-halfLen - gap, yHalf, 12]);
  const distal = outwardBox([halfLen + gap, -yHalf, -1], [halfLen + gap + 2, yHalf, 12]);
  return {
    [MESIAL_FDI]: handle(hashMesh(mesial), mesial),
    [DISTAL_FDI]: handle(hashMesh(distal), distal),
  };
}

// ---------------------------------------------------------------------------
// Variants + the assembled result.
// ---------------------------------------------------------------------------
export type CavityVariant = 'inlay' | 'inlay-shallow' | 'onlay' | 'onlay-thin';

export interface AssembledCavity {
  readonly variant: CavityVariant;
  readonly restorationType: 'inlay' | 'onlay';
  /** The cusp-coverage SELECTION op (onlay only; null for an inlay). */
  readonly cuspCoverage: CavityCuspCoverageStageResult | null;
  readonly fit: RestorationStageResult;
  readonly patch: CavityOcclusalPatchStageResult;
  readonly contact: CavityProximalContactStageResult;
  readonly shell: CavityShellStageResult;
  readonly qcReport: QcReport;
  /** The exact tooth-with-cavity + shell solids (for the acknowledgment-scope
   * interference analysis — the onlay). */
  readonly toothMesh: IndexedMesh;
  readonly shellMesh: IndexedMesh;
  /** Measured acceptance numbers (RE-MEASURED in the assembled chain). */
  readonly measured: {
    readonly marginFitMm: number;
    readonly seamDihedralDeg: number;
    readonly seamDihedralBeforeDeg: number;
    readonly seamDihedralAfterDeg: number;
    readonly seatingValueMm3: number;
    readonly seatingThresholdMm3: number;
    readonly seatingPassed: boolean;
    readonly seatingAcknowledged: boolean;
    readonly minWallThicknessMm: number;
    readonly minWallThresholdMm: number;
    readonly minWallPassed: boolean;
    readonly cuspCoverageThicknessMm: number | null;
    readonly cuspCoverageThresholdMm: number | null;
    readonly cuspCoveragePassed: boolean | null;
    readonly maxContactResidualMm: number;
    readonly contactClampWarning: boolean;
    readonly shellTriCount: number;
    readonly shellWatertight: boolean;
    readonly reportPassed: boolean;
    /** The onlay coupling crux: the extended outline == the fixture onlayOutline. */
    readonly extendedOutlineMatchesFixture: boolean | null;
    readonly fitErrorBoundMm: number;
  };
}

// ---------------------------------------------------------------------------
// Cached expensive fit builds — the SDF/MC fit surface (seconds) is memoized per
// variant so a single `assembleCavity` builds it once, and the acceptance +
// reproducibility suites share it WITHIN a run. Value-level cache only; each
// STAGE is still invoked fresh by record/replay (which reset the cache to prove
// a cold build reproduces the recorded hashes — the crown-journal-lib pattern).
// ---------------------------------------------------------------------------
const fitCache = new Map<CavityVariant, RestorationStageResult>();

interface CavityFixtureBundle {
  readonly toothMesh: IndexedMesh;
  readonly toothHash: string;
  readonly outline: Vec3[];
  readonly halfLen: number;
  readonly yHalf: number;
  /** onlay only: the covered-cusp selection + coverage divider inputs. */
  readonly onlay: {
    readonly inlayOutline: Vec3[];
    readonly onlayOutline: Vec3[];
    readonly coveredCuspTriangleIndices: Uint32Array;
    readonly boundaryY: number;
    readonly covMarginY: number;
    readonly covMarginZ: number;
  } | null;
}

/** Builds the fixture for a variant, returning the tooth mesh + the OUTLINE the
 * downstream stages consume (the plain cavity outline for an inlay; for an onlay
 * the extended outline the cuspCoverage stage produces — the genuine coupling). */
function buildFixture(variant: CavityVariant): CavityFixtureBundle {
  if (variant === 'inlay' || variant === 'inlay-shallow') {
    const fx = variant === 'inlay-shallow' ? modCavityMesh({ isthmusDepthMm: 0.4, boxDepthMm: 0.9 }) : modCavityMesh();
    return {
      toothMesh: fx.mesh,
      toothHash: hashMesh(fx.mesh),
      outline: fx.cavityOutline,
      halfLen: fx.lengthMm / 2,
      yHalf: 6,
      onlay: null,
    };
  }
  const fx = variant === 'onlay-thin' ? modOnlayCavityMesh({ covMarginZ: 5.5, bHOCz: 5.0 }) : modOnlayCavityMesh();
  return {
    toothMesh: fx.mesh,
    toothHash: hashMesh(fx.mesh),
    // NOTE: the outline is filled by the cuspCoverage stage's extended outline in
    // assembleCavity (the coupling); this placeholder is the inlay-style base.
    outline: fx.inlayOutline,
    halfLen: fx.lengthMm / 2,
    yHalf: 8,
    onlay: {
      inlayOutline: fx.inlayOutline,
      onlayOutline: fx.onlayOutline,
      coveredCuspTriangleIndices: fx.coveredCuspTriangleIndices,
      boundaryY: fx.coveredCuspBuccolingualBoundaryY,
      covMarginY: fx.covMarginY,
      covMarginZ: fx.covMarginZ,
    },
  };
}

function contextFor(
  restorationType: 'inlay' | 'onlay',
  profile: PipelineMaterialProfile,
  toothHash: string,
  toothMesh: IndexedMesh,
  outline: readonly Vec3[],
  neighbors: Partial<Record<FdiTooth, PipelineMeshHandle>>,
): PipelineContext {
  return {
    restorationId: `cavity-accept-${restorationType}`,
    restorationType,
    materialProfile: profile,
    insertionAxis: AXIS,
    targetMesh: handle(toothHash, toothMesh),
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors,
    antagonist: null,
    stages: {},
  };
}

/**
 * Runs the full assembled cavity chain for `variant` and returns every stage
 * result + the RE-MEASURED acceptance numbers. Deterministic (fixed params, no
 * random / Date.now). GENUINELY COUPLED end-to-end.
 */
export async function assembleCavity(variant: CavityVariant): Promise<AssembledCavity> {
  const restorationType: 'inlay' | 'onlay' = variant === 'inlay' || variant === 'inlay-shallow' ? 'inlay' : 'onlay';
  const profile = restorationType === 'inlay' ? INLAY_PROFILE : ONLAY_PROFILE;
  // Phase 6 Task 1 caller-switch: the cavity band is read from the PROFILE's
  // promoted field (was INLAY_MARGIN_EXCL / ONLAY_MARGIN_EXCL engine constants —
  // bit-identical values, so the acceptance goldens do not move).
  const marginExclusionMm = restorationType === 'inlay' ? profile.inlayMarginExclusionMm : profile.onlayMarginExclusionMm;

  const fx = buildFixture(variant);
  const neighbors = neighborHandles(fx.halfLen, fx.yHalf);

  // 0. (ONLAY) cusp-coverage SELECTION — extend the outline over the covered
  //    buccal cusp. Its EXTENDED outline is the outline the fit/patch/shell are
  //    all built on (the coupling: the selected outline IS the design outline).
  let cuspCoverage: CavityCuspCoverageStageResult | null = null;
  let designOutline: readonly Vec3[] = fx.outline;
  let extendedOutlineMatchesFixture: boolean | null = null;
  if (restorationType === 'onlay') {
    const baseCtx = contextFor('onlay', profile, fx.toothHash, fx.toothMesh, fx.onlay!.inlayOutline, neighbors);
    cuspCoverage = runCavityCuspCoverageStage(baseCtx, TOOTH, {
      coveredCuspTriangleIndices: fx.onlay!.coveredCuspTriangleIndices,
      hashOutline,
    });
    designOutline = cuspCoverage.extendedOutline;
    // The T7 coupled crux — the extended outline reproduces the fixture onlayOutline.
    const key = (p: Vec3): string => `${p[0]}|${p[1]}|${p[2]}`;
    const extSet = new Set(designOutline.map(key));
    const fxSet = new Set(fx.onlay!.onlayOutline.map(key));
    extendedOutlineMatchesFixture = extSet.size === fxSet.size && [...fxSet].every((k) => extSet.has(k));
  }

  const ctx = contextFor(restorationType, profile, fx.toothHash, fx.toothMesh, designOutline, neighbors);

  // 1. cavity inner (fit) surface — SDF/MC offset + blockout + skirt (memoized).
  const cached = fitCache.get(variant);
  const fit = cached ?? (await runCavityInnerSurfaceStage(ctx, TOOTH, { pitchMm: PITCH, blendWidthMm: BLEND_WIDTH, hashMesh }));
  if (!cached) fitCache.set(variant, fit);

  // 2. occlusal patch — cubic-Hermite G1 blend (measures the seam dihedral).
  const patch = runCavityOcclusalPatchStage(ctx, TOOTH, { hashMesh });

  // 3. proximal box contact adaptation — per-box Newton to the neighbours;
  //    re-measures the seam G1 after. The patch that is adapted here is the
  //    patch that is shelled next (coupling).
  const contact = runCavityProximalContactStage(ctx, TOOTH, {
    patchMesh: handle(patch.meshContentHash!, patch.mesh!),
    proximalFaces: patch.proximalFaces,
    seamEdges: patch.seamEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    hashMesh,
  });

  // 4. shell — the direct deterministic weld along the shared outline ring.
  const shell = await runCavityShellStage(ctx, TOOTH, {
    fitSurfaceMesh: handle(fit.meshContentHash!, fit.mesh!),
    patchMesh: handle(contact.meshContentHash!, contact.mesh!),
    hashMesh,
  });

  // 5. QC on the FINAL welded solid — the full cavity §6 gate set. The fit /
  //    patch surfaces measured are the EXACT ones welded into the shell.
  const contacts: ContactResidualInput[] = contact.boxes.map((b) => ({
    kind: b.side === 'mesial' ? 'proximalMesial' : 'proximalDistal',
    targetPenetrationMm: b.targetPenetrationMm,
    achievedSignedDistanceMm: b.achievedSignedDistanceMm,
    contactResidualMm: b.contactResidualMm,
    regionResidualMm: b.faceResidualMm,
    clampBound: b.clampBound,
  }));
  const contactClampWarning = contact.clampedBoxes.length > 0;

  const qcInput: RunInlayQcInput = {
    inlaySolid: shell.mesh,
    fitSurfaceMesh: fit.mesh!,
    patchMesh: contact.mesh!,
    toothWithCavitySolid: fx.toothMesh,
    cavityOutlineResampledPoints: designOutline,
    insertionAxis: AXIS,
    restorationType,
    thicknessMinimums: { inlayMinThicknessMm: INLAY_MIN, onlayMinThicknessMm: ONLAY_MIN },
    marginExclusionMm,
    ...(restorationType === 'onlay'
      ? {
          coverage: {
            coverageDivider: { pointMm: [0, fx.onlay!.boundaryY, 0], normalMm: [0, -1, 0] },
            cuspCoverageMinThicknessMm: CUSP_COVERAGE_MIN,
          },
          acknowledgedGates: ONLAY_ACKNOWLEDGED_GATES,
        }
      : {}),
    seamEdges: patch.seamEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    contacts,
    contactClampWarning,
    kernelVersion: KERNEL_VERSION,
    profileVersion: profile.version,
    journalHash: `cavity-accept-${variant}`,
  };
  const qcReport = await runInlayQc(qcInput);

  const byGate = Object.fromEntries(qcReport.gates.map((g) => [g.gate, g]));
  const seating = byGate['seating']!;
  const minWall = byGate['minWallThickness']!;
  const cusp = byGate['cuspCoverageThickness'];

  return {
    variant,
    restorationType,
    cuspCoverage,
    fit,
    patch,
    contact,
    shell,
    qcReport,
    toothMesh: fx.toothMesh,
    shellMesh: shell.mesh,
    measured: {
      marginFitMm: byGate['marginFit']!.value ?? Number.POSITIVE_INFINITY,
      seamDihedralDeg: byGate['seamDihedral']!.value ?? Number.POSITIVE_INFINITY,
      seamDihedralBeforeDeg: contact.seamDihedralMaxBeforeDeg,
      seamDihedralAfterDeg: contact.seamDihedralMaxAfterDeg,
      seatingValueMm3: seating.value ?? Number.POSITIVE_INFINITY,
      seatingThresholdMm3: seating.threshold ?? 0,
      seatingPassed: seating.passed,
      seatingAcknowledged: seating.acknowledged === true,
      minWallThicknessMm: minWall.value ?? Number.POSITIVE_INFINITY,
      minWallThresholdMm: minWall.threshold ?? 0,
      minWallPassed: minWall.passed,
      cuspCoverageThicknessMm: cusp ? (cusp.value ?? Number.POSITIVE_INFINITY) : null,
      cuspCoverageThresholdMm: cusp ? (cusp.threshold ?? 0) : null,
      cuspCoveragePassed: cusp ? cusp.passed : null,
      maxContactResidualMm: contact.params['maxContactResidualMm'] as number,
      contactClampWarning,
      shellTriCount: shell.mesh.indices.length / 3,
      shellWatertight: analyzeMesh(shell.mesh).watertight,
      reportPassed: qcReport.passed,
      extendedOutlineMatchesFixture,
      fitErrorBoundMm: fit.errorBoundMm ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// The ACKNOWLEDGED-seating scope instrument (the onlay) — interference geometry
// (volume, junction-band vertex fraction, centroid, off-band verts). Mirrors the
// T7 onlay-acceptance analysis so the bounded+localized guards ride along.
// ---------------------------------------------------------------------------
export interface InterferenceAnalysis {
  readonly volumeMm3: number;
  readonly vertexCount: number;
  readonly inBandFraction: number;
  readonly centroid: Vec3;
  readonly offBandVertices: Vec3[];
}
export async function analyzeSeatingInterference(shellMesh: IndexedMesh, toothMesh: IndexedMesh): Promise<InterferenceAnalysis> {
  const inter = await intersect(shellMesh, toothMesh);
  const st = inter.indices.length > 0 ? analyzeMesh(inter) : null;
  const volumeMm3 = Math.abs(st?.signedVolumeMm3 ?? 0);
  const n = inter.positions.length / 3;
  let inBand = 0;
  let cx = 0, cy = 0, cz = 0;
  const offBandVertices: Vec3[] = [];
  for (let v = 0; v < n; v++) {
    const x = inter.positions[v * 3]!, y = inter.positions[v * 3 + 1]!, z = inter.positions[v * 3 + 2]!;
    cx += x; cy += y; cz += z;
    if (y >= JUNCTION_BAND.yMin && y <= JUNCTION_BAND.yMax && z >= JUNCTION_BAND.zMin && z <= JUNCTION_BAND.zMax) inBand++;
    else offBandVertices.push([x, y, z]);
  }
  return {
    volumeMm3,
    vertexCount: n,
    inBandFraction: n > 0 ? inBand / n : 1,
    centroid: n > 0 ? [cx / n, cy / n, cz / n] : [0, 0, 0],
    offBandVertices,
  };
}

// ---------------------------------------------------------------------------
// Journal reproducibility — record the stage ops (content-addressed), then
// replay every stage FRESH and assert bit-identity.
// ---------------------------------------------------------------------------
export interface CavityReplayFailure {
  readonly stage: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export interface RecordedCavityJournal {
  readonly restorationType: 'inlay' | 'onlay';
  /** One Operation per stage, content-addressed. */
  readonly operations: readonly Operation[];
  /** The assembled cavity (for the caller to report measured numbers). */
  readonly cavity: AssembledCavity;
}

const FIXED_TIMESTAMP = new Date(0).toISOString(); // audit-display only; keeps the recorded journal byte-deterministic.

function meshOperation(id: string, name: string, result: RestorationStageResult): Operation {
  return {
    id,
    name,
    params: result.params,
    inputHashes: result.inputHashes,
    outputHashes: [result.meshContentHash!],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  };
}

/** The content-addressed output id used to key each stage in the recorded /
 * replayed journals — one per (chain, stage). */
export function stageId(restorationType: 'inlay' | 'onlay', stage: string): string {
  return `cavity-${restorationType}-${stage}`;
}

function buildOperations(cavity: AssembledCavity): Operation[] {
  const t = cavity.restorationType;
  const ops: Operation[] = [];
  if (cavity.cuspCoverage) {
    // The cuspCoverage op has NO mesh; its content-addressed output is the
    // extended-outline hash (journaled in params.extendedOutlineHash).
    ops.push({
      id: stageId(t, 'cuspCoverage'),
      name: cavity.cuspCoverage.operationName, // 'cuspCoverage.select'
      params: cavity.cuspCoverage.params,
      inputHashes: cavity.cuspCoverage.inputHashes,
      outputHashes: [cavity.cuspCoverage.params['extendedOutlineHash'] as string],
      kernelVersion: KERNEL_VERSION,
      timestamp: FIXED_TIMESTAMP,
    });
  }
  ops.push(meshOperation(stageId(t, 'innerSurface'), cavity.fit.operationName, cavity.fit));
  ops.push(meshOperation(stageId(t, 'occlusalPatch'), cavity.patch.operationName, cavity.patch));
  ops.push(meshOperation(stageId(t, 'proximalContact'), cavity.contact.operationName, cavity.contact));
  ops.push(meshOperation(stageId(t, 'shell'), cavity.shell.operationName, cavity.shell));
  ops.push({
    id: stageId(t, 'qc'),
    name: 'qc.run',
    params: { gateCount: cavity.qcReport.gates.length, passed: cavity.qcReport.passed, restorationType: t },
    inputHashes: [cavity.shell.meshContentHash!],
    outputHashes: [hashQcReport(cavity.qcReport)],
    kernelVersion: KERNEL_VERSION,
    timestamp: FIXED_TIMESTAMP,
  });
  return ops;
}

/** Maps an assembled cavity to its stage→outputHash record (the replay currency). */
function actualHashes(cavity: AssembledCavity): Record<string, string> {
  const t = cavity.restorationType;
  const out: Record<string, string> = {
    [stageId(t, 'innerSurface')]: cavity.fit.meshContentHash!,
    [stageId(t, 'occlusalPatch')]: cavity.patch.meshContentHash!,
    [stageId(t, 'proximalContact')]: cavity.contact.meshContentHash!,
    [stageId(t, 'shell')]: cavity.shell.meshContentHash!,
    [stageId(t, 'qc')]: hashQcReport(cavity.qcReport),
  };
  if (cavity.cuspCoverage) {
    out[stageId(t, 'cuspCoverage')] = cavity.cuspCoverage.params['extendedOutlineHash'] as string;
  }
  return out;
}

/** Records the assembled cavity journal for `restorationType` (the healthy,
 * passing variant) — every stage with a content-addressed output hash. */
export async function recordCavityJournal(restorationType: 'inlay' | 'onlay'): Promise<RecordedCavityJournal> {
  const cavity = await assembleCavity(restorationType);
  return { restorationType, operations: buildOperations(cavity), cavity };
}

/**
 * Replays the recorded journal FRESH from scratch — re-runs the ENTIRE coupled
 * chain (`assembleCavity(restorationType)`, cold: the caller resets the caches
 * first) as an independent computation and re-hashes every stage output,
 * comparing against the recorded `outputHashes[0]`. Returns every stage whose
 * replay is NOT bit-identical (empty ⇒ full reproducibility). Re-running the
 * whole assembler (rather than a hand-duplicated chain) guarantees the replay
 * path cannot silently drift from the record path.
 */
export async function replayCavityJournal(journal: RecordedCavityJournal): Promise<CavityReplayFailure[]> {
  const expected = Object.fromEntries(journal.operations.map((op) => [op.id, op.outputHashes[0]!]));
  const cavity = await assembleCavity(journal.restorationType);
  const actual = actualHashes(cavity);
  const failures: CavityReplayFailure[] = [];
  for (const [id, expectedHash] of Object.entries(expected)) {
    const actualHash = actual[id]!;
    if (actualHash !== expectedHash) {
      failures.push({ stage: id, expectedHash, actualHash });
    }
  }
  return failures;
}

/** Reset the module-level fit cache — for tests that must prove a build from a
 * truly cold start reproduces the recorded hashes. */
export function resetCavityCaches(): void {
  fitCache.clear();
}
