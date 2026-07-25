// packages/clinical-profiles — Versioned clinical defaults (gaps,
// thicknesses, connector areas, algorithm pitches with clinical meaning).
// No clinical defaults live outside this package (CLAUDE.md invariant 7,
// PLAN.md §3). Schema-checked JSON material profiles arrive in Phase 4;
// until then this package exports individual named constants (first real
// export: Phase 2 Task 7's `DEFAULT_OFFSET_VOXEL_PITCH_MM` — see
// constants.ts for the citation discipline every entry here follows).
//
// `.ts`-extension re-export: this package is imported by root-level golden
// tests and may be pulled into kernel-workers' Node worker import closure by
// future callers — same native-Node-resolution rationale as
// packages/kernel/src/index.ts (see boolean/manifold.ts's module doc).
export {
  DEFAULT_OFFSET_VOXEL_PITCH_MM,
  DEFAULT_RESTORATION_PARAMS,
  DEFAULT_UNDERCUT_BLOCKOUT_THRESHOLD_MM,
} from './constants.ts';
export { STANDARD_ZIRCONIA_PROFILE, EMAX_LITHIUM_DISILICATE_PROFILE } from './profiles.ts';
export type {
  ConnectorAreaTargets,
  MaterialProfile,
  RawMaterialProfileJson,
} from './materialProfile.ts';
export {
  MaterialProfileValidationError,
  computeProfileChecksum,
  loadMaterialProfile,
  validateMaterialProfileShape,
} from './materialProfile.ts';
// Re-exported (Phase 4 Task 2) so sibling leaf packages — starting
// `@dqcad/tooth-library`, whose asset checksums use the exact same
// "sync, pure-TS, Node+browser-portable SHA-256 over a canonical JSON
// serialization" scheme this package invented for material profiles — reuse
// the SAME implementation rather than forking a second copy. See sha256.ts's
// and canonicalJson.ts's own module docs for why each is shaped the way it
// is; nothing about either is material-profile-specific.
export { sha256Bytes, sha256HexOfString } from './sha256.ts';
export { canonicalStringify } from './canonicalJson.ts';
