// apps/server/src/export-validation.test.ts
//
// Unit tests for the export endpoint's pure validation core
// (export-validation.ts): byte integrity (the verify-bytes-hash-FIRST
// contract), byte re-import + the cleanliness gate (the T2 equivalence
// conditions asserted source-free), and journal verification (export-op
// binding, restoration/finalMesh, the N4 null-ack refusal, the P6-T8
// ack-tampering refusal). Route-level wiring is covered by
// export-endpoint.test.ts and the per-type dual-validation suites.
import { describe, expect, it } from 'vitest';
import { KERNEL_VERSION, indexedToSoup, weldVertices, type IndexedMesh } from '@dqcad/kernel';
import { exportPlyBinary, exportStlBinary, writeStlBinary } from '@dqcad/io';
import type {
  CaseDocument,
  Operation,
  QcReport,
  RestorationExportRequest,
} from '@dqcad/shared-types';
import {
  decodeExportBytes,
  reimportExportedBytes,
  verifyExportJournal,
  ExportRejectionError,
} from './export-validation.js';
import { hashMesh } from './journal-replay.js';
import { sha256HexOf } from './mesh-storage.js';

// --- fixtures -------------------------------------------------------------

/** Outward unit cube (the T2 test staple): watertight, manifold, single
 * component, positive volume. */
function cube(): IndexedMesh {
  const v = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const idx = [
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
    6, 1, 6, 5,
  ];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function translated(mesh: IndexedMesh, dx: number): IndexedMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) positions[i] = positions[i]! + dx;
  return { positions, indices: mesh.indices.slice() };
}

/** Per-triangle soup expansion of an indexed mesh (for the RAW writer, which
 * unlike the export writers performs no solid validation — exactly what the
 * dirty-bytes tests need). */
function soupOf(...meshes: IndexedMesh[]): {
  positions: Float64Array;
  normals: null;
  triangleCount: number;
} {
  const tris: number[] = [];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.indices.length; i++) {
      const v = mesh.indices[i]! * 3;
      tris.push(mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!);
    }
  }
  return { positions: new Float64Array(tris), normals: null, triangleCount: tris.length / 9 };
}

function rejectionOf(fn: () => unknown): ExportRejectionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExportRejectionError) return error;
    throw error;
  }
  throw new Error('expected an ExportRejectionError, nothing was thrown');
}

// --- decodeExportBytes ----------------------------------------------------

describe('decodeExportBytes (verify-bytes-hash-FIRST)', () => {
  const bytes = exportStlBinary(cube());
  const good = {
    bytesBase64: Buffer.from(bytes).toString('base64'),
    bytesSha256: sha256HexOf(Buffer.from(bytes)),
    byteLength: bytes.byteLength,
  };

  it('round-trips valid base64 to the exact bytes', () => {
    const decoded = decodeExportBytes(good);
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
  });

  it('rejects a wrong bytesSha256 with export-bytes-integrity + both hashes in details', () => {
    const err = rejectionOf(() => decodeExportBytes({ ...good, bytesSha256: '0'.repeat(64) }));
    expect(err.code).toBe('export-bytes-integrity');
    expect(err.httpStatus).toBe(400);
    expect(err.details['declaredSha256']).toBe('0'.repeat(64));
    expect(err.details['actualSha256']).toBe(good.bytesSha256);
  });

  it('rejects a wrong byteLength', () => {
    const err = rejectionOf(() => decodeExportBytes({ ...good, byteLength: good.byteLength - 1 }));
    expect(err.code).toBe('export-bytes-integrity');
    expect(err.details['declaredByteLength']).toBe(good.byteLength - 1);
  });

  it('rejects garbled base64 (decode is lenient — the hash gate is what catches it)', () => {
    // NOTE: PURELY-invalid characters (e.g. '!') are silently DROPPED by
    // Buffer's lenient decoder, so corruption must change the decodable
    // payload to be observable — which real corruption does. Flip one
    // mid-payload character to a DIFFERENT valid base64 character.
    const i = 200;
    const flipped = good.bytesBase64[i] === 'B' ? 'C' : 'B';
    const garbled = `${good.bytesBase64.slice(0, i)}${flipped}${good.bytesBase64.slice(i + 1)}`;
    const err = rejectionOf(() => decodeExportBytes({ ...good, bytesBase64: garbled }));
    expect(err.code).toBe('export-bytes-integrity');
  });
});

// --- reimportExportedBytes ------------------------------------------------

describe('reimportExportedBytes (parse + intake + T2 cleanliness conditions)', () => {
  it('re-imports clean export STL bytes (weld reproduces the canonical topology)', () => {
    const mesh = cube();
    const result = reimportExportedBytes(exportStlBinary(mesh), 'stl');
    expect(result.parseDiagnostics.format).toBe('stl-binary');
    expect(result.parseDiagnostics.warnings).toHaveLength(0);
    expect(result.mesh.indices.length).toBe(mesh.indices.length);
    // The T2 equivalence: the re-import equals the CANONICAL re-index of the
    // source (triangle-scan first-occurrence vertex order; the cube's
    // coordinates are f32-exact so narrow32 is the identity here). NOT
    // hash-identical to the source itself — the vertex-order boundary the
    // endpoint suites document.
    const canon = weldVertices(indexedToSoup(mesh));
    expect(hashMesh(result.mesh)).toBe(hashMesh(canon));
    expect(hashMesh(result.mesh)).not.toBe(hashMesh(mesh));
  });

  it('re-imports clean export PLY bytes losslessly (hash-identical always)', () => {
    const mesh = cube();
    const result = reimportExportedBytes(exportPlyBinary(mesh), 'ply');
    expect(hashMesh(result.mesh)).toBe(hashMesh(mesh));
  });

  it('rejects truncated bytes with export-bytes-parse-failed (TruncatedFileError)', () => {
    const bytes = exportStlBinary(cube());
    const err = rejectionOf(() =>
      reimportExportedBytes(bytes.slice(0, bytes.byteLength - 13), 'stl'),
    );
    expect(err.code).toBe('export-bytes-parse-failed');
    expect(err.httpStatus).toBe(400);
    expect(err.details['errorName']).toBe('TruncatedFileError');
  });

  it('rejects bytes too short to be a header at all', () => {
    const err = rejectionOf(() => reimportExportedBytes(new Uint8Array(10), 'stl'));
    expect(err.code).toBe('export-bytes-parse-failed');
  });

  it('rejects a multi-component STL (two disjoint cubes) with export-reimport-integrity', () => {
    const bytes = writeStlBinary(soupOf(cube(), translated(cube(), 5)));
    const err = rejectionOf(() => reimportExportedBytes(bytes, 'stl'));
    expect(err.code).toBe('export-reimport-integrity');
    expect((err.details['violations'] as Record<string, number>)['componentCount']).toBe(2);
  });

  it('rejects an STL with a degenerate triangle (intake had to repair)', () => {
    const base = soupOf(cube());
    const positions = new Float64Array(base.positions.length + 9);
    positions.set(base.positions);
    // Append a zero-area triangle (all three vertices identical).
    positions.set([0, 0, 0, 0, 0, 0, 0, 0, 0], base.positions.length);
    const bytes = writeStlBinary({
      positions,
      normals: null,
      triangleCount: base.triangleCount + 1,
    });
    const err = rejectionOf(() => reimportExportedBytes(bytes, 'stl'));
    expect(err.code).toBe('export-reimport-integrity');
    const violations = err.details['violations'] as Record<string, number>;
    expect(violations['degenerateCount'] ?? violations['duplicateIndexCount']).toBeGreaterThan(0);
  });

  it('rejects an STL with one flipped triangle (orientation repair needed)', () => {
    const mesh = cube();
    const flipped = { positions: mesh.positions, indices: mesh.indices.slice() };
    // Reverse the winding of the first triangle only.
    const [a, b, c] = [flipped.indices[0]!, flipped.indices[1]!, flipped.indices[2]!];
    flipped.indices[0] = c;
    flipped.indices[2] = a;
    void b;
    const bytes = writeStlBinary(soupOf(flipped));
    const err = rejectionOf(() => reimportExportedBytes(bytes, 'stl'));
    expect(err.code).toBe('export-reimport-integrity');
    expect((err.details['violations'] as Record<string, number>)['flippedCount']).toBe(1);
  });
});

// --- verifyExportJournal --------------------------------------------------

describe('verifyExportJournal (persisted-journal authority)', () => {
  const mesh = cube();
  const finalMeshHash = hashMesh(mesh);
  const bytes = exportStlBinary(mesh);
  const bytesSha256 = sha256HexOf(Buffer.from(bytes));

  const report: QcReport = {
    gates: [
      {
        gate: 'watertight',
        passed: true,
        acknowledged: false,
        value: null,
        threshold: null,
        unit: null,
        message: 'ok',
      },
      {
        gate: 'seating',
        passed: false,
        acknowledged: true,
        value: 2,
        threshold: 1,
        unit: 'mm3',
        message: 'high',
      },
    ],
    passed: true,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.1.0',
    journalHash: finalMeshHash,
  };

  const ackOp: Operation = {
    id: 'ack-1',
    name: 'inlay-qc-ack',
    params: {
      restorationId: 'resto-1',
      acknowledgedGate: 'seating',
      acknowledgedGates: ['seating'],
    },
    inputHashes: [],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  const exportOp: Operation = {
    id: 'export-1',
    name: 'restoration-export',
    // `teeth` is part of the REAL journaled op shape (exportFlow.ts) and is
    // verified three-way since review B1 (request = saved restoration =
    // journaled op).
    params: {
      restorationId: 'resto-1',
      restorationType: 'inlay',
      teeth: [36],
      format: 'stl',
      byteLength: bytes.byteLength,
    },
    inputHashes: [finalMeshHash],
    outputHashes: [bytesSha256],
    kernelVersion: KERNEL_VERSION,
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  function makeDocument(overrides?: {
    history?: Operation[];
    finalMesh?: string | undefined;
    restorationType?: 'inlay' | 'crown';
    noRestoration?: boolean;
  }): CaseDocument {
    return {
      id: 'case-1',
      schemaVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      meshes: [],
      scene: [],
      restorations: overrides?.noRestoration
        ? []
        : [
            {
              id: 'resto-1',
              type: overrides?.restorationType ?? 'inlay',
              teeth: [36],
              pontics: [],
              targetNodeId: null,
              marginLines: {},
              insertionAxis: [0, 0, 1],
              params: {
                cementGapMm: 0.05,
                marginalGapMm: 0.02,
                spacerStartMm: 0.8,
                minWallThicknessMm: 0.5,
                proximalContactPenetrationMm: 0.02,
                occlusalContactMm: 0,
              },
              stages:
                overrides && 'finalMesh' in overrides
                  ? overrides.finalMesh === undefined
                    ? {}
                    : { finalMesh: overrides.finalMesh }
                  : { finalMesh: finalMeshHash },
              qc: report,
            },
          ],
      measurements: [],
      history: overrides?.history ?? [ackOp, exportOp],
      settings: { materialProfileId: 'standard-zirconia', profileVersion: '1.1.0' },
    };
  }

  function makeRequest(overrides?: Partial<RestorationExportRequest>): RestorationExportRequest {
    const base: RestorationExportRequest = {
      schemaVersion: 1,
      caseId: 'case-1',
      restorationId: 'resto-1',
      restorationType: 'inlay',
      teeth: [36],
      format: 'stl',
      meshContentHash: finalMeshHash,
      exportOperationId: 'export-1',
      bytesBase64: Buffer.from(bytes).toString('base64'),
      bytesSha256,
      byteLength: bytes.byteLength,
      qcReport: report,
      acknowledgments: [
        {
          gate: 'seating',
          message: 'high',
          value: 2,
          threshold: 1,
          unit: 'mm3',
          operationId: 'ack-1',
        },
      ],
      caseJournalHash: 'f'.repeat(64),
      journalOperationCount: 2,
      materialProfile: { id: 'standard-zirconia', version: '1.1.0', checksum: 'a'.repeat(64) },
      kernelVersion: KERNEL_VERSION,
    };
    return { ...base, ...overrides };
  }

  it('accepts a fully consistent document/request pair', () => {
    expect(() => verifyExportJournal(makeDocument(), makeRequest())).not.toThrow();
  });

  const reject = (
    document: CaseDocument,
    request: RestorationExportRequest,
  ): ExportRejectionError => rejectionOf(() => verifyExportJournal(document, request));

  it('rejects an operation-count mismatch (truncated-journal triage)', () => {
    const err = reject(makeDocument(), makeRequest({ journalOperationCount: 5 }));
    expect(err.code).toBe('export-journal-verification-failed');
    expect(err.details['reason']).toBe('operation-count-mismatch');
    expect(err.details['savedOperationCount']).toBe(2);
  });

  it('rejects a missing export operation', () => {
    const err = reject(
      makeDocument({ history: [ackOp] }),
      makeRequest({ journalOperationCount: 1 }),
    );
    expect(err.details['reason']).toBe('export-operation-missing');
  });

  it('rejects an export ref pointing at a non-export op', () => {
    const err = reject(makeDocument(), makeRequest({ exportOperationId: 'ack-1' }));
    expect(err.details['reason']).toBe('export-operation-wrong-name');
  });

  it('rejects a journaled outputHashes[0] that is not the request bytesSha256', () => {
    const tamperedOp = { ...exportOp, outputHashes: ['0'.repeat(64)] };
    const err = reject(makeDocument({ history: [ackOp, tamperedOp] }), makeRequest());
    expect(err.details['reason']).toBe('export-operation-bytes-hash-mismatch');
  });

  it('rejects a journaled inputHashes[0] that is not the request meshContentHash', () => {
    const tamperedOp = { ...exportOp, inputHashes: ['0'.repeat(64)] };
    const err = reject(makeDocument({ history: [ackOp, tamperedOp] }), makeRequest());
    expect(err.details['reason']).toBe('export-operation-mesh-hash-mismatch');
  });

  it('rejects export-op params disagreeing on restorationId/format', () => {
    const tamperedOp = { ...exportOp, params: { ...exportOp.params, format: 'ply' } };
    const err = reject(makeDocument({ history: [ackOp, tamperedOp] }), makeRequest());
    expect(err.details['reason']).toBe('export-operation-params-mismatch');
  });

  it('rejects a missing restoration', () => {
    const err = reject(makeDocument({ noRestoration: true }), makeRequest());
    expect(err.details['reason']).toBe('restoration-missing');
  });

  it('rejects a restoration-type mismatch', () => {
    const err = reject(makeDocument({ restorationType: 'crown' }), makeRequest());
    expect(err.details['reason']).toBe('restoration-type-mismatch');
  });

  // Review B1 — three-way teeth identity (request = saved restoration =
  // journaled export op). Both refusal reasons unit-covered; the endpoint-
  // level red-pre-fix regressions live in export-traceability.test.ts.
  it('B1: rejects request teeth that disagree with the SAVED restoration (the authority)', () => {
    const err = reject(makeDocument(), makeRequest({ teeth: [46] }));
    expect(err.details['reason']).toBe('restoration-teeth-mismatch');
    expect(err.details['saved']).toEqual([36]);
    expect(err.details['request']).toEqual([46]);
  });

  it('B1: rejects a journaled export op whose params.teeth disagree with the request', () => {
    const tamperedOp = { ...exportOp, params: { ...exportOp.params, teeth: [46] } };
    const err = reject(makeDocument({ history: [ackOp, tamperedOp] }), makeRequest());
    expect(err.details['reason']).toBe('export-operation-teeth-mismatch');
  });

  it('B1: rejects a journaled export op MISSING params.teeth entirely (not a legitimate op shape)', () => {
    const withoutTeeth = { ...(exportOp.params as Record<string, unknown>) };
    delete withoutTeeth['teeth'];
    const tamperedOp = { ...exportOp, params: withoutTeeth };
    const err = reject(makeDocument({ history: [ackOp, tamperedOp] }), makeRequest());
    expect(err.details['reason']).toBe('export-operation-teeth-mismatch');
  });

  it('B1: teeth equality is exact-SEQUENCE — a reordered set is refused, never normalized', () => {
    const multi = { ...exportOp, params: { ...exportOp.params, teeth: [36, 37] } };
    const document = makeDocument({ history: [ackOp, multi] });
    const restoration = document.restorations[0]! as unknown as { teeth: number[] };
    restoration.teeth = [36, 37];
    const err = reject(document, makeRequest({ teeth: [37, 36] }));
    expect(err.details['reason']).toBe('restoration-teeth-mismatch');
  });

  it('rejects bytes that do not serialize the persisted stages.finalMesh', () => {
    const err = reject(makeDocument({ finalMesh: '1'.repeat(64) }), makeRequest());
    expect(err.details['reason']).toBe('final-mesh-mismatch');
  });

  it('rejects stages.finalMesh being absent entirely', () => {
    const err = reject(makeDocument({ finalMesh: undefined }), makeRequest());
    expect(err.details['reason']).toBe('final-mesh-mismatch');
    expect(err.details['savedFinalMesh']).toBeNull();
  });

  it('REFUSES operationId: null (the N4 contract — unjournaled acknowledgment)', () => {
    const request = makeRequest({
      acknowledgments: [
        {
          gate: 'seating',
          message: 'high',
          value: 2,
          threshold: 1,
          unit: 'mm3',
          operationId: null,
        },
      ],
    });
    const err = reject(makeDocument(), request);
    expect(err.code).toBe('export-unjournaled-acknowledgment');
    expect(err.httpStatus).toBe(409);
    expect(err.details['gate']).toBe('seating');
  });

  it('rejects an ack ref pointing at a nonexistent op (P6-T8 tampering)', () => {
    const request = makeRequest({
      acknowledgments: [
        {
          gate: 'seating',
          message: 'high',
          value: 2,
          threshold: 1,
          unit: 'mm3',
          operationId: 'nope',
        },
      ],
    });
    expect(reject(makeDocument(), request).code).toBe('export-acknowledgment-invalid');
  });

  it('rejects an ack ref pointing at a non-ack op', () => {
    const request = makeRequest({
      acknowledgments: [
        {
          gate: 'seating',
          message: 'high',
          value: 2,
          threshold: 1,
          unit: 'mm3',
          operationId: 'export-1',
        },
      ],
    });
    expect(reject(makeDocument(), request).code).toBe('export-acknowledgment-invalid');
  });

  it('rejects an ack op that acknowledges a DIFFERENT gate', () => {
    const request = makeRequest({
      acknowledgments: [
        {
          gate: 'watertight',
          message: 'x',
          value: null,
          threshold: null,
          unit: null,
          operationId: 'ack-1',
        },
      ],
    });
    expect(reject(makeDocument(), request).code).toBe('export-acknowledgment-invalid');
  });

  it('rejects an ack op recorded for a DIFFERENT restoration', () => {
    const foreignAck = { ...ackOp, params: { ...ackOp.params, restorationId: 'other-resto' } };
    const err = reject(makeDocument({ history: [foreignAck, exportOp] }), makeRequest());
    expect(err.code).toBe('export-acknowledgment-invalid');
  });
});
