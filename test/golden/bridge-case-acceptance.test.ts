// test/golden/bridge-case-acceptance.test.ts
//
// Phase 9 Task 6 — THE ACCEPTANCE of the bridge built from the case (phase
// acceptance 3 + 4): the closed-form 14-15-16 arch case (two prepped
// abutments in one target scan, a separate gingiva scan, the confirmed margins,
// the shared axis — apps/client/src/engine/archBridgeFixture.asset.json) is
// driven through the REAL client controller (engine/bridgeDesign.ts
// `startFromCase` → every stage → QC) on a real Node WorkerPool, with the
// tooth-library body for 15 served as the server would serve it. Asserted:
//
//   1. all 11 bridge gates pass, for every pontic style;
//   2. every stage op carries the case inputs it consumed (target scan,
//      margin loops, gingiva scan, library asset, upstream stages);
//   3. a fresh session rebuilt from the same case reproduces every stage hash
//      bit-identically (pinned below, version-guarded);
//   4. the demonstration bridge — now an explicit `startDemo` — fails every
//      gate closed, so it can never pass for export.
//
// It lives in test/ because it needs BOTH the client engine and
// `@dqcad/tooth-library` (the engine itself may not import the library — it
// fetches it), the bridge-acceptance precedent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_VERSION, WorkerPool } from '@dqcad/kernel-workers';
import { STARTER_TOOTH_ASSETS } from '@dqcad/tooth-library';
import { parseStl, writeStlBinary } from '@dqcad/io';
import { intake } from '@dqcad/kernel';
import type { FdiTooth, QcReport, Vec3 } from '@dqcad/shared-types';
import { caseStore } from '../../apps/client/src/engine/caseStore.ts';
import { bridgeDesignEngine, type RunnablePool } from '../../apps/client/src/engine/bridgeDesign.ts';
import { createRestoration } from '../../apps/client/src/engine/restorations.ts';
import { __resetToothLibraryCacheForTests } from '../../apps/client/src/engine/toothLibrary.ts';
import { useServerStatusStore } from '../../apps/client/src/state/serverStatusStore.ts';
import type { MeshStats } from '../../apps/client/src/engine/repair.ts';
import type { PonticStyleName } from '../../apps/client/src/state/bridgeStore.ts';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';

const PITCH_MM = 0.06;
const EXPECTED_KERNEL_VERSION = '0.36.0';
const EXPECTED_MANIFOLD_VERSION = '3.5.1';

const asset = JSON.parse(readFileSync(join(repoRoot, 'apps', 'client', 'src', 'engine', 'archBridgeFixture.asset.json'), 'utf8')) as {
  teeth: number[];
  ponticTooth: number;
  insertionAxis: number[];
  targetScan: { positions: number[]; indices: number[] };
  gingiva: { positions: number[]; indices: number[] };
  abutments: { tooth: number; marginLoop: number[][] }[];
};

interface Pin {
  kernelVersion: string;
  manifoldVersion: string;
  stages: Record<string, Record<string, string>>;
}
const PIN_PATH = join(repoRoot, 'test-fixtures', 'golden', 'bridge-case-real-path.json');
const PIN = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as Pin;

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

/** The tooth library as the server serves it (metadata + mesh bytes). */
const libraryFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const fdiMatch = /^\/api\/tooth-library\/(\d+)$/.exec(url);
  if (fdiMatch) {
    const starter = STARTER_TOOTH_ASSETS.get(Number(fdiMatch[1]) as FdiTooth);
    return starter ? Response.json(starter.metadata) : new Response('', { status: 404 });
  }
  const meshMatch = /^\/api\/meshes\/([0-9a-f]{64})$/.exec(url);
  if (meshMatch) {
    for (const starter of STARTER_TOOTH_ASSETS.values()) {
      if (starter.metadata.meshChecksum === meshMatch[1]) return new Response(new Uint8Array(starter.meshBytes));
    }
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

/** The scan as the app imports it: binary STL bytes (Float32 vertices)
 * parsed and welded by the same intake the import worker runs. */
function viaStl(mesh: { positions: number[]; indices: number[] }): { positions: Float64Array; indices: Uint32Array } {
  const triangleCount = mesh.indices.length / 3;
  const soup = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]!;
      for (let k = 0; k < 3; k++) soup[t * 9 + v * 3 + k] = mesh.positions[vi * 3 + k]!;
    }
  }
  const bytes = writeStlBinary({ positions: soup, normals: null, triangleCount });
  const parsed = parseStl(bytes).soup;
  return intake({ kind: 'soup', soup: parsed }).mesh;
}

async function register(name: string, source: { positions: number[]; indices: number[] }, role: 'upperJaw' | 'gingiva') {
  const imported = viaStl(source);
  const positions = imported.positions;
  const indices = imported.indices;
  const { contentHash } = await pool.run('hashMesh', { positions: positions.slice(), indices: indices.slice() });
  caseStore.registerImportedMesh({
    contentHash,
    name,
    format: 'stl',
    positions,
    indices,
    stats: STATS,
    report: { weldEpsilonMm: 1e-6, steps: [] },
    operations: [],
  });
  return caseStore.addSceneNode(contentHash, role);
}

/** A fresh case: the arch scan + gingiva scan + a 14-15-16 bridge with its
 * confirmed margins and axis. */
async function setupCase(): Promise<string> {
  caseStore.resetForTests();
  bridgeDesignEngine.resetForTests();
  __resetToothLibraryCacheForTests();
  bridgeDesignEngine.__setPoolForTests(pool as unknown as RunnablePool);
  bridgeDesignEngine.__setToothLibraryFetchForTests(libraryFetch);
  useServerStatusStore.getState().setStatus('online');
  const target = await register('arch-14-16.stl', asset.targetScan, 'upperJaw');
  await register('gingiva-15.stl', asset.gingiva, 'gingiva');
  const restoration = createRestoration({ type: 'bridge', teeth: asset.teeth as FdiTooth[], pontics: [asset.ponticTooth as FdiTooth], targetNodeId: target.id });
  const marginLines: Record<number, { anchors: []; closed: true; resampledPoints: Vec3[] }> = {};
  for (const a of asset.abutments) {
    // The shoulder ring as the imported (Float32) scan holds it.
    marginLines[a.tooth] = {
      anchors: [],
      closed: true,
      resampledPoints: a.marginLoop.map((p) => [Math.fround(p[0]!), Math.fround(p[1]!), Math.fround(p[2]!)] as Vec3),
    };
  }
  caseStore.updateRestoration(
    { ...restoration, marginLines, insertionAxis: [asset.insertionAxis[0]!, asset.insertionAxis[1]!, asset.insertionAxis[2]!] },
    {
      id: 'op-margins-axis',
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

function restorationOf(id: string) {
  return caseStore.getDocument().restorations.find((r) => r.id === id)!;
}

function opOf(name: string) {
  return caseStore.getDocument().history.filter((o) => o.name === name).pop()!;
}

/** Commits every stage after the abutment surfaces for `style`. A new pontic
 * style invalidates everything downstream of the abutment surfaces, so one
 * session cycles through the styles without rebuilding the abutments. */
async function runStyle(id: string, style: PonticStyleName): Promise<{ report: QcReport; stages: Record<string, string> }> {
  await bridgeDesignEngine.commitPontic(style);
  await bridgeDesignEngine.commitConnectors();
  await bridgeDesignEngine.selectFramework('fullContour');
  await bridgeDesignEngine.runAssembly();
  await bridgeDesignEngine.runQc();
  const r = restorationOf(id);
  return { report: r.qc!, stages: { ...(r.stages as Record<string, string>) } };
}

function table(report: QcReport): string {
  return report.gates
    .map((g) => `  ${g.passed ? '✓' : '✗'} ${g.gate.padEnd(22)} ${g.message.slice(0, 170)}`)
    .join('\n');
}

beforeAll(() => {
  const manifold = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'manifold-3d', 'package.json'), 'utf8')) as { version: string };
  expect(manifold.version, 'the pins below are valid for this manifold-3d version only').toBe(EXPECTED_MANIFOLD_VERSION);
  expect(KERNEL_VERSION, 'the stage pins are valid for this kernel version only').toBe(EXPECTED_KERNEL_VERSION);
  expect(PIN.kernelVersion).toBe(EXPECTED_KERNEL_VERSION);
  expect(PIN.manifoldVersion).toBe(EXPECTED_MANIFOLD_VERSION);
});

afterAll(async () => {
  bridgeDesignEngine.resetForTests();
  caseStore.resetForTests();
  useServerStatusStore.getState().setStatus('unknown');
  await pool.destroy();
});

const GATES = [
  'watertight',
  'manifold',
  'selfIntersection',
  'minWallThickness:14',
  'minWallThickness:15',
  'minWallThickness:16',
  'connectorCrossSection',
  'marginFit:14',
  'marginFit:16',
  'ponticRelief',
  'seating',
];

describe('Phase 9 Task 6 — the bridge built from the case', () => {
  it('passes all 11 gates for every pontic style; every stage hash is pinned; the journal proves its inputs', async () => {
    const id = await setupCase();
    await bridgeDesignEngine.startFromCase(id, { pitchMm: PITCH_MM });
    await bridgeDesignEngine.commitAbutmentSurfaces();
    const doc = caseStore.getDocument();
    const target = doc.scene.find((n) => n.role === 'upperJaw')!;
    const gingiva = doc.scene.find((n) => n.role === 'gingiva')!;

    for (const style of ['hygienic', 'ridgeLap', 'ovate'] as const) {
      const { report, stages } = await runStyle(id, style);
      console.log(`[bridge-case][${style}] kernel ${EXPECTED_KERNEL_VERSION}\n${table(report)}`);
      expect(report.gates.map((g) => g.gate)).toEqual(GATES);
      for (const g of report.gates) {
        expect(g.passed, `${style} ${g.gate}: ${g.message}`).toBe(true);
        expect(g.inputProvenance, g.gate).toBeUndefined();
      }
      expect(report.passed).toBe(true);
      // Re-pin mode (PRINT_BRIDGE_CASE_PINS=1, after a deliberate change)
      // prints every style's hashes instead of asserting them.
      if (process.env.PRINT_BRIDGE_CASE_PINS === '1') console.log(`[bridge-case][pins] ${style} ${JSON.stringify(stages)}`);
      // Replay proof: the pins were recorded by an independent run.
      else expect(stages, style).toEqual(PIN.stages[style]);

      // Phase acceptance 4: every stage op names the case inputs it consumed.
      const abut = opOf('bridge-abutment-surfaces');
      expect(abut.params['geometrySource']).toBe('case');
      expect(abut.inputHashes[0]).toBe(target.meshId);
      expect(abut.inputHashes).toHaveLength(3); // the scan + the two margin loops
      const pontic = opOf('bridge-pontic');
      expect(pontic.params['style']).toBe(style);
      expect(pontic.params['geometrySource']).toBe('case');
      expect(pontic.inputHashes[0]).toBe(gingiva.meshId);
      expect(pontic.inputHashes).toContain(stages['bridgeAbutmentSurfaces']);
      expect(pontic.inputHashes).toContain(STARTER_TOOTH_ASSETS.get(15 as FdiTooth)!.metadata.meshChecksum);
      expect(pontic.params['ponticTemplate']).toMatchObject({ origin: 'library' });
      expect(opOf('bridge-connectors').inputHashes).toEqual([stages['bridgeAbutmentSurfaces'], stages['bridgePontic']]);
      expect(opOf('bridge-assembly').inputHashes).toEqual([
        stages['bridgeAbutmentSurfaces'],
        stages['bridgePontic'],
        stages['bridgeConnectors'],
      ]);
    }
  }, 1_200_000);
});

describe('Phase 9 Task 6 — demo mode is explicit and cannot pass for export', () => {
  it('the demonstration bridge fails every gate closed (demo-fixture); the hard gates cannot be acknowledged', async () => {
    const id = await setupCase();
    bridgeDesignEngine.startDemo(id);
    await bridgeDesignEngine.commitAbutmentSurfaces();
    await bridgeDesignEngine.commitPontic('hygienic');
    await bridgeDesignEngine.commitConnectors();
    await bridgeDesignEngine.selectFramework('fullContour');
    await bridgeDesignEngine.runAssembly();
    await bridgeDesignEngine.runQc();
    const report = restorationOf(id).qc!;
    expect(report.passed).toBe(false);
    for (const g of report.gates) {
      expect(g.passed, g.gate).toBe(false);
      expect(g.inputProvenance, g.gate).toBe('demo-fixture');
    }
    expect(opOf('bridge-abutment-surfaces').params['geometrySource']).toBe('demo');
    // A hard structural gate cannot be acknowledged past — the demo can never
    // reach a passing (exportable) report.
    await expect(bridgeDesignEngine.acknowledgeGate('watertight')).rejects.toThrow(/HARD/);
    expect(restorationOf(id).qc!.passed).toBe(false);
  }, 600_000);
});
