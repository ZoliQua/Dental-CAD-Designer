// packages/kernel/src/intake/report.ts
//
// Builds the journal-ready `IntakeStepReport`/`IntakeReport` shapes (see
// types.ts) from a step's before/after counts. Shared by `intake()`
// (intake.ts) AND by kernel-workers' `intakeMesh` job (which orchestrates
// the same 4 steps itself, rather than delegating to `intake()`, so it can
// check cancellation and report progress BETWEEN stages — see intake.ts's
// module doc) — factoring this out keeps both producers building the exact
// same report shape, which matters for the real-fixture golden snapshot
// test (test/golden) staying meaningful regardless of which call path
// produced it.

import type { IndexedMesh } from '../mesh/types.ts';
import type { IntakeStepCounts, IntakeStepReport } from './types.ts';

export function countsOf(mesh: IndexedMesh): IntakeStepCounts {
  return { vertexCount: mesh.positions.length / 3, triangleCount: mesh.indices.length / 3 };
}

export function makeStepReport(
  step: IntakeStepReport['step'],
  before: IntakeStepCounts,
  after: IntakeStepCounts,
  details: Record<string, number>,
): IntakeStepReport {
  return { step, before, after, details };
}
