// scripts/generate-fixtures.ts
//
// Deterministic generator for the synthetic golden-test meshes and the
// stand-in prep-die scan under test-fixtures/. Run with `tsx` (see root
// package.json's `fixtures:generate` script) or import the individual
// `generate*` functions (as test/golden/golden.test.ts does) to regenerate
// into an arbitrary directory, e.g. for a determinism check.
//
// Determinism (hard invariant, see docs/plans/phase-0-foundation.md's
// Global Constraints): no Math.random / unseeded randomness anywhere below,
// no Date.now() or other wall-clock value baked into any file's bytes.
// Every shape is built from closed-form trig/vector math over fixed
// integer parameters, so re-running this script always produces
// byte-identical output.
//
// The binary STL writer (`writeBinaryStl`) below is script-local test
// tooling — packages/io gets the real STL/PLY parsers and writers starting
// Phase 1. Do not import this writer from production code.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Used ONLY for a generation-time sanity check on the heatmap fixture pairs
// below (see `checkHeatmapFixtureTolerance`) — the same "catch a gross
// geometry bug before it ever reaches a checked-in fixture" role
// `meshVolume`'s check plays for the volume fixtures. @dqcad/kernel's BVH
// (Task 7) is real production code, already a workspace dependency, and is
// exactly the machinery the actual acceptance test (distanceHeatmap.test.ts)
// exercises against the checked-in STL bytes — reusing it here (rather than
// a second, hand-rolled distance routine) means this sanity check can never
// disagree with the kernel's own notion of "closest point on the mesh".
import { buildBvh, closestPoint, type IndexedMesh } from '@dqcad/kernel';

// ---------------------------------------------------------------------------
// Minimal Float64 vector geometry (deliberately tiny and self-contained —
// packages/kernel's real halfedge mesh + vector math lands starting Phase 2;
// this is fixture-generation tooling only).
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];

export interface Face {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface Mesh {
  readonly vertices: readonly Vec3[];
  readonly faces: readonly Face[];
}

function sub(u: Vec3, v: Vec3): Vec3 {
  return [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
}

function add(u: Vec3, v: Vec3): Vec3 {
  return [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
}

function scale(u: Vec3, s: number): Vec3 {
  return [u[0] * s, u[1] * s, u[2] * s];
}

function cross(u: Vec3, v: Vec3): Vec3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function dot(u: Vec3, v: Vec3): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

function length(u: Vec3): number {
  return Math.sqrt(dot(u, u));
}

function normalize(u: Vec3): Vec3 {
  const l = length(u);
  return [u[0] / l, u[1] / l, u[2] / l];
}

/** Indexed access with a thrown error instead of a silent `undefined` —
 * `noUncheckedIndexedAccess` is on repo-wide; this keeps that honest without
 * resorting to non-null assertions. */
function vertexAt(vertices: readonly Vec3[], index: number): Vec3 {
  const v = vertices[index];
  if (v === undefined) {
    throw new Error(`vertex index out of range: ${index}`);
  }
  return v;
}

/**
 * Returns `face`, possibly with its winding reversed, so that its normal
 * (right-hand rule over a→b→c) points away from `reference`. `reference`
 * must be a point the solid is locally "star-shaped" from — the shape's own
 * center for convex solids (spheres, the cylinder, the stand-in prep-die),
 * or a local point on the tube centerline for the torus (see buildTorus).
 */
function orientOutward(vertices: readonly Vec3[], face: Face, reference: Vec3): Face {
  const v0 = vertexAt(vertices, face.a);
  const v1 = vertexAt(vertices, face.b);
  const v2 = vertexAt(vertices, face.c);
  const normal = cross(sub(v1, v0), sub(v2, v0));
  const centroid: Vec3 = [
    (v0[0] + v1[0] + v2[0]) / 3,
    (v0[1] + v1[1] + v2[1]) / 3,
    (v0[2] + v1[2] + v2[2]) / 3,
  ];
  const outwardDir = sub(centroid, reference);
  return dot(normal, outwardDir) >= 0 ? face : { a: face.a, b: face.c, c: face.b };
}

function translateMesh(mesh: Mesh, offset: Vec3): Mesh {
  return { vertices: mesh.vertices.map((v) => add(v, offset)), faces: mesh.faces };
}

// ---------------------------------------------------------------------------
// Shape builders
// ---------------------------------------------------------------------------

/** Base regular icosahedron, unit circumradius, centered at the origin. */
function buildIcosahedronBase(): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  const vertices = raw.map(normalize);
  const faceIndices: ReadonlyArray<readonly [number, number, number]> = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const faces = faceIndices.map(([a, b, c]) => ({ a, b, c }));
  return { vertices, faces };
}

/** One subdivision pass: each triangle becomes 4, new edge midpoints are
 * re-projected onto the unit sphere. Midpoints are deduplicated via a
 * shared-edge cache keyed by the (order-independent) endpoint pair, so
 * adjacent triangles share vertices rather than each growing their own
 * (which would leave a non-manifold mesh). */
function subdivideIcosphere(mesh: Mesh): Mesh {
  const vertices = mesh.vertices.slice();
  const midpointCache = new Map<string, number>();

  function midpointIndex(i: number, j: number): number {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    const cached = midpointCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const a = vertexAt(vertices, i);
    const b = vertexAt(vertices, j);
    const midpoint = normalize([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    const newIndex = vertices.length;
    vertices.push(midpoint);
    midpointCache.set(key, newIndex);
    return newIndex;
  }

  const faces: Face[] = [];
  for (const face of mesh.faces) {
    const ab = midpointIndex(face.a, face.b);
    const bc = midpointIndex(face.b, face.c);
    const ca = midpointIndex(face.c, face.a);
    faces.push({ a: face.a, b: ab, c: ca });
    faces.push({ a: face.b, b: bc, c: ab });
    faces.push({ a: face.c, b: ca, c: bc });
    faces.push({ a: ab, b: bc, c: ca });
  }
  return { vertices, faces };
}

/** Icosphere: a geodesic sphere built by recursively subdividing an
 * icosahedron and re-projecting new vertices onto the sphere. `centeredAt`
 * defaults to the origin; translation happens after orientation, since
 * orientation only depends on relative (not absolute) position. */
export function buildIcosphere(radius: number, subdivisions: number, centeredAt: Vec3 = [0, 0, 0]): Mesh {
  let mesh = buildIcosahedronBase();
  for (let i = 0; i < subdivisions; i++) {
    mesh = subdivideIcosphere(mesh);
  }
  const vertices = mesh.vertices.map((v) => scale(v, radius));
  const faces = mesh.faces.map((f) => orientOutward(vertices, f, [0, 0, 0]));
  return translateMesh({ vertices, faces }, centeredAt);
}

/** Capped cylinder, axis along Z, centered at the origin. `segments`
 * regular-polygon-approximates each circular cross-section. */
export function buildCylinder(radius: number, height: number, segments: number): Mesh {
  const halfHeight = height / 2;
  const bottomRing: Vec3[] = [];
  const topRing: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const x = radius * Math.cos(theta);
    const y = radius * Math.sin(theta);
    bottomRing.push([x, y, -halfHeight]);
    topRing.push([x, y, halfHeight]);
  }
  const bottomCenterIndex = 2 * segments;
  const topCenterIndex = 2 * segments + 1;
  const vertices: Vec3[] = [...bottomRing, ...topRing, [0, 0, -halfHeight], [0, 0, halfHeight]];

  const rawFaces: Face[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    // Side wall, two triangles per quad.
    rawFaces.push({ a: i, b: segments + i, c: j });
    rawFaces.push({ a: j, b: segments + i, c: segments + j });
    // Cap fans.
    rawFaces.push({ a: bottomCenterIndex, b: i, c: j });
    rawFaces.push({ a: topCenterIndex, b: segments + j, c: segments + i });
  }
  // The solid cylinder is convex, so the overall centroid is a valid
  // "interior reference" for every face, caps included.
  const faces = rawFaces.map((f) => orientOutward(vertices, f, [0, 0, 0]));
  return { vertices, faces };
}

/** Torus, tube swept around the Z axis. `majorSegments` samples the sweep
 * angle (u), `minorSegments` samples the tube's circular cross-section (v). */
export function buildTorus(
  majorRadius: number,
  minorRadius: number,
  majorSegments: number,
  minorSegments: number,
): Mesh {
  const vertices: Vec3[] = [];
  const index = (i: number, j: number): number => i * minorSegments + j;
  for (let i = 0; i < majorSegments; i++) {
    const u = (2 * Math.PI * i) / majorSegments;
    for (let j = 0; j < minorSegments; j++) {
      const v = (2 * Math.PI * j) / minorSegments;
      const tubeRadius = majorRadius + minorRadius * Math.cos(v);
      vertices.push([tubeRadius * Math.cos(u), tubeRadius * Math.sin(u), minorRadius * Math.sin(v)]);
    }
  }

  const rawFaces: Face[] = [];
  for (let i = 0; i < majorSegments; i++) {
    const iNext = (i + 1) % majorSegments;
    for (let j = 0; j < minorSegments; j++) {
      const jNext = (j + 1) % minorSegments;
      const a = index(i, j);
      const b = index(iNext, j);
      const c = index(iNext, jNext);
      const d = index(i, jNext);
      rawFaces.push({ a, b, c });
      rawFaces.push({ a, b: c, c: d });
    }
  }

  // The torus is not convex (its own centroid sits in the hole), so each
  // face is oriented against the nearest point on the tube's centerline
  // (the major circle) rather than a single global reference — that point
  // is always "interior" to the solid locally around the face.
  const faces = rawFaces.map((f) => {
    const v0 = vertexAt(vertices, f.a);
    const v1 = vertexAt(vertices, f.b);
    const v2 = vertexAt(vertices, f.c);
    const centroidU = Math.atan2(
      (v0[1] + v1[1] + v2[1]) / 3,
      (v0[0] + v1[0] + v2[0]) / 3,
    );
    const reference: Vec3 = [majorRadius * Math.cos(centroidU), majorRadius * Math.sin(centroidU), 0];
    return orientOutward(vertices, f, reference);
  });
  return { vertices, faces };
}

/** Truncated cone with a flat "shoulder" margin collar at its base — a
 * procedural stand-in for a real prep-die/crown-prep scan (see
 * test-fixtures/standin-scans/README.md). Axis along Z, base at z=0.
 *
 * Profile (radius as a function of height): constant at `shoulderRadius`
 * for the shoulder collar, then linearly decreasing to `topRadius` for the
 * remaining taper. That profile is a non-increasing, piecewise-linear
 * concave function of z (slope goes from 0 to a constant negative value,
 * i.e. non-increasing), which makes the solid of revolution convex — so,
 * as with the cylinder, a single interior reference point orients every
 * face correctly. */
export function buildStandinPrepDie(): Mesh {
  const shoulderRadius = 4;
  const topRadius = 2.5;
  const shoulderHeight = 1;
  const totalHeight = 10;
  const segments = 64;

  const bottomRing: Vec3[] = [];
  const shoulderTopRing: Vec3[] = [];
  const topRing: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    bottomRing.push([shoulderRadius * cosT, shoulderRadius * sinT, 0]);
    shoulderTopRing.push([shoulderRadius * cosT, shoulderRadius * sinT, shoulderHeight]);
    topRing.push([topRadius * cosT, topRadius * sinT, totalHeight]);
  }
  const bottomCenterIndex = 3 * segments;
  const topCenterIndex = 3 * segments + 1;
  const vertices: Vec3[] = [
    ...bottomRing,
    ...shoulderTopRing,
    ...topRing,
    [0, 0, 0],
    [0, 0, totalHeight],
  ];
  const bottomOffset = 0;
  const shoulderOffset = segments;
  const topOffset = 2 * segments;

  const rawFaces: Face[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    // Bottom cap fan.
    rawFaces.push({ a: bottomCenterIndex, b: bottomOffset + i, c: bottomOffset + j });
    // Shoulder collar wall (constant radius).
    rawFaces.push({ a: bottomOffset + i, b: shoulderOffset + i, c: bottomOffset + j });
    rawFaces.push({ a: bottomOffset + j, b: shoulderOffset + i, c: shoulderOffset + j });
    // Taper wall (shoulder top ring -> occlusal top ring).
    rawFaces.push({ a: shoulderOffset + i, b: topOffset + i, c: shoulderOffset + j });
    rawFaces.push({ a: shoulderOffset + j, b: topOffset + i, c: topOffset + j });
    // Top cap fan.
    rawFaces.push({ a: topCenterIndex, b: topOffset + j, c: topOffset + i });
  }
  const reference: Vec3 = [0, 0, totalHeight / 2];
  const faces = rawFaces.map((f) => orientOutward(vertices, f, reference));
  return { vertices, faces };
}

/** Flat rectangular grid mesh in the XY plane at a fixed Z, spanning
 * [-halfWidthX, halfWidthX] x [-halfWidthY, halfWidthY], tessellated into
 * `segmentsX * segmentsY` quads (2 triangles each) — used only by Task 9's
 * plane-pair heatmap fixture (see `HEATMAP_FIXTURE_PAIRS` below), where the
 * convex-solid `orientOutward` helper doesn't apply (an open plane has no
 * "interior" reference point). Winding is fixed directly so both triangles
 * of every quad share a consistent +Z-facing normal — arbitrary but fixed,
 * and irrelevant to closestPoint queries (BVH nearest-point search doesn't
 * care about winding), only cosmetic for the exported STL's per-facet
 * normal field. */
export function buildPlane(
  halfWidthX: number,
  halfWidthY: number,
  segmentsX: number,
  segmentsY: number,
  z: number,
): Mesh {
  const rowLength = segmentsY + 1;
  const indexAt = (i: number, j: number): number => i * rowLength + j;
  const vertices: Vec3[] = [];
  for (let i = 0; i <= segmentsX; i++) {
    const x = -halfWidthX + (2 * halfWidthX * i) / segmentsX;
    for (let j = 0; j <= segmentsY; j++) {
      const y = -halfWidthY + (2 * halfWidthY * j) / segmentsY;
      vertices.push([x, y, z]);
    }
  }
  const faces: Face[] = [];
  for (let i = 0; i < segmentsX; i++) {
    for (let j = 0; j < segmentsY; j++) {
      const a = indexAt(i, j);
      const b = indexAt(i + 1, j);
      const c = indexAt(i + 1, j + 1);
      const d = indexAt(i, j + 1);
      faces.push({ a, b, c });
      faces.push({ a, b: c, c: d });
    }
  }
  return { vertices, faces };
}

// ---------------------------------------------------------------------------
// Binary STL writer — script-local test tooling. Real STL/PLY parsers and
// writers land in packages/io starting Phase 1; production code must not
// import this.
// ---------------------------------------------------------------------------

const STL_HEADER_TEXT = 'DQCAD synthetic fixture';

export function writeBinaryStl(mesh: Mesh): Buffer {
  const header = Buffer.alloc(80);
  header.write(STL_HEADER_TEXT, 0, 'ascii');

  const countBuffer = Buffer.alloc(4);
  countBuffer.writeUInt32LE(mesh.faces.length, 0);

  const triangleBuffers = mesh.faces.map((face) => {
    const v0 = vertexAt(mesh.vertices, face.a);
    const v1 = vertexAt(mesh.vertices, face.b);
    const v2 = vertexAt(mesh.vertices, face.c);
    const normal = normalize(cross(sub(v1, v0), sub(v2, v0)));

    const buffer = Buffer.alloc(50);
    let offset = 0;
    for (const component of normal) {
      buffer.writeFloatLE(component, offset);
      offset += 4;
    }
    for (const vertex of [v0, v1, v2]) {
      for (const component of vertex) {
        buffer.writeFloatLE(component, offset);
        offset += 4;
      }
    }
    buffer.writeUInt16LE(0, offset); // attribute byte count, unused
    return buffer;
  });

  return Buffer.concat([header, countBuffer, ...triangleBuffers]);
}

export function computeBoundingBox(mesh: Mesh): { min: Vec3; max: Vec3 } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const v of mesh.vertices) {
    if (v[0] < minX) minX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[2] < minZ) minZ = v[2];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] > maxY) maxY = v[1];
    if (v[2] > maxZ) maxZ = v[2];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Signed volume via the divergence theorem (sum of signed tetrahedra
 * volumes from the origin). Valid for any closed, consistently
 * outward-oriented mesh regardless of its position in space. Used here only
 * to sanity-check each fixture's tessellation tolerance at generation time. */
function meshVolume(mesh: Mesh): number {
  let volume = 0;
  for (const face of mesh.faces) {
    const v0 = vertexAt(mesh.vertices, face.a);
    const v1 = vertexAt(mesh.vertices, face.b);
    const v2 = vertexAt(mesh.vertices, face.c);
    volume += dot(v0, cross(v1, v2)) / 6;
  }
  return volume;
}

// ---------------------------------------------------------------------------
// Analytic ground truth + tessellation-tolerance derivations.
//
// Every synthetic fixture is a flat-triangle tessellation of a smooth
// analytic surface, so its actual mesh volume is systematically different
// from the closed-form (smooth) formula value — never a bug, but something
// a golden test must tolerate by a *documented, derived* amount rather than
// a hand-picked fudge factor. Two derivations are used:
//
// 1) Icosphere (sphere-r5, boolean-pair-a/b): built by recursively
//    subdividing an icosahedron and re-projecting new vertices onto the
//    sphere. A chord subtending a small central angle `a` on a sphere of
//    radius R sits below the sphere surface by a sagitta
//    s = R * (1 - cos(a/2)) ≈ R * a^2 / 8 (small-angle approximation).
//    Since a sphere's volume V = (1/3) * R * SurfaceArea exactly (the
//    cone-to-center identity), integrating that sagitta gap across the
//    whole surface gives a relative volume deficit of
//    ΔV / V ≈ 3 * s / R ≈ (3/8) * a^2. The base icosahedron's edge central
//    angle is a0 = arccos(1/sqrt(5)); each subdivision approximately halves
//    the angular edge size, so at subdivision depth n, a_n ≈ a0 / 2^n.
//
// 2) Polygon-swept shapes (cylinder, torus): a circular cross-section
//    sampled at n points and connected by straight edges is a regular n-gon
//    inscribed in that circle. A regular n-gon inscribed in a circle of
//    radius r has area (n/2) * r^2 * sin(2*pi/n) versus the circle's
//    pi*r^2, so the fractional area deficit — and, since the swept
//    dimension is unaffected, the fractional volume deficit too — is
//    1 - (n / (2*pi)) * sin(2*pi/n). The torus has two sampled directions;
//    its tube cross-section (minorSegments = 64, coarser than
//    majorSegments = 128) dominates the deficit, so a 2x safety factor
//    covers the smaller higher-order contribution from the major-direction
//    sampling.
// ---------------------------------------------------------------------------

function icosphereToleranceFraction(subdivisions: number): number {
  const baseAngle = Math.acos(1 / Math.sqrt(5));
  const angleAtDepth = baseAngle / 2 ** subdivisions;
  return (3 / 8) * angleAtDepth ** 2;
}

function inscribedPolygonDeficitFraction(segments: number): number {
  return 1 - (segments / (2 * Math.PI)) * Math.sin((2 * Math.PI) / segments);
}

// Closed-form lens (Steinmetz-style spherical cap) intersection volume for
// two equal spheres of radius r with centers a distance d apart
// (d <= 2r): V = pi * (4r + d) * (2r - d)^2 / 12. Not stored in the sidecar
// (whose shape is fixed to the fields below), but documented here for the
// Phase 2 kernel boolean tests that will consume boolean-pair-a/b: with
// r=3, d=3, V = pi * 15 * 9 / 12 = 11.25 * pi ≈ 35.343 mm^3.

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

export interface SyntheticFixture {
  readonly name: string;
  readonly mesh: Mesh;
  readonly analyticVolumeMm3: number;
  readonly analyticAreaMm2: number;
  readonly meshVolumeToleranceFraction: number;
}

const SPHERE_R5_SUBDIVISIONS = 4;
const BOOLEAN_PAIR_SUBDIVISIONS = 3;
const CYLINDER_SEGMENTS = 128;
const TORUS_MAJOR_SEGMENTS = 128;
const TORUS_MINOR_SEGMENTS = 64;

function buildSyntheticFixtures(): readonly SyntheticFixture[] {
  const sphereR5 = buildIcosphere(5, SPHERE_R5_SUBDIVISIONS);
  const cylinder = buildCylinder(3, 8, CYLINDER_SEGMENTS);
  const torus = buildTorus(5, 2, TORUS_MAJOR_SEGMENTS, TORUS_MINOR_SEGMENTS);
  // Two radius-3 spheres, centers 3 mm apart (symmetric about the origin),
  // sized so their known closed-form lens intersection volume (see comment
  // above) is available for Phase 2 boolean-op golden tests.
  const booleanPairA = buildIcosphere(3, BOOLEAN_PAIR_SUBDIVISIONS, [-1.5, 0, 0]);
  const booleanPairB = buildIcosphere(3, BOOLEAN_PAIR_SUBDIVISIONS, [1.5, 0, 0]);

  return [
    {
      name: 'sphere-r5',
      mesh: sphereR5,
      analyticVolumeMm3: (4 / 3) * Math.PI * 5 ** 3,
      analyticAreaMm2: 4 * Math.PI * 5 ** 2,
      meshVolumeToleranceFraction: icosphereToleranceFraction(SPHERE_R5_SUBDIVISIONS),
    },
    {
      name: 'cylinder-r3-h8',
      mesh: cylinder,
      analyticVolumeMm3: Math.PI * 3 ** 2 * 8,
      analyticAreaMm2: 2 * Math.PI * 3 ** 2 + 2 * Math.PI * 3 * 8,
      meshVolumeToleranceFraction: inscribedPolygonDeficitFraction(CYLINDER_SEGMENTS),
    },
    {
      name: 'torus-R5-r2',
      mesh: torus,
      // With R=5, r=2: 2*R*r^2 (volume coefficient) and 4*R*r (area
      // coefficient) both equal 40 — 2*5*2^2 = 4*5*2 = 40 — so the
      // closed-form volume and surface area are numerically equal
      // (40*pi^2). That is a coincidence of these particular parameters,
      // not a bug.
      analyticVolumeMm3: 2 * Math.PI ** 2 * 5 * 2 ** 2,
      analyticAreaMm2: 4 * Math.PI ** 2 * 5 * 2,
      meshVolumeToleranceFraction: 2 * inscribedPolygonDeficitFraction(TORUS_MINOR_SEGMENTS),
    },
    {
      name: 'boolean-pair-a',
      mesh: booleanPairA,
      analyticVolumeMm3: (4 / 3) * Math.PI * 3 ** 3,
      analyticAreaMm2: 4 * Math.PI * 3 ** 2,
      meshVolumeToleranceFraction: icosphereToleranceFraction(BOOLEAN_PAIR_SUBDIVISIONS),
    },
    {
      name: 'boolean-pair-b',
      mesh: booleanPairB,
      analyticVolumeMm3: (4 / 3) * Math.PI * 3 ** 3,
      analyticAreaMm2: 4 * Math.PI * 3 ** 2,
      meshVolumeToleranceFraction: icosphereToleranceFraction(BOOLEAN_PAIR_SUBDIVISIONS),
    },
  ];
}

export const SYNTHETIC_FIXTURES: readonly SyntheticFixture[] = buildSyntheticFixtures();

// ---------------------------------------------------------------------------
// Heatmap fixture pairs (Task 9) — two known-offset mesh pairs for the
// distance-heatmap's phase-acceptance test ("reports the analytic offset
// within ±1 µm"). Unlike SYNTHETIC_FIXTURES above (one closed solid each,
// checked against an analytic VOLUME), each entry here is a PAIR of meshes
// checked against an analytic per-vertex SURFACE-DISTANCE offset — a
// different sidecar shape, so these are generated/written separately (see
// `generateHeatmapFixtures` below) rather than folded into
// `SYNTHETIC_FIXTURES`/`writeFixtureFiles`.
//
// ## offset-pair-inner / offset-pair-outer: icospheres r=5 and r=5.05
//
// Naively "two spheres 0.05 mm apart" sounds exact, but a triangulated
// (flat-faceted) sphere is NOT the smooth analytic sphere: the true
// per-vertex closest-point-ON-THE-MESH distance from an inner-sphere vertex
// to the outer mesh is slightly LESS than the radial gap, because the outer
// mesh's flat facets sag inward (toward the inner sphere) between its
// vertices. Getting the two meshes' vertices in exact RADIAL correspondence
// (so the "obvious" candidate closest point is a real vertex, not some
// unrelated point) is necessary but not sufficient for a tight bound — this
// section derives and then empirically verifies the resulting error.
//
// ### Radial correspondence
//
// `buildIcosphere(radius, subdivisions)` (above) only applies `radius` as a
// final uniform scale of a shared unit-sphere vertex set (built once by
// `buildIcosahedronBase` + `subdivideIcosphere`, both radius-independent).
// Calling it with the SAME `subdivisions` for both radii therefore
// guarantees vertex[i] of the outer mesh is EXACTLY `outer/inner` times
// vertex[i] of the inner mesh — i.e. every inner vertex has a corresponding
// outer vertex on the exact same ray from the origin, `radius` mm further
// out. The straight-line (chord) distance between that pair is exactly
// `outerRadius - innerRadius` (both being scalar multiples of the same unit
// vector) — no tessellation error at all for THAT specific point pair.
//
// ### Why the true mesh-to-mesh distance is still slightly less
//
// The outer mesh's SURFACE near that corresponding vertex V' is not just
// V' — it's a fan of flat triangles through V' and its neighbors (also on
// the r_outer sphere). Set up local coordinates at V' with the z axis along
// the outward radial direction. Each flat facet through V' is (to leading
// order) the plane z = a*x + b*y for some small tilt coefficients a, b —
// no constant term, since V' itself (at local (0,0,0)) is exactly on every
// facet that touches it. A neighboring vertex at true tangential distance
// rho ≈ r_outer * alpha (alpha = the tessellation's edge central angle at
// this subdivision depth) sits at local z ≈ -rho^2 / (2 r_outer) (the
// standard spherical sagitta, since it too lies exactly ON the sphere).
// Solving z = a*x + b*y for a, b against that O(rho, rho^2) data gives
// a, b = O(rho / r_outer) = O(alpha) — a small but non-zero tilt.
//
// The inner-sphere query point V sits at local (0, 0, -g) where
// g = r_outer - r_inner is the radial gap (0.05 mm here). Distance from V
// to the (infinite) facet plane z = a*x + b*y (normal (a, b, -1)) is
// `g / sqrt(a^2 + b^2 + 1) ≈ g * (1 - (a^2+b^2)/2)` for small a, b — i.e. a
// deficit of order `g * alpha^2` below the naive vertex-only distance `g`.
// Since alpha halves each subdivision (each pass roughly bisects every
// triangle edge — see `icosphereToleranceFraction`'s doc for the same
// halving argument, used there for a different quantity), this deficit
// shrinks by ~4x per subdivision level.
//
// ### Empirical verification (this is what actually sizes the fixture)
//
// Rather than trust the O(g alpha^2) order-of-magnitude estimate above for
// a ±1 µm acceptance bound, the exact per-vertex worst case was computed
// directly with this project's own kernel (buildBvh + closestPoint — the
// SAME machinery the shipped distanceHeatmap job uses) at increasing
// subdivision depths:
//
//   subdivision 2 (162 vertices):    max |distance - 0.05mm| ≈ 0.888 µm
//   subdivision 3 (642 vertices):    max |distance - 0.05mm| ≈ 0.226 µm
//   subdivision 4 (2562 vertices):   max |distance - 0.05mm| ≈ 0.057 µm  <- chosen
//   subdivision 5 (10242 vertices):  max |distance - 0.05mm| ≈ 0.014 µm
//
// (~4x shrink per level, confirming the alpha^2 scaling above). Subdivision
// 4 is chosen: max deviation ≈ 0.057 µm is a ~17x margin under the ±1 µm
// acceptance bound (and a healthy margin under the tighter 0.1 µm
// `OFFSET_PAIR_TOLERANCE_MM` this fixture's own sidecar/tests assert),
// while keeping the fixture the same size class as `sphere-r5` (also
// subdivision 4, ~2.6k vertices, ~256 KB binary STL). See
// packages/kernel-workers/src/distanceHeatmap.test.ts for the acceptance
// assertion itself and its measured value on the checked-in fixture.
const OFFSET_PAIR_SUBDIVISIONS = 4;
const OFFSET_PAIR_INNER_RADIUS_MM = 5;
const OFFSET_PAIR_OUTER_RADIUS_MM = 5.05;
// Written as its own literal, not `OUTER - INNER` — 5.05 itself isn't
// exactly representable in Float64, so that subtraction lands a few ULPs
// off 0.05 (noise at the 1e-14 mm scale, i.e. utterly below even this
// fixture's own tolerance, but needless jitter in the sidecar/tests below).
const OFFSET_PAIR_GAP_MM = 0.05; // 50 µm
/** Generation-time sanity bound (checked below, at fixture-write time) —
 * deliberately tighter than the ±1 µm phase-acceptance bound the actual
 * test asserts (see this section's doc), so a future change that erodes
 * the margin trips here long before it could ever threaten acceptance. */
const OFFSET_PAIR_TOLERANCE_MM = 0.0001; // 0.1 µm

// ## plane-pair-a / plane-pair-b: flat planes, exactly 17 µm apart
//
// Unlike a sphere, a FLAT mesh has zero tessellation error against its own
// analytic shape (a plane) — every mesh vertex, and every point on every
// facet, already lies exactly on the plane z = const, no matter how coarse
// the tessellation. So the only thing this pair needs is: (a) plane B must
// be flat, at exactly `PLANE_PAIR_OFFSET_MM` above plane A, and (b) plane B
// must extend strictly beyond plane A's footprint by a comfortable margin,
// so the true closest point on B from ANY vertex of A is always the
// straight-down perpendicular foot (interior to some facet of B), never a
// boundary edge/vertex of B (which would read as a longer, non-perpendicular
// distance). Plane A spans [-5, 5]mm on each axis; plane B spans [-7, 7]mm —
// a 2 mm margin, vastly more than needed for exactness at this scale. This
// pair is the "strict" ±1 µm case: the only error source is IEEE Float64
// rounding (~1e-12 mm), nothing tessellation-related.
const PLANE_PAIR_OFFSET_MM = 0.017; // 17 µm
const PLANE_PAIR_A_HALF_WIDTH_MM = 5;
const PLANE_PAIR_B_HALF_WIDTH_MM = 7;
const PLANE_PAIR_A_SEGMENTS = 8;
const PLANE_PAIR_B_SEGMENTS = 10;
const PLANE_PAIR_TOLERANCE_MM = 1e-9;

export interface HeatmapFixturePair {
  /** Shared basename for this pair's combined sidecar JSON
   * (`${pairName}.expected.json`), distinct from `nameA`/`nameB` (each
   * mesh's own `.stl` basename). */
  readonly pairName: string;
  readonly nameA: string;
  readonly nameB: string;
  readonly meshA: Mesh;
  readonly meshB: Mesh;
  /** Analytic closest-point-on-B distance every vertex of A should report,
   * in mm. */
  readonly analyticOffsetMm: number;
  /** Documented, derived (see this section's module doc) upper bound on
   * `|measured - analyticOffsetMm|` across every vertex of A, in mm —
   * checked at generation time below, and asserted (independently, against
   * the checked-in STL bytes) by
   * packages/kernel-workers/src/distanceHeatmap.test.ts. */
  readonly toleranceMm: number;
}

function buildHeatmapFixturePairs(): readonly HeatmapFixturePair[] {
  const offsetInner = buildIcosphere(OFFSET_PAIR_INNER_RADIUS_MM, OFFSET_PAIR_SUBDIVISIONS);
  const offsetOuter = buildIcosphere(OFFSET_PAIR_OUTER_RADIUS_MM, OFFSET_PAIR_SUBDIVISIONS);
  const planeA = buildPlane(
    PLANE_PAIR_A_HALF_WIDTH_MM,
    PLANE_PAIR_A_HALF_WIDTH_MM,
    PLANE_PAIR_A_SEGMENTS,
    PLANE_PAIR_A_SEGMENTS,
    0,
  );
  const planeB = buildPlane(
    PLANE_PAIR_B_HALF_WIDTH_MM,
    PLANE_PAIR_B_HALF_WIDTH_MM,
    PLANE_PAIR_B_SEGMENTS,
    PLANE_PAIR_B_SEGMENTS,
    PLANE_PAIR_OFFSET_MM,
  );

  return [
    {
      pairName: 'offset-pair',
      nameA: 'offset-pair-inner',
      nameB: 'offset-pair-outer',
      meshA: offsetInner,
      meshB: offsetOuter,
      analyticOffsetMm: OFFSET_PAIR_GAP_MM,
      toleranceMm: OFFSET_PAIR_TOLERANCE_MM,
    },
    {
      pairName: 'plane-pair',
      nameA: 'plane-pair-a',
      nameB: 'plane-pair-b',
      meshA: planeA,
      meshB: planeB,
      analyticOffsetMm: PLANE_PAIR_OFFSET_MM,
      toleranceMm: PLANE_PAIR_TOLERANCE_MM,
    },
  ];
}

export const HEATMAP_FIXTURE_PAIRS: readonly HeatmapFixturePair[] = buildHeatmapFixturePairs();

const STANDIN_README_TEXT = `# Stand-in prep-die scan

\`standin-prep-die.stl\` is a **procedural, synthetic** truncated cone with a
shoulder margin collar (see \`buildStandinPrepDie\` in
\`scripts/generate-fixtures.ts\`) — it is **NOT a real scan**.

- Real arch/antagonist fixtures are imported (anonymized) by Task 8; once
  that lands, its outputs belong alongside this file, under
  \`test-fixtures/real-scans/\`.
- A real prep-die / crown-prep case is still needed from the project owner
  before Phase 3 acceptance — this stand-in only unblocks pipeline
  plumbing (intake, QC gates, margin-detection scaffolding) that needs
  *some* prep-shaped mesh to run against before that real case arrives.

Do not treat this file's dimensions or geometry as clinically meaningful.
`;

// ---------------------------------------------------------------------------
// File generation
// ---------------------------------------------------------------------------

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeFixtureFiles(outDir: string, fixture: SyntheticFixture): { stlPath: string; jsonPath: string } {
  const stlBuffer = writeBinaryStl(fixture.mesh);
  const bbox = computeBoundingBox(fixture.mesh);
  const sidecar = {
    analyticVolumeMm3: fixture.analyticVolumeMm3,
    analyticAreaMm2: fixture.analyticAreaMm2,
    bbox,
    sha256: sha256Hex(stlBuffer),
    meshVolumeToleranceFraction: fixture.meshVolumeToleranceFraction,
  };

  // Generation-time sanity check (not a test): catches gross geometry bugs
  // (flipped winding, wrong parameters) that would silently corrupt a
  // checked-in golden fixture. 3x the documented tolerance is a deliberate
  // margin — see test/golden/golden.test.ts's structural-integrity check
  // for the same margin applied as a real assertion.
  const actualVolume = meshVolume(fixture.mesh);
  const relativeError = Math.abs(actualVolume - fixture.analyticVolumeMm3) / fixture.analyticVolumeMm3;
  if (relativeError > fixture.meshVolumeToleranceFraction * 3) {
    throw new Error(
      `${fixture.name}: mesh volume ${actualVolume} deviates from analytic volume ` +
        `${fixture.analyticVolumeMm3} by ${(relativeError * 100).toFixed(4)}%, ` +
        `exceeding 3x the documented tolerance ` +
        `(${(fixture.meshVolumeToleranceFraction * 300).toFixed(4)}%). This indicates a bug in the ` +
        `shape builder, not normal tessellation error.`,
    );
  }

  const stlPath = join(outDir, `${fixture.name}.stl`);
  const jsonPath = join(outDir, `${fixture.name}.expected.json`);
  writeFileSync(stlPath, stlBuffer);
  writeFileSync(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  return { stlPath, jsonPath };
}

export function generateSyntheticFixtures(outDir: string): readonly string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const fixture of SYNTHETIC_FIXTURES) {
    const { stlPath, jsonPath } = writeFixtureFiles(outDir, fixture);
    written.push(stlPath, jsonPath);
  }
  return written;
}

function toIndexedMesh(mesh: Mesh): IndexedMesh {
  const positions = new Float64Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((v, i) => {
    positions[i * 3] = v[0];
    positions[i * 3 + 1] = v[1];
    positions[i * 3 + 2] = v[2];
  });
  const indices = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((f, i) => {
    indices[i * 3] = f.a;
    indices[i * 3 + 1] = f.b;
    indices[i * 3 + 2] = f.c;
  });
  return { positions, indices };
}

/** Generation-time sanity check for a `HeatmapFixturePair` (not a test —
 * same role as `writeFixtureFiles`'s volume check above): computes, via the
 * real kernel BVH, the exact closest-point-on-B distance for EVERY vertex of
 * A, and throws if the worst-case deviation from `pair.analyticOffsetMm`
 * exceeds `pair.toleranceMm` — catches a wrong radius/offset/subdivision
 * parameter before it ever reaches a checked-in fixture. Returns the
 * measured worst-case deviation (mm) so it can be recorded for humans
 * regenerating fixtures (printed by this script's CLI entry point below).
 */
function checkHeatmapFixtureTolerance(pair: HeatmapFixturePair): number {
  const meshA = toIndexedMesh(pair.meshA);
  const meshB = toIndexedMesh(pair.meshB);
  const bvhB = buildBvh(meshB);

  let maxDeviationMm = 0;
  const vertexCount = meshA.positions.length / 3;
  for (let v = 0; v < vertexCount; v++) {
    const p: [number, number, number] = [
      meshA.positions[v * 3]!,
      meshA.positions[v * 3 + 1]!,
      meshA.positions[v * 3 + 2]!,
    ];
    const result = closestPoint(meshB, bvhB, p);
    const deviation = Math.abs(result.distance - pair.analyticOffsetMm);
    if (deviation > maxDeviationMm) {
      maxDeviationMm = deviation;
    }
  }

  if (maxDeviationMm > pair.toleranceMm) {
    throw new Error(
      `${pair.pairName}: worst-case vertex-to-mesh distance deviates from the analytic offset ` +
        `${pair.analyticOffsetMm}mm by ${(maxDeviationMm * 1000).toFixed(4)}µm, exceeding the ` +
        `documented tolerance ${(pair.toleranceMm * 1000).toFixed(4)}µm. This indicates a bug in ` +
        `the fixture parameters (radii/offset/subdivision), not normal tessellation error — see ` +
        `HEATMAP_FIXTURE_PAIRS's doc comment for the expected-error derivation.`,
    );
  }
  return maxDeviationMm;
}

function writeHeatmapFixturePair(outDir: string, pair: HeatmapFixturePair): readonly string[] {
  checkHeatmapFixtureTolerance(pair);

  const stlBufferA = writeBinaryStl(pair.meshA);
  const stlBufferB = writeBinaryStl(pair.meshB);
  const sidecar = {
    analyticOffsetMm: pair.analyticOffsetMm,
    toleranceMm: pair.toleranceMm,
    a: { file: `${pair.nameA}.stl`, sha256: sha256Hex(stlBufferA), bbox: computeBoundingBox(pair.meshA) },
    b: { file: `${pair.nameB}.stl`, sha256: sha256Hex(stlBufferB), bbox: computeBoundingBox(pair.meshB) },
  };

  const stlPathA = join(outDir, `${pair.nameA}.stl`);
  const stlPathB = join(outDir, `${pair.nameB}.stl`);
  const jsonPath = join(outDir, `${pair.pairName}.expected.json`);
  writeFileSync(stlPathA, stlBufferA);
  writeFileSync(stlPathB, stlBufferB);
  writeFileSync(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  return [stlPathA, stlPathB, jsonPath];
}

export function generateHeatmapFixtures(outDir: string): readonly string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const pair of HEATMAP_FIXTURE_PAIRS) {
    written.push(...writeHeatmapFixturePair(outDir, pair));
  }
  return written;
}

export function generateStandinScan(outDir: string): readonly string[] {
  mkdirSync(outDir, { recursive: true });
  const stlPath = join(outDir, 'standin-prep-die.stl');
  const readmePath = join(outDir, 'README.md');
  writeFileSync(stlPath, writeBinaryStl(buildStandinPrepDie()));
  writeFileSync(readmePath, STANDIN_README_TEXT, 'utf8');
  return [stlPath, readmePath];
}

export function generateAll(rootOutDir: string): readonly string[] {
  return [
    ...generateSyntheticFixtures(join(rootOutDir, 'synthetic')),
    ...generateHeatmapFixtures(join(rootOutDir, 'synthetic')),
    ...generateStandinScan(join(rootOutDir, 'standin-scans')),
  ];
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectlyExecuted()) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..');
  const outDir = join(repoRoot, 'test-fixtures');
  const written = generateAll(outDir);
  for (const path of written) {
    console.log(`wrote ${path}`);
  }
}
