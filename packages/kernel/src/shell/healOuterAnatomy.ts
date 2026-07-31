// packages/kernel/src/shell/healOuterAnatomy.ts
//
// Phase 4 Task 12b — the deterministic HEAL step between morph (Task 6) and
// shell (Task 7). The RBF morph (anatomy/morph.ts) deforms the placed library
// tooth to the patient's contacts; that deformation can fold the surface onto
// itself, producing SELF-INTERSECTIONS and near-degenerate slivers that remain
// invisible to halfedge watertightness (the mesh stays closed + 2-manifold in
// the connectivity sense) yet make the manifold-3d cleanup inside
// `constructShell` reject the stitched crown as non-manifold. `healOuterAnatomy`
// re-derives a GUARANTEED-CLEAN closed 2-manifold from the morphed OUTER
// anatomy so the shell stage can consume it.
//
// ## How it heals — SDF re-mesh at the zero level set (clean BY CONSTRUCTION)
//
// The heal samples the morphed outer's signed-distance field on a banded voxel
// grid and extracts the iso-0 surface with marching cubes (the exact
// `offset/offsetMesh.ts` pipeline at `distanceMm = 0`). A marching-cubes iso
// surface is ALWAYS a clean, oriented, watertight 2-manifold with no
// self-intersections and no degenerate triangles — the healing is structural,
// not a repair heuristic: whatever folds/slivers the RBF introduced, the
// zero-level-set of the field is a single well-defined surface and MC emits a
// valid manifold for it. The output is re-validated (watertight + single
// component) through the same manifold-3d wrapper `offsetMesh` uses.
//
// ## Intaglio is NEVER touched (the ≤10 µm fit is preserved EXACTLY)
//
// This heals the OUTER anatomy ONLY. The inner intaglio surface (Task 4) — the
// precision fit surface carrying the ≤10 µm marginal seal — is a SEPARATE mesh
// that `constructShell` stitches to its EXACT margin rim; it is never passed
// here and never re-sampled. Sub-pitch detail loss on the occlusal/buccal OUTER
// shape (bounded below) is clinically acceptable; the fit surface stays exact.
//
// @errorBound `errorBoundMm = pitchMm / 2 + eps_f32` — inherited verbatim from
// `offsetMesh`'s own `@errorBound` at `distanceMm = 0` (each MC vertex lies on
// the iso-0 crossing of a 1-Lipschitz field along a grid edge of length
// `pitch`, so its field value — its signed distance to the true morphed
// surface — is within `pitch / 2`; `eps_f32` collects the documented Float32
// grid-storage + manifold-3d WASM-cast boundaries). Consequence surfaced to QC:
// every point of the healed OUTER surface (including the occlusal/proximal
// CONTACT loci the morph drove to target) is displaced from the morph's surface
// by at most `errorBoundMm`, so the contacts the morph achieved shift by at
// most this bound. The heal does NOT re-measure contacts; the morph's reported
// residuals are the contact truth and this bound is an ADDITIONAL remesh-induced
// shift ON TOP OF them. The downstream contact/interpenetration gate MUST SUM the
// two — the true post-heal deviation of a contact from its target is bounded by
// `morphContactResidualMm + errorBoundMm`, NOT by either alone: a contact the
// morph drove to within sub-µm can be up to `pitchMm / 2` (tens of µm at a coarse
// pitch) off after the remesh. Treating this heal bound as a separate outer-shape
// figure rather than adding it to the morph residual would understate the
// post-heal contact error.
//
// Deterministic: `offsetMesh` is deterministic (same mesh + pitch + manifold-3d
// version ⇒ byte-identical output — offsetMesh.test.ts pins this), so the heal
// enters the journal chain and the coupled crown records → replays bit-identical.
import type { IndexedMesh } from '../mesh/types.ts';
import type { MeshStats } from '../intake/types.ts';
import { offsetMesh } from '../offset/offsetMesh.ts';

export interface HealOuterAnatomyOptions {
  /** Voxel pitch (mm) of the SDF re-mesh grid — the remesh resolution, and the
   * dominant term of the `@errorBound` (`pitchMm / 2`). REQUIRED (no clinical
   * default in the kernel; the pipeline supplies it). Finer pitch = tighter
   * bound on the outer-surface displacement (and the contact shift) at the cost
   * of a denser mesh + longer remesh. Must be finite and > 0. */
  readonly pitchMm: number;
}

export interface HealOuterAnatomyResult {
  /** The healed OUTER anatomy: a clean, watertight, single-component,
   * self-intersection-free closed 2-manifold (re-validated). A NEW immutable
   * mesh (the input is never mutated). */
  readonly mesh: IndexedMesh;
  /** `analyzeMesh` over the healed mesh (post manifold-3d cleanup). */
  readonly stats: MeshStats;
  /** The documented approximation bound (mm) — see this module's `@errorBound`.
   * The healed OUTER surface (incl. every contact locus) is within this of the
   * morph's surface; surfaced to the QC report by the shell stage. */
  readonly errorBoundMm: number;
  /** Echo of the remesh pitch, for journaling. */
  readonly pitchMm: number;
  /** Triangle count of the morphed input (pre-heal) — journaled for audit. */
  readonly triangleCountBefore: number;
  /** Triangle count of the healed output — journaled for audit. */
  readonly triangleCountAfter: number;
}

/**
 * Heals a CLOSED, watertight (possibly self-intersecting / sliver-bearing)
 * morphed outer anatomy into a guaranteed-clean closed 2-manifold by SDF
 * re-mesh at the zero level set — see this module's doc for the construction,
 * the intaglio-preservation guarantee, and the `@errorBound`.
 *
 * Deterministic: same mesh + pitch + manifold-3d version ⇒ byte-identical
 * output.
 *
 * @throws {TypeError} if `pitchMm` is not finite and > 0 (from `offsetMesh`).
 * @throws {PitchTooSmallError} if `pitchMm < MIN_PITCH_MM` (from `offsetMesh`).
 * @throws {NonWatertightMeshError} if `outerMesh` is not closed — the signed
 * distance field requires a watertight input (from `offsetMesh`). A morphed
 * library tooth is always closed, so this only fires on genuinely broken input.
 * @throws {NonManifoldInputError} if the re-meshed surface fails manifold
 * validation (should not happen for an iso surface — surfaced, not swallowed).
 */
export async function healOuterAnatomy(
  outerMesh: IndexedMesh,
  options: HealOuterAnatomyOptions,
): Promise<HealOuterAnatomyResult> {
  const triangleCountBefore = outerMesh.indices.length / 3;
  // The heal IS an offset by zero: the iso-0 surface of the morphed outer's
  // signed-distance field, re-meshed by marching cubes (clean 2-manifold by
  // construction) and manifold-cleaned. Reuses the full offset pipeline so the
  // determinism + `@errorBound` derivation are shared, not re-implemented.
  const offset = await offsetMesh(outerMesh, 0, { pitchMm: options.pitchMm });
  return {
    mesh: offset.mesh,
    stats: offset.stats,
    errorBoundMm: offset.errorBoundMm,
    pitchMm: options.pitchMm,
    triangleCountBefore,
    triangleCountAfter: offset.mesh.indices.length / 3,
  };
}
