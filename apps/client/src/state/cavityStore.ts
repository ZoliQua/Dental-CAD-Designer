// apps/client/src/state/cavityStore.ts
//
// UI-facing snapshot of the inlay/onlay (cavity) design workflow (Phase 5 Task
// 8) — the cavity analogue of state/crownStore.ts, same layering pattern:
// engine/cavityDesign.ts is the SOLE writer (it pushes a snapshot after every
// state change via `apply`), and ui/CavityDesignPanel.tsx only ever READS this
// store (field selectors) and calls back into `cavityDesignEngine`'s exported
// methods. Depends only on `@dqcad/shared-types` (never engine/ or
// kernel-workers — CLAUDE.md layer rule `state -> shared-types`); the trivial
// string-literal unions it mirrors are re-declared here, the same "duplicate the
// trivial shape at the layer boundary" convention crownStore documents.
//
// The COMMITTED design state (each stage's output hash in `Restoration.stages`,
// the `QcReport` in `Restoration.qc`) lives in the case document
// (state/caseStore.ts) — the panel reads that through `useCaseStore`. THIS store
// holds only the EPHEMERAL in-progress tool state.
import { create } from 'zustand';
import type { QcReport } from '@dqcad/shared-types';

/** The seven cavity-design stages (mirrors engine/cavityWorkflow.ts's
 * `CavityStage`). */
export type CavityStageName = 'outline' | 'fit' | 'patch' | 'contacts' | 'cuspCoverage' | 'shell' | 'qc';

/** Why a stage is blocked (mirrors engine/cavityWorkflow.ts's
 * `CavityPrerequisiteCode`). `null` on the `allowed` gates. */
export type CavityPrerequisiteCode =
  | 'noTargetScan'
  | 'noCavityOutline'
  | 'fitIncomplete'
  | 'patchIncomplete'
  | 'contactsIncomplete'
  | 'cuspCoverageIncomplete'
  | 'shellIncomplete';

/** One stage's runnability verdict, projected from engine/cavityWorkflow.ts's
 * `CavityStageGate` (the engine computes it; this is the plain snapshot the
 * panel renders — enabled/blocked/complete + the block reason). */
export interface CavityStageGateSnapshot {
  stage: CavityStageName;
  allowed: boolean;
  complete: boolean;
  reason: CavityPrerequisiteCode | null;
}

export interface CavityFitSummary {
  errorBoundMm: number;
  flatZoneErrorBoundMm: number;
  patchTriangleCount: number;
  skirtTriangleCount: number;
  marginVertexCount: number;
  pitchMm: number;
}

export interface CavityPatchSummary {
  /** The G1 acceptance measurable — max seam dihedral (deg) across the blend
   * seam; the acceptance gate is < 5°. Surfaced as the panel's seam readout. */
  seamDihedralMaxDeg: number;
  seamDihedralMeanDeg: number;
  seamDihedralBoundDeg: number;
  /** The AUTHORITATIVE seam pass/fail verdict, computed by the engine with the
   * SAME predicate the seam-dihedral gate uses
   * (`packages/cad-pipeline/src/gates/seamDihedral.ts`): `sampleCount > 0 AND
   * maxDeg < boundDeg`. The panel READS this boolean — it must NOT re-derive
   * `maxDeg < boundDeg` itself, because that raw compare paints the zero-sample
   * case (an empty/mis-partitioned seam, `maxDeg === 0`) GREEN even though the
   * gate treats it as a hard FAILURE. */
  seamWithinBound: boolean;
  patchTriangleCount: number;
  proximalFaceCount: number;
}

export interface CavityBoxReadout {
  label: string;
  targetPenetrationMm: number;
  achievedSignedDistanceMm: number;
  contactResidualMm: number;
  clampBound: boolean;
}

export interface CavityContactsSummary {
  boxes: readonly CavityBoxReadout[];
  clampedBoxes: readonly string[];
  /** Seam G1 survival evidence — the seam dihedral BEFORE and AFTER adaptation
   * (the box adaptation must not break the occlusal seam's G1 continuity). */
  seamDihedralMaxBeforeDeg: number;
  seamDihedralMaxAfterDeg: number;
}

export interface CavityCoverageSummary {
  /** The covered-cusp divider plane (point + normal) the region-scoped
   * cusp-coverage thickness gate uses. Onlay only. */
  pointMm: readonly [number, number, number];
  normalMm: readonly [number, number, number];
}

export interface CavityShellSummary {
  watertight: boolean;
  componentCount: number;
  seamRingVertexCount: number;
  volumeMm3: number;
}

export interface CavityState {
  restorationId: string | null;
  /** The restoration type driving the workflow ('inlay' | 'onlay'); mirrors
   * `Restoration.type` so the panel can render/hide the onlay-only cusp-coverage
   * stage without reading the document. */
  restorationType: 'inlay' | 'onlay' | null;
  active: boolean;
  gates: readonly CavityStageGateSnapshot[];
  /** The stage the panel highlights as "do this next", or `null`. */
  nextStage: CavityStageName | null;
  /** The stage whose worker job is currently in flight, or `null`. */
  busyStage: CavityStageName | null;
  progress: number;
  /** HONEST failure surface: the last stage error message. NEVER cleared by a
   * later success on a DIFFERENT stage; cleared only by re-running the failed
   * stage or `clearError`. `errorStage` names which stage failed. */
  error: string | null;
  errorStage: CavityStageName | null;

  fit: CavityFitSummary | null;
  patch: CavityPatchSummary | null;
  contacts: CavityContactsSummary | null;
  coverage: CavityCoverageSummary | null;
  shell: CavityShellSummary | null;
  /** Mirror of `Restoration.qc` for the panel's gate table. */
  qc: QcReport | null;

  fitGhostVisible: boolean;
  /** Bumped whenever the engine changes the design mesh, so Viewport re-syncs. */
  designGeneration: number;

  /** The single writer seam the engine pushes snapshots through. */
  apply: (partial: Partial<Omit<CavityState, 'apply' | 'reset'>>) => void;
  reset: () => void;
}

const INITIAL: Omit<CavityState, 'apply' | 'reset'> = {
  restorationId: null,
  restorationType: null,
  active: false,
  gates: [],
  nextStage: null,
  busyStage: null,
  progress: 0,
  error: null,
  errorStage: null,
  fit: null,
  patch: null,
  contacts: null,
  coverage: null,
  shell: null,
  qc: null,
  fitGhostVisible: true,
  designGeneration: 0,
};

export const useCavityStore = create<CavityState>((set) => ({
  ...INITIAL,
  apply: (partial) => set(partial),
  reset: () => set({ ...INITIAL }),
}));
