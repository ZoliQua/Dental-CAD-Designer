// Repair panel: appears under a scene-tree row when that node's CURRENT
// mesh's intake stats show an issue (multiple components / non-manifold
// edges / boundary holes). Each candidate repair is its own card: an
// eagerly-computed preview (before/after stats — no mutation, safe to
// compute automatically) plus an EXPLICIT per-repair "Apply" button. There
// is deliberately no "apply all" / auto-apply anywhere in this file
// (CLAUDE.md invariant 5 — repair requires explicit user confirmation).
//
// Keyed by the SceneNode's `meshId` prop (see ui/Sidebar.tsx) rather than
// the import-time contentHash: `caseStore.applyRepair` repoints the
// SceneNode to the repaired mesh's NEW contentHash, so re-deriving
// `meshId` from the live CaseDocument (via useCaseStore) — and using it as
// each card's React `key` — is what makes a second repair (e.g. fill holes
// after removing components) automatically start from a fresh preview of
// the ALREADY-repaired mesh, rather than a stale one.
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { caseStore } from '../engine/caseStore';
import {
  applyRepairPreview,
  previewFillSmallHoles,
  previewRemoveComponents,
  previewSplitNonManifoldEdges,
  previewSplitNonManifoldVertices,
  type FillSmallHolesPreview,
  type MeshStats,
  type RemoveComponentsPreview,
  type SplitNonManifoldEdgesPreview,
  type SplitNonManifoldVerticesPreview,
} from '../engine/repair';
import { useCaseStore } from '../state/caseStore';

interface RepairPanelProps {
  meshId: string;
}

export function RepairPanel({ meshId }: RepairPanelProps) {
  const { t } = useTranslation();
  // engine/caseStore.ts's meshStore is a plain class, not part of the
  // zustand snapshot — subscribing to `document` here is what makes this
  // component re-render (and re-look-up `meshId`'s record) after ANY case
  // mutation, including a repair applied by a sibling card.
  useCaseStore((state) => state.document);
  const record = caseStore.getMeshRecord(meshId);

  // Bowtie ("non-manifold vertex") detection is NOT part of `MeshStats`
  // (unlike `componentCount`/`manifoldEdges`/`boundaryEdgeCount` above) —
  // touching `MeshStats`'s shape would ripple into every OTHER kernel-ops
  // golden entry that hashes `JSON.stringify(stats)` (intake, offsetMesh —
  // see scripts/kernel-ops-lib.ts), far outside this task's fillSmallHoles-
  // only golden-change scope. Detected instead via its own cheap preview
  // call (same worker job the card itself uses), gating this ONE card
  // asynchronously rather than synchronously like the other three.
  const [bowtieCount, setBowtieCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBowtieCount(null);
    void (async () => {
      const r = caseStore.getMeshRecord(meshId);
      if (!r) return;
      try {
        const preview = await previewSplitNonManifoldVertices(r);
        if (!cancelled) setBowtieCount(preview.report.nonManifoldVertexCountBefore);
      } catch {
        if (!cancelled) setBowtieCount(0); // detection failure — fail closed (card stays hidden), same as any other card's own error handling
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meshId]);

  if (!record) return null;

  const { stats } = record;
  const showRemoveComponents = stats.componentCount > 1;
  const showSplitNonManifold = !stats.manifoldEdges;
  const showSplitNonManifoldVertices = (bowtieCount ?? 0) > 0;
  const showFillHoles = stats.boundaryEdgeCount > 0;

  if (!showRemoveComponents && !showSplitNonManifold && !showSplitNonManifoldVertices && !showFillHoles) {
    return null;
  }

  return (
    <div className="repair-panel" data-testid="repair-panel">
      <h3 className="repair-panel__title">{t('repair.panelTitle')}</h3>
      {showRemoveComponents && <RemoveComponentsCard key={`remove-components-${meshId}`} meshId={meshId} />}
      {showSplitNonManifold && <SplitNonManifoldEdgesCard key={`split-non-manifold-${meshId}`} meshId={meshId} />}
      {showSplitNonManifoldVertices && (
        <SplitNonManifoldVerticesCard key={`split-non-manifold-vertices-${meshId}`} meshId={meshId} />
      )}
      {showFillHoles && <FillSmallHolesCard key={`fill-small-holes-${meshId}`} meshId={meshId} />}
    </div>
  );
}

type CardState<P> =
  | { status: 'loading' }
  | { status: 'ready'; preview: P }
  | { status: 'applying'; preview: P }
  | { status: 'applied'; measurementsCleared: number }
  | { status: 'error'; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads `measurementsCleared` back off the journal entry `applyRepairPreview`
 * just appended (`caseStore.applyRepair` merges it into the SAME Operation's
 * `params` — see that method's doc) so each card's "Applied" state can
 * surface the "N measurement(s) removed" note without `applyRepairPreview`
 * having to change its `EngineMeshRecord` return shape. */
function measurementsClearedFromLastOperation(): number {
  const lastOperation = caseStore.getDocument().history.at(-1);
  const count = lastOperation?.params.measurementsCleared;
  return typeof count === 'number' ? count : 0;
}

function RepairStatsTable({ before, after }: { before: MeshStats; after: MeshStats }) {
  const { t } = useTranslation();
  const yesNo = (value: boolean) => t(value ? 'import.stats.yes' : 'import.stats.no');
  return (
    <table className="repair-card__stats">
      <thead>
        <tr>
          <th />
          <th>{t('repair.stats.before')}</th>
          <th>{t('repair.stats.after')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{t('import.stats.watertight')}</td>
          <td>{yesNo(before.watertight)}</td>
          <td>{yesNo(after.watertight)}</td>
        </tr>
        <tr>
          <td>{t('import.stats.manifold')}</td>
          <td>{yesNo(before.manifoldEdges)}</td>
          <td>{yesNo(after.manifoldEdges)}</td>
        </tr>
        <tr>
          <td>{t('import.stats.components')}</td>
          <td>{before.componentCount}</td>
          <td>{after.componentCount}</td>
        </tr>
        <tr>
          <td>{t('import.stats.boundaryEdges')}</td>
          <td>{before.boundaryEdgeCount}</td>
          <td>{after.boundaryEdgeCount}</td>
        </tr>
      </tbody>
    </table>
  );
}

function RemoveComponentsCard({ meshId }: { meshId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CardState<RemoveComponentsPreview>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const record = caseStore.getMeshRecord(meshId);
      if (!record) return;
      try {
        // First call just to enumerate every component (`report.components`
        // is always populated regardless of selector — see
        // removeComponents.ts) — used to compute the default "keep only the
        // largest" selector below.
        const scan = await previewRemoveComponents(record, { mode: 'minTriangles', minTriangles: 0 });
        const components = scan.report.components;
        const largest = components.reduce((a, b) => (b.triangleCount > a.triangleCount ? b : a));
        const preview = await previewRemoveComponents(record, { mode: 'keep', keepIds: [largest.id] });
        if (!cancelled) setState({ status: 'ready', preview });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meshId]);

  async function handleApply(): Promise<void> {
    if (state.status !== 'ready') return;
    const { preview } = state;
    setState({ status: 'applying', preview });
    try {
      await applyRepairPreview(preview);
      setState({ status: 'applied', measurementsCleared: measurementsClearedFromLastOperation() });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  return (
    <RepairCardShell
      titleKey="repair.removeComponents.title"
      descriptionKey="repair.removeComponents.description"
      testId="repair-card-remove-components"
      state={state}
      onApply={() => void handleApply()}
      applyDisabled={state.status === 'ready' && state.preview.report.removedComponentIds.length === 0}
      summary={
        state.status === 'ready' || state.status === 'applying'
          ? state.preview.report.removedComponentIds.length === 0
            ? t('repair.removeComponents.noneToRemove')
            : t('repair.removeComponents.summary', {
                removed: state.preview.report.removedComponentIds.length,
                total: state.preview.report.components.length,
              })
          : null
      }
    />
  );
}

function SplitNonManifoldEdgesCard({ meshId }: { meshId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CardState<SplitNonManifoldEdgesPreview>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const record = caseStore.getMeshRecord(meshId);
      if (!record) return;
      try {
        const preview = await previewSplitNonManifoldEdges(record);
        if (!cancelled) setState({ status: 'ready', preview });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meshId]);

  async function handleApply(): Promise<void> {
    if (state.status !== 'ready') return;
    const { preview } = state;
    setState({ status: 'applying', preview });
    try {
      await applyRepairPreview(preview);
      setState({ status: 'applied', measurementsCleared: measurementsClearedFromLastOperation() });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  return (
    <RepairCardShell
      titleKey="repair.splitNonManifoldEdges.title"
      descriptionKey="repair.splitNonManifoldEdges.description"
      testId="repair-card-split-non-manifold-edges"
      state={state}
      onApply={() => void handleApply()}
      applyDisabled={false}
      summary={
        state.status === 'ready' || state.status === 'applying'
          ? t('repair.splitNonManifoldEdges.summary', {
              count: state.preview.report.duplicatedVertexCount,
              edges: state.preview.report.nonManifoldEdgeCountBefore,
            })
          : null
      }
    />
  );
}

function SplitNonManifoldVerticesCard({ meshId }: { meshId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CardState<SplitNonManifoldVerticesPreview>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const record = caseStore.getMeshRecord(meshId);
      if (!record) return;
      try {
        const preview = await previewSplitNonManifoldVertices(record);
        if (!cancelled) setState({ status: 'ready', preview });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meshId]);

  async function handleApply(): Promise<void> {
    if (state.status !== 'ready') return;
    const { preview } = state;
    setState({ status: 'applying', preview });
    try {
      await applyRepairPreview(preview);
      setState({ status: 'applied', measurementsCleared: measurementsClearedFromLastOperation() });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  return (
    <RepairCardShell
      titleKey="repair.splitNonManifoldVertices.title"
      descriptionKey="repair.splitNonManifoldVertices.description"
      testId="repair-card-split-non-manifold-vertices"
      state={state}
      onApply={() => void handleApply()}
      applyDisabled={false}
      summary={
        state.status === 'ready' || state.status === 'applying'
          ? t('repair.splitNonManifoldVertices.summary', {
              count: state.preview.report.duplicatedVertexCount,
              vertices: state.preview.report.nonManifoldVertexCountBefore,
            })
          : null
      }
    />
  );
}

function FillSmallHolesCard({ meshId }: { meshId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CardState<FillSmallHolesPreview>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const record = caseStore.getMeshRecord(meshId);
      if (!record) return;
      try {
        const preview = await previewFillSmallHoles(record);
        if (!cancelled) setState({ status: 'ready', preview });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meshId]);

  async function handleApply(): Promise<void> {
    if (state.status !== 'ready') return;
    const { preview } = state;
    setState({ status: 'applying', preview });
    try {
      await applyRepairPreview(preview);
      setState({ status: 'applied', measurementsCleared: measurementsClearedFromLastOperation() });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  const skippedCount = state.status === 'ready' || state.status === 'applying' ? state.preview.report.loopsSkipped.length : 0;

  return (
    <RepairCardShell
      titleKey="repair.fillSmallHoles.title"
      descriptionKey="repair.fillSmallHoles.description"
      testId="repair-card-fill-small-holes"
      state={state}
      onApply={() => void handleApply()}
      applyDisabled={state.status === 'ready' && state.preview.report.loopsFilled === 0}
      summary={
        state.status === 'ready' || state.status === 'applying' ? (
          <>
            <p className="repair-card__summary">
              {state.preview.report.loopsFound === 0
                ? t('repair.fillSmallHoles.noneToFill')
                : t('repair.fillSmallHoles.summary', {
                    filled: state.preview.report.loopsFilled,
                    found: state.preview.report.loopsFound,
                  })}
            </p>
            {skippedCount > 0 && (
              <p className="repair-card__summary repair-card__summary--muted">
                {t('repair.fillSmallHoles.skippedSummary', { count: skippedCount })}
              </p>
            )}
          </>
        ) : null
      }
    />
  );
}

interface RepairCardShellProps<P extends { statsBefore: MeshStats; statsAfter: MeshStats }> {
  titleKey: string;
  descriptionKey: string;
  testId: string;
  state: CardState<P>;
  onApply: () => void;
  applyDisabled: boolean;
  summary: ReactNode;
}

function RepairCardShell<P extends { statsBefore: MeshStats; statsAfter: MeshStats }>({
  titleKey,
  descriptionKey,
  testId,
  state,
  onApply,
  applyDisabled,
  summary,
}: RepairCardShellProps<P>) {
  const { t } = useTranslation();
  return (
    <div className="repair-card" data-testid={testId}>
      <h4 className="repair-card__title">{t(titleKey)}</h4>
      <p className="repair-card__description">{t(descriptionKey)}</p>
      {state.status === 'loading' && <p className="repair-card__status">{t('repair.previewLoading')}</p>}
      {state.status === 'error' && (
        <p className="repair-card__error">{t('repair.previewError', { message: state.message })}</p>
      )}
      {state.status === 'applied' && (
        <>
          <p className="repair-card__applied">{t('repair.applied')}</p>
          {state.measurementsCleared > 0 && (
            <p className="repair-card__applied-note" data-testid={`${testId}-measurements-cleared`}>
              {t('repair.measurementsCleared', { count: state.measurementsCleared })}
            </p>
          )}
        </>
      )}
      {(state.status === 'ready' || state.status === 'applying') && (
        <>
          {typeof summary === 'string' ? <p className="repair-card__summary">{summary}</p> : summary}
          <RepairStatsTable before={state.preview.statsBefore} after={state.preview.statsAfter} />
          <button
            type="button"
            className="repair-card__apply-button"
            onClick={onApply}
            disabled={state.status === 'applying' || applyDisabled}
            data-testid={`${testId}-apply`}
          >
            {state.status === 'applying' ? t('repair.applying') : t('repair.applyButton')}
          </button>
        </>
      )}
    </div>
  );
}
