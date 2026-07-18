// apps/client/src/engine/meshStore.ts
//
// Engine-side registry of imported meshes, content-addressed by SHA-256 hash
// of the final (post-intake) mesh buffers (see hash.ts's hashMeshContent).
// This is NOT part of CaseDocument (@dqcad/shared-types) — a CaseDocument
// only ever holds `MeshAsset` metadata (id, contentHash, name, unit,
// triangleCount; see engine/caseStore.ts). The actual geometry buffers live
// here, for the lifetime of the browser session, and are never serialized
// into the (JSON-able) CaseDocument snapshot published to zustand.
//
// ## Where the Float64 "master" copy lives
//
// `positions`/`indices` on an `EngineMeshRecord` are the EXACT Float64/
// Uint32 typed arrays handed back by the `intakeMesh` worker job
// (packages/kernel-workers), transferred (not copied) across the worker
// boundary by importer.ts. They are never downcast and never mutated after
// `register()` stores them — any future geometry operation (Task 6+) that
// needs to read or derive from this mesh reads `positions`/`indices` here,
// in Float64, as the single source of truth. This satisfies CLAUDE.md's
// Float64 rule: the only Float32 data anywhere in this record is
// `renderPositions`, described next.
//
// ## Render copy re-centering
//
// `renderPositions` is a SEPARATE Float32Array — the ONLY Float32 data in
// the whole engine/state stack (CLAUDE.md: "Float32Array only in engine/
// render copies... re-centered at the case bbox centroid"). It is
// (re)computed by `recenterAll()` below, over EVERY registered mesh's
// `stats.bbox`, whenever the registry's membership changes (register/
// remove) — every mesh's render copy shares the SAME origin so multiple
// meshes stay spatially consistent inside one Three.js scene (float32
// precision degrades far from the origin, hence re-centering at all). This
// is O(total registered vertex count) per register()/remove() call, which
// is acceptable for Phase 1's few-mesh cases; Task 6 (the real viewer) may
// want to make this incremental if case sizes grow enough for it to matter.
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';

export interface EngineMeshRecord {
  contentHash: string;
  /** Sanitized (basename-only) display name — see importer.ts's
   * `sanitizeBasename`. */
  name: string;
  format: 'stl' | 'ply';
  /** Float64 master positions (3-per-vertex, indexed) — see module doc. */
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
  /** Float32 render copy, re-centered at the current case bbox centroid —
   * see module doc. Consumed only by SceneManager. */
  renderPositions: Float32Array;
  /** Same values as `indices` (index buffers need no re-centering) — kept
   * as a same-named field purely so SceneManager call sites read
   * `record.renderIndices` alongside `record.renderPositions` without
   * having to know they happen to be the identical array. */
  renderIndices: Uint32Array;
  /** Optional RENDER-ONLY LOD copy (Phase 2 Task 10) — present once
   * engine/lod.ts's `decimateMesh` worker job has completed for this mesh.
   * `lod.positions` are the decimated Float64 world-frame vertices (kept in
   * Float64 so `recenterAll()` below can recompute the Float32
   * `renderPositions` against any FUTURE world offset without accumulating
   * rounding — exactly the same master->render relationship the full-res
   * pair above has). HARD INVARIANT (this task's brief): this is a
   * separate, derived copy — the Float64 `positions`/`indices` masters
   * above are NEVER replaced or mutated by any LOD operation, and nothing
   * outside SceneManager's render path ever consumes these buffers
   * (picking/measuring/sections/heatmaps/exports all read the masters —
   * verified consumer-by-consumer in engine/lod.ts's module doc). */
  lod?: {
    positions: Float64Array;
    indices: Uint32Array;
    renderPositions: Float32Array;
    /** Realized max QEM error of the decimation, mm — carried for the dev
     * panel/debugging (see @dqcad/kernel's decimate.ts `@errorBound`). */
    maxErrorMm: number;
  };
}

export interface RegisterMeshInput {
  contentHash: string;
  name: string;
  format: 'stl' | 'ply';
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  report: IntakeReport;
}

/** Bounded, content-addressed mesh registry — see this module's doc comment. */
export class MeshStore {
  private readonly records = new Map<string, EngineMeshRecord>();
  /** Float64 mm world-space offset (the union-bbox centroid) currently
   * subtracted from every record's Float64 `positions` to produce its
   * Float32 `renderPositions` — i.e. `positions[i] - worldOffset ===
   * renderPositions[i]` (up to Float32 rounding). Exposed via
   * `getWorldOffset()` so a future coordinate readout (Task 7 measurements
   * picking a point in the re-centered render frame) can add this back to
   * report the true case/world mm coordinate. Recomputed every
   * `recenterAll()` call; `[0, 0, 0]` when the registry is empty. */
  private worldOffset: readonly [number, number, number] = [0, 0, 0];

  has(contentHash: string): boolean {
    return this.records.has(contentHash);
  }

  get(contentHash: string): EngineMeshRecord | undefined {
    return this.records.get(contentHash);
  }

  list(): EngineMeshRecord[] {
    return [...this.records.values()];
  }

  /**
   * Registers a newly intake'd mesh. Idempotent by content hash — importing
   * the exact same processed geometry twice (e.g. the user re-drops the
   * same file) returns the EXISTING record unchanged rather than duplicating
   * it, matching CLAUDE.md's "Scan files are content-addressed... and
   * immutable once stored". Recomputes every record's render copy against
   * the new combined case bbox centroid (see `recenterAll` below).
   */
  register(input: RegisterMeshInput): EngineMeshRecord {
    const existing = this.records.get(input.contentHash);
    if (existing) {
      return existing;
    }
    const record: EngineMeshRecord = {
      contentHash: input.contentHash,
      name: input.name,
      format: input.format,
      positions: input.positions,
      indices: input.indices,
      stats: input.stats,
      report: input.report,
      renderPositions: new Float32Array(input.positions.length),
      renderIndices: input.indices,
    };
    this.records.set(input.contentHash, record);
    this.recenterAll();
    return record;
  }

  remove(contentHash: string): void {
    if (this.records.delete(contentHash)) {
      this.recenterAll();
    }
  }

  /**
   * Attaches a RENDER-ONLY LOD copy to an existing record (Phase 2 Task 10
   * — see `EngineMeshRecord.lod`'s doc and engine/lod.ts for who computes
   * it). The record's Float64 master `positions`/`indices` are untouched —
   * this only ever ADDS a derived render copy. A no-op (returns `false`) if
   * `contentHash` is no longer registered (the mesh was removed while its
   * LOD job was in flight — the stale result is simply dropped, mirroring
   * engine/heatmap.ts's stale-async-result convention). The LOD's Float32
   * render copy is computed against the CURRENT world offset, and
   * `recenterAll()` keeps it in sync with every later membership change,
   * exactly like the full-res render copy.
   */
  setLod(contentHash: string, lod: { positions: Float64Array; indices: Uint32Array; maxErrorMm: number }): boolean {
    const record = this.records.get(contentHash);
    if (!record) return false;
    const renderPositions = new Float32Array(lod.positions.length);
    const [ox, oy, oz] = this.worldOffset;
    for (let v = 0; v < lod.positions.length / 3; v++) {
      renderPositions[v * 3] = lod.positions[v * 3]! - ox;
      renderPositions[v * 3 + 1] = lod.positions[v * 3 + 1]! - oy;
      renderPositions[v * 3 + 2] = lod.positions[v * 3 + 2]! - oz;
    }
    record.lod = { positions: lod.positions, indices: lod.indices, renderPositions, maxErrorMm: lod.maxErrorMm };
    return true;
  }

  /** TEST-ONLY: drops every record without recomputing anything (there's
   * nothing left to recenter). */
  clear(): void {
    this.records.clear();
    this.worldOffset = [0, 0, 0];
  }

  /** Float64 mm world-space offset currently subtracted from every record's
   * render copy — see the field doc above. */
  getWorldOffset(): readonly [number, number, number] {
    return this.worldOffset;
  }

  /** Union bbox centroid (Float64 mm) across every registered mesh's
   * `stats.bbox` — see module doc's "Render copy re-centering" section. */
  private recenterAll(): void {
    const records = [...this.records.values()];
    if (records.length === 0) {
      this.worldOffset = [0, 0, 0];
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const record of records) {
      const { min, max } = record.stats.bbox;
      if (min[0] < minX) minX = min[0];
      if (min[1] < minY) minY = min[1];
      if (min[2] < minZ) minZ = min[2];
      if (max[0] > maxX) maxX = max[0];
      if (max[1] > maxY) maxY = max[1];
      if (max[2] > maxZ) maxZ = max[2];
    }
    const centroidX = (minX + maxX) / 2;
    const centroidY = (minY + maxY) / 2;
    const centroidZ = (minZ + maxZ) / 2;
    this.worldOffset = [centroidX, centroidY, centroidZ];

    for (const record of records) {
      const vertexCount = record.positions.length / 3;
      for (let v = 0; v < vertexCount; v++) {
        record.renderPositions[v * 3] = record.positions[v * 3]! - centroidX;
        record.renderPositions[v * 3 + 1] = record.positions[v * 3 + 1]! - centroidY;
        record.renderPositions[v * 3 + 2] = record.positions[v * 3 + 2]! - centroidZ;
      }
      // The LOD render copy (if any) shares the same origin as every other
      // render copy — recomputed from its own Float64 LOD positions, never
      // by shifting the Float32 values (which would accumulate rounding).
      const lod = record.lod;
      if (lod) {
        const lodVertexCount = lod.positions.length / 3;
        for (let v = 0; v < lodVertexCount; v++) {
          lod.renderPositions[v * 3] = lod.positions[v * 3]! - centroidX;
          lod.renderPositions[v * 3 + 1] = lod.positions[v * 3 + 1]! - centroidY;
          lod.renderPositions[v * 3 + 2] = lod.positions[v * 3 + 2]! - centroidZ;
        }
      }
    }
  }
}
