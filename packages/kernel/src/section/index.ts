// packages/kernel/src/section — cross-section polyline extraction, SVG
// export, and (via ../boolean/manifold.ts) the filled-cap computation.
// See polyline.ts's module doc for the acceptance-critical outline
// algorithm and svg.ts's for the SVG export.
export {
  DegeneratePlaneError,
  normalizePlane,
  projectToPlaneXY,
  signedDistance,
  type Plane,
  type PlaneBasis,
} from './plane.ts';
export { ON_PLANE_EPSILON_MM, sectionMesh, type SectionMeshResult, type SectionPolyline } from './polyline.ts';
export { extractLocalSubmesh } from './roi.ts';
export {
  projectPolylinesToPlaneXY,
  sectionToSvg,
  type SectionSvgPolyline,
  type SectionToSvgOptions,
} from './svg.ts';
// Re-exported here (not just from ../boolean/manifold.ts directly) so
// `sectionMesh`'s "outline" and `sectionCap`'s "fill" — this task's two
// halves of one feature — have one obvious shared import path, even though
// `sectionCap` physically lives alongside the rest of the manifold-3d
// wrapper (see its own doc comment for why: it reuses that file's private
// `constructManifold`/`NonManifoldInputError` machinery).
export { sectionCap } from '../boolean/manifold.ts';
