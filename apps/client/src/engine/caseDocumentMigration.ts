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
    return { ...legacy, marginLines };
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

/**
 * Entry point for every document-load path (currently: persistence.ts's
 * `openCase`) — accepts whatever `GET /api/cases/:id` actually returned
 * (untyped: the server does not validate its own GET response shape, see
 * this module's top doc), migrates a schemaVersion-1 document, and passes a
 * schemaVersion-2 document through unchanged. Any OTHER `schemaVersion`
 * value is a hard error (never silently coerced) — this repo has never had
 * a schemaVersion other than 1 or 2, so anything else means either
 * corrupted data or a FUTURE schema version this client build predates,
 * neither of which this function can safely guess how to handle.
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
    return raw as CaseDocument;
  }
  if (schemaVersion === 1) {
    return migrateCaseDocumentV1ToV2(raw as LegacyCaseDocumentV1);
  }
  throw new Error(
    `migrateCaseDocumentIfNeeded: unsupported CaseDocument.schemaVersion ${JSON.stringify(schemaVersion)} (expected 1 or 2)`,
  );
}
