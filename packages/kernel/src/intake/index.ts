// packages/kernel/src/intake — mesh intake pipeline: weld vertices, drop
// degenerate triangles, orient normals consistently, analyze topology, and
// the composed intake() entry point. See intake.ts's module doc for the
// pipeline overview and each step's own file for its algorithm.
export { MESH_WELD_EPSILON_MM, weldVertices } from './weld.ts';
export { indexedToSoup } from './soup.ts';
export {
  DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4,
  checkDegenerateTriangle,
  dropDegenerateTriangles,
  type DegenerateCheck,
  type DropDegenerateResult,
} from './degenerate.ts';
export { orientNormalsConsistently, type OrientComponentReport, type OrientNormalsResult } from './orient.ts';
export { analyzeMesh } from './analyze.ts';
export { countsOf, makeStepReport } from './report.ts';
export { intake } from './intake.ts';
export type {
  Bbox,
  IntakeInput,
  IntakeOptions,
  IntakeReport,
  IntakeResult,
  IntakeStepCounts,
  IntakeStepReport,
  MeshStats,
  TriangleSoup,
} from './types.ts';
