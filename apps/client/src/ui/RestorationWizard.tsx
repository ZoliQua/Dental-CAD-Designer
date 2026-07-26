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
  PLACEHOLDER_INSERTION_AXIS,
  PREP_CAPABLE_ROLES,
  restorationHasIrreplaceableWork,
  updateRestoration,
} from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import { FdiToothChart } from './FdiToothChart';

/** Restoration types selectable via the wizard. Inlay/onlay were greyed out
 * (with an i18n'd "Phase 5" note) from Phase 3 Task 2 through Phase 5 Tasks
 * 1-10 — those tasks built the kernel/pipeline/CavityDesignPanel machinery
 * but never revisited this picker, so a dentist could not actually CREATE an
 * inlay/onlay restoration through the product UI even though the full
 * design workflow existed downstream (`ui/CavityDesignPanel.tsx`). Phase 5
 * Task 11 (phase wrap-up) closes this gap: `engine/marginEditor.ts` and
 * `engine/restorations.ts` are already restoration-type-agnostic (verified —
 * neither branches on `'crown'`/`'bridge'` except the bridge-specific
 * multi-tooth/contiguity path above), so enabling the two remaining types
 * needed no other change. The `enabled: false` / phase-note rendering path
 * is kept (not deleted) as the established mechanism for a future
 * not-yet-implemented restoration type. */
const SELECTABLE_TYPES: readonly { type: RestorationType; enabled: boolean }[] = [
  { type: 'crown', enabled: true },
  { type: 'bridge', enabled: true },
  { type: 'inlay', enabled: true },
  { type: 'onlay', enabled: true },
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
    // `?? []`/`?? null` belt-and-braces: every load path now backfills
    // these (engine/caseDocumentMigration.ts's schemaVersion-2 restoration-
    // field backfill), so this should never actually be needed — kept
    // cheap and defensive at this render boundary anyway, since it was
    // exactly this line's missing-field crash that motivated that fix.
    pontics: restoration.pontics ?? [],
    targetNodeId: restoration.targetNodeId ?? null,
  };
}

export function RestorationWizard() {
  const { t } = useTranslation();
  const document = useCaseStore((state) => state.document);
  const selectedRestorationId = useCaseStore((state) => state.selectedRestorationId);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  // Task-11-review Critical 2: a restoration carrying hand-traced margin
  // lines and/or a set insertion axis must never be deleted with no
  // confirmation — `null` when no delete is pending; set to the target
  // restoration when `handleDelete` determines it has irreplaceable work
  // (see `restorationHasIrreplaceableWork`), gating the actual
  // `deleteRestoration` call behind the dialog below. A restoration with
  // NEITHER (a bare, freshly-created one) still deletes immediately, same
  // as before this fix — the confirm is specifically about NOT silently
  // losing manual work, not about every delete.
  const [pendingDelete, setPendingDelete] = useState<Restoration | null>(null);

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
    const target = document.restorations.find((restoration) => restoration.id === id);
    if (target && restorationHasIrreplaceableWork(target)) {
      setPendingDelete(target);
      return;
    }
    performDelete(id);
  }

  function performDelete(id: string): void {
    deleteRestoration(id);
    if (draft.editingId === id) {
      setDraft(emptyDraft());
    }
    if (pendingDelete?.id === id) {
      setPendingDelete(null);
    }
  }

  function confirmPendingDelete(): void {
    if (!pendingDelete) return;
    performDelete(pendingDelete.id);
  }

  function cancelPendingDelete(): void {
    setPendingDelete(null);
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

      {pendingDelete && (
        <div className="restoration-delete-confirm__backdrop">
          <div className="restoration-delete-confirm" role="dialog" aria-modal="true">
            <h3 className="restoration-delete-confirm__title">{t('restoration.deleteConfirm.title')}</h3>
            <p className="restoration-delete-confirm__message" data-testid="restoration-delete-confirm-message">
              {t(
                Object.keys(pendingDelete.marginLines).length > 0 && restorationHasNonPlaceholderAxis(pendingDelete)
                  ? 'restoration.deleteConfirm.messageBoth'
                  : Object.keys(pendingDelete.marginLines).length > 0
                    ? 'restoration.deleteConfirm.messageMarginsOnly'
                    : 'restoration.deleteConfirm.messageAxisOnly',
                { marginCount: Object.keys(pendingDelete.marginLines).length },
              )}
            </p>
            <div className="restoration-delete-confirm__actions">
              <button
                type="button"
                onClick={cancelPendingDelete}
                data-testid="restoration-delete-confirm-cancel"
              >
                {t('restoration.deleteConfirm.cancelButton')}
              </button>
              <button
                type="button"
                onClick={confirmPendingDelete}
                data-testid="restoration-delete-confirm-confirm"
              >
                {t('restoration.deleteConfirm.confirmButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** `engine/restorations.ts` only exports the COMBINED
 * `restorationHasIrreplaceableWork` predicate (margins OR axis) — this
 * picks apart just the axis half, reusing its exported
 * `PLACEHOLDER_INSERTION_AXIS`, to choose which of the three delete-confirm
 * message variants to show (margins-only/axis-only/both) — a UI-copy
 * concern that doesn't belong in the engine layer. */
function restorationHasNonPlaceholderAxis(restoration: Restoration): boolean {
  return restoration.insertionAxis.some((component, i) => component !== PLACEHOLDER_INSERTION_AXIS[i]);
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
            className={`restoration-chip${(restoration.pontics ?? []).includes(tooth) ? ' restoration-chip--pontic' : ''}`}
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
