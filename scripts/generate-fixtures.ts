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
