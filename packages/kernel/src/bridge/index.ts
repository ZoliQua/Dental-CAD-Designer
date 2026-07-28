// packages/kernel/src/bridge/index.ts — public surface of the bridge/ module
// (Phase 6). See sharedAxis.ts's module doc for the shared-insertion-axis
// assessment + suggestion (the reuse map over the P3/P4 axis+undercut
// machinery).
export {
  assessSharedAxis,
  suggestSharedAxis,
  type SharedAxisRegionReport,
  type SharedAxisAssessment,
  type AssessSharedAxisOptions,
  type SharedAxisSuggestion,
} from './sharedAxis.ts';

// Phase 6 Task 3 — the pontic gingival interface (per-style base construction +
// the blend-independent relief measurement). See ponticInterface.ts's module doc.
export {
  shapePonticBase,
  synthPonticSeatRing,
  measurePonticRelief,
  analyticCylinderSignedDistanceMm,
  crestSagittaBoundMm,
  PonticInterfaceParamError,
  type PonticInterfaceStyle,
  type RidgeCrestCylinder,
  type PonticPatch,
  type PonticInterfaceParams,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type PonticBaseSample,
  type ShapePonticBaseResult,
  type PonticReliefPatchStats,
  type PonticReliefMeasurement,
} from './ponticInterface.ts';

// Phase 6 Task 4 — the bridge CONNECTOR op (editable 2D profiles + deterministic
// watertight loft + the exact closed-form minimum cross-section area, the
// fracture-strength gate value). See connector.ts's module doc + @errorBound.
export {
  CONNECTOR_PROFILE_MIN_AREA_MM2,
  makeEllipseConnectorProfile,
  ellipseConnectorProfileAreaMm2,
  connectorProfileSignedArea,
  validateConnectorProfile,
  buildConnectorFrame,
  loftConnectorProfiles,
  connectorAreaQuadratic,
  analyticConnectorMinArea,
  sampleConnectorCrossSectionAreas,
  measureConnectorMinArea,
  connectorAxialLengthMm,
  NonClosedProfileError,
  DegenerateProfileError,
  SelfIntersectingProfileError,
  ProfileVertexCountMismatchError,
  ProfileWindingMismatchError,
  NonSimpleConnectorSectionError,
  type Vec2,
  type ConnectorProfile2D,
  type ConnectorFrame,
  type ConnectorProfileInfo,
  type LoftConnectorResult,
  type ConnectorAreaQuadratic,
  type ConnectorAnalyticMinArea,
  type SampledConnectorAreas,
  type SampleConnectorAreasOptions,
  type MeasureConnectorMinAreaResult,
} from './connector.ts';

// Phase 6 Task 5 — the framework CUTBACK op (reduced anatomy for veneering:
// the outer surface offset inward by the veneering space, fit surfaces + margin
// preserved byte-exact via a topology-preserving tapered normal displacement).
// See frameworkCutback.ts's module doc + @errorBound.
export {
  frameworkCutback,
  FrameworkCutbackParamError,
  type FrameworkCutbackOptions,
  type FrameworkCutbackResult,
  type FrameworkCutbackValidation,
} from './frameworkCutback.ts';

// Phase 6 Task 6 — the whole-bridge ASSEMBLY op (units + pontic + connectors →
// ONE watertight single-component solid via boolean union) + the geometric
// fit-surface extractor that re-measures margin fit on the assembled solid.
// See bridgeAssembly.ts's module doc (union-vs-weld, survive-assembly, provenance).
export {
  assembleBridge,
  extractFitPatch,
  BridgeAssemblyError,
  type BridgeAssemblyResult,
  type BridgeAssemblyFailureReason,
  type FitRegionDescriptor,
} from './bridgeAssembly.ts';
