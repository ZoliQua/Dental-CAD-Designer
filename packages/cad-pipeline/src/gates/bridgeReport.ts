// packages/cad-pipeline/src/gates/bridgeReport.ts
//
// Phase 6 Task 6 — the WHOLE-BRIDGE QC-REPORT assembly. `runBridgeQc` is the
// bridge analogue of `runCrownQc` / `runInlayQc`: it gathers every gate input for
// the assembled bridge solid (some via async manifold-3d booleans), runs the
// ordered gate set through the deterministic `runQcGates` runner, and returns one
// `QcReport` ready to store on the bridge's `qc` field.
//
// ## The gate set + order
//
//   watertight → manifold → selfIntersection(proxy)
//   → minWallThickness:<unit> (one PER UNIT, mode-aware)
//   → connectorCrossSection (all connectors)
//   → marginFit:<abutment> (one PER ABUTMENT, RE-MEASURED on the assembled solid)
//   → ponticRelief (±20 µm)
//   → seating (the whole bridge onto both dies)
//
// vs the crown set: min-wall + margin-fit are run PER UNIT / PER ABUTMENT (a bridge
// has multiple units and multiple margins — each judged on its own, gate names
// suffixed `:<label>` so the runner's unique-name rule holds and the report shows
// every unit), the connector gate carries REAL per-connector measurements (not the
// single-crown N/A stub), and the NEW `ponticRelief` gate rides along.
//
// ## Per-unit thickness — the region attribution (documented)
//
// The min-wall gate measures each unit's OWN inner (fit) + outer (anatomy) surfaces
// — the cut-back unit surfaces as they stand PRE-union. This is the correct, and
// CONSERVATIVE, attribution for the assembled solid: a boolean UNION only ADDS
// connector material (it never removes wall), so the assembled solid's wall at any
// unit is ≥ the pre-union unit wall the gate measures. Measuring the pre-union
// surfaces therefore never OVER-reports thickness (the patient-safety direction),
// and it avoids re-deriving inner/outer surfaces from the re-tessellated union
// output — the same "measure the exact input surfaces, not the cleaned solid" split
// `runCrownQc`/`runInlayQc` use for their thickness + margin gates. `frameworkMode`
// switches every unit's thresholds to the single framework minimum (Task 5).
//
// ## Per-abutment margin fit — RE-MEASURED on the assembled solid (survive-assembly)
//
// Unlike thickness, the margin fit is RE-MEASURED on the ASSEMBLED solid: the union
// passes the intaglio + its margin rim through the manifold-3d Float32 WASM
// boundary (`boolean/manifold.ts` @errorBound), and the acceptance requires the rim
// to survive ≤ 10 µm. `extractFitPatch(assembledSolid, fitRegion)` selects each
// abutment's intaglio patch off the FUSED solid (by the unit's known cavity region
// — construction provenance, see bridgeAssembly.ts's doc on why a per-vertex mask
// cannot be carried through the union), and `marginFitGate` measures its boundary
// rim against the confirmed margin polyline. The caller compares this to the
// pre-union number to REPORT the survive-assembly delta (the acceptance test does).
//
// ## Seating — the whole bridge onto both dies
//
// The abutment dies are fused (`union`) into one "dies" solid and
// `measureSeating(assembledSolid, dies)` measures die-into-wall interference for the
// whole bridge seating along the shared axis — the P4 seating semantics, expected
// ≈ clean on the parallel fixture (each intaglio is offset outward from its die).
//
// Determinism / hash-stability / DOM-free — identical to `runCrownQc` (the report
// carries NO timestamp; it is journalHash/version-addressed).
import { analyzeMesh, extractFitPatch, union, type IndexedMesh, type Vec3, type FitRegionDescriptor } from '@dqcad/kernel';
import type { QcReport } from '@dqcad/shared-types';
import { runQcGates, type QcGate } from './runner.ts';
import { watertightGate, manifoldGate } from './watertight.ts';
import { measureSelfIntersection, selfIntersectionGate, type SelfIntersectionMeasurement } from './selfIntersection.ts';
import { minWallThicknessGate } from './minWallThickness.ts';
import { marginFitGate } from './marginFit.ts';
import { measureSeating, seatingGate, type SeatingMeasurement } from './seating.ts';
import { connectorCrossSectionGate, type ConnectorCrossSection } from './connectorCrossSection.ts';
import { ponticReliefGate } from './ponticRelief.ts';

/** Thrown when a bridge QC input is structurally invalid (no units, no dies).
 * Explicit field + body assignment (NOT a TS ctor parameter property). */
export class BridgeQcInputError extends Error {
  constructor(message: string) {
    super(`runBridgeQc: ${message}`);
    this.name = 'BridgeQcInputError';
  }
}

/** One unit's thickness + (for abutments) margin-fit inputs. */
export interface BridgeUnitQcInput {
  /** Unit label (e.g. "14", "15", "16") — suffixes the per-unit gate names. */
  readonly label: string;
  readonly kind: 'abutment' | 'pontic';
  /** The unit's INNER (fit) surface — for min-wall. */
  readonly innerSurfaceMesh: IndexedMesh;
  /** The unit's OUTER (anatomy) surface — for min-wall. */
  readonly outerSurfaceMesh: IndexedMesh;
  /** This unit's insertion axis (classifies occlusal vs axial walls). */
  readonly insertionAxis: Vec3;
  /** The unit's margin polyline (dense resampled) — margin-band exclusion for
   * min-wall AND (abutments) the marginFit currency. */
  readonly marginLoop: readonly Vec3[];
  /** Margin-band exclusion (mm) for the min-wall gate. */
  readonly marginExclusionMm?: number;
  /** The intaglio fit-region descriptor — REQUIRED for an abutment (the marginFit
   * gate extracts the patch off the assembled solid with it); omitted for a pontic. */
  readonly fitRegion?: FitRegionDescriptor;
}

export interface RunBridgeQcInput {
  /** The fused watertight bridge solid (`assembleBridge` output). */
  readonly assembledSolid: IndexedMesh;
  /** Every unit (abutments + pontic), in arch order. */
  readonly units: readonly BridgeUnitQcInput[];
  /** The abutment prep dies (each watertight) — fused for the seating simulation. */
  readonly dieSolids: readonly IndexedMesh[];
  /** The measured connectors (kernel `measureConnectorMinArea` → per-connector
   * min area + positional target) — the T4 connector-area gate currency. */
  readonly connectors: readonly ConnectorCrossSection[];

  // --- profile-resolved clinical thresholds (from the material profile) ---
  readonly minWallThicknessMm: number;
  readonly occlusalMinWallThicknessMm: number;
  readonly connectorAreaTargetMm2: number;
  /** Framework mode — every unit judged against the single framework minimum. */
  readonly frameworkMode?: boolean;
  readonly frameworkMinThicknessMm?: number;

  // --- pontic relief (Task 3 measurement → the ±20 µm gate) ---
  readonly ponticRelief: {
    readonly maxAbsDeviationMm: number;
    readonly style: string;
    readonly configuredReliefMm: number;
    readonly thresholdMm?: number;
  };

  // --- optional gate-tolerance overrides ---
  readonly marginFitThresholdMm?: number;
  readonly seatingInterferenceVolumeToleranceMm3?: number;

  // --- report metadata ---
  readonly kernelVersion: string;
  readonly profileVersion: string;
  readonly journalHash: string;
  readonly acknowledgedGates?: ReadonlySet<string> | readonly string[];
}

interface BridgeQcContext {
  readonly input: RunBridgeQcInput;
  readonly stats: ReturnType<typeof analyzeMesh>;
  readonly selfIntersection: SelfIntersectionMeasurement;
  readonly seating: SeatingMeasurement;
  /** Per-abutment extracted assembled-solid intaglio patch, keyed by label. */
  readonly abutmentFitPatches: ReadonlyMap<string, IndexedMesh>;
}

/** Rename a gate result's `gate` (for the per-unit / per-abutment suffixing). */
function withName(result: ReturnType<QcGate<BridgeQcContext>>, name: string): ReturnType<QcGate<BridgeQcContext>> {
  return { ...result, gate: name };
}

/**
 * Runs the full whole-bridge QC gate set and assembles the `QcReport`. Async only
 * because several gates use manifold-3d booleans (measured once up front — the
 * self-intersection probe + the seating intersect + the dies union); the report
 * itself is a deterministic, hash-stable pure function of its inputs +
 * kernel/manifold-3d version. `onProgress` (if given) is fire-and-forget.
 *
 * @throws {BridgeQcInputError} for no units / no dies.
 * @throws propagates each gate's own typed errors.
 */
export async function runBridgeQc(input: RunBridgeQcInput, onProgress?: (fraction: number) => void): Promise<QcReport> {
  onProgress?.(0);
  if (input.units.length === 0) throw new BridgeQcInputError('no units supplied');
  if (input.dieSolids.length === 0) throw new BridgeQcInputError('no dies supplied (seating needs at least one abutment die)');

  const stats = analyzeMesh(input.assembledSolid);
  onProgress?.(0.1);
  const selfIntersection = await measureSelfIntersection(input.assembledSolid);
  onProgress?.(0.3);
  // Fuse the dies, then measure whole-bridge seating.
  let dies = input.dieSolids[0]!;
  for (let i = 1; i < input.dieSolids.length; i++) dies = await union(dies, input.dieSolids[i]!);
  const seating = await measureSeating(input.assembledSolid, dies);
  onProgress?.(0.5);

  // Per-abutment intaglio patches off the ASSEMBLED solid (survive-assembly).
  const abutmentFitPatches = new Map<string, IndexedMesh>();
  for (const unit of input.units) {
    if (unit.kind === 'abutment') {
      if (!unit.fitRegion) throw new BridgeQcInputError(`abutment "${unit.label}" has no fitRegion (needed to re-measure margin fit on the assembled solid)`);
      abutmentFitPatches.set(unit.label, extractFitPatch(input.assembledSolid, unit.fitRegion));
    }
  }
  onProgress?.(0.6);

  const gates: QcGate<BridgeQcContext>[] = [
    (c) => watertightGate({ stats: c.stats }),
    (c) => manifoldGate({ stats: c.stats }),
    (c) => selfIntersectionGate({ measurement: c.selfIntersection, restorationLabel: 'bridge' }),
  ];

  // Per-unit min-wall thickness (mode-aware) — one gate per unit.
  for (const unit of input.units) {
    gates.push((c) =>
      withName(
        minWallThicknessGate({
          innerSurfaceMesh: unit.innerSurfaceMesh,
          outerSurfaceMesh: unit.outerSurfaceMesh,
          minWallThicknessMm: c.input.minWallThicknessMm,
          occlusalMinWallThicknessMm: c.input.occlusalMinWallThicknessMm,
          insertionAxis: unit.insertionAxis,
          marginResampledPoints: unit.marginLoop,
          marginExclusionMm: unit.marginExclusionMm,
          frameworkMode: c.input.frameworkMode,
          frameworkMinThicknessMm: c.input.frameworkMinThicknessMm,
        }),
        `minWallThickness:${unit.label}`,
      ),
    );
  }

  // The connector-area gate (all connectors).
  gates.push((c) => connectorCrossSectionGate({ connectorAreaTargetMm2: c.input.connectorAreaTargetMm2, connectors: c.input.connectors }));

  // Per-abutment margin fit, RE-MEASURED on the assembled solid.
  for (const unit of input.units) {
    if (unit.kind !== 'abutment') continue;
    gates.push((c) =>
      withName(
        marginFitGate({
          innerSurfaceMesh: c.abutmentFitPatches.get(unit.label)!,
          marginResampledPoints: unit.marginLoop,
          thresholdMm: c.input.marginFitThresholdMm,
        }),
        `marginFit:${unit.label}`,
      ),
    );
  }

  // Pontic relief (±20 µm) + whole-bridge seating.
  gates.push((c) =>
    ponticReliefGate({
      maxAbsDeviationMm: c.input.ponticRelief.maxAbsDeviationMm,
      style: c.input.ponticRelief.style,
      configuredReliefMm: c.input.ponticRelief.configuredReliefMm,
      thresholdMm: c.input.ponticRelief.thresholdMm,
    }),
  );
  gates.push((c) => seatingGate({ measurement: c.seating, interferenceVolumeToleranceMm3: c.input.seatingInterferenceVolumeToleranceMm3 }));

  const total = gates.length;
  const wrapped: QcGate<BridgeQcContext>[] = gates.map((gate, i) => (c: BridgeQcContext) => {
    const result = gate(c);
    onProgress?.(0.6 + (0.4 * (i + 1)) / total);
    return result;
  });

  const context: BridgeQcContext = { input, stats, selfIntersection, seating, abutmentFitPatches };
  const report = runQcGates(context, wrapped, {
    kernelVersion: input.kernelVersion,
    profileVersion: input.profileVersion,
    journalHash: input.journalHash,
    acknowledgedGates: input.acknowledgedGates,
  });
  onProgress?.(1);
  return report;
}
