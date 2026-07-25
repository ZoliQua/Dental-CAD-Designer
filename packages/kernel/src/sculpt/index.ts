// packages/kernel/src/sculpt — Phase 4 Task 8: freeform add/remove/smooth
// sculpting brushes on the crown shell, with the fit surface (inner + margin +
// seam) LOCKED by default. See sculpt.ts's module doc.
export {
  applySculptStroke,
  applySculptGesture,
  computeShellLock,
  SculptStrokeParamError,
  SculptNotWatertightError,
  SCULPT_LOCK_INNER_EPSILON_MM,
  SCULPT_LOCK_SEAM_RING_GROWTH,
  SCULPT_MIN_AREA_FRACTION,
  SCULPT_CLAMP_BISECTION_ITERS,
  type SculptBrushType,
  type SculptStroke,
  type SculptStrokeOptions,
  type SculptStrokeResult,
  type SculptGestureResult,
  type ShellLockOptions,
  type ShellLockResult,
} from './sculpt.ts';
