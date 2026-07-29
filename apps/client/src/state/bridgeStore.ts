// apps/client/src/state/bridgeStore.ts
//
// UI-facing snapshot of the bridge (multi-unit) design workflow (Phase 6 Task 7)
// — the bridge analogue of state/cavityStore.ts, same layering pattern:
// engine/bridgeDesign.ts is the SOLE writer (it pushes a snapshot after every
// state change via `apply`), and ui/BridgeDesignPanel.tsx only ever READS this
// store (field selectors) and calls back into `bridgeDesignEngine`'s exported
// methods. Depends only on `@dqcad/shared-types` (never engine/ or
// kernel-workers — CLAUDE.md layer rule `state -> shared-types`); the trivial
// string-literal unions it mirrors are re-declared here.
//
// The COMMITTED design state (each stage's output hash in `Restoration.stages`,
// the `QcReport` in `Restoration.qc`) lives in the case document
// (state/caseStore.ts) — the panel reads that through `useCaseStore`. THIS store
// holds only the EPHEMERAL in-progress tool state.
import { create } from 'zustand';
import type { QcReport } from '@dqcad/shared-types';

/** The seven bridge-design stages (mirrors engine/bridgeWorkflow.ts's
 * `BridgeStage`). */
export type BridgeStageName =
  | 'margins'
  | 'abutmentSurfaces'
  | 'pontic'
  | 'connectors'
  | 'framework'
  | 'assembly'
  | 'qc';

/** Why a stage is blocked (mirrors engine/bridgeWorkflow.ts's
 * `BridgePrerequisiteCode`). `null` on the `allowed` gates. */
export type BridgePrerequisiteCode =
  | 'noTargetScan'
  | 'noAbutmentMargins'
  | 'abutmentSurfacesIncomplete'
  | 'ponticIncomplete'
  | 'connectorsIncomplete'
  | 'frameworkIncomplete'
  | 'assemblyIncomplete';

/** One stage's runnability verdict, projected from engine/bridgeWorkflow.ts's
 * `BridgeStageGate` (the engine computes it; this is the plain snapshot the panel
 * renders — enabled/blocked/complete + the block reason). */
export interface BridgeStageGateSnapshot {
  stage: BridgeStageName;
  allowed: boolean;
  complete: boolean;
  reason: BridgePrerequisiteCode | null;
}

/** The three pontic gingival-interface styles. */
export type PonticStyleName = 'hygienic' | 'ridgeLap' | 'ovate';

/** Framework vs full-contour mode. */
export type BridgeFrameworkMode = 'fullContour' | 'framework';

export interface BridgeSharedAxisSummary {
  acceptable: boolean;
  direction: readonly [number, number, number];
  perAbutment: readonly { label: string; marginFitMm: number }[];
}

export interface BridgeAbutmentSummary {
  units: readonly { label: string; marginFitMm: number }[];
}

export interface BridgePonticSummary {
  style: PonticStyleName;
  configuredReliefMm: number;
  /** The measured worst |base ↔ gingiva − configured| deviation (mm); the ±20 µm
   * acceptance is `maxAbsDeviationMm ≤ thresholdMm`. */
  maxAbsDeviationMm: number;
  thresholdMm: number;
  withinTolerance: boolean;
}

/** One connector's live/committed readout — the T4 min-area instrument value +
 * its positional gate verdict. */
export interface BridgeConnectorReadout {
  label: string;
  teeth: readonly [number, number];
  semiAxisMm: number;
  minAreaMm2: number;
  targetMm2: number;
  passed: boolean;
}

export interface BridgeConnectorsSummary {
  connectors: readonly BridgeConnectorReadout[];
}

export interface BridgeFrameworkSummary {
  mode: BridgeFrameworkMode;
  /** Present in framework mode — the veneering space + the non-uniform taper band
   * near the margin (the honest disclosure that the space is NOT uniform). */
  veneeringSpaceMm: number | null;
  taperBandMm: number | null;
}

export interface BridgeAssemblySummary {
  watertight: boolean;
  componentCount: number;
  volumeMm3: number | null;
  triangleCount: number;
}

export interface BridgeState {
  restorationId: string | null;
  active: boolean;
  gates: readonly BridgeStageGateSnapshot[];
  nextStage: BridgeStageName | null;
  busyStage: BridgeStageName | null;
  progress: number;
  /** HONEST failure surface: the last stage error message. NEVER cleared by a
   * later success on a DIFFERENT stage; cleared only by re-running the failed
   * stage or `clearError`. `errorStage` names which stage failed. */
  error: string | null;
  errorStage: BridgeStageName | null;
  /** When the failure is a KNOWN, user-actionable condition (currently the
   * P7-T1 session-restore failure), the i18n key the panel translates INSTEAD
   * of showing the raw `error` string — so the actionable message renders in
   * all four languages. `errorDetail` carries the untranslated technical
   * detail interpolated into the translation ({{detail}}). Null for every
   * other failure (the raw `error` path is unchanged). */
  errorKey: string | null;
  errorDetail: string | null;

  sharedAxis: BridgeSharedAxisSummary | null;
  abutmentSurfaces: BridgeAbutmentSummary | null;
  pontic: BridgePonticSummary | null;
  connectors: BridgeConnectorsSummary | null;
  /** The connector-editor LIVE preview (re-loft + re-measure on a profile edit,
   * journaling nothing) — distinct from `connectors` (the committed milestone). */
  liveConnectors: BridgeConnectorsSummary | null;
  framework: BridgeFrameworkSummary | null;
  assembly: BridgeAssemblySummary | null;
  /** Mirror of `Restoration.qc` for the panel's gate table. */
  qc: QcReport | null;

  /** Bumped whenever the engine changes design state, so a Viewport re-syncs. */
  designGeneration: number;

  /** The single writer seam the engine pushes snapshots through. */
  apply: (partial: Partial<Omit<BridgeState, 'apply' | 'reset'>>) => void;
  reset: () => void;
}

const INITIAL: Omit<BridgeState, 'apply' | 'reset'> = {
  restorationId: null,
  active: false,
  gates: [],
  nextStage: null,
  busyStage: null,
  progress: 0,
  error: null,
  errorStage: null,
  errorKey: null,
  errorDetail: null,
  sharedAxis: null,
  abutmentSurfaces: null,
  pontic: null,
  connectors: null,
  liveConnectors: null,
  framework: null,
  assembly: null,
  qc: null,
  designGeneration: 0,
};

export const useBridgeStore = create<BridgeState>((set) => ({
  ...INITIAL,
  apply: (partial) => set(partial),
  reset: () => set({ ...INITIAL }),
}));
