// packages/kernel/src/cavity/inlayShell.ts
//
// Phase 5 Task 6: the INLAY/ONLAY SHELL — assemble the fit surface (Task 3) and
// the occlusal patch + adapted proximal faces (Task 4/5) into a SINGLE
// WATERTIGHT 2-manifold solid, joined along their SHARED cavity outline.
//
// ## The stitch — a DIRECT DETERMINISTIC WELD, not a boolean (documented choice)
//
// This is the one place the crown `constructShell` (shell/shell.ts) precedent
// does NOT transfer verbatim, and the reason is a DELIBERATE property engineered
// across Task 3/4/5: BOTH open surfaces carry the SAME cavity outline as their
// single open boundary loop, BIT-EXACT.
//
//   - the fit surface (Task 3) is an occlusally-open cup whose one boundary loop
//     IS `dedupLoop(cavityOutline)` (its skirt bottom rim == the outline points);
//   - the occlusal patch (Task 4, adapted by Task 5) is a gingivally-open cap
//     whose one boundary loop IS the SAME `dedupLoop(cavityOutline)` — Task 5
//     pins the outline ring byte-exactly (only the interior proximal rim moves).
//
// The crown shell has TWO DISTINCT rims (an outer cervical rim and an inner
// margin rim, different loops offset by the marginal wall thickness), so it
// needs the ruled margin-band ZIPPER + an azimuth pairing to bridge them. Here
// the two rims are the SAME ring, so there is nothing to bridge: concatenating
// the two surfaces and WELDING coincident vertices (`weldVertices`, exact
// coordinate dedup at `MESH_WELD_EPSILON_MM`) fuses the shared ring — every
// outline edge, a boundary edge on BOTH surfaces, gains its second incident
// triangle and becomes a manifold interior edge. The result is a closed
// 2-manifold with NO fabricated seam-band geometry.
//
// This is PREFERRED over a boolean union for accuracy (CLAUDE.md's overriding
// rule): a boolean would re-tessellate the margin through the manifold-3d WASM
// Float32 boundary, perturbing the ≤10 µm marginal seal the fit surface was
// built to hold; the weld keeps every input vertex at its exact Float64 leader
// position (`weldVertices` never averages — see its doc), so the fit surface's
// margin ring and the patch's seam edges are carried into the shell UNCHANGED
// (the Task-3 margin fit and the Task-4 seam dihedral survive assembly
// byte-for-byte — the QC gates re-measure them on the exact input surfaces).
//
// ## Validation — a bad stitch is IMPOSSIBLE to mistake for a shell
//
// The shared-ring assumption is VERIFIED first (fail-fast, falsifiable): each
// input must present EXACTLY ONE boundary loop, and the two loops' bit-exact
// coordinate SETS must be equal — a perturbed / mismatched ring throws
// {@link InlayShellRingMismatchError} before any welding. After welding, the
// stitched surface is consistently oriented, pinned OUTWARD (positive signed
// volume), and passed through the manifold-3d wrapper (`cleanupMesh`, which
// THROWS {@link NonManifoldInputError} if the result is not a valid closed
// 2-manifold and collapses any degenerate slivers); `constructInlayShell` then
// re-runs `analyzeMesh` and throws {@link InlayShellNotWatertightError} unless
// the cleaned shell is watertight AND single-component. So a non-watertight
// stitch can never masquerade as a shell (CLAUDE.md invariant 4).
//
// ## Determinism across the WASM boundary
//
// The weld + orient are pure Float64 and deterministic; the only nondeterminism
// risk is the manifold-3d Float32 round-trip inside `cleanupMesh`, whose output
// hash depends on the manifold-3d WASM BUILD. Same inputs + same manifold-3d
// version ⇒ byte-identical shell (pinned by a committed sha256 in the test,
// guarded by the installed manifold-3d version — the `constructShell`
// precedent).
//
// @errorBound The stitch introduces NO geometric approximation of its own (the
// weld is an exact coordinate merge); the only positional change is the shared
// manifold-3d Float64→Float32 boundary (`boolean/manifold.ts`'s module
// `@errorBound`, ~1.2e-7 relative) applied by `cleanupMesh` to the WHOLE shell.
// The fit surface and patch that the QC gates measure are the pre-cleanup
// Float64 inputs, so the margin-fit / seam / wall-thickness measurements are
// exact (never routed through the Float32 boundary) — the same split
// `runCrownQc` uses (it measures the inner/outer surfaces, not the cleaned
// solid).
import type { IndexedMesh } from '../mesh/types.ts';
import type { TriangleSoup } from '../intake/types.ts';
import type { MeshStats } from '../intake/types.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { weldVertices } from '../intake/weld.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { cleanupMesh } from '../boolean/manifold.ts';

// ---------------------------------------------------------------------------
// Errors — explicit fields only (NO TS constructor parameter properties: this
// module is inside the Node worker's strip-only-TS loader closure).
// ---------------------------------------------------------------------------

/** Thrown when the fit surface or occlusal patch does not present EXACTLY one
 * open boundary loop to weld (a closed mesh has none; a badly cropped one may
 * have several). Both must be OPEN patches with a single boundary == the cavity
 * outline; anything else is a loud typed failure, never a silently unsealed
 * shell. */
export class InlayShellOpenBoundaryError extends Error {
  readonly which: 'fit' | 'patch';
  readonly loopCount: number;
  constructor(which: 'fit' | 'patch', loopCount: number) {
    super(
      `constructInlayShell: the ${which} surface has ${loopCount} boundary loop(s); the inlay-shell weld needs exactly ` +
        `one open rim on each surface (the shared cavity outline).`,
    );
    this.name = 'InlayShellOpenBoundaryError';
    this.which = which;
    this.loopCount = loopCount;
  }
}

/** Thrown when the fit surface's and the occlusal patch's boundary loops are
 * NOT the SAME bit-exact ring (different vertex counts, or a coordinate on one
 * ring absent from the other). The shared-ring property is engineered across
 * Task 3/4/5 (both boundaries are `dedupLoop(cavityOutline)`); a mismatch here
 * is a REAL Task 3/4/5 integration defect (or a perturbed ring) to FIX, never
 * to weld around — a weld that cannot fuse the ring would leave the shell open,
 * so this fails loudly BEFORE welding. */
export class InlayShellRingMismatchError extends Error {
  readonly fitRingVertexCount: number;
  readonly patchRingVertexCount: number;
  readonly sharedVertexCount: number;
  constructor(fitRingVertexCount: number, patchRingVertexCount: number, sharedVertexCount: number) {
    super(
      `constructInlayShell: the fit-surface and occlusal-patch boundary rings are not the SAME bit-exact outline ` +
        `(fit ${fitRingVertexCount} verts, patch ${patchRingVertexCount} verts, ${sharedVertexCount} shared bit-exactly) — ` +
        `both must be dedupLoop(cavityOutline); a mismatch is a Task 3/4/5 integration defect (or a perturbed ring), not a stitch to force.`,
    );
    this.name = 'InlayShellRingMismatchError';
    this.fitRingVertexCount = fitRingVertexCount;
    this.patchRingVertexCount = patchRingVertexCount;
    this.sharedVertexCount = sharedVertexCount;
  }
}

/** Thrown when the constructed inlay shell, AFTER the manifold-3d cleanup pass,
 * fails re-validation (not watertight, or more than one connected component). A
 * false "watertight" claim on a QC-gated solid is the worst possible outcome
 * (CLAUDE.md invariant 4), so this fails loudly with the measured stats rather
 * than returning a bad shell. */
export class InlayShellNotWatertightError extends Error {
  readonly stats: MeshStats;
  constructor(stats: MeshStats) {
    super(
      `constructInlayShell: the assembled inlay shell is not a watertight single-component solid after manifold cleanup ` +
        `(watertight=${stats.watertight}, manifoldEdges=${stats.manifoldEdges}, boundaryEdgeCount=${stats.boundaryEdgeCount}, ` +
        `componentCount=${stats.componentCount}) — refusing to return a non-watertight shell.`,
    );
    this.name = 'InlayShellNotWatertightError';
    this.stats = stats;
  }
}

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface ConstructInlayShellHooks {
  /** Fraction in [0, 1] at phase boundaries. Affects no computed value. */
  readonly onProgress?: (fraction: number) => void;
  /** Awaited at phase boundaries — should THROW to cancel. Affects no computed
   * value (byte-identity contract). */
  readonly checkCancel?: () => Promise<void>;
}

export interface ConstructInlayShellResult {
  /** The watertight inlay/onlay shell (manifold-3d cleaned). A NEW immutable
   * mesh. */
  readonly mesh: IndexedMesh;
  readonly stats: MeshStats;
  /** Shared cavity-outline ring vertex count (the welded seam). */
  readonly seamRingVertexCount: number;
  /** Triangles contributed by the fit surface / occlusal patch (pre-cleanup). */
  readonly fitTriangleCount: number;
  readonly patchTriangleCount: number;
  /** Shell volume, mm³ (signed volume from analyzeMesh; always > 0 here). */
  readonly volumeMm3: number;
}

function coordKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

/** Bit-exact coordinate keys of every boundary loop's destination vertices. */
function boundaryLoopCoordKeys(mesh: IndexedMesh): string[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return coordKey(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    }),
  );
}

/** Concatenate two indexed meshes into ONE unindexed triangle soup (every
 * triangle owns its 3 vertex positions) — the input `weldVertices` re-indexes,
 * fusing coincident vertices (the shared cavity ring) deterministically. */
function combinedSoup(fit: IndexedMesh, patch: IndexedMesh): TriangleSoup {
  const fitTri = fit.indices.length / 3;
  const patchTri = patch.indices.length / 3;
  const triangleCount = fitTri + patchTri;
  const positions = new Float64Array(triangleCount * 9);
  let w = 0;
  const emit = (mesh: IndexedMesh): void => {
    const idx = mesh.indices;
    const pos = mesh.positions;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i]!;
      positions[w++] = pos[v * 3]!;
      positions[w++] = pos[v * 3 + 1]!;
      positions[w++] = pos[v * 3 + 2]!;
    }
  };
  emit(fit);
  emit(patch);
  return { positions, normals: null, triangleCount };
}

/**
 * Assembles the inlay/onlay shell from the fit surface (Task 3) and the
 * occlusal patch + adapted proximal faces (Task 4/5) — see this module's doc
 * for the shared-ring weld, why it is preferred over a boolean, the validation,
 * and the determinism story. Deterministic: same inputs + same manifold-3d
 * version ⇒ byte-identical shell.
 *
 * @throws {InlayShellOpenBoundaryError} if either surface lacks a single open rim.
 * @throws {InlayShellRingMismatchError} if the two rims are not the same
 * bit-exact outline (a Task 3/4/5 integration defect / a perturbed ring).
 * @throws {NonManifoldInputError} (from the wrapper) if the welded surface is
 * not a valid closed 2-manifold.
 * @throws {InlayShellNotWatertightError} if the cleaned shell is not a
 * watertight single-component solid.
 */
export async function constructInlayShell(
  fitMesh: IndexedMesh,
  patchMesh: IndexedMesh,
  hooks?: ConstructInlayShellHooks,
): Promise<ConstructInlayShellResult> {
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0);

  // 1) VERIFY the shared-ring assumption FIRST (fail-fast, falsifiable).
  const fitLoops = boundaryLoopCoordKeys(fitMesh);
  if (fitLoops.length !== 1) throw new InlayShellOpenBoundaryError('fit', fitLoops.length);
  const patchLoops = boundaryLoopCoordKeys(patchMesh);
  if (patchLoops.length !== 1) throw new InlayShellOpenBoundaryError('patch', patchLoops.length);
  const fitRing = new Set(fitLoops[0]!);
  const patchRing = new Set(patchLoops[0]!);
  let shared = 0;
  for (const k of fitRing) if (patchRing.has(k)) shared++;
  if (fitRing.size !== patchRing.size || shared !== fitRing.size) {
    throw new InlayShellRingMismatchError(fitRing.size, patchRing.size, shared);
  }
  hooks?.onProgress?.(0.2);

  // 2) WELD: concatenate + fuse coincident vertices (the shared outline ring).
  const stitched = weldVertices(combinedSoup(fitMesh, patchMesh));
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.4);

  // 3) Consistently orient the single welded component. The fit surface and
  //    patch arrive with independent windings, so this reconciles them into one
  //    globally-consistent orientation — and `orientNormalsConsistently`
  //    canonicalizes each closed island to NON-NEGATIVE (outward) signed volume,
  //    so the result is already outward-oriented (positive volume) for the
  //    single-component shell; no explicit sign flip is needed.
  const oriented = orientNormalsConsistently(stitched).mesh;
  hooks?.onProgress?.(0.55);

  // 4) Re-validate + clean via the manifold-3d wrapper (throws
  //    NonManifoldInputError if the weld is not a valid closed 2-manifold).
  const shell = await cleanupMesh(oriented);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.9);

  const stats = analyzeMesh(shell);
  if (!stats.watertight || stats.componentCount !== 1) {
    throw new InlayShellNotWatertightError(stats);
  }
  hooks?.onProgress?.(1);

  return {
    mesh: shell,
    stats,
    seamRingVertexCount: fitRing.size,
    fitTriangleCount: fitMesh.indices.length / 3,
    patchTriangleCount: patchMesh.indices.length / 3,
    volumeMm3: stats.signedVolumeMm3 ?? 0,
  };
}
