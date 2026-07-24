// packages/cad-pipeline/src/gates/report.ts
//
// Phase 4 Task 9: the full §6 crown QC-REPORT assembly — `runCrownQc` gathers
// every gate input (some via async manifold-3d booleans), runs the whole ordered
// gate set through the deterministic `runQcGates` runner, and returns one
// `QcReport` (shared-types) ready to store on the restoration's `qc` field.
//
// ## The gate set + order (runner.ts's documented Task-9 order)
//
//   watertight → manifold → selfIntersection → minWallThickness → marginFit →
//   seating → connectorCrossSection → contact
//
// ## Async measure, sync gates (determinism preserved)
//
// Two gates rest on manifold-3d booleans (WASM, async): `seating`
// (intersect+volume) and `selfIntersection` (construct-probe). Their MEASUREMENTS
// are taken ONCE here, up front (`measureSeating`, `measureSelfIntersection`), and
// `analyzeMesh` is run ONCE for the watertight+manifold gates. The gates
// themselves are then pure synchronous `(input) => QcGateResult` functions the
// runner executes in deterministic array order — so the runner stays synchronous
// and every acknowledgment/dedup rule in `runner.ts` applies unchanged.
//
// ## Determinism (CLAUDE.md invariant 2)
//
// The report is a pure function of its inputs + params + kernel/manifold-3d
// version: no `Date.now`, no `Math.random`, no worker-scheduling dependence. The
// `QcReport` carries NO timestamp (see shared-types' `QcReport` — it is
// `journalHash`/version-addressed), so the report is hash-stable across runs; the
// caller may stamp a display timestamp on the surrounding journal `Operation`
// (never inside the report or any gate computation).
//
// ## Thresholds come from the caller's resolved profile (invariant 7)
//
// Every clinical threshold (`minWallThicknessMm`, `occlusalMinWallThicknessMm`,
// `connectorAreaTargetMm2`, the contact target penetrations carried on the
// residuals) is passed IN by the caller from the resolved profile — never
// hardcoded here. Gate TOLERANCES that are QC-gate constants (margin-fit 10 µm,
// seating 1e-6 mm³ interference — a derived measurement-noise floor, not zero,
// contact 50 µm) live in their own gate modules and are
// overridable via the optional fields below.
//
// DOM/Three-free (invariant 6) — callable identically from the client worker
// (`kernel-workers` runQc job) and the Node server's export re-validation.
import { analyzeMesh, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import type { QcReport } from '@dqcad/shared-types';
import { runQcGates, type QcGate } from './runner.ts';
import { watertightGate, manifoldGate } from './watertight.ts';
import { measureSelfIntersection, selfIntersectionGate, type SelfIntersectionMeasurement } from './selfIntersection.ts';
import { minWallThicknessGate } from './minWallThickness.ts';
import { marginFitGate } from './marginFit.ts';
import { measureSeating, seatingGate, type SeatingMeasurement } from './seating.ts';
import { connectorCrossSectionGate, type ConnectorCrossSection } from './connectorCrossSection.ts';
import { contactGate, type ContactResidualInput } from './contact.ts';

export interface RunCrownQcInput {
  /** The finished watertight crown solid (T7 shell / T8 sculpt output). */
  readonly crownSolid: IndexedMesh;
  /** The crown INNER (intaglio) surface — for margin-fit + min-wall. */
  readonly innerSurfaceMesh: IndexedMesh;
  /** The crown OUTER surface (shell's trimmed outer) — for min-wall. */
  readonly outerSurfaceMesh: IndexedMesh;
  /** The prep die (watertight) — for the seating simulation. */
  readonly dieSolid: IndexedMesh;
  /** Confirmed margin dense on-surface polyline (`resampledPoints`). */
  readonly marginResampledPoints: readonly Vec3[];
  /** Insertion axis (unit vector). */
  readonly insertionAxis: Vec3;

  // --- profile-resolved clinical thresholds (from context.materialProfile) ---
  readonly minWallThicknessMm: number;
  readonly occlusalMinWallThicknessMm: number;
  readonly connectorAreaTargetMm2: number;

  // --- T6 morph contact residuals ---
  readonly contacts: readonly ContactResidualInput[];
  readonly contactClampWarning: boolean;

  // --- optional gate-tolerance / measurement overrides ---
  readonly marginExclusionMm?: number;
  readonly marginFitThresholdMm?: number;
  readonly seatingInterferenceVolumeToleranceMm3?: number;
  readonly contactToleranceMm?: number;
  /** Phase 6 bridge connectors (absent/empty → single-crown N/A stub). */
  readonly connectors?: readonly ConnectorCrossSection[];

  // --- report metadata ---
  readonly kernelVersion: string;
  readonly profileVersion: string;
  readonly journalHash: string;
  /** Gate names the user has explicitly (journaled) acknowledged. */
  readonly acknowledgedGates?: ReadonlySet<string> | readonly string[];
}

/** Everything the (sync) gate thunks read — pre-computed once (analyzeMesh +
 * the two async manifold-3d measurements). */
interface CrownQcContext {
  readonly input: RunCrownQcInput;
  readonly stats: ReturnType<typeof analyzeMesh>;
  readonly seating: SeatingMeasurement;
  readonly selfIntersection: SelfIntersectionMeasurement;
}

/**
 * Runs the full §6 crown QC gate set and assembles the `QcReport`. Async only
 * because two gates use manifold-3d booleans (measured once up front); the
 * report itself is a deterministic, hash-stable pure function of the inputs +
 * kernel/manifold-3d version — `onProgress` (if given) is fire-and-forget
 * progress reporting that affects NO computed value. See this file's module doc.
 *
 * @param onProgress optional [0..1] progress callback — emitted at the two WASM
 * measurement phases and once per gate (for the worker job's progress UI).
 */
export async function runCrownQc(input: RunCrownQcInput, onProgress?: (fraction: number) => void): Promise<QcReport> {
  onProgress?.(0);
  const stats = analyzeMesh(input.crownSolid);
  onProgress?.(0.1);
  // Async measurements (WASM) taken once, up front.
  const seating = await measureSeating(input.crownSolid, input.dieSolid);
  onProgress?.(0.4);
  const selfIntersection = await measureSelfIntersection(input.crownSolid);
  onProgress?.(0.6);

  const baseGates: readonly QcGate<CrownQcContext>[] = [
    (c) => watertightGate({ stats: c.stats }),
    (c) => manifoldGate({ stats: c.stats }),
    (c) => selfIntersectionGate({ measurement: c.selfIntersection }),
    (c) =>
      minWallThicknessGate({
        innerSurfaceMesh: c.input.innerSurfaceMesh,
        outerSurfaceMesh: c.input.outerSurfaceMesh,
        minWallThicknessMm: c.input.minWallThicknessMm,
        occlusalMinWallThicknessMm: c.input.occlusalMinWallThicknessMm,
        insertionAxis: c.input.insertionAxis,
        marginResampledPoints: c.input.marginResampledPoints,
        marginExclusionMm: c.input.marginExclusionMm,
      }),
    (c) =>
      marginFitGate({
        innerSurfaceMesh: c.input.innerSurfaceMesh,
        marginResampledPoints: c.input.marginResampledPoints,
        thresholdMm: c.input.marginFitThresholdMm,
      }),
    (c) => seatingGate({ measurement: c.seating, interferenceVolumeToleranceMm3: c.input.seatingInterferenceVolumeToleranceMm3 }),
    (c) => connectorCrossSectionGate({ connectorAreaTargetMm2: c.input.connectorAreaTargetMm2, connectors: c.input.connectors }),
    (c) => contactGate({ contacts: c.input.contacts, contactClampWarning: c.input.contactClampWarning, toleranceMm: c.input.contactToleranceMm }),
  ];

  // Per-gate progress over the [0.6..1.0] band — pure wrapping, no effect on the
  // computed result (each wrapped gate delegates to the real gate).
  const total = baseGates.length;
  const gates: readonly QcGate<CrownQcContext>[] = baseGates.map((gate, i) => (c: CrownQcContext) => {
    const result = gate(c);
    onProgress?.(0.6 + (0.4 * (i + 1)) / total);
    return result;
  });

  const context: CrownQcContext = { input, stats, seating, selfIntersection };
  const report = runQcGates(context, gates, {
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    acknowledgedGates: input.acknowledgedGates,
  });
  onProgress?.(1);
  return report;
}
