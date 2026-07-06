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
    }
  }
}
