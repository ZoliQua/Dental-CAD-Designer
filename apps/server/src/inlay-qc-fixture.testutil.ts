// apps/server/src/inlay-qc-fixture.testutil.ts
//
// Shared inlay/onlay-QC test fixture for Phase 5 Task 9's server tests — the
// cavity analogue of `crown-qc-fixture.testutil.ts`. Builds a GENUINE
// end-to-end synthetic inlay/onlay via the SAME public kernel + cad-pipeline
// pipeline the client's cavity worker jobs use (analytic MOD cavity fixture →
// `buildCavityInnerSurface` fit surface → `buildOcclusalPatch` occlusal patch →
// `adaptProximalContacts` box adaptation → `runCavityShellStage` weld), so the
// QcReport the server recomputes is the same one the client's `runInlayQc`
// produces. The chain is GENUINELY COUPLED (the P4/T12b lesson): the patch that
// is adapted is the patch that is welded into the shell is the patch that QC
// measures; the shell is built ONCE (via the journaled stage) and reused for the
// QC input, persistence, and replay.
//
// The analytic MOD-cavity fixtures come from the kernel via its dedicated
// `@dqcad/kernel/cavity-fixtures` subpath export (test-only, resolved through
// the package map like `@dqcad/kernel-workers/hash` — NOT a relative
// `../../packages` path, which would violate this project's `rootDir: src`).
// This keeps the fixture drift-free (one source of truth in the kernel) while
// building the real geometry in-process. NOT a `.test.ts` — imported by the
// dual-validation + persistence suites, never run as a suite itself.
import {
  adaptProximalContacts,
  buildCavityInnerSurface,
  buildOcclusalPatch,
  extendOutlineOverCusp,
  KERNEL_VERSION,
  type IndexedMesh,
  type ProximalAdaptationInput,
  type ProximalFaceBoundary,
  type SeamEdge,
  type Vec3,
} from '@dqcad/kernel';
import { modCavityMesh, modOnlayCavityMesh } from '@dqcad/kernel/cavity-fixtures';
import type { FdiTooth, QcReport, RestorationType } from '@dqcad/shared-types';
import {
  runCavityShellStage,
  type CavityShellStageResult,
  type ContactResidualInput,
  type CoverageDivider,
  type PipelineContext,
  type PipelineMeshHandle,
  type RunInlayQcInput,
} from '@dqcad/cad-pipeline';
import { hashMesh } from './journal-replay.js';
import { PROFILE } from './crown-qc-fixture.testutil.js';

// A posterior molar — the clinically-appropriate seat for a MOD inlay/onlay.
export const CAVITY_TOOTH = 36 as FdiTooth;
export const AXIS: Vec3 = [0, 0, 1];

// --- geometry constants (ported verbatim from the golden acceptance tests so a
//     server build is byte-identical to the client's) ---
const INLAY_GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const ONLAY_GAP = { marginalGapMm: 0.03, cementGapMm: 0.08, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const PITCH = 0.06;
const PEN = 0.02;
/** Inlay/onlay isthmus/occlusal minimum (e.max IFU). */
const CAVITY_MIN = 1.0;
/** Onlay covered-cusp minimum (e.max IFU). */
const CUSP_COVERAGE_MIN = 1.5;
/** The cavity marginal-transition band the min-wall gate excludes (mm) — the
 * inlay's convergence-wedge width; wider for the onlay's broad covered cusp.
 * This is the geometry-scoped `marginExclusionMm` that rides WITH the request in
 * Task 9 (the golden acceptance's `MARGIN_EXCL`). */
export const INLAY_MARGIN_EXCL = 1.3;
export const ONLAY_MARGIN_EXCL = 1.8;

function handle(mesh: IndexedMesh): PipelineMeshHandle {
  return { contentHash: hashMesh(mesh), mesh };
}

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function faceOnSide(faces: readonly ProximalFaceBoundary[], sign: -1 | 1): ProximalFaceBoundary {
  const f = faces.find((face) => Math.sign(face.columnPoints[0]![0]) === sign);
  if (!f) throw new Error(`no proximal face on side ${sign}`);
  return f;
}

/** A cavity `PipelineContext` for the shell stage (restoration type inlay/onlay
 * — `runCavityShellStage` asserts it). The shell stage reads only the type; the
 * remaining fields are structurally required but unused by the weld. */
function cavityContext(restorationType: RestorationType, toothMesh: IndexedMesh): PipelineContext {
  return {
    restorationId: `cavity-${restorationType}`,
    restorationType,
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: handle(toothMesh),
    marginLoops: {},
    neighbors: {},
    antagonist: null,
    stages: {},
  };
}

/** Everything a Task-9 server test needs for one built inlay/onlay: the QC
 * input, the journaled shell stage (for replay + persistence), the input
 * handles, and the cavity context. */
export interface BuiltCavityRestoration {
  readonly qcInput: RunInlayQcInput;
  readonly shellResult: CavityShellStageResult;
  readonly context: PipelineContext;
  readonly fitHandle: PipelineMeshHandle;
  readonly patchHandle: PipelineMeshHandle;
  readonly toothMesh: IndexedMesh;
}

export type InlayVariant = 'inlay' | 'inlay-shallow';

/** Builds a MOD INLAY (all-pass on the default fixture; thickness-FAIL on the
 * shallow variant). The shell is built ONCE via `runCavityShellStage` and reused
 * for the QC input — the coupled chain. */
export async function buildInlay(variant: InlayVariant = 'inlay'): Promise<BuiltCavityRestoration> {
  const fx = variant === 'inlay-shallow' ? modCavityMesh({ isthmusDepthMm: 0.4, boxDepthMm: 0.9 }) : modCavityMesh();
  const halfLen = fx.lengthMm / 2;
  const fit = await buildCavityInnerSurface(fx.mesh, { ...INLAY_GAP, pitchMm: PITCH, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
  const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
  const gap = 0.1;
  const adaptations: ProximalAdaptationInput[] = [
    {
      label: 'mesial',
      columnPoints: faceOnSide(patch.proximalFaces, -1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, -1).freeRunPoints,
      neighborMesh: outwardBox([-halfLen - gap - 2, -6, -1], [-halfLen - gap, 6, 12]),
      targetPenetrationMm: PEN,
    },
    {
      label: 'distal',
      columnPoints: faceOnSide(patch.proximalFaces, 1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, 1).freeRunPoints,
      neighborMesh: outwardBox([halfLen + gap, -6, -1], [halfLen + gap + 2, 6, 12]),
      targetPenetrationMm: PEN,
    },
  ];
  const adapted = adaptProximalContacts(patch.mesh, adaptations);

  const fitHandle = handle(fit.mesh);
  const patchHandle = handle(adapted.mesh);
  const context = cavityContext('inlay', fx.mesh);
  const shellResult = await runCavityShellStage(context, CAVITY_TOOTH, { fitSurfaceMesh: fitHandle, patchMesh: patchHandle, hashMesh });

  const contacts: ContactResidualInput[] = adapted.boxes.map((b) => ({
    kind: b.label === 'mesial' ? 'proximalMesial' : 'proximalDistal',
    targetPenetrationMm: b.targetPenetrationMm,
    achievedSignedDistanceMm: b.achievedSignedDistanceMm,
    contactResidualMm: b.contactResidualMm,
    regionResidualMm: b.faceResidualMm,
    clampBound: b.clampBound,
  }));

  const qcInput: RunInlayQcInput = {
    inlaySolid: shellResult.mesh,
    fitSurfaceMesh: fit.mesh,
    patchMesh: adapted.mesh,
    toothWithCavitySolid: fx.mesh,
    cavityOutlineResampledPoints: fx.cavityOutline,
    insertionAxis: AXIS,
    restorationType: 'inlay',
    thicknessMinimums: { inlayMinThicknessMm: CAVITY_MIN, onlayMinThicknessMm: CAVITY_MIN },
    marginExclusionMm: INLAY_MARGIN_EXCL,
    seamEdges: patch.seamEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    contacts,
    contactClampWarning: adapted.clampedBoxes.length > 0,
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: 'inlay-dual-validation',
  };

  return { qcInput, shellResult, context, fitHandle, patchHandle, toothMesh: fx.mesh };
}

/** Builds a MOD ONLAY on the extended (cusp-coverage) outline — the coupled T7
 * chain (the `extendOutlineOverCusp` output IS the outline the fit/patch are
 * built on). The seating gate is ACKNOWLEDGED (the T7 bounded+localized junction
 * artifact) via `acknowledgedGates`; the acknowledgment must round-trip
 * bit-identically through the server (invariant 4). */
export async function buildOnlay(): Promise<BuiltCavityRestoration> {
  const fx = modOnlayCavityMesh();
  const halfLen = fx.lengthMm / 2;
  const ext = extendOutlineOverCusp(fx.mesh, fx.inlayOutline, AXIS, fx.coveredCuspTriangleIndices);
  const outline = ext.extendedOutline;
  const fit = await buildCavityInnerSurface(fx.mesh, { ...ONLAY_GAP, pitchMm: PITCH, cavityOutline: fx.onlayOutline, insertionAxis: AXIS });
  const patch = buildOcclusalPatch(fx.mesh, fx.onlayOutline, AXIS);
  const adaptations: ProximalAdaptationInput[] = [
    {
      label: 'mesial',
      columnPoints: faceOnSide(patch.proximalFaces, -1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, -1).freeRunPoints,
      neighborMesh: outwardBox([-halfLen - 2.1, -8, -1], [-halfLen - 0.1, 8, 12]),
      targetPenetrationMm: PEN,
    },
    {
      label: 'distal',
      columnPoints: faceOnSide(patch.proximalFaces, 1).columnPoints,
      freeRunPoints: faceOnSide(patch.proximalFaces, 1).freeRunPoints,
      neighborMesh: outwardBox([halfLen + 0.1, -8, -1], [halfLen + 2.1, 8, 12]),
      targetPenetrationMm: PEN,
    },
  ];
  const adapted = adaptProximalContacts(patch.mesh, adaptations);

  const fitHandle = handle(fit.mesh);
  const patchHandle = handle(adapted.mesh);
  const context = cavityContext('onlay', fx.mesh);
  const shellResult = await runCavityShellStage(context, CAVITY_TOOTH, { fitSurfaceMesh: fitHandle, patchMesh: patchHandle, hashMesh });

  const contacts: ContactResidualInput[] = adapted.boxes.map((b) => ({
    kind: b.label === 'mesial' ? 'proximalMesial' : 'proximalDistal',
    targetPenetrationMm: b.targetPenetrationMm,
    achievedSignedDistanceMm: b.achievedSignedDistanceMm,
    contactResidualMm: b.contactResidualMm,
    regionResidualMm: b.faceResidualMm,
    clampBound: b.clampBound,
  }));

  const coverage: { coverageDivider: CoverageDivider; cuspCoverageMinThicknessMm: number } = {
    coverageDivider: { pointMm: [0, fx.coveredCuspBuccolingualBoundaryY, 0], normalMm: [0, -1, 0] },
    cuspCoverageMinThicknessMm: CUSP_COVERAGE_MIN,
  };

  const qcInput: RunInlayQcInput = {
    inlaySolid: shellResult.mesh,
    fitSurfaceMesh: fit.mesh,
    patchMesh: adapted.mesh,
    toothWithCavitySolid: fx.mesh,
    cavityOutlineResampledPoints: outline,
    insertionAxis: AXIS,
    restorationType: 'onlay',
    thicknessMinimums: { inlayMinThicknessMm: CAVITY_MIN, onlayMinThicknessMm: CAVITY_MIN },
    marginExclusionMm: ONLAY_MARGIN_EXCL,
    coverage,
    seamEdges: patch.seamEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    contacts,
    contactClampWarning: adapted.clampedBoxes.length > 0,
    kernelVersion: KERNEL_VERSION,
    profileVersion: PROFILE.version,
    journalHash: 'onlay-dual-validation',
    acknowledgedGates: ['seating'],
  };

  return { qcInput, shellResult, context, fitHandle, patchHandle, toothMesh: fx.mesh };
}

// --- serialization: RunInlayQcInput → the POST .../validate-qc JSON body ---

function meshBody(m: IndexedMesh): { positions: number[]; indices: number[] } {
  return { positions: Array.from(m.positions), indices: Array.from(m.indices) };
}

function seamEdgeBody(e: SeamEdge): { a: number[]; b: number[]; segment: string } {
  return { a: [...e.a], b: [...e.b], segment: e.segment };
}

/** Serializes a `RunInlayQcInput` into the extended validate-qc JSON body.
 * `Array.from` on the Float64/Uint32 arrays yields plain numbers that JSON
 * round-trips exactly (shortest-round-trip Number↔String), so the server
 * reconstructs bit-identical inputs. */
export function toValidateInlayQcBody(
  input: RunInlayQcInput,
  extra?: { clientReport?: QcReport; acknowledgedGates?: readonly string[] },
): Record<string, unknown> {
  const ack = extra?.acknowledgedGates ?? input.acknowledgedGates;
  const acknowledgedGates = ack ? [...ack] : undefined;
  return {
    restorationType: input.restorationType,
    inlaySolid: meshBody(input.inlaySolid),
    fitSurfaceMesh: meshBody(input.fitSurfaceMesh),
    patchMesh: meshBody(input.patchMesh),
    toothWithCavitySolid: meshBody(input.toothWithCavitySolid),
    cavityOutlineResampledPoints: input.cavityOutlineResampledPoints.map((p) => [...p]),
    insertionAxis: [...input.insertionAxis],
    thicknessMinimums: { ...input.thicknessMinimums },
    marginExclusionMm: input.marginExclusionMm,
    ...(input.coverage
      ? {
          coverage: {
            coverageDivider: {
              pointMm: [...input.coverage.coverageDivider.pointMm],
              normalMm: [...input.coverage.coverageDivider.normalMm],
            },
            cuspCoverageMinThicknessMm: input.coverage.cuspCoverageMinThicknessMm,
          },
        }
      : {}),
    seamEdges: input.seamEdges.map(seamEdgeBody),
    cavityTriangleIndices: Array.from(input.cavityTriangleIndices),
    contacts: input.contacts.map((c) => ({ ...c })),
    contactClampWarning: input.contactClampWarning,
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    ...(acknowledgedGates ? { acknowledgedGates } : {}),
    ...(extra?.clientReport ? { clientReport: extra.clientReport } : {}),
  };
}
