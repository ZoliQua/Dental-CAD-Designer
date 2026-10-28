// test/golden/crown-open-arch-acceptance.test.ts
//
// Phase 10 Task 3 — THE ACCEPTANCE of the crown on an OPEN scan (phase
// acceptance 1 + 2, ADR-023 Decision 1). The closed-form open-arch prep case
// (kernel die/die.test-fixtures.ts `openArchPrepCase`: a shouldered prep die
// and two neighbour crowns on an open gingival sheet with a base cut) is
// imported through binary STL as the app imports it, and driven through the
// REAL client controller (engine/crownDesign.ts) on a real Node WorkerPool:
//
//   prepare die → intaglio → capture 21 / 12 from the scan (one pick each)
//   → anatomy (the BUILT-IN template, the current default) → morph → shell
//   → QC.
//
// Asserted:
//   1. the QC verdict, measured on case geometry (no stand-in): seven of the
//      eight crown gates pass — watertight, manifold, self-intersection,
//      margin fit (0.00 µm), seating on the extracted die, connector (N/A)
//      and contact against the captured neighbours. `minWallThickness` FAILS,
//      honestly: the built-in template is plane-trimmed at the margin, so its
//      cervical wall is a wedge, ~0.20 mm thick 0.2 mm above the margin (just
//      outside the profile's 0.2 mm finish-line band) on the crown solid as
//      built. The gate is right; the cure is the cervical fit (Task 4), and
//      the all-gates-pass lane is the fitted library template's (Task 5);
//   2. the die is certified: a synthetic floor closes the open scan, and its
//      clearance (≥ the required clearance, and covering the intaglio built)
//      is journaled with the die op;
//   3. every stage op names the case inputs it consumed (the scan, the die,
//      the captures);
//   4. the pipeline twin (`runPrepDieStage`) cuts the identical die from the
//      same scan — the engine, the pipeline and (export-die.test.ts) the
//      server agree;
//   5. a fresh session rebuilt from the same case reproduces every stage hash
//      bit-identically (pinned in test-fixtures/golden/crown-open-arch.json,
//      version-guarded).
//
// Plus an env-gated real lane (RUN_CROWN_REAL_DIE=1): real arch-case-01 tooth
// 11 through die extraction and the intaglio, recording the certificate and
// the intaglio's margin fit. The tooth is unprepared, so only these two
// stages are asserted.
//
// It lives in test/ because it needs the client engine and the kernel's test
// fixtures together (the bridge-case-acceptance precedent).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_VERSION, WorkerPool } from '@dqcad/kernel-workers';
import { parseStl, writeStlBinary } from '@dqcad/io';
import {
  AXIS_DEFAULT_ROI_RADIUS_MM,
  PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM,
  analyzeMesh,
  buildBvh,
  buildHalfedge,
  assertPrepDieCoversInnerSurface,
  extractMarginRegion,
  findBoundaryLoops,
  intake,
  prepDieInnerSurfaceNeeds,
  suggestInsertionAxis,
  type IndexedMesh,
} from '@dqcad/kernel';
import { openArchPrepCase } from '@dqcad/kernel/die-fixtures';
import { marginFitGate, runInnerSurfaceStage, runPrepDieStage, type PipelineMaterialProfile } from '@dqcad/cad-pipeline';
import { CROWN_DIE_EXTRACT_OP, NEIGHBOUR_CAPTURE_OP, type FdiTooth, type QcReport, type Vec3 } from '@dqcad/shared-types';
import { caseStore } from '../../apps/client/src/engine/caseStore.ts';
import { crownDesignEngine, type RunnablePool } from '../../apps/client/src/engine/crownDesign.ts';
import { createRestoration } from '../../apps/client/src/engine/restorations.ts';
import { useServerStatusStore } from '../../apps/client/src/state/serverStatusStore.ts';
import type { MeshStats } from '../../apps/client/src/engine/repair.ts';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

const TOOTH = 11 as FdiTooth;
/** The intaglio pitch (a journaled parameter): coarser than the clinical
 * 20 µm to keep the golden in minutes — the bridge-case golden's pitch. */
const PITCH_MM = 0.06;
const EXPECTED_KERNEL_VERSION = '0.33.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';
const PRINT = process.env['PRINT_CROWN_OPEN_ARCH_PINS'] === '1';
const RUN_REAL = process.env['RUN_CROWN_REAL_DIE'] === '1';

interface Pin {
  kernelVersion: string;
  manifoldVersion: string;
  stages: Record<string, string>;
}
const PIN_PATH = join(repoRoot, 'test-fixtures', 'golden', 'crown-open-arch.json');
const PIN = PRINT ? null : (JSON.parse(readFileSync(PIN_PATH, 'utf8')) as Pin);

const STATS: MeshStats = {
  watertight: false,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: null,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

const pool = new WorkerPool();

/** The scan as the app imports it: binary STL bytes (Float32 vertices)
 * parsed and welded by the same intake the import worker runs. */
function viaStl(mesh: IndexedMesh): IndexedMesh {
  const triangleCount = mesh.indices.length / 3;
  const soup = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]!;
      for (let k = 0; k < 3; k++) soup[t * 9 + v * 3 + k] = mesh.positions[vi * 3 + k]!;
    }
  }
  const bytes = writeStlBinary({ positions: soup, normals: null, triangleCount });
  return intake({ kind: 'soup', soup: parseStl(bytes).soup }).mesh;
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** What a click on the scan gives: the scan vertex nearest `target`. */
function pickOn(scan: IndexedMesh, target: Vec3): Vec3 {
  let best = Infinity;
  let at: Vec3 = [0, 0, 0];
  for (let i = 0; i < scan.positions.length; i += 3) {
    const d = Math.hypot(scan.positions[i]! - target[0], scan.positions[i + 1]! - target[1], scan.positions[i + 2]! - target[2]);
    if (d < best) {
      best = d;
      at = [scan.positions[i]!, scan.positions[i + 1]!, scan.positions[i + 2]!];
    }
  }
  return at;
}

const arch = openArchPrepCase();
const scan = viaStl(arch.scan);
/** The confirmed margin as the imported (Float32) scan holds it. */
const marginLoop: Vec3[] = arch.marginLoop.map((p): Vec3 => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])]);

/** A fresh case: the open scan + a crown on 11 with its margin and axis. */
async function setupCase(): Promise<{ restorationId: string; scanMeshId: string }> {
  caseStore.resetForTests();
  crownDesignEngine.resetForTests();
  crownDesignEngine.__setPoolForTests(pool as unknown as RunnablePool);
  useServerStatusStore.getState().setStatus('online');
  const { contentHash } = await pool.run('hashMesh', { positions: scan.positions.slice(), indices: scan.indices.slice() });
  caseStore.registerImportedMesh({
    contentHash,
    name: 'open-arch-prep-11.stl',
    format: 'stl',
    positions: scan.positions,
    indices: scan.indices,
    stats: STATS,
    report: { weldEpsilonMm: 1e-6, steps: [] },
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, 'upperJaw');
  const restoration = createRestoration({ type: 'crown', teeth: [TOOTH], targetNodeId: node.id });
  caseStore.updateRestoration(
    {
      ...restoration,
      marginLines: { [TOOTH]: { anchors: [], closed: true, resampledPoints: marginLoop } },
      insertionAxis: arch.insertionAxis,
    },
    {
      id: 'op-margin-axis',
      name: 'margin-edit',
      params: {},
      inputHashes: [],
      outputHashes: [],
      kernelVersion: 'test',
      timestamp: new Date(0).toISOString(),
    },
  );
  return { restorationId: restoration.id, scanMeshId: contentHash };
}

function restorationOf(id: string) {
  return caseStore.getDocument().restorations.find((r) => r.id === id)!;
}

function opOf(name: string) {
  return caseStore.getDocument().history.filter((o) => o.name === name).pop()!;
}

/** The whole crown through the real controller. Mesial (21) lies at −X, the
 * built-in placement's convention; each neighbour is picked on its crown. */
async function designCrown(): Promise<{ restorationId: string; scanMeshId: string; report: QcReport; stages: Record<string, string> }> {
  const ids = await setupCase();
  const n = arch.params.neighbours!;
  crownDesignEngine.start(ids.restorationId);
  await crownDesignEngine.runPrepDie();
  await crownDesignEngine.runInnerSurface({ pitchMm: PITCH_MM });
  await crownDesignEngine.captureNeighbour('mesial', pickOn(scan, [-n.centreMm, 0, n.heightMm]));
  await crownDesignEngine.captureNeighbour('distal', pickOn(scan, [n.centreMm, 0, n.heightMm]));
  await crownDesignEngine.placeAnatomyAuto();
  await crownDesignEngine.runMorph();
  await crownDesignEngine.constructShell();
  await crownDesignEngine.runQc();
  const r = restorationOf(ids.restorationId);
  return { ...ids, report: r.qc!, stages: { ...(r.stages as Record<string, string>) } };
}

function table(report: QcReport): string {
  return report.gates.map((g) => `  ${g.passed ? '✓' : '✗'} ${g.gate.padEnd(22)} ${g.message.slice(0, 170)}`).join('\n');
}

beforeAll(() => {
  const manifold = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8')) as { version: string };
  expect(manifold.version, 'the pins below are valid for this manifold-3d version only').toBe(EXPECTED_MANIFOLD_VERSION);
  expect(KERNEL_VERSION, 'the stage pins are valid for this kernel version only').toBe(EXPECTED_KERNEL_VERSION);
  if (PIN) {
    expect(PIN.kernelVersion).toBe(EXPECTED_KERNEL_VERSION);
    expect(PIN.manifoldVersion).toBe(EXPECTED_MANIFOLD_VERSION);
  }
});

afterAll(async () => {
  crownDesignEngine.resetForTests();
  caseStore.resetForTests();
  useServerStatusStore.getState().setStatus('unknown');
  await pool.destroy();
});

const GATES = [
  'watertight',
  'manifold',
  'selfIntersection',
  'minWallThickness',
  'marginFit',
  'seating',
  'connectorCrossSection',
  'contact',
];

describe('Phase 10 Task 3 — the crown on an open scan (built-in template)', () => {
  it('the imported scan is open (one base-cut boundary) — the die must be closed synthetically', () => {
    const stats = analyzeMesh(scan);
    expect(stats.watertight).toBe(false);
    expect(findBoundaryLoops(buildHalfedge(scan))).toHaveLength(1);
  });

  it('seven gates pass on case geometry, the cervical wall fails honestly; the die is certified; every stage op names its inputs; the hashes are pinned', async () => {
    const { restorationId, scanMeshId, report, stages } = await designCrown();
    console.log(`[crown-open-arch] kernel ${EXPECTED_KERNEL_VERSION}, pitch ${PITCH_MM} mm\n${table(report)}`);

    // 1. The verdict, measured on case geometry.
    expect(report.gates.map((g) => g.gate)).toEqual(GATES);
    for (const g of report.gates) {
      expect(g.inputProvenance, g.gate).toBeUndefined();
      if (g.gate === 'minWallThickness') continue;
      expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    }
    // The built-in template's plane-trimmed cervical wedge (see the module
    // doc): thinner than the profile minimum just above the finish-line band.
    const wall = report.gates.find((g) => g.gate === 'minWallThickness')!;
    expect(wall.passed, wall.message).toBe(false);
    expect(wall.value!).toBeGreaterThan(0.1);
    expect(wall.value!).toBeLessThan(wall.threshold!);
    expect(report.passed).toBe(false);

    // 2. The die: closed synthetically, certified, journaled.
    const dieOp = opOf(CROWN_DIE_EXTRACT_OP);
    const p = dieOp.params;
    console.log(
      `[crown-open-arch] die kept=${String(p['keptTriangleCount'])} synthetic=${String(p['syntheticTriangleCount'])} ` +
        `folds dropped=${String(p['foldTrianglesDropped'])} clearance=${String(p['clearanceMm'])} mm ` +
        `floor=${String(p['floorHeightMm'])} volume=${String(p['volumeMm3'])} mm³`,
    );
    expect(dieOp.inputHashes).toEqual([scanMeshId]);
    expect(dieOp.outputHashes).toEqual([stages['prepDie']]);
    expect(p['scanForm']).toBe('persisted-stl');
    expect(p['syntheticTriangleCount'] as number).toBeGreaterThan(0);
    expect(p['floorHeightMm']).not.toBeNull();
    const clearanceMm = p['clearanceMm'] as number;
    expect(clearanceMm).toBeGreaterThanOrEqual(PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM);
    const rp = restorationOf(restorationId).params;
    const needs = prepDieInnerSurfaceNeeds({ marginalGapMm: rp.marginalGapMm, cementGapMm: rp.cementGapMm }, PITCH_MM);
    expect(clearanceMm).toBeGreaterThanOrEqual(needs.requiredClearanceMm);

    // 3. Every stage op names the case inputs it consumed.
    expect(opOf('crown-inner-surface').inputHashes).toContain(stages['prepDie']);
    const captures = caseStore
      .getDocument()
      .history.filter((o) => o.name === NEIGHBOUR_CAPTURE_OP && o.params['restorationId'] === restorationId);
    expect(captures.map((o) => o.params['side']).sort()).toEqual(['distal', 'mesial']);
    for (const c of captures) expect(c.inputHashes[0]).toBe(scanMeshId);
    const anatomy = opOf('crown-anatomy');
    for (const c of captures) expect(anatomy.inputHashes).toContain(c.outputHashes[0]);
    expect(anatomy.params['neighbourProvenance']).toBe('case');
    expect(anatomy.params['anatomySource']).toMatchObject({ origin: 'builtin' });

    // 4. The pipeline twin cuts the identical die.
    const twin = runPrepDieStage(
      {
        restorationId,
        restorationType: 'crown',
        materialProfile: { restorationParams: rp } as PipelineMaterialProfile,
        insertionAxis: arch.insertionAxis,
        targetMesh: { contentHash: scanMeshId, mesh: scan },
        marginLoops: { [TOOTH]: { closed: true, resampledPoints: marginLoop } },
        neighbors: {},
        antagonist: null,
        stages: {},
      },
      TOOTH,
      { hashMesh },
    );
    expect(twin.meshContentHash).toBe(stages['prepDie']);

    // 5. The pins (recorded by an independent run). Re-pin mode
    // (PRINT_CROWN_OPEN_ARCH_PINS=1, after a deliberate change) prints them.
    if (PIN) expect(stages).toEqual(PIN.stages);
    else console.log(`[crown-open-arch][pins] ${JSON.stringify(stages)}`);
  }, 1_800_000);
});

interface Reference {
  resampledPoints: readonly [number, number, number][];
  anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
}

// The real lane runs the PIPELINE twin (the die stage, then the intaglio
// stage on the die, as the engine does) — the engine on this scan is covered
// by e2e phase9-crown.
describe.skipIf(!RUN_REAL)('Phase 10 Task 3 — REAL arch-case-01 tooth 11: die + intaglio [RUN_CROWN_REAL_DIE=1]', () => {
  it('extracts a certified die from the open scan and builds the intaglio on it; records the margin fit', async () => {
    const upper = loadUpperjawMesh();
    const ref = JSON.parse(
      readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', '11.reference.json'), 'utf8'),
    ) as Reference;
    const loop: Vec3[] = ref.resampledPoints.map((q) => [q[0], q[1], q[2]]);
    const seeds = ref.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric as Vec3 }));
    const axis = suggestInsertionAxis(
      upper,
      buildBvh(upper),
      extractMarginRegion(upper, buildHalfedge(upper), seeds, AXIS_DEFAULT_ROI_RADIUS_MM),
    ).best.direction;
    const restorationParams = {
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.8,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    };
    const ctx = {
      restorationId: 'arch-case-01-11',
      restorationType: 'crown' as const,
      materialProfile: { restorationParams } as PipelineMaterialProfile,
      insertionAxis: axis,
      targetMesh: { contentHash: hashMesh(upper), mesh: upper },
      marginLoops: { [TOOTH]: { closed: true, resampledPoints: loop } },
      neighbors: {},
      antagonist: null,
      stages: {},
    };
    const t0 = performance.now();
    const die = runPrepDieStage(ctx, TOOTH, { hashMesh });
    const dieMs = performance.now() - t0;
    expect(die.die.floorHeightMm).not.toBeNull();
    expect(die.die.clearanceMm).toBeGreaterThanOrEqual(PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM);
    // The certificate covers this intaglio (the worker job's check).
    assertPrepDieCoversInnerSurface(die.die, restorationParams, PITCH_MM);

    const t1 = performance.now();
    const inner = await runInnerSurfaceStage(
      { ...ctx, targetMesh: { contentHash: die.meshContentHash!, mesh: die.mesh! } },
      TOOTH,
      { pitchMm: PITCH_MM, hashMesh },
    );
    const innerMs = performance.now() - t1;
    const fit = marginFitGate({ innerSurfaceMesh: inner.mesh!, marginResampledPoints: loop });
    console.log(
      `[CROWN-REAL-DIE #11] die kept=${die.die.keptTriangleCount} synthetic=${die.die.syntheticTriangleCount} ` +
        `folds dropped=${die.die.foldTrianglesDropped} clearance=${die.die.clearanceMm.toFixed(4)} mm (${dieMs.toFixed(0)} ms); ` +
        `intaglio ${inner.mesh!.indices.length / 3} tris at ${PITCH_MM} mm (${innerMs.toFixed(0)} ms); ${fit.message}`,
    );
    expect(analyzeMesh(die.mesh!).watertight).toBe(true);
    expect(fit.passed, fit.message).toBe(true);
  }, 1_800_000);
});
