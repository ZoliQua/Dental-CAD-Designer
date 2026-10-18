// apps/server/src/stand-in-provenance.testutil.ts
//
// ADR-022 (Phase 9 Task 1) for the EXPORT suites. The export harness persists
// a case document with NO scans (`scene: []`), so — relative to that saved
// case — the closed-form neighbour / antagonist boxes the crown and cavity
// fixtures measured contacts against (and the onlay's fixed coverage divider)
// are not case-derived. The server refuses an untraceable `case` claim
// (export-provenance.ts), so these suites declare the stand-ins honestly:
// every contact and the coverage divider are tagged `placeholder`, which
// fails the contact / covered-cusp gates closed, and those gates are
// acknowledged (the harness journals one ack op per acknowledged gate) —
// exactly what a clinician must do in the real client until neighbour capture
// lands (Phase 9 Task 3). The validate-qc dual-validation suites keep the
// untagged fixtures: there the fixture IS the case under test.
import type { ContactResidualInput, CoverageDivider } from '@dqcad/cad-pipeline';
import type { GeometryProvenance } from '@dqcad/shared-types';

interface StandInInput {
  readonly contacts: readonly ContactResidualInput[];
  readonly coverage?: {
    readonly coverageDivider: CoverageDivider;
    readonly cuspCoverageMinThicknessMm: number;
    readonly dividerProvenance?: GeometryProvenance;
  };
  readonly acknowledgedGates?: ReadonlySet<string> | readonly string[];
}

/** The gates a declared stand-in fails closed (and the suites acknowledge). */
export function standInGates(input: StandInInput): string[] {
  return input.coverage === undefined ? ['contact'] : ['cuspCoverageThickness', 'contact'];
}

/** Tags every contact (and the coverage divider) `placeholder` and adds the
 * fail-closed gates to `acknowledgedGates`. */
export function declareStandIns<T extends StandInInput>(input: T): T {
  const acknowledged = new Set<string>(input.acknowledgedGates ?? []);
  for (const gate of standInGates(input)) acknowledged.add(gate);
  return {
    ...input,
    contacts: input.contacts.map((c) => ({ ...c, provenance: 'placeholder' as const })),
    ...(input.coverage === undefined
      ? {}
      : { coverage: { ...input.coverage, dividerProvenance: 'placeholder' as const } }),
    acknowledgedGates: [...acknowledged],
  };
}
