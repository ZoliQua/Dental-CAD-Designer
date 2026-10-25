// apps/server/src/export-provenance.ts
//
// ADR-022 (Phase 9 Task 1) — the server half of "design inputs come from the
// case". The contact and cusp-coverage gates fail closed on a non-`case`
// input, and the export re-validation re-runs them with the provenance that
// rides in the qcContext. That alone would let a client simply CLAIM `case`
// (or omit the field, which means `case`) for a stand-in — so before any gate
// runs, every `case` claim must be backed by the SAVED case document:
//
//  - antagonist contact → the case has an `antagonist`-role scan node, or the
//    journal holds the user's confirmation of an opposite-arch scan for THIS
//    restoration (`ANTAGONIST_CONFIRM_OP`) whose scan is still in the case;
//  - proximal (mesial/distal) contact → the journal holds a neighbour capture
//    of THAT side for THIS restoration (`NEIGHBOUR_CAPTURE_OP`, Phase 9 Task
//    3) taken from an arch scan (upper/lower jaw) still in the case, same
//    mesh (`inputHashes[0]` = the scan's mesh id);
//  - onlay coverage divider → no case-derived divider source exists (the
//    cusp watershed is not decided by ADR-022), so a `case` claim is refused.
//
// Non-`case` claims are always accepted here: they make the gate fail closed,
// which can only tighten the release (acknowledgment stays journaled).
//
//  - bridge (Phase 9 Task 6) → the ops that sealed the restoration's CURRENT
//    abutment-surfaces and pontic stages (`outputHashes[0]` = the saved stage
//    hash) were built from the case (`params.geometrySource === 'case'`): the
//    abutment op from the restoration's target scan, still in the case, same
//    mesh; the pontic op from a gingiva-role scan still in the case. The
//    demonstration bridge declares `demo-fixture` and fails closed instead.
import {
  ANTAGONIST_CONFIRM_OP,
  BRIDGE_ABUTMENT_SURFACES_OP,
  BRIDGE_PONTIC_OP,
  NEIGHBOUR_CAPTURE_OP,
  type CaseDocument,
  type GeometryProvenance,
  type Operation,
} from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';

interface ProvenanceContact {
  kind: string;
  provenance?: GeometryProvenance;
}

interface ProvenanceContext {
  contacts?: readonly ProvenanceContact[];
  coverage?: { dividerProvenance?: GeometryProvenance };
  units?: unknown;
  geometryProvenance?: GeometryProvenance;
}

const PROXIMAL_SIDES: Readonly<Record<string, string>> = {
  proximalMesial: 'mesial',
  proximalDistal: 'distal',
};

const ARCH_ROLES = new Set(['upperJaw', 'lowerJaw']);

/** Whether `op` names a scan still in the case, with the same mesh, whose
 * role is an arch scan. */
function fromArchScanInCase(op: Operation, document: CaseDocument): boolean {
  const node = document.scene.find((n) => n.id === op.params['scanNodeId']);
  return node !== undefined && ARCH_ROLES.has(node.role) && node.meshId === op.inputHashes[0];
}

function hasCaseOp(
  document: CaseDocument,
  name: string,
  restorationId: string,
  side: string | null,
): boolean {
  return (document.history ?? []).some(
    (op) =>
      op.name === name &&
      op.params['restorationId'] === restorationId &&
      (side === null || op.params['side'] === side) &&
      fromArchScanInCase(op, document),
  );
}

function claimsCase(provenance: GeometryProvenance | undefined): boolean {
  return provenance === undefined || provenance === 'case';
}

/** The op that sealed `stageHash` for this restoration (the latest match). */
function sealingOp(document: CaseDocument, name: string, restorationId: string, stageHash: string | undefined): Operation | undefined {
  if (stageHash === undefined) return undefined;
  const history = document.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const op = history[i]!;
    if (op.name === name && op.params['restorationId'] === restorationId && op.outputHashes[0] === stageHash) return op;
  }
  return undefined;
}

/** A bridge's `case` claim: its current abutment and pontic stages were
 * built from this case's scans (see this module's doc). */
function bridgeClaims(document: CaseDocument, restorationId: string): UntraceableClaim[] {
  const restoration = document.restorations.find((r) => r.id === restorationId);
  const claims: UntraceableClaim[] = [];
  const abutments = sealingOp(document, BRIDGE_ABUTMENT_SURFACES_OP, restorationId, restoration?.stages.bridgeAbutmentSurfaces);
  const target = document.scene.find((n) => n.id === restoration?.targetNodeId);
  if (!abutments || abutments.params['geometrySource'] !== 'case' || !target || target.meshId !== abutments.inputHashes[0]) {
    claims.push({
      input: 'bridge:abutmentSurfaces',
      reason: "the case records no abutment surfaces built from the restoration's target scan",
    });
  }
  const pontic = sealingOp(document, BRIDGE_PONTIC_OP, restorationId, restoration?.stages.bridgePontic);
  const gingiva = pontic
    ? document.scene.find((n) => n.role === 'gingiva' && n.meshId === pontic.inputHashes[0])
    : undefined;
  if (!pontic || pontic.params['geometrySource'] !== 'case' || !gingiva) {
    claims.push({ input: 'bridge:pontic', reason: "the case records no pontic shaped on one of its gingiva scans" });
  }
  return claims;
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
  restorationId: string,
): UntraceableClaim[] {
  if (ctx.units !== undefined) return claimsCase(ctx.geometryProvenance) ? bridgeClaims(document, restorationId) : [];
  const claims: UntraceableClaim[] = [];
  const hasAntagonistScan = document.scene.some((node) => node.role === 'antagonist');
  for (const contact of ctx.contacts ?? []) {
    if (!claimsCase(contact.provenance)) continue;
    if (contact.kind === 'antagonist') {
      if (!hasAntagonistScan && !hasCaseOp(document, ANTAGONIST_CONFIRM_OP, restorationId, null)) {
        claims.push({
          input: 'contact:antagonist',
          reason: 'the case has no antagonist-role scan and no confirmed opposite-arch antagonist',
        });
      }
    } else if (PROXIMAL_SIDES[contact.kind] !== undefined) {
      if (!hasCaseOp(document, NEIGHBOUR_CAPTURE_OP, restorationId, PROXIMAL_SIDES[contact.kind]!)) {
        claims.push({
          input: `contact:${contact.kind}`,
          reason: `the case records no ${PROXIMAL_SIDES[contact.kind]} neighbour capture from an arch scan`,
        });
      }
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
export function assertTraceableProvenance(
  ctx: ProvenanceContext,
  document: CaseDocument,
  restorationId: string,
): void {
  const claims = untraceableProvenanceClaims(ctx, document, restorationId);
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
