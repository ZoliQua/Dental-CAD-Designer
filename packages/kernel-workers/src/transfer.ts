// Helpers for building the transfer-list arguments used by
// `WorkerPool.run(..., { transfer })` (pool.ts) and by the worker-side
// dispatch that hands job results back (jobs/registry.ts's runJob, invoked from the
// worker-entry files) — see meshBuffers and transferablesOf respectively.

export interface MeshBuffersPayload {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface MeshBuffersResult {
  payload: MeshBuffersPayload;
  transfer: Transferable[];
}

/**
 * Wraps a mesh's position/index buffers together with the transfer list
 * needed to move (not copy) them across the worker boundary. `positions`
 * must be Float64Array — the kernel Float64 rule (see docs/plans/
 * phase-0-foundation.md Global Constraints) applies to any buffer crossing
 * this boundary, not just code inside packages/kernel itself.
 */
export function meshBuffers(positions: Float64Array, indices: Uint32Array): MeshBuffersResult {
  if (!(positions instanceof Float64Array)) {
    throw new TypeError('meshBuffers: positions must be a Float64Array (kernel Float64 rule)');
  }
  return {
    payload: { positions, indices },
    transfer: [positions.buffer, indices.buffer],
  };
}

/**
 * Auto-detects the ArrayBuffers backing a job result's top-level TypedArray
 * fields, so the worker-side dispatcher can transfer them back to the
 * caller (zero-copy) without every job needing to declare its own transfer
 * list. Only inspects one level deep — sufficient for the flat
 * `{ positions, indices }`-shaped results jobs/registry.ts's runJob currently produces.
 */
export function transferablesOf(value: unknown): Transferable[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const transferables: Transferable[] = [];
  for (const field of Object.values(value as Record<string, unknown>)) {
    if (ArrayBuffer.isView(field)) {
      transferables.push(field.buffer as ArrayBuffer);
    }
  }
  return transferables;
}
