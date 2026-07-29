// apps/server/src/export-acceptance-lib.ts
//
// Phase 7 Task 8 — THE PHASE-GATE acceptance harness library (the journal-lib
// pattern, one source of truth for test/golden-style record→replay reuse).
// Assembles the full export loop, per restoration type (crown / inlay / onlay /
// bridge), from the EXISTING P4/P5/P6 fixtures — never rebuilding the slow
// design construction:
//
//   design chain (reuse the fixture) → journaled export op (T3) → MANDATORY
//   finalMesh persistence (Task 8) → server re-validation on the exact bytes
//   (T4) → outer-envelope certification (T6, now mandatory) → release →
//   download → re-import the downloaded bytes → watertight/manifold (PLAN
//   acceptance #1) → traceability JSON schema-validated (acceptance #2,
//   schemaVersion 2) → tamper variants REJECTED (acceptance #3) → archive
//   round-trip identical (acceptance #4).
//
// The heavy work is the fixtures' design construction + the server QC recompute
// on release; both are done ONCE per type (the caller's beforeAll) and reused.
// The tamper matrix rejects BEFORE the QC recompute (steps ≤ 10.5), so it is
// cheap even for the expensive cavity fixtures. Byte serialization is a pure,
// deterministic function of the finalMesh (T2), so the reproducibility proof
// (two-record byte identity) needs no server.
//
// This is a *-lib.ts, imported by export-acceptance.test.ts — never run as a
// suite itself.
import {
  EMAX_LITHIUM_DISILICATE_PROFILE,
  STANDARD_ZIRCONIA_PROFILE,
  type MaterialProfile,
} from '@dqcad/clinical-profiles';
import { analyzeMesh, type IndexedMesh } from '@dqcad/kernel';
import {
  runBridgeQc,
  runCrownQc,
  runInlayQc,
  type RunBridgeQcInput,
  type RunCrownQcInput,
  type RunInlayQcInput,
} from '@dqcad/cad-pipeline';
import type { ExportFormat, FdiTooth, QcReport, RestorationType } from '@dqcad/shared-types';
import { buildCrownQcInput, toValidateQcBody, TOOTH as CROWN_TOOTH } from './crown-qc-fixture.testutil.js';
import {
  buildInlay,
  buildOnlay,
  toValidateInlayQcBody,
  CAVITY_TOOTH,
} from './inlay-qc-fixture.testutil.js';
import {
  buildBridge,
  toValidateBridgeQcBody,
  BRIDGE_TEETH,
  BRIDGE_PONTICS,
} from './bridge-qc-fixture.testutil.js';
import { toExportQcContext } from './export-request.testutil.js';
import { reimportExportedBytes } from './export-validation.js';
import { hashMesh } from './journal-replay.js';

/** A restoration-type-normalized fixture bundle — everything the full-loop
 * driver needs, sourced from the EXISTING P4/P5/P6 fixtures. */
export interface AcceptanceBundle {
  restorationType: RestorationType;
  teeth: readonly FdiTooth[];
  pontics: readonly FdiTooth[];
  /** The f64 final restoration solid the export bytes serialize. */
  finalMesh: IndexedMesh;
  /** The client QC report (freshness identity: journalHash = hashMesh(finalMesh),
   * profileVersion = the registry profile's version). */
  clientReport: QcReport;
  /** The riding export qcContext (the validate-qc body minus byte-derived +
   * request-derived fields). */
  qcContext: Record<string, unknown>;
  /** The registry profile the fixture was designed against (server pins it). */
  profile: MaterialProfile;
  /** Whether the report carries an acknowledged-with-warning gate (onlay). */
  hasAcknowledgedGate: boolean;
  /** Loosens a profile-derived threshold in a COPY of the qcContext — the
   * threshold-tamper variant (server step 8 profile pinning must refuse it). */
  loosenThreshold: (ctx: Record<string, unknown>) => Record<string, unknown>;
}

// --- fixture bundle builders (reuse the existing fixtures) ------------------

export async function buildCrownBundle(): Promise<AcceptanceBundle> {
  const base = await buildCrownQcInput('standin');
  const input: RunCrownQcInput = {
    ...base,
    journalHash: hashMesh(base.crownSolid),
    profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
  };
  const clientReport = await runCrownQc(input);
  return {
    restorationType: 'crown',
    teeth: [CROWN_TOOTH],
    pontics: [],
    finalMesh: input.crownSolid,
    clientReport,
    qcContext: toExportQcContext(toValidateQcBody(input), 'crownSolid'),
    profile: STANDARD_ZIRCONIA_PROFILE,
    hasAcknowledgedGate: false,
    loosenThreshold: (ctx) => ({ ...ctx, minWallThicknessMm: 0.05 }),
  };
}

export async function buildInlayBundle(): Promise<AcceptanceBundle> {
  const built = await buildInlay();
  const input: RunInlayQcInput = {
    ...built.qcInput,
    journalHash: hashMesh(built.qcInput.inlaySolid),
    profileVersion: EMAX_LITHIUM_DISILICATE_PROFILE.version,
  };
  const clientReport = await runInlayQc(input);
  return {
    restorationType: 'inlay',
    teeth: [CAVITY_TOOTH],
    pontics: [],
    finalMesh: input.inlaySolid,
    clientReport,
    qcContext: toExportQcContext(toValidateInlayQcBody(input), 'inlaySolid'),
    profile: EMAX_LITHIUM_DISILICATE_PROFILE,
    hasAcknowledgedGate: false,
    loosenThreshold: (ctx) => loosenCavityThreshold(ctx),
  };
}

export async function buildOnlayBundle(): Promise<AcceptanceBundle> {
  const built = await buildOnlay();
  const input: RunInlayQcInput = {
    ...built.qcInput,
    journalHash: hashMesh(built.qcInput.inlaySolid),
    profileVersion: EMAX_LITHIUM_DISILICATE_PROFILE.version,
  };
  const clientReport = await runInlayQc(input);
  return {
    restorationType: 'onlay',
    teeth: [CAVITY_TOOTH],
    pontics: [],
    finalMesh: input.inlaySolid,
    clientReport,
    qcContext: toExportQcContext(toValidateInlayQcBody(input), 'inlaySolid'),
    profile: EMAX_LITHIUM_DISILICATE_PROFILE,
    hasAcknowledgedGate: true, // the bounded+localized seating junction artifact (P5-T7)
    loosenThreshold: (ctx) => loosenCavityThreshold(ctx),
  };
}

export async function buildBridgeBundle(): Promise<AcceptanceBundle> {
  const built = await buildBridge();
  const input: RunBridgeQcInput = {
    ...built.qcInput,
    journalHash: hashMesh(built.assembledSolid),
    profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
  };
  const clientReport = await runBridgeQc(input);
  return {
    restorationType: 'bridge',
    teeth: BRIDGE_TEETH,
    pontics: BRIDGE_PONTICS,
    finalMesh: input.assembledSolid,
    clientReport,
    qcContext: toExportQcContext(toValidateBridgeQcBody(input), 'assembledSolid'),
    profile: STANDARD_ZIRCONIA_PROFILE,
    hasAcknowledgedGate: false,
    loosenThreshold: (ctx) => ({ ...ctx, minWallThicknessMm: 0.05 }),
  };
}

/** Loosens the inlay/onlay thickness minimum riding in the cavity qcContext —
 * `thicknessMinimums` is always present and both fields are server-pinned. */
function loosenCavityThreshold(ctx: Record<string, unknown>): Record<string, unknown> {
  const mins = ctx['thicknessMinimums'] as { inlayMinThicknessMm: number; onlayMinThicknessMm: number };
  return { ...ctx, thicknessMinimums: { ...mins, inlayMinThicknessMm: 0.05 } };
}

// --- re-import verification (PLAN acceptance #1) ----------------------------

export interface ReimportQc {
  watertight: boolean;
  manifold: boolean;
  triangleCount: number;
  vertexCount: number;
}

/**
 * Re-imports exported bytes through the SAME parse + intake path a mill would
 * use, and reports the watertight/manifold verdict (PLAN acceptance #1: "an
 * exported STL re-imports as watertight/manifold"). Independent of the server —
 * this is the honest "load what the mill loads" check.
 */
export function reimportWatertightManifold(bytes: Uint8Array, format: ExportFormat): ReimportQc {
  const mesh = reimportExportedBytes(bytes, format).mesh;
  const stats = analyzeMesh(mesh);
  return {
    watertight: stats.watertight,
    // "manifold" (PLAN acceptance #1) = no non-manifold edges (analyzeMesh's
    // `manifoldEdges`; watertight already implies this, asserted separately).
    manifold: stats.manifoldEdges,
    triangleCount: mesh.indices.length / 3,
    vertexCount: mesh.positions.length / 3,
  };
}

// --- binary-STL byte tampers (the tamper matrix, acceptance #3) -------------

const STL_HEADER_BYTES = 80;
const STL_COUNT_OFFSET = 80;
const STL_TRIANGLE_BYTES = 50;

/** A geometry byte-flip that BREAKS a vertex's weld: flips an exponent byte of
 * one occurrence of a shared vertex, so the re-import has an open component
 * intake cannot orient → `export-reimport-integrity`. */
export function flipGeometryByte(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const offset = STL_HEADER_BYTES + 4 + 100 * STL_TRIANGLE_BYTES + 12; // v0.x of triangle 100
  out[offset + 3] = out[offset + 3]! ^ 0x01; // exponent-byte flip: a large coordinate move
  return out;
}

/** Moves the occlusal-apex vertex (max z — far from the die/margin, so every
 * gate value is invariant) OUTWARD, IDENTICALLY across every per-triangle
 * occurrence — welds cleanly, stays watertight/manifold, but the re-import no
 * longer matches the persisted design solid → `export-outer-envelope-mismatch`.
 * The reviewer's consistent-adversary construction. */
export function moveApexOutward(bytes: Uint8Array, deltaMm = 0.5): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const triangleCount = view.getUint32(STL_COUNT_OFFSET, true);
  const base = STL_HEADER_BYTES + 4;
  const vLocalOffsets = [12, 24, 36];
  let maxZ = -Infinity;
  let apex: [number, number, number] | null = null;
  for (let t = 0; t < triangleCount; t++) {
    const tri = base + t * STL_TRIANGLE_BYTES;
    for (const v of vLocalOffsets) {
      const x = view.getFloat32(tri + v, true);
      const y = view.getFloat32(tri + v + 4, true);
      const z = view.getFloat32(tri + v + 8, true);
      if (z > maxZ) {
        maxZ = z;
        apex = [x, y, z];
      }
    }
  }
  if (!apex) throw new Error('moveApexOutward: no vertices');
  const [ax, ay, az] = apex;
  const newZ = Math.fround(az + deltaMm);
  let moved = 0;
  for (let t = 0; t < triangleCount; t++) {
    const tri = base + t * STL_TRIANGLE_BYTES;
    for (const v of vLocalOffsets) {
      if (
        view.getFloat32(tri + v, true) === ax &&
        view.getFloat32(tri + v + 4, true) === ay &&
        view.getFloat32(tri + v + 8, true) === az
      ) {
        view.setFloat32(tri + v + 8, newZ, true);
        moved += 1;
      }
    }
  }
  if (moved === 0) throw new Error('moveApexOutward: apex not found on second pass');
  return out;
}

/** Truncates the trailing bytes → the parser rejects (`TruncatedFileError` for
 * STL) → `export-bytes-parse-failed`. */
export function truncateBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, bytes.byteLength - 13);
}
