// Small cross-cutting helpers used by more than one jobs/ domain module —
// split out of the original monolithic jobs.ts (Phase 2 Task 1) purely to
// avoid duplicating them per-module. Like context.ts, this is a
// dependency-free leaf so no domain module ever needs to import back
// through jobs/registry.ts (which would be circular — see that file's
// module doc).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".

/** Shared shape for a single Float64 mm point/vector crossing the Comlink
 * boundary as a plain (structured-cloned) tuple — no typed array/transfer
 * needed for 3 numbers. Used by jobs/bvh.ts (measurePointToSurface,
 * raycastMesh) and jobs/section.ts (sectionMesh's plane point/normal). */
export type Vec3Payload = readonly [number, number, number];

/** Runtime guard shared by every job whose payload carries a full indexed
 * mesh (`positions`/`indices`) rather than just a contentHash — used by
 * jobs/misc.ts (serializeMeshStl, hashMesh), jobs/repair.ts (all three
 * repair jobs), and jobs/section.ts (sectionMesh). */
export function requireMeshPayload(positions: unknown, indices: unknown, jobName: string): void {
  if (!(positions instanceof Float64Array)) {
    throw new TypeError(`${jobName}: positions must be a Float64Array (kernel Float64 rule)`);
  }
  if (!(indices instanceof Uint32Array)) {
    throw new TypeError(`${jobName}: indices must be a Uint32Array`);
  }
}
