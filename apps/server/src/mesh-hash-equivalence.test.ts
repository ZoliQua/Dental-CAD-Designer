// apps/server/src/mesh-hash-equivalence.test.ts
//
// THE cross-package guard for server-side reproducibility (Task 11 review
// follow-up). The server's `journal-replay.ts` `hashMesh` and the CLIENT's
// `@dqcad/kernel-workers` `hashMeshContent` are two independent implementations
// of the SAME mesh content hash — the server-side journal-replay claim (a
// replayed crown stage reproducing the client's stored `stages.*` hash) is only
// true if they produce BYTE-IDENTICAL digests. They agree today by SHA-256's
// streaming property (`update(a);update(b)` ≡ `update(a‖b)`), but nothing else
// in CI would catch a future edit that silently breaks that equivalence (a byte
// order/layout change on one side, or a different digest/normalization). This
// test asserts the equivalence directly and fails loudly on ANY such drift.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IndexedMesh } from '@dqcad/kernel';
import { hashMeshContent } from '@dqcad/kernel-workers/hash';
import { hashMesh } from './journal-replay.js';
import { buildShell } from './crown-qc-fixture.testutil.js';
import { buildInlay } from './inlay-qc-fixture.testutil.js';
import { buildBridge } from './bridge-qc-fixture.testutil.js';

/** Synthetic meshes exercising the byte layout: negative/fractional/large
 * Float64 coordinates and multi-triangle Uint32 index runs. */
const SYNTHETIC: ReadonlyArray<{ name: string; mesh: IndexedMesh }> = [
  {
    name: 'single triangle, varied float magnitudes',
    mesh: {
      positions: new Float64Array([-1.5, 0.0009765625, 1e7, 2.25, -3.5, 0, 0, 1234.567, -0.000001]),
      indices: Uint32Array.from([0, 1, 2]),
    },
  },
  {
    name: 'two triangles (quad), higher indices',
    mesh: {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    },
  },
  {
    name: 'empty mesh (no vertices, no indices)',
    mesh: { positions: new Float64Array([]), indices: new Uint32Array([]) },
  },
];

describe('mesh content hash — server hashMesh ≡ client hashMeshContent (cross-package equivalence guard)', () => {
  let crownMesh: IndexedMesh;
  let inlayShellMesh: IndexedMesh;
  let bridgeAssembledMesh: IndexedMesh;

  beforeAll(async () => {
    // A REAL crown stage mesh (the exact kind whose hash lands on
    // Restoration.stages.finalMesh) — not just synthetic toys.
    crownMesh = (await buildShell('standin')).result.mesh!;
    // A REAL inlay SHELL stage mesh (the cavity-path analogue — Phase 5 Task 9)
    // whose hash lands on the inlay/onlay Restoration.stages.finalMesh.
    inlayShellMesh = (await buildInlay('inlay')).shellResult.mesh;
    // A REAL bridge ASSEMBLY stage mesh (the bridge-path analogue — Phase 6 Task
    // 8) whose hash lands on the bridge Restoration.stages.finalMesh.
    bridgeAssembledMesh = (await buildBridge()).assembledSolid;
  }, 600_000);

  afterAll(() => {
    // no resources to release
  });

  for (const { name, mesh } of SYNTHETIC) {
    it(`agrees for synthetic mesh: ${name}`, async () => {
      const server = hashMesh(mesh);
      const client = await hashMeshContent(mesh.positions, mesh.indices);
      expect(server).toMatch(/^[0-9a-f]{64}$/);
      expect(server).toBe(client);
    });
  }

  it('agrees for a REAL crown stage mesh (the reproducibility-critical case)', async () => {
    const server = hashMesh(crownMesh);
    const client = await hashMeshContent(crownMesh.positions, crownMesh.indices);
    expect(server).toBe(client);
  }, 60_000);

  it('agrees for a REAL inlay shell stage mesh (the cavity reproducibility-critical case)', async () => {
    const server = hashMesh(inlayShellMesh);
    const client = await hashMeshContent(inlayShellMesh.positions, inlayShellMesh.indices);
    expect(server).toBe(client);
  }, 60_000);

  it('agrees for a REAL bridge assembly stage mesh (the bridge reproducibility-critical case)', async () => {
    const server = hashMesh(bridgeAssembledMesh);
    const client = await hashMeshContent(bridgeAssembledMesh.positions, bridgeAssembledMesh.indices);
    expect(server).toBe(client);
  }, 60_000);
});
