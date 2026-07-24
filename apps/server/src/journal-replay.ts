// apps/server/src/journal-replay.ts
//
// Server-side crown-stage REPLAY (Phase 4 Task 11's reproducibility deliverable).
//
// The reproducibility invariant (CLAUDE.md invariant 2 / PLAN.md §6): replaying
// a journaled destructive operation in the Node/server runtime must reproduce
// the SAME output content hash the client recorded on `Restoration.stages.*`.
// This module is the server's entry point for that check — it re-runs a crown
// design stage through the SAME `@dqcad/cad-pipeline` the client worker uses
// (cad-pipeline is DOM/Three-free, so the server → cad-pipeline → kernel/io/
// shared-types edge is legal and the computation is identical across the
// client/server boundary), hashing the result with the SAME canonical
// `hashMesh` used to seal the stage's `contentHash` client-side.
//
// This is deliberately NOT a generic journal-replay engine (a server-side op
// dispatcher over arbitrary `Operation`s belongs to the export-endpoint task,
// where the whole journal is replayed against exported bytes). It is the
// focused, testable unit that proves a crown's final-mesh stage is
// content-portable and reproducible server-side.
import { createHash } from 'node:crypto';
import type { IndexedMesh } from '@dqcad/kernel';
import { runShellStage, type PipelineContext, type ShellStageOptions } from '@dqcad/cad-pipeline';
import type { FdiTooth } from '@dqcad/shared-types';

/**
 * The canonical mesh content hash: `sha256(positions bytes ‖ indices bytes)`.
 * Float64 positions + Uint32 indices are hashed over their raw little-endian
 * buffers, so the hash is a pure, deterministic function of the mesh's exact
 * coordinates and topology — the same value the client's mesh store addresses
 * the mesh by, hence the same value that lands on `Restoration.stages.*`.
 *
 * ## INVARIANT: byte-identical to the client's `hashMeshContent`
 *
 * The whole server-side reproducibility claim (a replayed crown stage
 * reproducing the client's stored `stages.*` hash) rests on this producing the
 * SAME digest the client lands via `@dqcad/kernel-workers`'s
 * `hashMeshContent(positions, indices)`. They agree today because SHA-256 is a
 * streaming Merkle–Damgård hash — `update(a); update(b)` ≡ `update(a‖b)` — so
 * this function's two `update` calls equal `hashMeshContent`'s single combined
 * buffer over the SAME byte layout (positions Float64 LE, then indices Uint32
 * LE) and the SAME algorithm/lowercase-hex encoding.
 *
 * The async (browser SubtleCrypto / Node) vs. sync (`runShellStage`'s `(mesh)
 * => string` callback) split makes sharing the exact function impractical, so
 * the equivalence is GUARDED, not assumed: `mesh-hash-equivalence.test.ts`
 * asserts `hashMesh(mesh) === await hashMeshContent(mesh.positions,
 * mesh.indices)` for representative meshes incl. a real crown stage mesh, and
 * fails loudly if EITHER side's byte layout, digest, or encoding ever drifts.
 * Do NOT change the byte order/algorithm here (or in `hashMeshContent`) without
 * that test staying green.
 */
export function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

export interface ReplayShellStageResult {
  /** The re-run shell stage's output crown solid. */
  readonly mesh: IndexedMesh;
  /** `hashMesh(mesh)` — must equal the stored `Restoration.stages.finalMesh`
   * and the stage `Operation.outputHashes[0]` for the replay to be valid. */
  readonly meshContentHash: string;
  /** `Operation.inputHashes` this replay read (the outer-anatomy + inner
   * surface content hashes) — for cross-checking against the journal entry. */
  readonly inputHashes: readonly string[];
}

/**
 * Re-runs the crown SHELL stage (the final watertight-solid producer) in the
 * server runtime and returns its output mesh + canonical content hash. The
 * caller supplies the SAME `PipelineContext` and inner/outer meshes the
 * original design used; a deterministic `runShellStage` (no `Date.now`, no
 * randomness) then reproduces the recorded `stages.finalMesh` hash bit-for-bit.
 *
 * `options.hashMesh` is forced to this module's canonical `hashMesh` so the
 * replay and the stored hash are computed identically — a caller cannot
 * accidentally supply a different hashing function and mask a real divergence.
 */
export async function replayShellStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: Omit<ShellStageOptions, 'hashMesh'>,
): Promise<ReplayShellStageResult> {
  const result = await runShellStage(context, tooth, { ...options, hashMesh });
  if (!result.mesh || result.meshContentHash === null) {
    // Unreachable for the shell stage (it always produces a mesh) — defensive.
    throw new Error('replayShellStage: shell stage produced no mesh/hash');
  }
  return {
    mesh: result.mesh,
    meshContentHash: result.meshContentHash,
    inputHashes: result.inputHashes,
  };
}
