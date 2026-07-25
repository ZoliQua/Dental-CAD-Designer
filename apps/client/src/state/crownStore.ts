// apps/client/src/state/crownStore.ts
//
// UI-facing snapshot of the crown-design workflow (Phase 4 Task 10) — same
// layering pattern as state/axisStore.ts / state/marginStore.ts:
// engine/crownDesign.ts is the SOLE writer (it pushes a snapshot after every
// state change via `apply`), and ui/CrownDesignPanel.tsx only ever READS this
// store (field selectors) and calls back into `crownDesignEngine`'s exported
// methods. This store depends only on `@dqcad/shared-types` — never on
// engine/ or kernel-workers (CLAUDE.md layer rule `state -> shared-types`);
// the few kernel/engine enums it needs (`CrownStageName`, `MorphContactKind`,
// `SculptBrushType`) are re-declared here as the trivial string-literal
// unions they are, the same "duplicate the trivial shape at the layer
// boundary" convention state/axisStore.ts documents for `AxisSearchMode`.
//
// The COMMITTED design state (each stage's output hash in `Restoration.stages`
// and the final `QcReport` in `Restoration.qc`) lives in the case document
// (state/caseStore.ts) — the panel reads that through `useCaseStore`. THIS
// store holds only the EPHEMERAL in-progress tool state: which stage is
// running, progress/error, per-stage numeric readouts, the morph strength
// sliders, the brush palette, and overlay-visibility toggles.
import { create } from 'zustand';
import type { QcReport } from '@dqcad/shared-types';

/** The six crown-design stages (mirrors engine/crownWorkflow.ts's
 * `CrownStage` — identical union, re-declared here per the layer rule). */
export type CrownStageName = 'innerSurface' | 'anatomy' | 'morph' | 'shell' | 'freeform' | 'qc';

/** Mirrors `@dqcad/kernel`'s `MorphContactKind` (re-declared; state may not
 * import kernel/kernel-workers). */
export type MorphContactKind = 'proximalMesial' | 'proximalDistal' | 'antagonist';

/** Mirrors `@dqcad/kernel`'s `SculptBrushType`. */
export type SculptBrushType = 'add' | 'remove' | 'smooth';

/** Why a stage is blocked (mirrors engine/crownWorkflow.ts's
 * `CrownPrerequisiteCode`). `null` on the `allowed` gates. */
export type CrownPrerequisiteCode =
  | 'noTargetScan'
  | 'noMarginLine'
  | 'innerSurfaceIncomplete'
  | 'anatomyIncomplete'
  | 'morphIncomplete'
  | 'shellIncomplete';

/** One stage's runnability verdict, projected from engine/crownWorkflow.ts's
 * `StageGate` (the engine computes it; this is the plain snapshot the panel
 * renders — enabled/blocked/complete + the block reason). */
export interface CrownStageGateSnapshot {
  stage: CrownStageName;
  allowed: boolean;
  complete: boolean;
  reason: CrownPrerequisiteCode | null;
}

export interface InnerSurfaceSummary {
  errorBoundMm: number;
  patchTriangleCount: number;
  marginVertexCount: number;
  pitchMm: number;
}

export interface AnatomySummary {
  scaleMesialDistal: number;
  scaleBuccoLingual: number;
  scaleOcclusoGingival: number;
  usedProximalGap: boolean;
  antagonistUsed: boolean;
  /** `true` after a manual gizmo transform, `false` after auto-place. */
  manual: boolean;
}

export interface MorphContactReadout {
  kind: MorphContactKind;
  strength: number;
  targetPenetrationMm: number;
  achievedSignedDistanceMm: number;
  contactResidualMm: number;
  clampBound: boolean;
}

export interface MorphSummary {
  maxContactResidualMm: number | null;
  marginSealMaxDeviationMm: number;
  contacts: readonly MorphContactReadout[];
  clampedContacts: readonly MorphContactKind[];
}

export interface ShellSummary {
  watertight: boolean;
  minWallThicknessMm: number;
  minOcclusalWallThicknessMm: number;
  minAxialWallThicknessMm: number;
  volumeMm3: number;
  autoThickenApplied: boolean;
  autoThickenMaxAppliedMm: number;
}

export interface SculptSummary {
  movedVertexCount: number;
  peakDisplacementMm: number;
  lockedVertexCount: number;
  sculptableVertexCount: number;
}

/** Morph contact-strength sliders (0..1 each) — `resolveMorph` re-runs the
 * cached RBF plan at these strengths on every slider commit (the interactive
 * < 500 ms path, T6). */
export interface MorphStrengthsUi {
  proximalMesial: number;
  proximalDistal: number;
  antagonist: number;
}

export interface CrownState {
  restorationId: string | null;
  active: boolean;
  gates: readonly CrownStageGateSnapshot[];
  /** The stage the panel highlights as "do this next" (engine/crownWorkflow
   * `nextRunnableStage`), or `null` when finished/blocked. */
  nextStage: CrownStageName | null;
  /** The stage whose worker job is currently in flight, or `null`. */
  busyStage: CrownStageName | null;
  progress: number;
  /** HONEST failure surface: the last stage error message (e.g. the shell
   * `NonManifoldInputError` on a distorted real morph — T9). NEVER cleared by
   * a later success on a DIFFERENT stage; cleared only by re-running the
   * failed stage or `clearError`. `errorStage` names which stage failed. */
  error: string | null;
  errorStage: CrownStageName | null;

  inner: InnerSurfaceSummary | null;
  anatomy: AnatomySummary | null;
  morph: MorphSummary | null;
  shell: ShellSummary | null;
  sculpt: SculptSummary | null;
  /** Mirror of `Restoration.qc` for the panel's gate table — kept here (not
   * only read from the document) so the QC sub-panel re-renders on the same
   * store the rest of the workflow uses; the engine sets both together. */
  qc: QcReport | null;

  strengths: MorphStrengthsUi;
  /** `true` while a live `resolveMorph` re-solve is in flight (slider drag) —
   * a subtle "updating" hint that never gates the slider (mirrors
   * axisStore's `heatmapBusy`). */
  morphBusy: boolean;

  brush: SculptBrushType;
  brushRadiusMm: number;
  brushStrength: number;
  /** Outer-surface LOCK — when `true` (default), sculpt strokes are confined
   * to the outer surface (the intaglio fit surface stays frozen). Surfaced as
   * a lock indicator in the freeform panel. */
  outerLock: boolean;

  innerGhostVisible: boolean;
  contactHeatmapVisible: boolean;
  thicknessHeatmapVisible: boolean;
  /** Bumped whenever the engine changes the design mesh OR any overlay color
   * buffer, so ui/Viewport.tsx re-syncs SceneManager (same "engine keeps the
   * buffers, store only signals a change" split as axisStore's
   * `heatmapGeneration`). */
  designGeneration: number;

  /** The single writer seam the engine pushes snapshots through. */
  apply: (partial: Partial<Omit<CrownState, 'apply' | 'reset'>>) => void;
  reset: () => void;
}

const INITIAL: Omit<CrownState, 'apply' | 'reset'> = {
  restorationId: null,
  active: false,
  gates: [],
  nextStage: null,
  busyStage: null,
  progress: 0,
  error: null,
  errorStage: null,
  inner: null,
  anatomy: null,
  morph: null,
  shell: null,
  sculpt: null,
  qc: null,
  strengths: { proximalMesial: 1, proximalDistal: 1, antagonist: 1 },
  morphBusy: false,
  brush: 'add',
  brushRadiusMm: 0.5,
  brushStrength: 0.1,
  outerLock: true,
  innerGhostVisible: true,
  contactHeatmapVisible: true,
  thicknessHeatmapVisible: true,
  designGeneration: 0,
};

export const useCrownStore = create<CrownState>((set) => ({
  ...INITIAL,
  apply: (partial) => set(partial),
  reset: () => set({ ...INITIAL }),
}));
