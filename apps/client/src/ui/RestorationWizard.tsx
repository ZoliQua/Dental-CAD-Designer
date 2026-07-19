// Case wizard: restoration setup (Phase 3 Task 2,
// docs/plans/phase-3-margin-axis.md). Pure React/DOM — all mutation goes
// through engine/restorations.ts's exported actions (ui never mutates the
// published CaseDocument snapshot directly, same rule as every other panel
// in this directory). Two halves in one file (both are "the wizard" — no
// separate list/form panels elsewhere reference either piece):
//   - `RestorationWizard`: the list of existing restorations (per-tooth
//     chips, selected restoration highlighted, edit/delete) plus the
//     create/edit form (type picker, FDI chart, target-scan select,
//     contiguity warning).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CaseDocument,
  FdiTooth,
  Restoration,
  RestorationType,
  SceneNode,
} from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
import {
  applyBridgeToothClick,
  applySingleToothClick,
  checkBridgeContiguity,
} from '../engine/fdiChart';
import {
  createRestoration,
  deleteRestoration,
  PREP_CAPABLE_ROLES,
  updateRestoration,
} from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import { FdiToothChart } from './FdiToothChart';

/** Restoration types selectable THIS phase — inlay/onlay are shown, greyed,
 * with an i18n'd "Phase 5" note (this task's brief: "inlay/onlay greyed with
 * i18n'd Phase 5 note"). */
const SELECTABLE_TYPES: readonly { type: RestorationType; enabled: boolean }[] = [
  { type: 'crown', enabled: true },
  { type: 'bridge', enabled: true },
  { type: 'inlay', enabled: false },
  { type: 'onlay', enabled: false },
];

interface Draft {
  editingId: string | null;
  type: RestorationType;
  teeth: readonly FdiTooth[];
  pontics: readonly FdiTooth[];
  targetNodeId: string | null;
}

function emptyDraft(): Draft {
  return { editingId: null, type: 'crown', teeth: [], pontics: [], targetNodeId: null };
}

function draftFromRestoration(restoration: Restoration): Draft {
  return {
    editingId: restoration.id,
    type: restoration.type,
    teeth: restoration.teeth,
    pontics: restoration.pontics,
    targetNodeId: restoration.targetNodeId,
  };
}

export function RestorationWizard() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const selectedRestorationId = useCaseStore((state) => state.selectedRestorationId);
  const [draft, setDraft] = useState<Draft>(emptyDraft());

  const targetOptions = document.scene.filter((node) => PREP_CAPABLE_ROLES.includes(node.role));

  function handleTypeChange(type: RestorationType): void {
    if (type === draft.type) return;
    if (type === 'bridge') {
      setDraft((prev) => ({ ...prev, type }));
    } else {
      // Downgrading from bridge (or switching between non-bridge types):
      // this wizard only ever builds a single-tooth selection for
      // crown/inlay/onlay (see engine/fdiChart.ts's `applySingleToothClick`
      // doc) — keep at most the first previously picked tooth, drop pontics.
      setDraft((prev) => ({ ...prev, type, teeth: prev.teeth.slice(0, 1), pontics: [] }));
    }
  }

  function handleToothClick(tooth: FdiTooth): void {
    if (draft.type === 'bridge') {
      const { teeth, pontics } = applyBridgeToothClick(draft.teeth, draft.pontics, tooth);
      setDraft((prev) => ({ ...prev, teeth, pontics }));
    } else {
      const teeth = applySingleToothClick(draft.teeth, tooth);
      setDraft((prev) => ({ ...prev, teeth, pontics: [] }));
    }
  }

  function handleTargetChange(value: string): void {
    setDraft((prev) => ({ ...prev, targetNodeId: value === '' ? null : value }));
  }

  function startEdit(restoration: Restoration): void {
    setDraft(draftFromRestoration(restoration));
    caseStore.setSelectedRestorationId(restoration.id);
  }

  function cancelEdit(): void {
    setDraft(emptyDraft());
    caseStore.setSelectedRestorationId(null);
  }

  function handleDelete(id: string): void {
    deleteRestoration(id);
    if (draft.editingId === id) {
      setDraft(emptyDraft());
    }
  }

  function handleSubmit(): void {
    if (!canSubmit) return;
    if (draft.editingId) {
      updateRestoration(draft.editingId, {
        type: draft.type,
        teeth: draft.teeth,
        pontics: draft.pontics,
        targetNodeId: draft.targetNodeId,
      });
      caseStore.setSelectedRestorationId(draft.editingId);
    } else {
      createRestoration({
        type: draft.type,
        teeth: draft.teeth,
        pontics: draft.pontics,
        targetNodeId: draft.targetNodeId,
      });
    }
    setDraft(emptyDraft());
  }

  const contiguity =
    draft.type === 'bridge' && draft.teeth.length >= 2 ? checkBridgeContiguity(draft.teeth) : null;
  const teethValid =
    draft.type === 'bridge'
      ? draft.teeth.length >= 2 && contiguity?.contiguous === true
      : draft.teeth.length === 1;
  const canSubmit = teethValid && draft.targetNodeId !== null;

  return (
    <section className="restoration-panel">
      <h2 className="restoration-panel__title">{t('restoration.panelTitle')}</h2>

      {document.restorations.length === 0 ? (
        <p className="restoration-panel__empty" data-testid="restoration-empty">
          {t('restoration.empty')}
        </p>
      ) : (
        <ul className="restoration-list">
          {document.restorations.map((restoration) => (
            <RestorationRow
              key={restoration.id}
              restoration={restoration}
              selected={restoration.id === selectedRestorationId}
              onSelect={() => caseStore.setSelectedRestorationId(restoration.id)}
              onEdit={() => startEdit(restoration)}
              onDelete={() => handleDelete(restoration.id)}
            />
          ))}
        </ul>
      )}

      <form
        className="restoration-form"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <h3 className="restoration-form__title">
          {draft.editingId ? t('restoration.form.editingTitle') : t('restoration.form.newTitle')}
        </h3>

        <div
          className="restoration-form__type-picker"
          role="group"
          aria-label={t('restoration.form.typeLabel')}
        >
          {SELECTABLE_TYPES.map(({ type, enabled }) => (
            <button
              key={type}
              type="button"
              className={`restoration-form__type-button${draft.type === type ? ' restoration-form__type-button--active' : ''}`}
              disabled={!enabled}
              aria-pressed={draft.type === type}
              onClick={() => handleTypeChange(type)}
              data-testid={`restoration-type-${type}`}
              title={enabled ? undefined : t('restoration.form.phase5Note')}
            >
              {t(`restoration.type.${type}`)}
              {!enabled && (
                <span className="restoration-form__type-note">
                  {' '}
                  ({t('restoration.form.phase5Note')})
                </span>
              )}
            </button>
          ))}
        </div>

        <FdiToothChart
          teeth={draft.teeth}
          pontics={draft.pontics}
          onToothClick={handleToothClick}
        />

        {contiguity && !contiguity.contiguous && (
          <p
            className="restoration-form__contiguity-warning"
            data-testid="bridge-contiguity-warning"
          >
            {t(`restoration.form.contiguity.${contiguity.reason}`)}
          </p>
        )}

        <label className="restoration-form__target">
          <span>{t('restoration.form.targetScanLabel')}</span>
          {targetOptions.length === 0 ? (
            <p className="restoration-form__no-targets">{t('restoration.form.noTargetScans')}</p>
          ) : (
            <select
              value={draft.targetNodeId ?? ''}
              onChange={(event) => handleTargetChange(event.target.value)}
              data-testid="restoration-target-select"
            >
              <option value="">{t('restoration.form.targetScanPlaceholder')}</option>
              {targetOptions.map((node) => (
                <option key={node.id} value={node.id}>
                  {targetOptionLabel(node, document.meshes)}
                </option>
              ))}
            </select>
          )}
        </label>

        <div className="restoration-form__actions">
          <button type="submit" disabled={!canSubmit} data-testid="restoration-submit-button">
            {draft.editingId
              ? t('restoration.form.saveButton')
              : t('restoration.form.createButton')}
          </button>
          {(draft.editingId || draft.teeth.length > 0) && (
            <button type="button" onClick={cancelEdit} data-testid="restoration-cancel-button">
              {t('restoration.form.cancelButton')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function targetOptionLabel(node: SceneNode, meshes: CaseDocument['meshes']): string {
  const mesh = meshes.find((asset) => asset.id === node.meshId);
  return `${mesh?.name ?? node.meshId} (${node.role})`;
}

function RestorationRow({
  restoration,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  restoration: Restoration;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={`restoration-list__row${selected ? ' restoration-list__row--selected' : ''}`}
      data-testid="restoration-row"
      onClick={onSelect}
    >
      <span className="restoration-list__type">{t(`restoration.type.${restoration.type}`)}</span>
      <span className="restoration-list__chips">
        {restoration.teeth.map((tooth) => (
          <span
            key={tooth}
            className={`restoration-chip${restoration.pontics.includes(tooth) ? ' restoration-chip--pontic' : ''}`}
            data-testid={`restoration-chip-${tooth}`}
          >
            {tooth}
          </span>
        ))}
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
        data-testid="restoration-edit-button"
      >
        {t('restoration.list.editButton')}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        data-testid="restoration-delete-button"
      >
        {t('restoration.list.deleteButton')}
      </button>
    </li>
  );
}
