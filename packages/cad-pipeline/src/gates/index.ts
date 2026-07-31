// packages/cad-pipeline/src/gates — the QC gate runner. See runner.ts's
// module doc. No actual clinical gates ship in this task (YAGNI guardrail:
// "no gates beyond the runner + a trivial test gate") — this directory
// gains watertight/manifold/margin-fit/thickness/seating/... gates starting
// Phase 4 Task 4/7/9.
export {
  runQcGates,
  DuplicateGateNameError,
  HardGateAcknowledgmentError,
  NON_ACKNOWLEDGEABLE_GATES,
  type QcGate,
  type RunQcGatesOptions,
} from './runner.ts';
export {
  marginFitGate,
  measureMarginFit,
  MarginFitInputError,
  MARGIN_FIT_GATE_THRESHOLD_MM,
  MARGIN_FIT_GATE_NAME,
  type MarginFitMeasurement,
  type MarginFitGateInput,
} from './marginFit.ts';
export {
  minWallThicknessGate,
  measureMinWallThickness,
  MinWallThicknessInputError,
  MIN_WALL_THICKNESS_GATE_NAME,
  type MinWallThicknessGateInput,
  type MinWallThicknessMeasurement,
} from './minWallThickness.ts';
export {
  cuspCoverageThicknessGate,
  measureCuspCoverageThickness,
  CUSP_COVERAGE_THICKNESS_GATE_NAME,
  type CuspCoverageThicknessGateInput,
  type CuspCoverageThicknessMeasurement,
  type CoverageDivider,
} from './cuspCoverageThickness.ts';
export {
  watertightGate,
  manifoldGate,
  WATERTIGHT_GATE_NAME,
  MANIFOLD_GATE_NAME,
  type TopologyGateInput,
} from './watertight.ts';
export {
  measureSelfIntersection,
  selfIntersectionGate,
  SELF_INTERSECTION_GATE_NAME,
  type SelfIntersectionMeasurement,
  type SelfIntersectionGateInput,
} from './selfIntersection.ts';
export {
  measureSeating,
  seatingGate,
  SEATING_GATE_NAME,
  SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3,
  type SeatingMeasurement,
  type SeatingGateInput,
} from './seating.ts';
export {
  connectorCrossSectionGate,
  connectorPositionalTargetMm2,
  fdiPositionDigit,
  isPosteriorTooth,
  CONNECTOR_CROSS_SECTION_GATE_NAME,
  type ConnectorCrossSection,
  type ConnectorCrossSectionGateInput,
  type ConnectorAreaTargetsMm2,
} from './connectorCrossSection.ts';
export {
  contactGate,
  CONTACT_GATE_NAME,
  CONTACT_GATE_DEFAULT_TOLERANCE_MM,
  type ContactResidualInput,
  type ContactGateInput,
} from './contact.ts';
export {
  seamDihedralGate,
  SEAM_DIHEDRAL_GATE_NAME,
  SEAM_DIHEDRAL_GATE_THRESHOLD_DEG,
  type SeamDihedralGateInput,
} from './seamDihedral.ts';
export {
  ponticReliefGate,
  PONTIC_RELIEF_GATE_NAME,
  PONTIC_RELIEF_GATE_THRESHOLD_MM,
  type PonticReliefGateInput,
} from './ponticRelief.ts';
export { runCrownQc, type RunCrownQcInput } from './report.ts';
export {
  runBridgeQc,
  BridgeQcInputError,
  type RunBridgeQcInput,
  type BridgeUnitQcInput,
} from './bridgeReport.ts';
export {
  runInlayQc,
  selectInlayMinThicknessMm,
  NonCavityRestorationTypeError,
  OnlayCoverageRequiredError,
  type RunInlayQcInput,
  type CavityThicknessMinimums,
} from './inlayReport.ts';
