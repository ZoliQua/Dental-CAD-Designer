// apps/client/src/engine/cavityNeighbourSide.regression.test.ts
//
// Phase 9 Task 2 regression — the cavity contacts stage paired each proximal
// box face with a neighbour by the sign of its WORLD x (`x < 0` ⇒ mesial),
// which is only right for an origin-centred fixture. On a real scan (arbitrary
// placement) both faces of an MOD cavity can land on the same side of world
// zero, so both were adapted to the SAME neighbour box. The side is now taken
// along the mesio-distal direction relative to the cavity outline centroid.
//
// Fixture: the committed analytic MOD cavity (engine/modCavityFixture.asset.json)
// translated off-origin by a fixed vector, driven through the REAL kernel jobs
// (Node WorkerPool). Pinned in test-fixtures/regression/cavity-neighbour-side.json:
// the per-box labels and the adapted patch's content hash.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkerPool } from '@dqcad/kernel-workers';
import { caseStore } from './caseStore';
import { cavityDesignEngine, type RunnablePool } from './cavityDesign';
import { buildModCavity } from './cavityGeometry';
import { createRestoration } from './restorations';
import { useCavityStore } from '../state/cavityStore';
import type { MeshStats } from './repair';

interface RegressionPin {
  translationMm: [number, number, number];
  fitPitchMm: number;
  expectedBoxLabels: string[];
  expectedProximalContactsHash: string;
  expectedOriginProximalContactsHash: string;
}

const PIN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../test-fixtures/regression/cavity-neighbour-side.json', import.meta.url),
    ),
    'utf8',
  ),
) as RegressionPin;

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

const pool = new WorkerPool();

function setupCase(translation: readonly [number, number, number]): string {
  const fx = buildModCavity();
  const positions = Float64Array.from(fx.mesh.positions, (v, i) => v + translation[i % 3]!);
  const outline = fx.cavityOutline.map(
    (p) => [p[0] + translation[0], p[1] + translation[1], p[2] + translation[2]] as const,
  );
  caseStore.registerImportedMesh({
    contentHash: `mod-${translation.join('_')}`,
    name: 'tooth.stl',
    format: 'stl',
    positions,
    indices: fx.mesh.indices,
    stats: STATS,
    report: { weldEpsilonMm: 1e-6, steps: [] },
    operations: [],
  });
  const node = caseStore.addSceneNode(`mod-${translation.join('_')}`, 'prepDie');
  const restoration = createRestoration({ type: 'inlay', teeth: [16], targetNodeId: node.id });
  caseStore.updateRestoration(
    {
      ...restoration,
      marginLines: { 16: { anchors: [], closed: true, resampledPoints: outline } },
    },
    {
      id: 'op-outline',
      name: 'margin-edit',
      params: {},
      inputHashes: [],
      outputHashes: [],
      kernelVersion: 'test',
      timestamp: new Date(0).toISOString(),
    },
  );
  return restoration.id;
}

async function runContacts(translation: readonly [number, number, number]) {
  const id = setupCase(translation);
  cavityDesignEngine.start(id);
  await cavityDesignEngine.runFit({ pitchMm: PIN.fitPitchMm });
  await cavityDesignEngine.runPatch();
  await cavityDesignEngine.runContacts();
  const contacts = useCavityStore.getState().contacts!;
  const hash = caseStore.getDocument().restorations.find((r) => r.id === id)!.stages
    .proximalContacts!;
  return { contacts, hash };
}

beforeEach(() => {
  caseStore.resetForTests();
  cavityDesignEngine.resetForTests();
  cavityDesignEngine.__setPoolForTests(pool as unknown as RunnablePool);
});
afterEach(() => {
  cavityDesignEngine.resetForTests();
  caseStore.resetForTests();
});
afterAll(async () => {
  await pool.destroy();
});

describe('cavity contacts — neighbour side is chosen along the MD direction, not by world x (Phase 9 Task 2)', () => {
  it('off-origin MOD: one mesial + one distal box, matching the origin-centred result; output hash pinned', async () => {
    const origin = await runContacts([0, 0, 0]);
    caseStore.resetForTests();
    cavityDesignEngine.resetForTests();
    cavityDesignEngine.__setPoolForTests(pool as unknown as RunnablePool);
    const moved = await runContacts(PIN.translationMm);

    const labels = (c: typeof moved.contacts) => c.boxes.map((b) => b.label);
    expect(labels(origin.contacts)).toEqual(PIN.expectedBoxLabels);
    expect(labels(moved.contacts)).toEqual(PIN.expectedBoxLabels);
    // Translation-equivariant: each box reaches its target the same way.
    moved.contacts.boxes.forEach((b, i) => {
      const o = origin.contacts.boxes[i]!;
      expect(b.clampBound).toBe(o.clampBound);
      expect(Math.abs(b.contactResidualMm - o.contactResidualMm)).toBeLessThan(1e-6);
    });
    expect(moved.hash).toBe(PIN.expectedProximalContactsHash);
    // The origin-centred case was already paired correctly — its output is
    // byte-identical to the pre-fix code (pinned before the fix landed).
    expect(origin.hash).toBe(PIN.expectedOriginProximalContactsHash);
  }, 300_000);
});
