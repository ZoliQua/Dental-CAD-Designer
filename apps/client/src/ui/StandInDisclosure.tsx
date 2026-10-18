// apps/client/src/ui/StandInDisclosure.tsx
//
// ADR-022 disclosure pattern (generalizing ADR-014's bridge banner): a design
// input that is a stand-in for missing case data is named where it is used,
// and a QC gate measured on it says so in its row. Pure renderers — the
// provenance itself comes from the engine snapshots / the QC report.
import { useTranslation } from 'react-i18next';
import type { QcGateResult } from '@dqcad/shared-types';

export type StandInMessageKey =
  'provenance.crownNeighbours' | 'provenance.cavityNeighbours' | 'provenance.coverageDivider';

/** The stage-level banner for a placeholder input. */
export function StandInDisclosure({
  messageKey,
  testId,
}: {
  messageKey: StandInMessageKey;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="stand-in-disclosure" role="note" data-testid={testId}>
      <strong className="stand-in-disclosure__title">{t('provenance.title')}</strong>{' '}
      <span>{t(messageKey)}</span>
    </div>
  );
}

/** The per-gate note: rendered only for a gate measured on non-`case` input. */
export function GateProvenanceNote({ gate, testId }: { gate: QcGateResult; testId: string }) {
  const { t } = useTranslation();
  if (gate.inputProvenance === undefined) return null;
  return (
    <span className="qc-gate__provenance" data-testid={testId}>
      {' · '}
      {t(`provenance.gate.${gate.inputProvenance}`)}
    </span>
  );
}
