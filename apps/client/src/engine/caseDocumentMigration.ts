// apps/client/src/engine/caseDocumentMigration.ts
//
// Phase 3 Task 1: `CaseDocument.schemaVersion` 1 -> 2 load-time migration.
// The ONLY place a schemaVersion-1 document is ever accepted anywhere in
// this codebase — the server's PUT schema (apps/server/src/schemas.ts)
// rejects anything but `2` outright, per this task's brief ("migration
// happens client-side on load"), so a v1 document can only ever be
// encountered here, via `GET /api/cases/:id` returning a row that predates
// this migration (the server's own GET route does no validation on its
// response — `apps/server/src/app.ts` just echoes back whatever
// `documentJson` a row already has, so an old row legitimately still
// contains v1 JSON until the next successful save re-persists it as v2).
//
// ## What changed, schemaVersion 1 -> 2 (shared-types' `MarginLine`)
//
//   v1: { vertexAnchors: readonly number[]; controlPoints: readonly Vec3[]; closed: boolean }
//   v2: { anchors: readonly MarginAnchor[]; closed: boolean; resampledPoints?: readonly Vec3[] }
//   MarginAnchor = { position: Vec3; triangleIndex: number; barycentric: readonly [number, number, number] }
//
// See packages/kernel/src/spline/marginLine.ts's module doc for the
// kernel-side adapter this schema evolution was designed to feed losslessly
// (an ALREADY-mesh-resident `SurfacePoint` round-trips through `MarginLine`
// with zero loss now) — that adapter is NOT usable for THIS migration,
// though: it requires a real mesh (to evaluate/validate a `SurfacePoint`),
// and a v1 `MarginLine`'s `vertexAnchors` was already merely a "nearest
// mesh VERTEX" hint (packages/kernel/src/spline/marginLine.ts's git history
// documents it as such), not a triangle reference — there is no vertex ->
// triangle mapping recoverable from a vertex index alone without the
// mesh's own index buffer. More fundamentally, `CaseDocument` (still, as of
// this task) has no `Restoration` -> target-mesh mapping AT ALL (Phase 3
// Task 2's wizard is what introduces "assign the target scan" —
// docs/plans/phase-3-margin-axis.md) — so there is no unambiguous mesh to
// re-project a legacy control point onto even if one wanted to.
//
// ## The migration's documented, EXPLICIT limitation (CLAUDE.md invariant
// 5: "no silent data loss")
//
// Given the above, this migration does NOT attempt a real re-projection.
// Every legacy control point becomes a `MarginAnchor` whose `position` is
// carried through EXACTLY (`v1.controlPoints[i]`, zero loss — this is, and
// always was, the authoritative field: v1's own `vertexAnchors` was already
// documented as a "coarse, never-trust-for-position" hint, so dropping it
// here loses nothing beyond what v1's own kernel adapter already treated as
// non-authoritative) but whose `triangleIndex`/`barycentric` are UNRESOLVED
// PLACEHOLDERS (`UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX` = `-1`, this
// codebase's existing "no valid index here" convention — e.g.
// packages/kernel/src/halfedge/build.ts's `HalfedgeMesh.twin`), NOT a
// fabricated real value. This is flagged loudly, not silently: the
// migration Operation journaled below records `unresolvedAnchorCount`
// (every migrated anchor, by construction) and a `note` explaining exactly
// this, and every `MarginAnchor.position`'s doc (shared-types) says the
// same. A future margin-editing tool (Task 7+) is expected to re-snap a
// migrated margin line's anchors against its now-resolved target mesh (a
// single `snapToSurface`/BVH-projection call per anchor, cheap and already
// exact) before doing anything surface-relative with `triangleIndex`/
// `barycentric` — this migration's whole job is just "don't lose the
// position, don't crash, don't silently pretend to have resolved geometry
// this schema simply cannot express yet".
import type {
  CaseDocument,
  FdiTooth,
  MarginAnchor,
  MarginLine,
  Operation,
  Restoration,
  Vec3,
} from '@dqcad/shared-types';
import { KERNEL_VERSION } from '@dqcad/kernel-workers';

/** shared-types' PRE-Phase-3-Task-1 `MarginLine` shape (schemaVersion 1).
 * Deliberately NOT imported from shared-types (which only ever describes
 * the CURRENT schema, per that package's own "type declarations only" doc)
 * — kept here, module-private to this migration. */
interface LegacyMarginLineV1 {
  readonly vertexAnchors: readonly number[];
  readonly controlPoints: readonly Vec3[];
  readonly closed: boolean;
}

interface LegacyRestorationV1 extends Omit<Restoration, 'marginLines'> {
  readonly marginLines: Partial<Record<FdiTooth, LegacyMarginLineV1>>;
}

/** A schemaVersion-1 `CaseDocument` — everything else is unchanged from the
 * current shape (only `MarginLine`, nested under `restorations`, evolved). */
export interface LegacyCaseDocumentV1 extends Omit<CaseDocument, 'schemaVersion' | 'restorations'> {
  readonly schemaVersion: 1;
  readonly restorations: readonly LegacyRestorationV1[];
}

/** See this module's top doc, "The migration's documented, EXPLICIT
 * limitation". Never a valid triangle index (triangle indices are always
 * `>= 0`) — matches this codebase's existing sentinel convention. */
export const UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX = -1;

/** Placeholder barycentric weights for an unresolved migrated anchor — an
 * arbitrary but validly-shaped (sums to 1) triple, never meant to be
 * evaluated against a real mesh while `triangleIndex ===
 * UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX`. */
const UNRESOLVED_BARYCENTRIC: readonly [number, number, number] = [1, 0, 0];

function migrateMarginLine(legacy: LegacyMarginLineV1): MarginLine {
  // `legacy.vertexAnchors` is intentionally UNUSED — see this module's top
  // doc for why (already a non-authoritative hint in v1, and not even the
  // right index SPACE — vertex, not triangle — to build a MarginAnchor
  // from).
  const anchors: MarginAnchor[] = legacy.controlPoints.map((position) => ({
    position,
    triangleIndex: UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX,
    barycentric: UNRESOLVED_BARYCENTRIC,
  }));
  return { anchors, closed: legacy.closed };
}

interface MarginLineMigrationStats {
  restorationCount: number;
  marginLineCount: number;
  anchorCount: number;
}

function migrateRestorations(
  legacyRestorations: readonly LegacyRestorationV1[],
): { restorations: Restoration[]; stats: MarginLineMigrationStats } {
  let marginLineCount = 0;
  let anchorCount = 0;
  const restorations = legacyRestorations.map((legacy): Restoration => {
    const marginLines: Partial<Record<FdiTooth, MarginLine>> = {};
    for (const [toothKey, legacyMarginLine] of Object.entries(legacy.marginLines)) {
      if (!legacyMarginLine) continue;
      const migrated = migrateMarginLine(legacyMarginLine);
      marginLines[Number(toothKey) as FdiTooth] = migrated;
      marginLineCount++;
      anchorCount += migrated.anchors.length;
    }
    // `pontics`/`targetNodeId` (Phase 3 Task 2) did not exist on a real
    // schemaVersion-1 restoration — a v1 document predates the wizard that
    // introduced them, so `legacy` (typed as if they were always present,
    // per this file's existing "cast anyway" pattern) will actually lack
    // these keys at runtime. Backfill explicit, documented defaults rather
    // than silently spreading `undefined` through: `pontics: []` (no bridge
    // pontic marking existed pre-Task-2) and `targetNodeId: null` (no target
    // scan was ever recorded pre-Task-2 either — see `Restoration.targetNodeId`'s
    // doc, shared-types).
    return { ...legacy, pontics: legacy.pontics ?? [], targetNodeId: legacy.targetNodeId ?? null, marginLines };
  });
  return { restorations, stats: { restorationCount: legacyRestorations.length, marginLineCount, anchorCount } };
}

/**
 * Migrates a schemaVersion-1 `CaseDocument` to schemaVersion 2 — see this
 * module's top doc for the full contract and its documented limitation.
 * Appends ONE journal `Operation` (`migrate-schema-v1-to-v2`) summarizing
 * the change (CLAUDE.md invariant 5: data transformations get a journal
 * entry, never silent) — `inputHashes`/`outputHashes` stay empty since this
 * migration reshapes DOCUMENT STRUCTURE, not mesh content: no mesh geometry
 * is read or written, so there is no meaningful content hash to record
 * (unlike a geometry-mutating Operation, e.g. engine/repair.ts's
 * `applyRepairPreview`).
 */
export function migrateCaseDocumentV1ToV2(legacy: LegacyCaseDocumentV1): CaseDocument {
  const { restorations, stats } = migrateRestorations(legacy.restorations);
  const migrationOperation: Operation = {
    id: crypto.randomUUID(),
    name: 'migrate-schema-v1-to-v2',
    params: {
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      change: 'MarginLine.vertexAnchors/controlPoints -> MarginLine.anchors (MarginAnchor[])',
      restorationCount: stats.restorationCount,
      marginLineCount: stats.marginLineCount,
      anchorCount: stats.anchorCount,
      unresolvedAnchorCount: stats.anchorCount,
      unresolvedAnchorTriangleIndex: UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX,
      note:
        'Legacy vertexAnchors (nearest-vertex hints) were dropped (already non-authoritative in v1); ' +
        'controlPoints positions were carried through EXACTLY into anchors[].position. ' +
        'triangleIndex/barycentric could NOT be resolved against a real mesh at migration time (no ' +
        'Restoration -> target-mesh mapping exists yet — see Phase 3 Task 2) -- every migrated anchor ' +
        'uses the UNRESOLVED sentinel (triangleIndex -1) and must be re-snapped via the margin editor ' +
        'before being trusted for any surface-relative kernel operation.',
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: new Date().toISOString(),
  };

  return {
    ...legacy,
    schemaVersion: 2,
    restorations,
    history: [...legacy.history, migrationOperation],
  };
}

// ---------------------------------------------------------------------------
// schemaVersion-2 restoration-field backfill (Phase 3 Task 2 review fix)
// ---------------------------------------------------------------------------
//
// `Restoration.pontics`/`targetNodeId` (shared-types) were introduced by
// Phase 3 Task 2 as REQUIRED fields — but Task 1 already shipped
// schemaVersion 2 (this file's v1 -> v2 `MarginLine` migration above)
// *without* them, and the server never rejects an old row's already-stored
// JSON on GET (this module's top doc). So a case saved between Task 1 and
// Task 2 is tagged schemaVersion 2 on disk yet its restorations genuinely
// lack `pontics`/`targetNodeId` at runtime — not `undefined`-valued, the
// keys are simply absent from the JSON. Without this backfill that document
// loads fine at the `CaseDocument` type level (nothing here re-validates
// the GET response — same "untyped, cast anyway" situation the v1 migration
// document above), but crashes the very first render that touches
// `restoration.pontics` (ui/RestorationWizard.tsx) and then 400s the next
// save once the server's tightened schema (apps/server/src/schemas.ts)
// rejects the still-missing fields.
//
// Fix mirrors the v1 migration's shape: detect the missing keys, backfill
// documented defaults, journal it. Unlike the v1 migration (branched on
// `schemaVersion`), this is detected by FIELD PRESENCE, which is what makes
// it naturally exactly-once: once a document has been backfilled (and, via
// persistence.ts's `openCase` "wasMigrated" save-back — the same reference-
// inequality signal this function relies on below), every restoration DOES
// have both keys, so `restorationNeedsTask2Backfill` is false on every
// subsequent load and this whole path is skipped — no history-scanning
// needed to avoid a double journal entry.
//
// Defaults (matching `migrateRestorations`'s reasoning above, and
// `Restoration.pontics`/`targetNodeId`'s own docs, shared-types):
//   - `pontics: []` — no bridge pontic marking existed before Task 2; `[]`
//     is also the correct steady-state value for crown/inlay/onlay, so this
//     is never a lossy guess for those types, only an honest "never marked"
//     for a pre-Task-2 bridge.
//   - `targetNodeId: null` — no restoration had a target scan mapping
//     before Task 2 either. `null` is not a placeholder invented for this
//     migration: it is the SAME "no target scan assigned yet" state
//     `RestorationWizard.tsx`'s own `emptyDraft()` starts a brand-new
//     restoration in (`canSubmit` there requires `targetNodeId !== null`
//     before a restoration can even be created) — so a backfilled
//     restoration lands in a state the wizard already treats as valid and
//     recoverable ("finish assigning a target scan"), not a novel one.

/** A schemaVersion-2 `Restoration` as it could exist on disk for a document
 * saved between Phase 3 Task 1 (shipped schemaVersion 2) and Task 2 (added
 * `pontics`/`targetNodeId` to that SAME schemaVersion as required fields,
 * with no migration — see this module's "schemaVersion-2 restoration-field
 * backfill" doc above). `pontics`/`targetNodeId` are optional here
 * specifically to model "key absent from the JSON", which `Restoration`'s
 * own (current, required) shape cannot express. */
interface RawRestorationV2 extends Omit<Restoration, 'pontics' | 'targetNodeId'> {
  readonly pontics?: readonly FdiTooth[];
  readonly targetNodeId?: string | null;
}

function restorationNeedsTask2Backfill(restoration: RawRestorationV2): boolean {
  return !('pontics' in restoration) || !('targetNodeId' in restoration);
}

function backfillRestorationFields(restoration: RawRestorationV2): Restoration {
  return { ...restoration, pontics: restoration.pontics ?? [], targetNodeId: restoration.targetNodeId ?? null };
}

/**
 * Backfills `pontics`/`targetNodeId` on any schemaVersion-2 `CaseDocument`
 * restoration that predates their introduction (Phase 3 Task 2) — see this
 * module's "schemaVersion-2 restoration-field backfill" doc above. Returns
 * `document` BY REFERENCE, unchanged, when every restoration already has
 * both fields (the common case, and the only case once any given document
 * has been backfilled once) — `migrateCaseDocumentIfNeeded`'s callers (e.g.
 * persistence.ts's `openCase`) rely on that reference identity as their
 * "was this migrated" signal, same convention as `migrateCaseDocumentV1ToV2`.
 */
function backfillV2RestorationFieldsIfNeeded(document: CaseDocument): CaseDocument {
  const rawRestorations = document.restorations as readonly RawRestorationV2[];
  if (!rawRestorations.some(restorationNeedsTask2Backfill)) {
    return document;
  }

  let backfilledRestorationCount = 0;
  const restorations = rawRestorations.map((restoration): Restoration => {
    if (!restorationNeedsTask2Backfill(restoration)) {
      return restoration as Restoration;
    }
    backfilledRestorationCount += 1;
    return backfillRestorationFields(restoration);
  });

  const migrationOperation: Operation = {
    id: crypto.randomUUID(),
    name: 'migrate-backfill-restoration-fields',
    params: {
      schemaVersion: 2,
      change: 'Restoration.pontics/targetNodeId backfilled (added as REQUIRED fields to schemaVersion 2 by ' +
        'Phase 3 Task 2, with no migration at the time)',
      restorationCount: rawRestorations.length,
      backfilledRestorationCount,
      note:
        'pontics defaulted to [] (no bridge pontic marking existed before this field; also the correct ' +
        'steady-state value for crown/inlay/onlay); targetNodeId defaulted to null (no target-scan mapping ' +
        'existed before this field — the same "no target assigned" state RestorationWizard.tsx\'s own ' +
        'emptyDraft() starts a new restoration in).',
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: new Date().toISOString(),
  };

  return { ...document, restorations, history: [...document.history, migrationOperation] };
}

/**
 * Entry point for every document-load path (currently: persistence.ts's
 * `openCase`) — accepts whatever `GET /api/cases/:id` actually returned
 * (untyped: the server does not validate its own GET response shape, see
 * this module's top doc), migrates a schemaVersion-1 document, backfills a
 * schemaVersion-2 document missing Task 2's restoration fields (this
 * module's "schemaVersion-2 restoration-field backfill" doc above), and
 * passes an already-complete schemaVersion-2 document through unchanged
 * (by reference). Any OTHER `schemaVersion` value is a hard error (never
 * silently coerced) — this repo has never had a schemaVersion other than 1
 * or 2, so anything else means either corrupted data or a FUTURE schema
 * version this client build predates, neither of which this function can
 * safely guess how to handle.
 *
 * @throws {TypeError} if `raw` isn't even an object.
 * @throws {Error} if `raw.schemaVersion` is neither `1` nor `2`.
 */
export function migrateCaseDocumentIfNeeded(raw: unknown): CaseDocument {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('migrateCaseDocumentIfNeeded: expected a CaseDocument-shaped object');
  }
  const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 2) {
    return backfillV2RestorationFieldsIfNeeded(raw as CaseDocument);
  }
  if (schemaVersion === 1) {
    return migrateCaseDocumentV1ToV2(raw as LegacyCaseDocumentV1);
  }
  throw new Error(
    `migrateCaseDocumentIfNeeded: unsupported CaseDocument.schemaVersion ${JSON.stringify(schemaVersion)} (expected 1 or 2)`,
  );
}
