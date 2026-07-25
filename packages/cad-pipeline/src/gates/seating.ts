// packages/cad-pipeline/src/gates/seating.ts
//
// Phase 4 Task 9: the SEATING-SIMULATION QC gate — the §6 seating gate. It
// simulates seating the finished crown solid onto the prep die and measures how
// much die material ends up INSIDE the crown's solid (its walls) — i.e. how far
// the die penetrates past the intaglio into the wall material. A correctly
// designed crown has an intaglio offset OUTWARD from the die by the cement/
// marginal gap, so the die sits in the cavity with an air gap and there is ZERO
// die-into-wall interference: penetration ≈ 0.
//
// ## Method — the manifold-3d wrapper's intersect + volume (exact)
//
// The crown solid and the prep die are already in the SAME design frame (the
// crown was constructed ON this die — the inner surface is the die offset by the
// gap), so seating along the insertion axis is the in-place configuration; no
// re-positioning is needed (the design frame already has the crown seated). The
// interference is therefore the boolean INTERSECTION of the two solids:
//
//     interference = crownSolid ∩ die            (boolean/manifold.ts `intersect`)
//     penetration  = volume(interference)  mm³   (boolean/manifold.ts `volume`)
//
// Both go through the kernel's `boolean/manifold.ts` wrapper (repair-before-
// boolean: both inputs must be watertight 2-manifolds — the shell already is; the
// die is the intake-repaired prep solid). The measurement is EXACT for a fixed
// manifold-3d version (WASM determinism) — a disjoint pair yields an empty
// intersection and volume 0; an overlapping pair yields the exact overlap volume.
//
// ## Why the measure is an interference VOLUME (mm³), and its threshold
//
// `intersect + volume` yields a VOLUME. That is the truthful, exact quantity the
// wrapper produces; converting it to a single "depth" would need an additional
// approximate distance query and is deliberately NOT done here (accuracy over
// speed — we report the exact number the boolean gives). The gate value is thus
// the interference volume in mm³.
//
// The pass bar is `penetration ≤ interference tolerance`. A correctly seated
// crown eats into NO wall, but the interference is NOT identically zero: the
// crown SEATS TO the margin, so the crown solid's cervical rim COINCIDES with the
// die's margin rim (the marginal seal — the crown is SUPPOSED to contact the die
// there). That shared finish-line edge, plus the manifold-3d Float32 WASM boundary
// (`boolean/manifold.ts` @errorBound: ~1.2e-7 relative), yields a razor-thin
// SEAL sliver — die material that is inside the crown only in the marginal-seal
// band, NOT die penetrating the walls "beyond the marginal seal" (the brief's
// distinction).
//
// ### @errorBound — the seal/Float32 noise floor (the default tolerance)
//
// The spurious seal-band interference is bounded by (marginal-seal band area) ×
// (manifold-3d absolute coordinate error). At the few-mm dental working scale the
// Float32 absolute coordinate error is ≈ 3 mm × 1.2e-7 ≈ 4e-7 mm; a margin-seal
// band is at most O(2 mm²) (perimeter ~ 2π·1.5 mm × blend width ~0.3 mm), so the
// artifact volume is bounded by ≈ 2 mm² × 4e-7 mm ≈ 1e-6 mm³. That is the
// `SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3` default below. It cleanly separates
// artifact from defect: measured seal slivers observed on real synthetic crowns
// are ~1e-8 mm³ (≈ 100× below the floor), while genuine wall penetration is
// orders of magnitude LARGER — a 50 µm over-seat over even 1 mm² is 5e-5 mm³
// (50× ABOVE the floor). So the floor never hides clinically meaningful
// penetration (the DANGEROUS direction), it only absorbs the seal/Float32 noise.
//
// This is a MEASUREMENT ERROR BOUND surfaced per CLAUDE.md ("the error bound must
// be documented in code and surfaced in the QC report") — NOT a weakened clinical
// threshold and NOT a clinical design default (gaps/thicknesses stay in the
// profile, invariant 7); it is on the same "gate/measurement constant" footing as
// `marginFit.ts`'s fixed 10 µm bar and `minWallThickness.ts`'s sampling margin.
// It is a VOLUME (mm³), distinct from the marginal-seal GAP length
// (`marginalGapMm`, a marginal-fit distance owned by the `marginFit` gate) — the
// two must not be conflated. Overridable per-call.
//
// ## Fail-safe
//
// If either solid is not watertight, the wrapper rejects the boolean
// (`NonManifoldInputError`); rather than crash or silently pass, the measurement
// reports `seatable: false` and the gate FAILS (an unverifiable seating is not a
// passing seating — CLAUDE.md invariant 4). Pure split: the async boolean is the
// `measureSeating` step (run once by the report assembly); `seatingGate` itself is
// a pure synchronous `(measurement) => QcGateResult`. DOM/Three-free (invariant 6).
import { intersect, volume, NonManifoldInputError, type IndexedMesh } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const SEATING_GATE_NAME = 'seating';

/** Default interference tolerance (mm³): the manifold-3d Float32 / marginal-seal
 * NOISE FLOOR — a correctly seated crown has zero WALL penetration but a
 * razor-thin marginal-SEAL sliver where its rim meets the die. Derived (not
 * tuned): (seal band ~2 mm²) × (Float32 abs coord error ~4e-7 mm) ≈ 1e-6 mm³.
 * This is a measurement error bound (surfaced in the report), NOT a clinical
 * default; genuine wall penetration is orders of magnitude above it. Overridable. */
export const SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3 = 1e-6;

export interface SeatingMeasurement {
  /** Volume (mm³) of die material inside the crown's walls (crownSolid ∩ die).
   * 0 for a correctly gapped, well-seated crown. `Infinity` when unseatable. */
  readonly interferenceVolumeMm3: number;
  /** True iff the boolean succeeded (both inputs watertight). False → the
   * seating could not be verified (fail-safe: the gate fails). */
  readonly seatable: boolean;
  /** True iff the intersection was empty (no die material in any wall). */
  readonly empty: boolean;
  /** manifold-3d rejection status when `seatable` is false, else null. */
  readonly rejectionStatus: string | null;
}

/**
 * Simulates seating `crownSolid` onto `dieSolid` and measures the die-into-wall
 * interference volume via the manifold-3d wrapper (`intersect` then `volume`).
 * Async (WASM); deterministic for a fixed manifold-3d version. Never throws for
 * a clinical/geometry failure — a non-watertight input yields
 * `{ seatable: false, interferenceVolumeMm3: Infinity }` (fail-safe).
 */
export async function measureSeating(crownSolid: IndexedMesh, dieSolid: IndexedMesh): Promise<SeatingMeasurement> {
  try {
    const interference = await intersect(crownSolid, dieSolid);
    // An empty intersection carries no triangles — its volume is exactly 0; skip
    // reconstructing an empty manifold and report 0 directly.
    const interferenceVolumeMm3 = interference.indices.length === 0 ? 0 : await volume(interference);
    return {
      interferenceVolumeMm3,
      seatable: true,
      empty: interference.indices.length === 0,
      rejectionStatus: null,
    };
  } catch (error) {
    if (error instanceof NonManifoldInputError) {
      return { interferenceVolumeMm3: Number.POSITIVE_INFINITY, seatable: false, empty: false, rejectionStatus: error.status };
    }
    throw error;
  }
}

export interface SeatingGateInput {
  readonly measurement: SeatingMeasurement;
  /** Allowed die-into-wall interference volume (mm³). Default
   * `SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3` (1e-6 mm³ — a derived Float32/
   * seal-sliver measurement-noise floor, NOT zero; see that constant's doc for
   * the derivation). Overridable per-call. */
  readonly interferenceVolumeToleranceMm3?: number;
}

/**
 * The seating-simulation QC gate — passes iff the crown seats on the die with
 * die-into-wall interference volume ≤ the tolerance (default
 * `SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3` = 1e-6 mm³, the derived
 * measurement-noise floor — NOT zero). Value = the interference volume (mm³);
 * threshold = the tolerance. Pure/deterministic; Node- and worker-callable.
 */
export function seatingGate(input: SeatingGateInput): QcGateResult {
  const tolerance = input.interferenceVolumeToleranceMm3 ?? SEATING_DEFAULT_INTERFERENCE_VOLUME_MM3;
  const m = input.measurement;
  const fmt = (mm3: number): string => (Number.isFinite(mm3) ? `${mm3.toExponential(3)} mm³` : '∞');
  if (!m.seatable) {
    return {
      gate: SEATING_GATE_NAME,
      passed: false,
      acknowledged: false,
      value: null,
      threshold: tolerance,
      unit: 'mm³',
      message: `seating UNVERIFIABLE — the boolean rejected an input (status ${m.rejectionStatus ?? 'unknown'}); ` +
        'both the crown solid and the prep die must be watertight (repair first). Fail-safe: an unverifiable seating does not pass.',
    };
  }
  const passed = m.interferenceVolumeMm3 <= tolerance;
  return {
    gate: SEATING_GATE_NAME,
    passed,
    acknowledged: false,
    value: m.interferenceVolumeMm3,
    threshold: tolerance,
    unit: 'mm³',
    message: passed
      ? `seats cleanly — die-into-wall interference ${m.empty ? '0 (empty intersection)' : fmt(m.interferenceVolumeMm3)} ≤ ${fmt(tolerance)} tolerance ` +
        '(≤ the marginal-seal / manifold-3d Float32 noise floor — no penetration beyond the seal)'
      : `seating INTERFERENCE ${fmt(m.interferenceVolumeMm3)} > ${fmt(tolerance)} tolerance — the die penetrates the crown walls ` +
        '(intaglio under-gapped or over-seated); the crown will not seat to the margin',
  };
}
