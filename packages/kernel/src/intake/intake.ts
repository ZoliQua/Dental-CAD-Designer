// packages/kernel/src/intake/intake.ts
//
// `intake()`: the composed mesh-intake pipeline — weld (if the input is a
// raw soup) -> dropDegenerateTriangles -> orientNormalsConsistently ->
// analyzeMesh — producing a ready-to-use `IndexedMesh` plus a journal-ready
// `IntakeReport` (PLAN.md §2: "Every destructive operation appends an
// `Operation` ... to the case history" — this report is the payload a
// caller wraps into that journal `Operation`, not a journal entry itself;
// journaling/hashing is the case-store's job, not this pure kernel
// function's).
//
// ## Soup vs. already-indexed input
//
// `IntakeInput` (types.ts) accepts either shape:
//  - `{ kind: 'soup', soup }` — an unindexed `TriangleSoup`, e.g. STL parser
//    output (`RawTriangleSoup`, structurally compatible — see types.ts's
//    `TriangleSoup` doc) or a PLY mesh explicitly expanded via
//    `indexedToSoup` (soup.ts). This runs `weldVertices` first.
//  - `{ kind: 'indexed', mesh }` — an already shared-vertex `IndexedMesh`,
//    e.g. PLY parser output directly (`PlyMesh` is indexed by construction
//    — packages/io's module doc). The weld stage is SKIPPED entirely: PLY's
//    format has no reason to duplicate a vertex the way STL's per-triangle
//    soup does (every vertex is written once, referenced by index), so
//    re-welding it would spend an O(n) spatial-hash pass to confirm what
//    the format already guarantees. If a caller doesn't trust that (e.g. a
//    PLY written by a scanner known to emit near-duplicate vertices anyway)
//    it should convert via `indexedToSoup` and pass `{ kind: 'soup', ... }`
//    instead — weld semantics are then identical to the STL path.
//
// ## Why intake() takes no AbortSignal
//
// intake() is fully SYNCHRONOUS (no WASM, no I/O — every step here is plain
// CPU work over typed arrays), so it has no actual yield points between its
// internal stage calls; a `signal.aborted` check between them would only
// ever be observed if the signal fired during a PREVIOUS macrotask, never
// "while intake() is running". Real between-stage cancellation requires the
// CALLER to control stage sequencing with real `await` points — that's
// exactly what kernel-workers' `intakeMesh` job does: it calls
// `weldVertices` / `dropDegenerateTriangles` / `orientNormalsConsistently` /
// `analyzeMesh` directly (not through this function) so it can `await
// ctx.cancelled()` between each. `intake()` remains the convenient
// synchronous all-in-one composition for non-worker callers (tests, quick
// main-thread use on small meshes) that don't need cancellation.
import type { IndexedMesh } from '../mesh/types.ts';
import { analyzeMesh } from './analyze.ts';
import { dropDegenerateTriangles } from './degenerate.ts';
import { orientNormalsConsistently } from './orient.ts';
import { countsOf, makeStepReport } from './report.ts';
import type { IntakeInput, IntakeOptions, IntakeReport, IntakeResult, IntakeStepReport } from './types.ts';
import { MESH_WELD_EPSILON_MM, weldVertices } from './weld.ts';

const STAGE_COUNT_INDEXED_INPUT = 3; // dropDegenerate, orientNormals, analyze
const STAGE_COUNT_SOUP_INPUT = 4; // weld, dropDegenerate, orientNormals, analyze

export function intake(input: IntakeInput, opts: IntakeOptions = {}): IntakeResult {
  const epsilon = opts.epsilon ?? MESH_WELD_EPSILON_MM;
  const onProgress = opts.onProgress;
  const totalStages = input.kind === 'soup' ? STAGE_COUNT_SOUP_INPUT : STAGE_COUNT_INDEXED_INPUT;
  let stagesDone = 0;
  const reportProgress = (): void => {
    stagesDone++;
    onProgress?.(stagesDone / totalStages);
  };

  const steps: IntakeStepReport[] = [];

  let mesh: IndexedMesh;
  if (input.kind === 'soup') {
    const beforeWeld: IntakeStepReport['before'] = {
      vertexCount: input.soup.triangleCount * 3,
      triangleCount: input.soup.triangleCount,
    };
    mesh = weldVertices(input.soup, epsilon);
    steps.push(makeStepReport('weld', beforeWeld, countsOf(mesh), {}));
    reportProgress();
  } else {
    mesh = input.mesh;
  }

  const beforeDrop = countsOf(mesh);
  const dropped = dropDegenerateTriangles(mesh);
  steps.push(
    makeStepReport('dropDegenerateTriangles', beforeDrop, countsOf(dropped.mesh), {
      degenerateCount: dropped.degenerateCount,
      duplicateIndexCount: dropped.duplicateIndexCount,
    }),
  );
  reportProgress();

  const beforeOrient = countsOf(dropped.mesh);
  const oriented = orientNormalsConsistently(dropped.mesh);
  steps.push(
    makeStepReport('orientNormalsConsistently', beforeOrient, countsOf(oriented.mesh), {
      flippedCount: oriented.flippedCount,
      componentCount: oriented.componentCount,
      ambiguousComponentCount: oriented.ambiguousComponentCount,
    }),
  );
  reportProgress();

  const stats = analyzeMesh(oriented.mesh);
  reportProgress();

  const report: IntakeReport = { weldEpsilonMm: epsilon, steps };

  return { mesh: oriented.mesh, stats, report };
}
