// packages/kernel/src/bridge/ponticUnit.ts
//
// Phase 9 Task 6 — the PONTIC UNIT solid: the closed, watertight pontic a bridge
// assembly fuses, built from a placed library body and the per-style base
// surface (ponticInterface.ts). Phase 6 shaped and measured the base as an open
// patch, and the demonstration bridge carried a stand-in pontic unit; a bridge
// built from the case needs the real solid whose underside IS that base.
//
// ## Construction (deterministic, Float64 in, manifold wrapper booleans)
//
// Work in the crest cylinder's frame: station `s` along `mesialDistalDir`,
// angle `φ` from `upDir` toward `buccalDir`, radius `r` from the crest axis.
// The style surface is `r = R + t(φ)` (`ponticStyleTargetField`).
//
//   1. CUT. Subtract a "below" solid — the style surface over an extended
//      footprint, closed down to radius `R_in` — from the body, so no body
//      material lies between the ridge and the configured base. The cut
//      surface is lifted by its own measured chord inset, so its chords never
//      dip into the clearance.
//   2. FOOTPRINT. The plate top is `r_t = R + max(max t(φ), seatOffsetMm) +
//      plateThicknessMm`. The body's extent between the style surface and `r_t`
//      (its station range and largest |φ|), widened by `flangeMm` on every
//      side, is the footprint — so inside the plate band the body never
//      overhangs the plate's rim.
//   3. PLATE. A closed plate over that footprint, from the style surface up to
//      `r_t` (at least `plateThicknessMm` thick everywhere), is UNIONED with the
//      cut body. Its bottom is the base mesh itself, so the pontic's underside
//      over the whole footprint is the configured base.
//
// The plate's side walls are the pontic's RIM — the analogue of a crown
// shell's seam band, joining the underside to the outer surface. The result is
// partitioned by construction provenance (each vertex's place in the crest
// frame) into `underside` (inner, for the thickness gate), `rim` (excluded
// from both surfaces, as the crown's seam band is) and `outer`. Without that
// partition a closest-surface thickness reads ~0 at any edge where the
// underside meets the outer surface, which is not thin material.
//
// ## The plate is real geometry, not a measuring device
//
// Where the body is narrower than the footprint, the plate shows as a flange
// of thickness ≥ `plateThicknessMm` and width ≤ `flangeMm` — the thickness
// gate then measures that flange, honestly.
//
// @errorBound The base vertices are exact on the style surface (Float64
// cos/sin only, ponticInterface.ts); the booleans pass through the manifold-3d
// Float32 boundary (`boolean/manifold.ts` @errorBound). `asBuiltDeviationMm` is
// the MEASURED max distance from every primary-patch base sample to the
// as-built underside — the relief gate adds it to the design deviation, so the
// reported relief is a statement about the solid that is exported, not only
// about the design surface.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { intersect, subtract, union } from '../boolean/manifold.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import {
  ponticStyleTargetField,
  shapePonticBase,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type PonticInterfaceParams,
  type PonticInterfaceStyle,
  type RidgeCrestCylinder,
  type ShapePonticBaseResult,
} from './ponticInterface.ts';

/** Angular half-span (rad) of the "below" cut solid — wide enough to take every
 * body vertex above the crest axis' plane, below 90° so the crest frame stays a
 * graph over (s, φ). */
const BELOW_HALF_SPAN_RAD = (85 * Math.PI) / 180;

/** Vertex classification tolerance (mm): the manifold-3d Float32 boundary
 * rounding of a coordinate of a few tens of mm (≈ 2⁻²⁴·64 mm ≈ 4e-6 mm). */
const VERTEX_TOL_MM = 1e-5;

/** The cut surface's minimum lift above the style surface (mm). The cut face
 * ends up inside the plate (the plate starts AT the style surface and is
 * ≥ `plateThicknessMm` thick over the body's footprint), so the lift never
 * reaches the result; it only keeps the two faces far apart compared with the
 * boolean kernel's merge tolerance — near-coincident faces would be snapped
 * together and move base vertices off the configured surface. */
const CUT_CLEARANCE_MM = 0.01;

/** The cut surface's angular resolution relative to the base mesh's — finer,
 * so the lift that keeps its chords out of the clearance stays sub-micrometre. */
const CUT_ANGULAR_REFINEMENT = 4;

/** Classification tolerance (mm) beyond the construction's own chord sagitta:
 * the manifold-3d Float32 boundary rounding of a coordinate of a few tens of
 * mm (≈ 2⁻²⁴·64 mm ≈ 4e-6 mm), with margin. */
const CLASSIFY_FLOAT32_SLACK_MM = 1e-4;

export interface PonticUnitParams {
  /** How far (mm) the base plate extends past the body's cut section. */
  readonly flangeMm: number;
  /** Plate thickness (mm) above the discovery level. */
  readonly plateThicknessMm: number;
  /** The plate's lower reference level's minimum height above the crest (mm)
   * — keeps the plate reaching into the body when the style surface lies at
   * or below the body's seat (ridge-lap, ovate). */
  readonly seatOffsetMm: number;
  /** Base-mesh + sample-grid resolution (the plate's bottom is this mesh). */
  readonly resolution: PonticBaseResolution;
  /** How far (mm) the cut solid extends past the body's station range. Default 1. */
  readonly cutExtendMm?: number;
}

export interface PonticUnitResult {
  /** The closed, watertight, single-component pontic unit. */
  readonly solid: IndexedMesh;
  /** The as-built underside (the base) — the thickness gate's inner surface. */
  readonly underside: IndexedMesh;
  /** The plate side walls — excluded from both thickness surfaces. */
  readonly rim: IndexedMesh;
  /** Everything else — the thickness gate's outer surface. */
  readonly outer: IndexedMesh;
  /** The footprint the base covers (derived from the body's section). */
  readonly footprint: PonticBaseFootprint;
  /** The shaped base over that footprint (design surface + dense samples). */
  readonly base: ShapePonticBaseResult;
  /** The base footprint's boundary at the style surface (closed polyline). */
  readonly rimLoop: Vec3[];
  /** The plate's lower reference level (mm from the crest axis):
   * `R + max(max t, seatOffset)`; the plate top is this + `plateThicknessMm`. */
  readonly discoveryRadiusMm: number;
  /** @errorBound — max distance from a primary base sample to the as-built underside (mm). */
  readonly asBuiltDeviationMm: number;
}

export class PonticUnitError extends Error {
  readonly reason: 'emptySection' | 'footprintTooWide' | 'notWatertight';
  constructor(reason: PonticUnitError['reason'], message: string) {
    super(`buildPonticUnit: ${message}`);
    this.name = 'PonticUnitError';
    this.reason = reason;
  }
}

interface CrestCoords {
  readonly s: number;
  readonly r: number;
  readonly phi: number;
}

function crestCoords(crest: RidgeCrestCylinder, x: number, y: number, z: number): CrestCoords {
  const dx = x - crest.axisPointMm[0];
  const dy = y - crest.axisPointMm[1];
  const dz = z - crest.axisPointMm[2];
  const s = dx * crest.mesialDistalDir[0] + dy * crest.mesialDistalDir[1] + dz * crest.mesialDistalDir[2];
  const b = dx * crest.buccalDir[0] + dy * crest.buccalDir[1] + dz * crest.buccalDir[2];
  const u = dx * crest.upDir[0] + dy * crest.upDir[1] + dz * crest.upDir[2];
  return { s, r: Math.hypot(b, u), phi: Math.atan2(b, u) };
}

/** The point at (s, φ, r) of the crest frame. */
function crestPoint(crest: RidgeCrestCylinder, s: number, phi: number, r: number): Vec3 {
  const c = Math.cos(phi) * r;
  const b = Math.sin(phi) * r;
  return [
    crest.axisPointMm[0] + s * crest.mesialDistalDir[0] + c * crest.upDir[0] + b * crest.buccalDir[0],
    crest.axisPointMm[1] + s * crest.mesialDistalDir[1] + c * crest.upDir[1] + b * crest.buccalDir[1],
    crest.axisPointMm[2] + s * crest.mesialDistalDir[2] + c * crest.upDir[2] + b * crest.buccalDir[2],
  ];
}

function flipWinding(mesh: IndexedMesh): IndexedMesh {
  const indices = mesh.indices.slice();
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1]!;
    indices[t + 1] = indices[t + 2]!;
    indices[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices };
}

/**
 * A closed solid between a base grid (`shapePonticBase`'s mesh: rows of
 * `cols` vertices per station) and a second layer at radius `radiusAt(φ)` in
 * the crest frame, joined by side walls along the grid boundary. Oriented
 * consistently, then pinned outward (positive signed volume).
 */
function layeredSolid(
  crest: RidgeCrestCylinder,
  grid: IndexedMesh,
  rows: number,
  cols: number,
  radiusAt: (phi: number) => number,
): IndexedMesh {
  const n = rows * cols;
  const positions = new Float64Array(n * 6);
  positions.set(grid.positions, 0);
  for (let i = 0; i < n; i++) {
    const cc = crestCoords(crest, grid.positions[i * 3]!, grid.positions[i * 3 + 1]!, grid.positions[i * 3 + 2]!);
    const q = crestPoint(crest, cc.s, cc.phi, radiusAt(cc.phi));
    positions[(n + i) * 3] = q[0];
    positions[(n + i) * 3 + 1] = q[1];
    positions[(n + i) * 3 + 2] = q[2];
  }
  const A = (r: number, c: number): number => r * cols + c;
  const B = (r: number, c: number): number => n + r * cols + c;
  const tris: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      tris.push(A(r, c), A(r + 1, c), A(r + 1, c + 1), A(r, c), A(r + 1, c + 1), A(r, c + 1));
      tris.push(B(r, c), B(r + 1, c + 1), B(r + 1, c), B(r, c), B(r, c + 1), B(r + 1, c + 1));
    }
  }
  const loop: [number, number][] = [];
  for (let c = 0; c < cols; c++) loop.push([0, c]);
  for (let r = 1; r < rows; r++) loop.push([r, cols - 1]);
  for (let c = cols - 2; c >= 0; c--) loop.push([rows - 1, c]);
  for (let r = rows - 2; r >= 1; r--) loop.push([r, 0]);
  for (let k = 0; k < loop.length; k++) {
    const [r0, c0] = loop[k]!;
    const [r1, c1] = loop[(k + 1) % loop.length]!;
    tris.push(A(r0, c0), B(r0, c0), B(r1, c1), A(r0, c0), B(r1, c1), A(r1, c1));
  }
  const oriented = orientNormalsConsistently({ positions, indices: new Uint32Array(tris) }).mesh;
  const volume = analyzeMesh(oriented).signedVolumeMm3;
  return volume !== null && volume < 0 ? flipWinding(oriented) : oriented;
}

/** Sub-samples per grid interval when bounding a chord's inset. */
const CHORD_INSET_SUBSAMPLES = 32;

/**
 * How far (mm) the chords of a grid of `segments` angular steps over
 * ±`halfSpanRad` fall INSIDE the polar curve `r = radiusAt(φ)` (the crest
 * frame's cross-section; stations are ruled, so they add nothing). Measured on
 * `CHORD_INSET_SUBSAMPLES` points per interval — this covers the curvature of
 * a varying style field (a ridge-lap transition, an ovate seat edge), not only
 * a circle's sagitta.
 */
function chordInsetMm(radiusAt: (phi: number) => number, halfSpanRad: number, segments: number): number {
  const point = (phi: number): [number, number] => {
    const r = radiusAt(phi);
    return [r * Math.sin(phi), r * Math.cos(phi)];
  };
  let worst = 0;
  for (let j = 0; j < segments; j++) {
    const phiA = -halfSpanRad + (2 * halfSpanRad * j) / segments;
    const phiB = -halfSpanRad + (2 * halfSpanRad * (j + 1)) / segments;
    const a = point(phiA);
    const b = point(phiB);
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    // Outward normal of the chord (away from the crest axis).
    let nx = ey / len;
    let ny = -ex / len;
    if (nx * (a[0] + b[0]) + ny * (a[1] + b[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let k = 1; k < CHORD_INSET_SUBSAMPLES; k++) {
      const p = point(phiA + ((phiB - phiA) * k) / CHORD_INSET_SUBSAMPLES);
      const outside = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
      if (outside > worst) worst = outside;
    }
  }
  return worst;
}

/** A row-major grid over `footprint` (stations × angles, `shapePonticBase`'s
 * layout and parameter spacing) on the surface `r = radiusAt(φ)`. */
function styleGrid(
  crest: RidgeCrestCylinder,
  radiusAt: (phi: number) => number,
  footprint: PonticBaseFootprint,
  stations: number,
  angularSegments: number,
): { mesh: IndexedMesh; rows: number; cols: number } {
  const rows = stations + 1;
  const cols = angularSegments + 1;
  const positions = new Float64Array(rows * cols * 3);
  const phiHalf = footprint.angularHalfSpanRad;
  let k = 0;
  for (let i = 0; i < rows; i++) {
    const s =
      i === 0 ? footprint.stationMinMm : i === stations ? footprint.stationMaxMm : footprint.stationMinMm + ((footprint.stationMaxMm - footprint.stationMinMm) * i) / stations;
    for (let j = 0; j < cols; j++) {
      const phi = j === 0 ? -phiHalf : j === angularSegments ? phiHalf : -phiHalf + (2 * phiHalf * j) / angularSegments;
      const p = crestPoint(crest, s, phi, radiusAt(phi));
      positions[k++] = p[0];
      positions[k++] = p[1];
      positions[k++] = p[2];
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = (i + 1) * cols + j;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return { mesh: { positions, indices: new Uint32Array(indices) }, rows, cols };
}

/** The base grid's boundary loop, at the style surface (row-major grid). */
function gridBoundaryLoop(grid: IndexedMesh, rows: number, cols: number): Vec3[] {
  const at = (r: number, c: number): Vec3 => {
    const i = r * cols + c;
    return [grid.positions[i * 3]!, grid.positions[i * 3 + 1]!, grid.positions[i * 3 + 2]!];
  };
  const loop: Vec3[] = [];
  for (let c = 0; c < cols; c++) loop.push(at(0, c));
  for (let r = 1; r < rows; r++) loop.push(at(r, cols - 1));
  for (let c = cols - 2; c >= 0; c--) loop.push(at(rows - 1, c));
  for (let r = rows - 2; r >= 1; r--) loop.push(at(r, 0));
  return loop;
}

function submesh(mesh: IndexedMesh, triangles: readonly number[]): IndexedMesh {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[t * 3 + k]!;
      let nv = remap.get(vi);
      if (nv === undefined) {
        nv = positions.length / 3;
        remap.set(vi, nv);
        positions.push(mesh.positions[vi * 3]!, mesh.positions[vi * 3 + 1]!, mesh.positions[vi * 3 + 2]!);
      }
      indices.push(nv);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function assertPositive(name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`buildPonticUnit: ${name} must be finite and > 0, got ${value}`);
  }
}

/**
 * Builds the closed pontic unit from the placed library `body` — see this
 * module's doc for the construction, the surface partition and the
 * @errorBound. Deterministic: same inputs + manifold-3d version ⇒
 * byte-identical outputs.
 *
 * @throws {PonticUnitError} `emptySection` when the body has no material in
 * the plate band, `footprintTooWide` when the body's angular span reaches
 * 90°, `notWatertight` when the union is not one watertight solid.
 * @throws {PonticInterfaceParamError} for an invalid style param / frame.
 * @throws {NonManifoldInputError} (boolean wrapper) for a non-manifold body.
 */
export async function buildPonticUnit(
  body: IndexedMesh,
  crest: RidgeCrestCylinder,
  style: PonticInterfaceStyle,
  styleParams: PonticInterfaceParams,
  unit: PonticUnitParams,
): Promise<PonticUnitResult> {
  assertPositive('flangeMm', unit.flangeMm);
  assertPositive('plateThicknessMm', unit.plateThicknessMm);
  assertPositive('seatOffsetMm', unit.seatOffsetMm);
  const cutExtendMm = unit.cutExtendMm ?? 1;
  assertPositive('cutExtendMm', cutExtendMm);
  const target = ponticStyleTargetField(style, styleParams);
  const R = crest.radiusMm;
  const res = unit.resolution;
  const rows = res.meshStations + 1;
  const cols = res.meshAngularSegments + 1;

  // Body extent along the crest axis + the style field's range over the cut span.
  let sMin = Infinity;
  let sMax = -Infinity;
  for (let i = 0; i < body.positions.length; i += 3) {
    const cc = crestCoords(crest, body.positions[i]!, body.positions[i + 1]!, body.positions[i + 2]!);
    if (cc.s < sMin) sMin = cc.s;
    if (cc.s > sMax) sMax = cc.s;
  }
  let tMax = -Infinity;
  let tMin = Infinity;
  for (let k = 0; k <= res.sampleAngularSegments; k++) {
    const phi = -BELOW_HALF_SPAN_RAD + (2 * BELOW_HALF_SPAN_RAD * k) / res.sampleAngularSegments;
    const t = target(phi);
    if (t > tMax) tMax = t;
    if (t < tMin) tMin = t;
  }
  assertPositive("crest radius + the style's deepest target", R + tMin);
  const innerRadiusMm = 0.5 * (R + tMin);

  // 1. CUT — remove every body point between the ridge and the style surface.
  // The cut surface is a chordal grid; lifting it by its own chord sagitta
  // keeps every chord on or above the style surface, so no body material is
  // left inside the configured clearance.
  const cutFootprint: PonticBaseFootprint = {
    stationMinMm: sMin - cutExtendMm,
    stationMaxMm: sMax + cutExtendMm,
    angularHalfSpanRad: BELOW_HALF_SPAN_RAD,
  };
  const discoveryRadiusMm = R + Math.max(tMax, unit.seatOffsetMm);
  const cutSegments = CUT_ANGULAR_REFINEMENT * res.meshAngularSegments;
  const cutLiftMm = Math.max(
    chordInsetMm((phi) => R + target(phi), BELOW_HALF_SPAN_RAD, cutSegments) + CLASSIFY_FLOAT32_SLACK_MM,
    CUT_CLEARANCE_MM,
  );
  const cutGrid = styleGrid(crest, (phi) => R + target(phi) + cutLiftMm, cutFootprint, res.meshStations, cutSegments);
  const below = layeredSolid(crest, cutGrid.mesh, cutGrid.rows, cutGrid.cols, () => innerRadiusMm);
  const cut = await subtract(body, below);

  // 2. FOOTPRINT — the body's extent within the plate's height band (from the
  // style surface up to the plate top), so the body never overhangs the plate
  // rim inside the band: the rim's exposed wall is the full plate height.
  const plateTopRadiusMm = discoveryRadiusMm + unit.plateThicknessMm;
  const bandGrid = styleGrid(crest, () => plateTopRadiusMm, cutFootprint, res.meshStations, cutSegments);
  const band = layeredSolid(crest, bandGrid.mesh, bandGrid.rows, bandGrid.cols, () => innerRadiusMm);
  const lower = await intersect(cut, band);
  let sectionSMin = Infinity;
  let sectionSMax = -Infinity;
  let sectionPhi = 0;
  for (let i = 0; i < lower.positions.length; i += 3) {
    const cc = crestCoords(crest, lower.positions[i]!, lower.positions[i + 1]!, lower.positions[i + 2]!);
    if (cc.s < sectionSMin) sectionSMin = cc.s;
    if (cc.s > sectionSMax) sectionSMax = cc.s;
    if (Math.abs(cc.phi) > sectionPhi) sectionPhi = Math.abs(cc.phi);
  }
  if (lower.indices.length === 0 || !(sectionSMax > sectionSMin)) {
    throw new PonticUnitError(
      'emptySection',
      `the placed body has no material within ${(plateTopRadiusMm - R).toFixed(3)} mm of the crest — nothing to seat the base under`,
    );
  }
  const footprint: PonticBaseFootprint = {
    stationMinMm: sectionSMin - unit.flangeMm,
    stationMaxMm: sectionSMax + unit.flangeMm,
    angularHalfSpanRad: sectionPhi + unit.flangeMm / discoveryRadiusMm,
  };
  if (!(footprint.angularHalfSpanRad < Math.PI / 2)) {
    throw new PonticUnitError(
      'footprintTooWide',
      `the body's section spans ±${((footprint.angularHalfSpanRad * 180) / Math.PI).toFixed(1)}° about the crest — the base cannot be a graph over the crest`,
    );
  }

  // 3. PLATE — the base mesh as its bottom, up to the discovery level + thickness.
  const base = shapePonticBase(crest, style, styleParams, footprint, res);
  const plate = layeredSolid(crest, base.mesh, rows, cols, () => plateTopRadiusMm);
  const solid = await union(cut, plate);
  const stats = analyzeMesh(solid);
  if (!stats.watertight || stats.componentCount !== 1) {
    throw new PonticUnitError(
      'notWatertight',
      `the pontic unit is not one watertight solid (watertight=${stats.watertight}, components=${stats.componentCount})`,
    );
  }

  // Partition by construction provenance: a triangle is underside when all
  // three VERTICES lie on the style surface inside the footprint (the base
  // mesh's vertices are exact; only the Float32 boundary moves them), rim when
  // all three lie on one plate side wall. Vertex tests are immune to the chord
  // curvature of a varying style field.
  const vertexCount = solid.positions.length / 3;
  const onBase = new Uint8Array(vertexCount);
  const wall = new Uint8Array(vertexCount); // bit mask of the four plate side walls
  const s0 = footprint.stationMinMm;
  const s1 = footprint.stationMaxMm;
  const phiH = footprint.angularHalfSpanRad;
  for (let v = 0; v < vertexCount; v++) {
    const cc = crestCoords(crest, solid.positions[v * 3]!, solid.positions[v * 3 + 1]!, solid.positions[v * 3 + 2]!);
    const styleR = R + target(cc.phi);
    const inside = cc.s >= s0 - VERTEX_TOL_MM && cc.s <= s1 + VERTEX_TOL_MM && (Math.abs(cc.phi) - phiH) * cc.r <= VERTEX_TOL_MM;
    if (inside && Math.abs(cc.r - styleR) <= VERTEX_TOL_MM) onBase[v] = 1;
    if (cc.r >= styleR - VERTEX_TOL_MM && cc.r <= plateTopRadiusMm + VERTEX_TOL_MM) {
      let mask = 0;
      if (Math.abs(cc.s - s0) <= VERTEX_TOL_MM) mask |= 1;
      if (Math.abs(cc.s - s1) <= VERTEX_TOL_MM) mask |= 2;
      if (Math.abs(cc.phi + phiH) * cc.r <= VERTEX_TOL_MM) mask |= 4;
      if (Math.abs(cc.phi - phiH) * cc.r <= VERTEX_TOL_MM) mask |= 8;
      wall[v] = mask;
    }
  }
  const underside: number[] = [];
  const rim: number[] = [];
  const outer: number[] = [];
  const triCount = solid.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = solid.indices[t * 3]!;
    const b = solid.indices[t * 3 + 1]!;
    const c = solid.indices[t * 3 + 2]!;
    if (onBase[a] && onBase[b] && onBase[c]) underside.push(t);
    else if ((wall[a]! & wall[b]! & wall[c]!) !== 0) rim.push(t);
    else outer.push(t);
  }
  const undersideMesh = submesh(solid, underside);

  // The as-built @errorBound: every primary base sample against the underside.
  let asBuiltDeviationMm = 0;
  if (undersideMesh.indices.length > 0) {
    const bvh = buildBvh(undersideMesh);
    for (const sample of base.samples) {
      if (sample.patch !== 'primary') continue;
      const d = closestPoint(undersideMesh, bvh, sample.pointMm).distance;
      if (d > asBuiltDeviationMm) asBuiltDeviationMm = d;
    }
  } else {
    asBuiltDeviationMm = Infinity;
  }

  return {
    solid,
    underside: undersideMesh,
    rim: submesh(solid, rim),
    outer: submesh(solid, outer),
    footprint,
    base,
    rimLoop: gridBoundaryLoop(base.mesh, rows, cols),
    discoveryRadiusMm,
    asBuiltDeviationMm,
  };
}
