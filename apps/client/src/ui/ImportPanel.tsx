// Drag & drop overlay + file picker + per-file progress list + intake
// summary + role-assignment dropdown + unit-rescale confirmation dialog.
// Pure React/DOM — all geometry work happens in engine/importer.ts; this
// component only calls its exported actions and reads state/importStore.ts
// + engine/caseStore.ts's read-only mesh-record lookup.
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshRole } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import {
  addMeshToScene,
  cancelImport,
  importFiles,
  resolveUnitConfirmation,
} from '../engine/importer';
import type { EngineMeshRecord } from '../engine/meshStore';
import { TERMINAL_IMPORT_PHASES, useImportStore, type ImportFileEntry } from '../state/importStore';

const ACCEPTED_EXTENSIONS = '.stl,.ply';
const MESH_ROLES: readonly MeshRole[] = ['upperJaw', 'lowerJaw', 'prepDie', 'antagonist', 'situ', 'gingiva'];

function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function formatBbox(min: readonly [number, number, number], max: readonly [number, number, number]): string {
  const fmt = (n: number) => n.toFixed(2);
  return `[${fmt(min[0])}, ${fmt(min[1])}, ${fmt(min[2])}] – [${fmt(max[0])}, ${fmt(max[1])}, ${fmt(max[2])}]`;
}

export function ImportPanel() {
  const { t } = useTranslation();
  const files = useImportStore((state) => state.files);
  const pendingUnitConfirmation = useImportStore((state) => state.pendingUnitConfirmation);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    function onDragEnter(event: globalThis.DragEvent): void {
      if (!event.dataTransfer?.types.includes('Files')) return;
      dragDepth.current += 1;
      setIsDragging(true);
    }
    function onDragLeave(): void {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    }
    function onDragOver(event: globalThis.DragEvent): void {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }
    function onDrop(event: globalThis.DragEvent): void {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      const dropped = Array.from(event.dataTransfer.files).filter((file) =>
        /\.(stl|ply)$/i.test(file.name),
      );
      if (dropped.length > 0) importFiles(dropped);
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = Array.from(event.target.files ?? []);
    if (selected.length > 0) importFiles(selected);
    event.target.value = ''; // allow re-selecting the same file
  }

  // React's DragEvent type is used only to satisfy the drop-zone's onDrop
  // prop below when it's rendered as a fallback target inside the panel
  // (the window-level listeners above handle the actual overlay behavior).
  function preventDefault(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
  }

  const entries = Object.values(files).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="import-panel">
      <div className="import-panel__controls">
        <button type="button" className="import-panel__browse-button" onClick={() => fileInputRef.current?.click()}>
          {t('import.browseButton')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          multiple
          className="import-panel__file-input"
          onChange={handleFileInputChange}
          data-testid="import-file-input"
        />
      </div>

      {entries.length > 0 && (
        <ul className="import-panel__file-list">
          {entries.map((entry) => (
            <ImportFileRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      {isDragging && (
        <div className="import-overlay" onDragOver={preventDefault}>
          <div className="import-overlay__message">{t('import.dropOverlayTitle')}</div>
        </div>
      )}

      {pendingUnitConfirmation && (
        <div className="unit-confirm-dialog__backdrop">
          <div className="unit-confirm-dialog" role="dialog" aria-modal="true">
            <h3 className="unit-confirm-dialog__title">{t('unitConfirm.title')}</h3>
            <p className="unit-confirm-dialog__message">
              {t(
                pendingUnitConfirmation.suspectedUnit === 'cm' ? 'unitConfirm.messageCm' : 'unitConfirm.messageUm',
                {
                  fileName: pendingUnitConfirmation.fileName,
                  extent: pendingUnitConfirmation.maxExtentMm.toFixed(2),
                  factor: pendingUnitConfirmation.suggestedFactor,
                },
              )}
            </p>
            <div className="unit-confirm-dialog__actions">
              <button
                type="button"
                data-testid="unit-confirm-keep-mm"
                onClick={() => resolveUnitConfirmation(pendingUnitConfirmation.fileId, 'keep-mm')}
              >
                {t('unitConfirm.keepMm')}
              </button>
              <button
                type="button"
                data-testid="unit-confirm-apply-factor"
                onClick={() => resolveUnitConfirmation(pendingUnitConfirmation.fileId, 'apply-factor')}
              >
                {t('unitConfirm.applyFactor', { factor: pendingUnitConfirmation.suggestedFactor })}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ImportFileRow({ entry }: { entry: ImportFileEntry }) {
  const { t } = useTranslation();
  const isTerminal = TERMINAL_IMPORT_PHASES.has(entry.phase);
  const record = entry.meshContentHash ? caseStore.getMeshRecord(entry.meshContentHash) : undefined;

  return (
    <li className="import-panel__file-row" data-testid="import-file-row">
      <div className="import-panel__file-header">
        <span className="import-panel__file-name">{entry.name}</span>
        <span className="import-panel__file-phase">{t(`import.phase.${entry.phase}`)}</span>
        {!isTerminal && (
          <button type="button" className="import-panel__cancel-button" onClick={() => cancelImport(entry.id)}>
            {t('import.cancelButton')}
          </button>
        )}
      </div>
      {!isTerminal && (
        <progress className="import-panel__progress" value={entry.progress} max={1}>
          {formatPercent(entry.progress)}
        </progress>
      )}
      {entry.phase === 'error' && entry.error && (
        <p className="import-panel__error">{t('import.errorLabel', { message: entry.error })}</p>
      )}
      {entry.phase === 'done' && record && <MeshSummary record={record} />}
    </li>
  );
}

function MeshSummary({ record }: { record: EngineMeshRecord }) {
  const { t } = useTranslation();
  const [addedRole, setAddedRole] = useState<MeshRole | null>(null);
  const { stats, report, contentHash } = record;
  const yesNo = (value: boolean) => t(value ? 'import.stats.yes' : 'import.stats.no');

  function handleRoleChange(event: ChangeEvent<HTMLSelectElement>): void {
    const role = event.target.value as MeshRole | '';
    if (!role) return;
    addMeshToScene(contentHash, role);
    setAddedRole(role);
    event.target.value = '';
  }

  return (
    <div className="import-summary">
      <dl className="import-summary__stats">
        <dt>{t('import.stats.watertight')}</dt>
        <dd>{yesNo(stats.watertight)}</dd>
        <dt>{t('import.stats.manifold')}</dt>
        <dd>{yesNo(stats.manifoldEdges)}</dd>
        <dt>{t('import.stats.components')}</dt>
        <dd>{stats.componentCount}</dd>
        <dt>{t('import.stats.bbox')}</dt>
        <dd>{formatBbox(stats.bbox.min, stats.bbox.max)}</dd>
        <dt>{t('import.stats.area')}</dt>
        <dd>{stats.surfaceAreaMm2.toFixed(2)}</dd>
        <dt>{t('import.stats.volume')}</dt>
        <dd>{stats.signedVolumeMm3 !== null ? stats.signedVolumeMm3.toFixed(2) : t('import.stats.notApplicable')}</dd>
        <dt>{t('import.stats.degenerate')}</dt>
        <dd>{stats.degenerateCount}</dd>
        <dt>{t('import.stats.boundaryEdges')}</dt>
        <dd>{stats.boundaryEdgeCount}</dd>
      </dl>
      {report.steps.some((step) => Object.keys(step.details).length > 0) && (
        <p className="import-summary__warnings-title">{t('import.warningsTitle')}</p>
      )}
      <label className="import-summary__role">
        <span>{t('import.roleLabel')}</span>
        <select onChange={handleRoleChange} defaultValue="" data-testid="import-role-select">
          <option value="" disabled>
            {t('import.rolePlaceholder')}
          </option>
          {MESH_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`role.${role}`)}
            </option>
          ))}
        </select>
      </label>
      {addedRole && <span className="import-summary__added">{t('import.addedToScene')}</span>}
    </div>
  );
}
