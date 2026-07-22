import type { CaseDocument } from '@dqcad/shared-types';

/**
 * Builds a minimal, structurally valid, empty CaseDocument for a freshly created case.
 * No clinical parameter values are chosen here (PLAN.md global constraint: no clinical
 * defaults outside packages/clinical-profiles) — `settings` only carries placeholder
 * identifiers, not material/measurement defaults.
 */
export function createEmptyCaseDocument(id: string, createdAt: string): CaseDocument {
  return {
    id,
    schemaVersion: 2,
    createdAt,
    meshes: [],
    scene: [],
    restorations: [],
    measurements: [],
    history: [],
    settings: {
      materialProfileId: 'unassigned',
      profileVersion: '0.0.0',
    },
  };
}
