// packages/cad-pipeline/src/stages/bridgeAssembly.ts
//
// Phase 6 Task 6 — the BRIDGE ASSEMBLY stage. The abutment units + pontic +
// connectors (Tasks 2–5) are, up to here, independent watertight solids; this
// stage FUSES them into ONE watertight single-component bridge solid via the
// kernel `assembleBridge` op (boolean union through the manifold-3d wrapper) and
// emits ONE journaled op `bridge.assembly`.
//
// ## Guard rail (P5 T1 pattern) + why one journaled op
//
// `assertBridgeContext` at entry — bridge-only. The union is a single coupled step
// (the whole bridge fuses at once), so — like the abutment-surfaces (T2) and
// connectors (T4) stages — this emits ONE journaled op whose `inputHashes` list
// every fused solid (units then connectors, in the supplied order) and whose
// `outputHashes` is the single assembled solid. Replay re-fuses deterministically
// (WASM determinism at a fixed manifold-3d version) → identical output hash.
//
// The stage produces GEOMETRY (the assembled solid); the whole-bridge QC REPORT is
// `gates/bridgeReport.ts#runBridgeQc` (the P4/P5 "stage builds geometry, the QC
// assembler judges it" split).
import { assembleBridge, BridgeAssemblyError, type IndexedMesh } from '@dqcad/kernel';
import type { BridgePipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import { assertBridgeContext } from '../pipeline/context.ts';

/** Thrown when the stage is given no solids to fuse. */
export class NoAssemblySolidsError extends Error {
  constructor() {
    super('bridgeAssembly stage: no solids supplied (options.unitMeshes + options.connectorMeshes are both empty) — a bridge needs at least one unit');
    this.name = 'NoAssemblySolidsError';
  }
}

export interface BridgeAssemblyStageOptions {
  /** The unit bodies (abutments + pontic), in arch order — union inputs. */
  readonly unitMeshes: readonly PipelineMeshHandle[];
  /** The connector bars (Task 4 lofts) — union inputs. */
  readonly connectorMeshes: readonly PipelineMeshHandle[];
  /** Content-hash function for the produced solid — injected by the caller. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

export interface BridgeAssemblyStageResult {
  readonly stage: 'assembly';
  /** The fused watertight single-component bridge solid. */
  readonly assembledSolid: IndexedMesh;
  readonly contentHash: string;
  readonly watertight: boolean;
  readonly componentCount: number;
  readonly volumeMm3: number | null;
  readonly triangleCount: number;
  readonly operationName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
}

/**
 * Runs the bridge assembly stage — fuses every unit + connector into one solid.
 * Deterministic (fixed manifold-3d version) → byte-identical fused solid + hash.
 * Async (WASM union).
 *
 * @throws {RestorationTypeMismatchError}/{BridgeContextIncompleteError} via `assertBridgeContext`.
 * @throws {NoAssemblySolidsError} if no solids are supplied.
 * @throws {BridgeAssemblyError} (propagated) if the fuse is non-watertight/disjoint.
 */
export async function runBridgeAssemblyStage(
  context: BridgePipelineContext,
  options: BridgeAssemblyStageOptions,
): Promise<BridgeAssemblyStageResult> {
  assertBridgeContext(context); // bridge-only stage — guard rail
  const handles = [...options.unitMeshes, ...options.connectorMeshes];
  if (handles.length === 0) throw new NoAssemblySolidsError();

  const solids = handles.map((h) => h.mesh);
  let result;
  try {
    result = await assembleBridge(solids);
  } catch (error) {
    // Re-throw the kernel typed error unchanged (the caller surfaces it); named
    // here only for the doc — never swallowed.
    if (error instanceof BridgeAssemblyError) throw error;
    throw error;
  }
  const contentHash = options.hashMesh(result.solid);

  return {
    stage: 'assembly',
    assembledSolid: result.solid,
    contentHash,
    watertight: result.watertight,
    componentCount: result.componentCount,
    volumeMm3: result.volumeMm3,
    triangleCount: result.triangleCount,
    operationName: 'bridge.assembly',
    params: {
      inputCount: result.inputCount,
      unitCount: options.unitMeshes.length,
      connectorCount: options.connectorMeshes.length,
      componentCount: result.componentCount,
      watertight: result.watertight,
      triangleCount: result.triangleCount,
    },
    inputHashes: handles.map((h) => h.contentHash),
    outputHashes: [contentHash],
  };
}
