// packages/kernel/src/cavity/inlayShell.test.ts
//
// Phase 5 Task 6: constructInlayShell — assemble the fit surface (T3) + the
// occlusal patch / adapted proximal faces (T4/T5) into a single watertight
// 2-manifold, welded along the shared cavity-outline ring.
//
// Coverage:
//   - the SHARED-RING assumption is real (fit boundary loop == patch boundary
//     loop, bit-exact) — the precondition the direct weld rests on;
//   - the assembled shell is watertight + manifold + single-component (default,
//     onlay reduced-cusp, and the POST-contact-adaptation patch);
//   - a broken stitch (perturbed ring) throws a typed error (falsifiable);
//   - determinism: byte-identical double run + committed sha256 (manifold-3d
//     version guarded — the WASM cleanup round-trip).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import { buildCavityInnerSurface } from './innerSurface.ts';
import { buildOcclusalPatch } from './occlusalPatch.ts';
import { adaptProximalContacts, type ProximalAdaptationInput } from './proximalContact.ts';
import { type ProximalFaceBoundary } from './occlusalPatch.ts';
import {
  constructInlayShell,
  InlayShellRingMismatchError,
  InlayShellOpenBoundaryError,
} from './inlayShell.ts';

const AXIS: Vec3 = [0, 0, 1];
const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const PITCH = 0.06;
const PEN = 0.02;

function sha256(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(new Float64Array(mesh.positions).buffer));
  h.update(Buffer.from(new Uint32Array(mesh.indices).buffer));
  return h.digest('hex');
}

function coordKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function boundaryRings(mesh: IndexedMesh): string[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return coordKey(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    }),
  );
}

async function buildFit(fx: ReturnType<typeof modCavityMesh>): Promise<IndexedMesh> {
  const r = await buildCavityInnerSurface(fx.mesh, { ...GAP, pitchMm: PITCH, cavityOutline: fx.cavityOutline, insertionAxis: AXIS });
  return r.mesh;
}

// --- outward-wound axis-aligned box (CCW from outside) for the adaptation neighbour ---
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}
function faceOnSide(faces: readonly ProximalFaceBoundary[], sign: -1 | 1): ProximalFaceBoundary {
  const f = faces.find((face) => Math.sign(face.columnPoints[0]![0]) === sign);
  if (!f) throw new Error(`no proximal face on side ${sign}`);
  return f;
}

describe('constructInlayShell — the shared-ring weld', () => {
  it('the fit surface and occlusal patch share the SAME bit-exact outline ring (the weld precondition)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const fitRings = boundaryRings(fit);
    const patchRings = boundaryRings(patch.mesh);
    expect(fitRings, 'fit surface has exactly 1 boundary loop').toHaveLength(1);
    expect(patchRings, 'occlusal patch has exactly 1 boundary loop').toHaveLength(1);
    const fitSet = new Set(fitRings[0]!);
    const patchSet = new Set(patchRings[0]!);
    let shared = 0;
    for (const k of fitSet) if (patchSet.has(k)) shared++;
    console.log(`[INLAY SHELL RING] fit ring ${fitSet.size} verts / patch ring ${patchSet.size} verts / ${shared} shared bit-exactly`);
    expect(fitSet.size).toBe(patchSet.size);
    expect(shared).toBe(fitSet.size);
  });

  it('assembles a WATERTIGHT, manifold, single-component solid (default MOD inlay)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const shell = await constructInlayShell(fit, patch.mesh);
    const s = shell.stats;
    console.log(
      `[INLAY SHELL default] watertight=${s.watertight} manifold=${s.manifoldEdges} components=${s.componentCount} ` +
        `boundaryEdges=${s.boundaryEdgeCount} vol=${shell.volumeMm3.toFixed(4)}mm³ ring=${shell.seamRingVertexCount} tris=${shell.mesh.indices.length / 3}`,
    );
    expect(s.watertight).toBe(true);
    expect(s.manifoldEdges).toBe(true);
    expect(s.boundaryEdgeCount).toBe(0);
    expect(s.componentCount).toBe(1);
    expect(shell.volumeMm3).toBeGreaterThan(0);
    // an inlay's volume is bounded well below the whole tooth block (~675 mm³) —
    // a sanity ceiling a runaway union (inlay ∪ tooth) would blow through.
    expect(shell.volumeMm3).toBeLessThan(150);
    expect(shell.seamRingVertexCount).toBeGreaterThan(0);
  });

  it('assembles a watertight solid for the ONLAY reduced-cusp variant', async () => {
    const fx = modCavityMesh({ reducedCusp: true });
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const shell = await constructInlayShell(fit, patch.mesh);
    console.log(`[INLAY SHELL onlay] watertight=${shell.stats.watertight} components=${shell.stats.componentCount} vol=${shell.volumeMm3.toFixed(4)}mm³`);
    expect(shell.stats.watertight).toBe(true);
    expect(shell.stats.componentCount).toBe(1);
  });

  it('assembles a watertight solid from the POST-contact-adaptation patch (T5 output)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const halfLen = fx.lengthMm / 2;
    const adaptations: ProximalAdaptationInput[] = [
      { label: 'mesial', ...pick(faceOnSide(patch.proximalFaces, -1)), neighborMesh: outwardBox([-halfLen - 0.1 - 2, -5, -1], [-halfLen - 0.1, 5, 10]), targetPenetrationMm: PEN },
      { label: 'distal', ...pick(faceOnSide(patch.proximalFaces, 1)), neighborMesh: outwardBox([halfLen + 0.1, -5, -1], [halfLen + 0.1 + 2, 5, 10]), targetPenetrationMm: PEN },
    ];
    const adapted = adaptProximalContacts(patch.mesh, adaptations);
    expect(adapted.clampedBoxes).toHaveLength(0);
    const shell = await constructInlayShell(fit, adapted.mesh);
    console.log(`[INLAY SHELL adapted] watertight=${shell.stats.watertight} components=${shell.stats.componentCount} vol=${shell.volumeMm3.toFixed(4)}mm³`);
    expect(shell.stats.watertight).toBe(true);
    expect(shell.stats.componentCount).toBe(1);
  });

  it('a BROKEN stitch (perturbed patch ring) throws InlayShellRingMismatchError (falsifiable)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    // Perturb ONE boundary-ring vertex of the patch by 10 µm (>> the 1 nm weld
    // epsilon) so the ring no longer matches the fit surface's ring.
    const hm = buildHalfedge(patch.mesh);
    const loops = findBoundaryLoops(hm);
    const perturbVertex = destinationVertex(hm, loops[0]![0]!);
    const positions = patch.mesh.positions.slice();
    positions[perturbVertex * 3] = positions[perturbVertex * 3]! + 0.01;
    const brokenPatch: IndexedMesh = { positions, indices: patch.mesh.indices.slice() };
    await expect(constructInlayShell(fit, brokenPatch)).rejects.toBeInstanceOf(InlayShellRingMismatchError);
  });

  it('a CLOSED input (no open rim) throws InlayShellOpenBoundaryError (both fit and patch positions)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    // The fixture tooth solid is watertight → zero boundary loops. Closed PATCH:
    await expect(constructInlayShell(fit, fx.mesh)).rejects.toBeInstanceOf(InlayShellOpenBoundaryError);
    // Closed FIT (the other branch):
    await expect(constructInlayShell(fx.mesh, patch.mesh)).rejects.toBeInstanceOf(InlayShellOpenBoundaryError);
  });

  it('progress + cancel hooks affect no computed value (byte-identity) and report monotonic progress', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const fractions: number[] = [];
    const withHooks = await constructInlayShell(fit, patch.mesh, {
      onProgress: (f) => fractions.push(f),
      checkCancel: async () => {},
    });
    const without = await constructInlayShell(fit, patch.mesh);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!)).toBe(true);
    // byte-identical to the no-hooks run
    expect(sha256(withHooks.mesh)).toBe(sha256(without.mesh));
  });

  it('canonicalizes an INWARD-wound input to a positive-volume watertight shell', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const reverse = (m: IndexedMesh): IndexedMesh => {
      const idx = m.indices.slice();
      for (let t = 0; t < idx.length / 3; t++) {
        const tmp = idx[t * 3 + 1]!;
        idx[t * 3 + 1] = idx[t * 3 + 2]!;
        idx[t * 3 + 2] = tmp;
      }
      return { positions: m.positions.slice(), indices: idx };
    };
    const shell = await constructInlayShell(reverse(fit), reverse(patch.mesh));
    expect(shell.stats.watertight).toBe(true);
    expect(shell.stats.componentCount).toBe(1);
    expect(shell.volumeMm3).toBeGreaterThan(0);
  });

  it('is deterministic: byte-identical double run + committed sha256 (manifold-3d guarded)', async () => {
    const fx = modCavityMesh();
    const fit = await buildFit(fx);
    const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const a = await constructInlayShell(fit, patch.mesh);
    const b = await constructInlayShell(fit, patch.mesh);
    const ha = sha256(a.mesh);
    const hb = sha256(b.mesh);
    console.log(`[INLAY SHELL GOLDEN] sha256 = ${ha} (manifold-3d ${installedManifoldVersion()})`);
    expect(ha).toBe(hb);
    // The Float32 WASM cleanup round-trip is manifold-3d-version-dependent — the
    // committed pin is valid only for this installed version (the constructShell
    // precedent). A version bump is a deliberate golden update.
    if (installedManifoldVersion() === '3.5.1') {
      expect(ha).toBe(PINNED_SHELL_SHA256);
    }
    // Analytic re-validation of the pinned shell (never pin a broken shell).
    expect(analyzeMesh(a.mesh).watertight).toBe(true);
  });
});

function pick(face: ProximalFaceBoundary): { columnPoints: readonly Vec3[]; freeRunPoints: readonly Vec3[] } {
  return { columnPoints: face.columnPoints, freeRunPoints: face.freeRunPoints };
}

// The committed determinism pin — filled from the first green run (see the test
// log line). Manifold-3d 3.5.1.
const PINNED_SHELL_SHA256 = '96a9b7d41c8b2931a110442a8ff4a89270c8b40f782faa5a7e8947de4bce8313';

function installedManifoldVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/kernel/src/cavity → repo node_modules
  const pkgPath = join(here, '..', '..', '..', '..', 'node_modules', 'manifold-3d', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}
