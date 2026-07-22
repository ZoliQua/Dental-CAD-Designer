// packages/cad-pipeline/src/gates — the QC gate runner. See runner.ts's
// module doc. No actual clinical gates ship in this task (YAGNI guardrail:
// "no gates beyond the runner + a trivial test gate") — this directory
// gains watertight/manifold/margin-fit/thickness/seating/... gates starting
// Phase 4 Task 4/7/9.
export { runQcGates, DuplicateGateNameError, type QcGate, type RunQcGatesOptions } from './runner.ts';
