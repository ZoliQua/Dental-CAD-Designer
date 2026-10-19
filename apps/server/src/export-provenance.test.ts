// ADR-022 — the export route refuses a `case` provenance claim the saved case
// cannot back (export-provenance.ts). Pure unit tests over plain contexts.
import { describe, expect, it } from 'vitest';
import { ANTAGONIST_CONFIRM_OP, NEIGHBOUR_CAPTURE_OP, type CaseDocument, type Operation } from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';
import { assertTraceableProvenance, untraceableProvenanceClaims } from './export-provenance.js';

function doc(roles: string[], history: Operation[] = []): CaseDocument {
  return {
    scene: roles.map((role, i) => ({ id: `n${i}`, meshId: `mesh-n${i}`, role })),
    history,
  } as unknown as CaseDocument;
}

function captureOp(
  params: Record<string, unknown>,
  inputHashes: string[],
  name: string = NEIGHBOUR_CAPTURE_OP,
): Operation {
  return { id: 'op', name, params, inputHashes, outputHashes: ['region'], kernelVersion: 'k', timestamp: 't' };
}

const R = 'restoration-1';

const proximal = (provenance?: 'case' | 'placeholder') => ({
  kind: 'proximalMesial',
  ...(provenance ? { provenance } : {}),
});
const antagonist = (provenance?: 'case' | 'placeholder') => ({
  kind: 'antagonist',
  ...(provenance ? { provenance } : {}),
});

describe('untraceableProvenanceClaims', () => {
  it('declared stand-ins are always traceable (they fail the gate closed)', () => {
    expect(
      untraceableProvenanceClaims(
        {
          contacts: [proximal('placeholder'), antagonist('placeholder')],
          coverage: { dividerProvenance: 'placeholder' },
        },
        doc([]),
        R,
      ),
    ).toEqual([]);
  });

  it('a proximal contact claiming case (explicit or by omission) with no neighbour capture is refused', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [proximal('case')] }, doc(['upperJaw']), R).map(
        (c) => c.input,
      ),
    ).toEqual(['contact:proximalMesial']);
    expect(
      untraceableProvenanceClaims({ contacts: [proximal()] }, doc(['upperJaw']), R),
    ).toHaveLength(1);
  });

  it('a proximal case claim is backed by a journaled capture of that side from an arch scan still in the case (Phase 9 Task 3)', () => {
    const capture = captureOp({ restorationId: R, side: 'mesial', scanNodeId: 'n0' }, ['mesh-n0']);
    expect(
      untraceableProvenanceClaims({ contacts: [proximal('case')] }, doc(['upperJaw'], [capture]), R),
    ).toEqual([]);
    // The other side, another restoration, a swapped scan, a removed scan, or
    // a non-arch scan do not back it.
    const refused = (roles: string[], op: Operation): number =>
      untraceableProvenanceClaims({ contacts: [proximal('case')] }, doc(roles, [op]), R).length;
    expect(refused(['upperJaw'], captureOp({ restorationId: R, side: 'distal', scanNodeId: 'n0' }, ['mesh-n0']))).toBe(1);
    expect(refused(['upperJaw'], captureOp({ restorationId: 'other', side: 'mesial', scanNodeId: 'n0' }, ['mesh-n0']))).toBe(1);
    expect(refused(['upperJaw'], captureOp({ restorationId: R, side: 'mesial', scanNodeId: 'n0' }, ['mesh-other']))).toBe(1);
    expect(refused([], capture)).toBe(1);
    expect(refused(['prepDie'], capture)).toBe(1);
  });

  it('an antagonist contact claiming case is backed by an antagonist-role scan or a confirmed opposite-arch capture', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [antagonist()] }, doc(['prepDie']), R),
    ).toHaveLength(1);
    expect(
      untraceableProvenanceClaims(
        { contacts: [antagonist('case')] },
        doc(['prepDie', 'antagonist']),
        R,
      ),
    ).toEqual([]);
    const confirm = captureOp({ restorationId: R, scanNodeId: 'n1' }, ['mesh-n1'], ANTAGONIST_CONFIRM_OP);
    expect(
      untraceableProvenanceClaims({ contacts: [antagonist('case')] }, doc(['upperJaw', 'lowerJaw'], [confirm]), R),
    ).toEqual([]);
    expect(
      untraceableProvenanceClaims({ contacts: [antagonist('case')] }, doc(['upperJaw', 'prepDie'], [confirm]), R),
    ).toHaveLength(1);
  });

  it('an onlay coverage divider claiming case is refused', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [], coverage: {} }, doc([]), R).map((c) => c.input),
    ).toEqual(['coverage:divider']);
  });

  it('the bridge branch is out of scope (Phase 9 Task 6)', () => {
    expect(untraceableProvenanceClaims({ units: [], contacts: [proximal()] }, doc([]), R)).toEqual([]);
  });
});

describe('assertTraceableProvenance', () => {
  it('throws the typed 409 naming every untraceable claim', () => {
    try {
      assertTraceableProvenance({ contacts: [proximal(), antagonist()] }, doc([]), R);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExportRejectionError);
      const e = error as ExportRejectionError;
      expect(e.code).toBe('export-untraceable-provenance');
      expect(e.httpStatus).toBe(409);
      expect((e.details.claims as unknown[]).length).toBe(2);
    }
  });
});
