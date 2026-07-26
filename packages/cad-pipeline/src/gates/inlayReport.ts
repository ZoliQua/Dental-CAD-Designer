// packages/cad-pipeline/src/gates/inlayReport.ts
//
// Phase 5 Task 6: the full inlay/onlay QC-REPORT assembly — `runInlayQc`
// gathers every gate input (some via async manifold-3d booleans), runs the
// restoration-type-aware gate set through the deterministic `runQcGates`
// runner, and returns one `QcReport` ready to store on the restoration's `qc`
// field. It is the cavity analogue of `report.ts`'s `runCrownQc` and reuses
// every gate module unchanged — only the SET, the ORDER, and the thickness
// THRESHOLD SELECTION differ.
//
// ## The gate set + order
//
//   watertight → manifold → selfIntersection → minWallThickness(inlay minimums)
//   → marginFit(cavity outline) → seamDihedral(G1) → seating → contact
//
// vs the crown set: the CONNECTOR gate is dropped (an inlay/onlay is a single
// unit, never a bridge span — a connector gate would be a vacuous N/A stub), and
// the SEAM-DIHEDRAL gate is added (the G1 boundary-blend acceptance, Task 4's
// flagged "not yet wired into a runInlayQc" item — it consumes the stage-surfaced
// `seamEdges` + `cavityTriangleIndices`). Every other gate is the SAME function
// the crown QC uses.
//
// ## Restoration-type-aware thickness threshold (the NEW selection logic)
//
// The min-wall GATE is reused verbatim (its fail-safe sampling margin included);
// only the THRESHOLD it reads is selected by restoration type:
// `inlayMinThicknessMm` for an inlay, `onlayMinThicknessMm` for an onlay (both
// from the profile via `selectInlayMinThicknessMm`). The isthmus/floor wall of a
// cavity restoration is judged against ONE uniform minimum (not the crown's
// axial/occlusal split), so both the gate's axial and occlusal thresholds are
// set to that value. Task 7 adds the onlay covered-cusp minimum
// (`cuspCoverageMinThicknessMm`) as a region-scoped threshold; this task ships
// the inlay/onlay isthmus minimum.
//
// ## marginFit + seamDihedral measured on the INPUT surfaces (survive assembly)
//
// The margin-fit gate measures the FIT SURFACE (the exact Float64 intaglio that
// was welded into the shell) against the cavity outline; the seam-dihedral gate
// measures the PATCH (the exact adapted occlusal surface) against the tooth.
// Neither is routed through the assembled shell's manifold-3d Float32 cleanup —
// the SAME split `runCrownQc` uses (it measures the inner/outer surfaces, not
// the cleaned solid). Because `constructInlayShell` welds COPIES and never
// mutates its inputs (and the weld keeps every vertex at its exact Float64
// leader position), the Task-3 margin fit and Task-4 seam dihedral are carried
// into the assembled-shell QC run byte-for-byte.
//
// ## Seating semantics for an inlay (verified, carries over from the crown)
//
// `measureSeating(inlaySolid, toothWithCavitySolid)` — the inlay seats INTO the
// cavity pocket, so the "die" is the tooth-with-cavity solid and the
// interference is the die material inside the inlay's walls (inlaySolid ∩ tooth).
// A correctly gapped inlay is offset OUTWARD from the cavity walls by the cement/
// marginal gap, so it sits in the pocket with clearance and there is ZERO
// die-into-wall interference beyond the razor-thin marginal-seal sliver at the
// cavosurface outline — exactly the crown intaglio/die relationship, with the
// roles (restoration ∩ prep) unchanged. The 1e-6 mm³ interference floor (the
// manifold-3d Float32 / seal-sliver noise floor) applies identically.
//
// Determinism / hash-stability / DOM-free — identical to `runCrownQc` (see
// report.ts's module doc).
import { analyzeMesh, type IndexedMesh, type SeamEdge, type Vec3 } from '@dqcad/kernel';
import type { QcReport, RestorationType } from '@dqcad/shared-types';
import { runQcGates, type QcGate } from './runner.ts';
import { watertightGate, manifoldGate } from './watertight.ts';
import { measureSelfIntersection, selfIntersectionGate, type SelfIntersectionMeasurement } from './selfIntersection.ts';
import { minWallThicknessGate } from './minWallThickness.ts';
import { cuspCoverageThicknessGate, type CoverageDivider } from './cuspCoverageThickness.ts';
import { marginFitGate } from './marginFit.ts';
import { seamDihedralGate } from './seamDihedral.ts';
import { measureSeating, seatingGate, type SeatingMeasurement } from './seating.ts';
import { contactGate, type ContactResidualInput } from './contact.ts';

/** Thrown when `selectInlayMinThicknessMm` is asked for a NON-cavity
 * restoration type — the inlay/onlay QC report is only defined for a cavity
 * restoration (a crown/bridge goes through `runCrownQc`). Explicit field + body
 * assignment (NOT a TS constructor parameter property — this module is in the
 * Node worker's strip-only-TS import closure). */
export class NonCavityRestorationTypeError extends Error {
  readonly restorationType: RestorationType;
  constructor(restorationType: RestorationType) {
    super(
      `selectInlayMinThicknessMm: restoration type '${restorationType}' is not a cavity restoration — ` +
        `the inlay/onlay thickness minimum is defined only for 'inlay' / 'onlay' (a crown/bridge uses runCrownQc).`,
    );
    this.name = 'NonCavityRestorationTypeError';
    this.restorationType = restorationType;
  }
}

/** The profile-resolved cavity thickness minimums (mm), passed IN by the caller
 * from the resolved material profile — NEVER defaulted here (CLAUDE.md invariant
 * 7). */
export interface CavityThicknessMinimums {
  readonly inlayMinThicknessMm: number;
  readonly onlayMinThicknessMm: number;
}

/**
 * Restoration-type-aware thickness-threshold SELECTION (the new Task-6 logic):
 * the isthmus/floor minimum wall thickness a cavity restoration is judged
 * against — `inlayMinThicknessMm` for an inlay, `onlayMinThicknessMm` for an
 * onlay. Pure; the value comes from the profile (invariant 7), this only
 * SELECTS which one applies.
 *
 * @throws {NonCavityRestorationTypeError} for a crown/bridge.
 * @throws {TypeError} if the selected minimum is missing/non-finite.
 */
export function selectInlayMinThicknessMm(restorationType: RestorationType, minimums: CavityThicknessMinimums): number {
  let value: number;
  if (restorationType === 'inlay') {
    value = minimums.inlayMinThicknessMm;
  } else if (restorationType === 'onlay') {
    value = minimums.onlayMinThicknessMm;
  } else {
    throw new NonCavityRestorationTypeError(restorationType);
  }
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `selectInlayMinThicknessMm: the ${restorationType} minimum thickness is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile.`,
    );
  }
  return value;
}

export interface RunInlayQcInput {
  /** The finished watertight inlay/onlay solid (Task-6 shell output). */
  readonly inlaySolid: IndexedMesh;
  /** The inlay INNER (fit) surface (Task 3) — for margin-fit + min-wall. The
   * EXACT Float64 surface welded into the shell. */
  readonly fitSurfaceMesh: IndexedMesh;
  /** The inlay OUTER (occlusal patch + adapted proximal faces, Task 4/5) — for
   * min-wall + the seam-dihedral gate. The EXACT Float64 surface welded in. */
  readonly patchMesh: IndexedMesh;
  /** The tooth-with-cavity solid (watertight) — the "die" for the seating
   * simulation AND the surrounding surface for the seam-dihedral gate. */
  readonly toothWithCavitySolid: IndexedMesh;
  /** Confirmed cavity outline dense on-surface polyline (`resampledPoints`). */
  readonly cavityOutlineResampledPoints: readonly Vec3[];
  /** Insertion axis (unit vector). */
  readonly insertionAxis: Vec3;

  /** Which cavity restoration this is — selects the thickness minimum. */
  readonly restorationType: RestorationType;
  /** Profile-resolved cavity thickness minimums (the selection input). */
  readonly thicknessMinimums: CavityThicknessMinimums;

  /** ONLAY covered-cusp coverage (T7). When present AND `restorationType ===
   * 'onlay'`, the region-scoped `cuspCoverageThickness` gate runs: the covered
   * cusp (the half-space on the `coverageDivider`'s positive side) must meet
   * `cuspCoverageMinThicknessMm` (from the profile). Omitted for an inlay (no
   * covered cusp) — the gate is then not in the set. */
  readonly coverage?: {
    readonly coverageDivider: CoverageDivider;
    readonly cuspCoverageMinThicknessMm: number;
  };
  /** Cavity min-wall MARGINAL-TRANSITION band width (mm). An inlay closes along
   * its ENTIRE cavity outline (not a single cervical margin), so the fit-surface
   * ↔ occlusal-patch CONVERGENCE WEDGE — the restoration feathering to the
   * cavosurface margin (the marginal-seal region, governed by `marginFit`) —
   * wraps the whole perimeter. The min-wall gate excludes this band so it
   * measures the STRUCTURAL isthmus/floor bulk, not the marginal wedge (the
   * crown's `marginExclusion` role, sized for the cavity's larger convergence
   * zone — ~one restoration-thickness vs the crown's 0.2 mm finish-line feather).
   * The caller supplies it (a butt-margin occlusal patch would let a smaller
   * band suffice — see Task 6 report). */
  readonly marginExclusionMm: number;

  /** The occlusal SEAM edges (Task 4/5 `seamEdges`) — the G1 gate currency. */
  readonly seamEdges: readonly SeamEdge[];
  /** Cavity-surface triangle indices to exclude when the seam gate
   * disambiguates the surrounding triangle (Task 4/5 `cavityTriangleIndices`). */
  readonly cavityTriangleIndices: ReadonlySet<number> | Uint32Array;

  /** T5 proximal box contact residuals (mapped to the contact-gate currency). */
  readonly contacts: readonly ContactResidualInput[];
  readonly contactClampWarning: boolean;

  // --- optional gate-tolerance / measurement overrides ---
  readonly marginFitThresholdMm?: number;
  readonly seamDihedralThresholdDeg?: number;
  readonly seatingInterferenceVolumeToleranceMm3?: number;
  readonly contactToleranceMm?: number;

  // --- report metadata ---
  readonly kernelVersion: string;
  readonly profileVersion: string;
  readonly journalHash: string;
  readonly acknowledgedGates?: ReadonlySet<string> | readonly string[];
}

interface InlayQcContext {
  readonly input: RunInlayQcInput;
  readonly minThicknessMm: number;
  readonly stats: ReturnType<typeof analyzeMesh>;
  readonly seating: SeatingMeasurement;
  readonly selfIntersection: SelfIntersectionMeasurement;
}

/**
 * Runs the full inlay/onlay QC gate set and assembles the `QcReport`. Async
 * only because two gates use manifold-3d booleans (measured once up front —
 * `measureSeating` on inlay∩tooth and `measureSelfIntersection`); the report
 * itself is a deterministic, hash-stable pure function of the inputs +
 * kernel/manifold-3d version. `onProgress` (if given) is fire-and-forget and
 * affects NO computed value. See this module's doc.
 *
 * @throws {NonCavityRestorationTypeError} if `restorationType` is not a cavity.
 * @throws propagates each gate's own typed errors (e.g. `SeamEdgeNotOnMeshError`).
 */
export async function runInlayQc(input: RunInlayQcInput, onProgress?: (fraction: number) => void): Promise<QcReport> {
  onProgress?.(0);
  const minThicknessMm = selectInlayMinThicknessMm(input.restorationType, input.thicknessMinimums);
  const stats = analyzeMesh(input.inlaySolid);
  onProgress?.(0.1);
  // Async measurements (WASM) taken once, up front. Seating: die = tooth-with-
  // cavity (the inlay seats INTO the pocket — see this module's doc).
  const seating = await measureSeating(input.inlaySolid, input.toothWithCavitySolid);
  onProgress?.(0.4);
  const selfIntersection = await measureSelfIntersection(input.inlaySolid);
  onProgress?.(0.6);

  const baseGates: readonly QcGate<InlayQcContext>[] = [
    (c) => watertightGate({ stats: c.stats }),
    (c) => manifoldGate({ stats: c.stats }),
    (c) => selfIntersectionGate({ measurement: c.selfIntersection, restorationLabel: c.input.restorationType }),
    (c) =>
      minWallThicknessGate({
        innerSurfaceMesh: c.input.fitSurfaceMesh,
        outerSurfaceMesh: c.input.patchMesh,
        // A cavity restoration's isthmus/floor wall is judged against ONE
        // uniform minimum — both thresholds set to the selected inlay/onlay min.
        minWallThicknessMm: c.minThicknessMm,
        occlusalMinWallThicknessMm: c.minThicknessMm,
        insertionAxis: c.input.insertionAxis,
        marginResampledPoints: c.input.cavityOutlineResampledPoints,
        marginExclusionMm: c.input.marginExclusionMm,
      }),
    (c) =>
      marginFitGate({
        innerSurfaceMesh: c.input.fitSurfaceMesh,
        marginResampledPoints: c.input.cavityOutlineResampledPoints,
        thresholdMm: c.input.marginFitThresholdMm,
      }),
    (c) =>
      seamDihedralGate({
        patchMesh: c.input.patchMesh,
        toothMesh: c.input.toothWithCavitySolid,
        seamEdges: c.input.seamEdges,
        cavityTriangleIndices: c.input.cavityTriangleIndices,
        thresholdDeg: c.input.seamDihedralThresholdDeg,
      }),
    (c) => seatingGate({ measurement: c.seating, interferenceVolumeToleranceMm3: c.input.seatingInterferenceVolumeToleranceMm3 }),
    (c) => contactGate({ contacts: c.input.contacts, contactClampWarning: c.input.contactClampWarning, toleranceMm: c.input.contactToleranceMm }),
  ];

  // T7: the ONLAY covered-cusp region-scoped gate runs directly AFTER the body
  // min-wall gate, only for an onlay carrying coverage info.
  const coverage = input.restorationType === 'onlay' ? input.coverage : undefined;
  const gateSet: readonly QcGate<InlayQcContext>[] = coverage
    ? [
        ...baseGates.slice(0, 4), // watertight, manifold, selfIntersection, minWallThickness
        (c) =>
          cuspCoverageThicknessGate({
            fitSurfaceMesh: c.input.fitSurfaceMesh,
            patchMesh: c.input.patchMesh,
            insertionAxis: c.input.insertionAxis,
            marginResampledPoints: c.input.cavityOutlineResampledPoints,
            marginExclusionMm: c.input.marginExclusionMm,
            coverageDivider: coverage.coverageDivider,
            cuspCoverageMinThicknessMm: coverage.cuspCoverageMinThicknessMm,
          }),
        ...baseGates.slice(4), // marginFit, seamDihedral, seating, contact
      ]
    : baseGates;

  const total = gateSet.length;
  const gates: readonly QcGate<InlayQcContext>[] = gateSet.map((gate, i) => (c: InlayQcContext) => {
    const result = gate(c);
    onProgress?.(0.6 + (0.4 * (i + 1)) / total);
    return result;
  });

  const context: InlayQcContext = { input, minThicknessMm, stats, seating, selfIntersection };
  const report = runQcGates(context, gates, {
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    acknowledgedGates: input.acknowledgedGates,
  });
  onProgress?.(1);
  return report;
}
