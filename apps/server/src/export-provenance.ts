// apps/server/src/export-provenance.ts
//
// ADR-022 (Phase 9 Task 1) — the server half of "design inputs come from the
// case". The contact and cusp-coverage gates fail closed on a non-`case`
// input, and the export re-validation re-runs them with the provenance that
// rides in the qcContext. That alone would let a client simply CLAIM `case`
// (or omit the field, which means `case`) for a stand-in — so before any gate
// runs, every `case` claim must be backed by the SAVED case document:
//
//  - antagonist contact → the case has an `antagonist`-role scan node;
//  - proximal (mesial/distal) contact → there is NO case-derived neighbour
//    source yet (neighbour capture from the arch scan, with its journaled
//    scan hash + pick points, is Phase 9 Task 3), so a `case` claim cannot be
//    traced and is refused;
//  - onlay coverage divider → no case-derived divider source exists (the
//    cusp watershed is not decided by ADR-022), so a `case` claim is refused.
//
// Non-`case` claims are always accepted here: they make the gate fail closed,
// which can only tighten the release (acknowledgment stays journaled).
// The bridge branch is out of scope until its real-geometry path lands
// (Phase 9 Task 6) — its whole workflow is the disclosed ADR-014 demo.
import type { CaseDocument, GeometryProvenance } from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';

interface ProvenanceContact {
  kind: string;
  provenance?: GeometryProvenance;
}

interface ProvenanceContext {
  contacts?: readonly ProvenanceContact[];
  coverage?: { dividerProvenance?: GeometryProvenance };
  units?: unknown;
}

const PROXIMAL_KINDS = new Set(['proximalMesial', 'proximalDistal']);

function claimsCase(provenance: GeometryProvenance | undefined): boolean {
  return provenance === undefined || provenance === 'case';
}

/** One untraceable claim, for the rejection diagnostics. */
export interface UntraceableClaim {
  input: string;
  reason: string;
}

/** Every `case` provenance claim in `ctx` the saved `document` cannot back.
 * Pure; empty ⇒ traceable. */
export function untraceableProvenanceClaims(
  ctx: ProvenanceContext,
  document: CaseDocument,
): UntraceableClaim[] {
  if (ctx.units !== undefined) return []; // bridge — Phase 9 Task 6
  const claims: UntraceableClaim[] = [];
  const hasAntagonistScan = document.scene.some((node) => node.role === 'antagonist');
  for (const contact of ctx.contacts ?? []) {
    if (!claimsCase(contact.provenance)) continue;
    if (contact.kind === 'antagonist') {
      if (!hasAntagonistScan) {
        claims.push({
          input: 'contact:antagonist',
          reason: 'the case has no antagonist-role scan',
        });
      }
    } else if (PROXIMAL_KINDS.has(contact.kind)) {
      claims.push({
        input: `contact:${contact.kind}`,
        reason: 'the case records no neighbour capture',
      });
    } else {
      claims.push({ input: `contact:${contact.kind}`, reason: 'unknown contact kind' });
    }
  }
  if (ctx.coverage !== undefined && claimsCase(ctx.coverage.dividerProvenance)) {
    claims.push({
      input: 'coverage:divider',
      reason: 'the case records no case-derived coverage divider',
    });
  }
  return claims;
}

/** @throws {ExportRejectionError} 409 `export-untraceable-provenance`. */
export function assertTraceableProvenance(ctx: ProvenanceContext, document: CaseDocument): void {
  const claims = untraceableProvenanceClaims(ctx, document);
  if (claims.length === 0) return;
  throw new ExportRejectionError(
    'export-untraceable-provenance',
    409,
    `the qcContext claims case-derived geometry the saved case cannot back: ` +
      claims.map((c) => `${c.input} (${c.reason})`).join('; ') +
      ` — declare the stand-in's provenance (ADR-022); its gate then fails closed and can be acknowledged`,
    { claims },
  );
}
