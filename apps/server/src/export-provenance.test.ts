// ADR-022 — the export route refuses a `case` provenance claim the saved case
// cannot back (export-provenance.ts). Pure unit tests over plain contexts.
import { describe, expect, it } from 'vitest';
import type { CaseDocument } from '@dqcad/shared-types';
import { ExportRejectionError } from './export-validation.js';
import { assertTraceableProvenance, untraceableProvenanceClaims } from './export-provenance.js';

function doc(roles: string[]): CaseDocument {
  return { scene: roles.map((role, i) => ({ id: `n${i}`, role })) } as unknown as CaseDocument;
}

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
      ),
    ).toEqual([]);
  });

  it('a proximal contact claiming case (explicit or by omission) is refused — no neighbour capture exists', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [proximal('case')] }, doc(['upperJaw'])).map(
        (c) => c.input,
      ),
    ).toEqual(['contact:proximalMesial']);
    expect(untraceableProvenanceClaims({ contacts: [proximal()] }, doc(['upperJaw']))).toHaveLength(
      1,
    );
  });

  it('an antagonist contact claiming case is backed only by an antagonist-role scan', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [antagonist()] }, doc(['prepDie'])),
    ).toHaveLength(1);
    expect(
      untraceableProvenanceClaims(
        { contacts: [antagonist('case')] },
        doc(['prepDie', 'antagonist']),
      ),
    ).toEqual([]);
  });

  it('an onlay coverage divider claiming case is refused', () => {
    expect(
      untraceableProvenanceClaims({ contacts: [], coverage: {} }, doc([])).map((c) => c.input),
    ).toEqual(['coverage:divider']);
  });

  it('the bridge branch is out of scope (Phase 9 Task 6)', () => {
    expect(untraceableProvenanceClaims({ units: [], contacts: [proximal()] }, doc([]))).toEqual([]);
  });
});

describe('assertTraceableProvenance', () => {
  it('throws the typed 409 naming every untraceable claim', () => {
    try {
      assertTraceableProvenance({ contacts: [proximal(), antagonist()] }, doc([]));
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
