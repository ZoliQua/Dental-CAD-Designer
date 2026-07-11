// scripts/generate-large-fixture.ts
//
// Deterministic ~120 MB binary STL "standin arch" fixture generator for
// Task 3's chunked-parsing perf test
// (packages/io/src/stl/large-fixture.perf.test.ts, env-gated by
// RUN_LARGE_FIXTURE=1 — see that file). Writes to test-fixtures/generated/
// (git-ignored, see .gitignore, and NOT committed — regenerate on demand
// via `npm run fixtures:generate-large`; CI regenerates it itself before
// running the gated perf test, per docs/plans/phase-1-import-viewer.md's
// Global Constraints: "the >100 MB perf fixture is NOT committed —
// generated deterministically on demand").
//
// Determinism (same invariant as scripts/generate-fixtures.ts): no
// Math.random/Date.now anywhere below — every vertex is closed-form trig
// over fixed integer/float parameters, so re-running this script produces
// a byte-identical file every time.
//
// Geometry: a dental-arch-like "horseshoe tube" — an open (not closed)
// elliptical center curve swept by a circular cross-section, highly
// subdivided to reach the target file size. This is a PERFORMANCE fixture
// only (unlike test-fixtures/synthetic/{sphere,cylinder,torus}*.stl, which
// carry closed-form analytic expected values for golden tests) — it has no
// `.expected.json` companion, isn't watertight (the two open ends of the
// horseshoe aren't capped), and its vertex winding isn't verified outward-
// consistent. None of that matters for what it's used for: packages/io's
// streaming parser only cares about triangle count and binary layout, not
// topology or manifoldness.
//
// Uses packages/io's real `writeStlBinary` (not a script-local writer, per
// scripts/generate-fixtures.ts's module doc — packages/io's writer/parser
// are the production implementation as of Phase 1).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeStlBinary } from '@dqcad/io';
import type { RawTriangleSoup } from '@dqcad/io';

type Vec3 = readonly [number, number, number];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return len === 0 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}

// ---------------------------------------------------------------------------
// Arch geometry parameters (mm — this project's units invariant, see
// docs/plans/phase-1-import-viewer.md's Global Constraints, even though
// this fixture's exact dimensions have no clinical meaning).
// ---------------------------------------------------------------------------
const ARCH_SEMI_AXIS_X_MM = 25;
const ARCH_SEMI_AXIS_Y_MM = 18;
const TUBE_RADIUS_MM = 3;
// An open horseshoe, not a full ellipse — roughly ±140°, leaving a gap at
// the "back" of the arch (theta = +-PI) the way a real dental arch is open
// at the posterior, not a closed ring.
const THETA_MIN = -Math.PI * (140 / 180);
const THETA_MAX = Math.PI * (140 / 180);

function centerPoint(theta: number): Vec3 {
  return [ARCH_SEMI_AXIS_X_MM * Math.cos(theta), ARCH_SEMI_AXIS_Y_MM * Math.sin(theta), 0];
}

function radialDirection(theta: number): Vec3 {
  return normalize([Math.cos(theta), Math.sin(theta), 0]);
}

const UP: Vec3 = [0, 0, 1];

function vertexAt(theta: number, phi: number): Vec3 {
  const center = centerPoint(theta);
  const radial = radialDirection(theta);
  return add(
    center,
    add(scale(radial, TUBE_RADIUS_MM * Math.cos(phi)), scale(UP, TUBE_RADIUS_MM * Math.sin(phi))),
  );
}

const STL_HEADER_BYTES = 80;
const STL_COUNT_BYTES = 4;
const STL_RECORD_BYTES = 50;

export interface LargeFixtureSpec {
  /** Rings along the arch's length (theta steps) — `longitudinalSegments +
   * 1` rings total, since the horseshoe is OPEN (not wrapped) along theta. */
  longitudinalSegments: number;
  /** Segments around the tube's circular cross-section (phi steps) —
   * wraps (closed) around the tube. */
  tubeSegments: number;
}

/** Picks `(longitudinalSegments, tubeSegments)` so the resulting triangle
 * soup's binary STL byte length is close to (at or just under)
 * `targetBytes`. `tubeSegments` is held at a fixed, visually-reasonable
 * roundness; `longitudinalSegments` is solved for from the target byte
 * budget. */
export function planLargeFixture(targetBytes: number, tubeSegments = 48): LargeFixtureSpec {
  const targetTriangleCount = Math.floor((targetBytes - STL_HEADER_BYTES - STL_COUNT_BYTES) / STL_RECORD_BYTES);
  const longitudinalSegments = Math.max(1, Math.round(targetTriangleCount / (tubeSegments * 2)));
  return { longitudinalSegments, tubeSegments };
}

export function largeFixtureTriangleCount(spec: LargeFixtureSpec): number {
  return spec.longitudinalSegments * spec.tubeSegments * 2;
}

/**
 * Builds the horseshoe-tube triangle soup directly as a flat, preallocated
 * `RawTriangleSoup` — no intermediate vertex/face indexing (unlike
 * scripts/generate-fixtures.ts's small synthetic fixtures): STL is a
 * triangle-soup format with no shared-vertex indexing to begin with, so
 * writing straight into the final flat layout avoids ever materializing a
 * separate indexed representation for a mesh this large.
 *
 * `normals: null` — `writeStlBinary`'s default (`useSourceNormals: false`)
 * recomputes each facet's geometric normal from its own vertex winding, so
 * this generator doesn't need to compute/store a second 9-triangle-count-
 * sized array just to be overwritten anyway.
 */
export function buildLargeFixtureSoup(spec: LargeFixtureSpec): RawTriangleSoup {
  const { longitudinalSegments, tubeSegments } = spec;
  const triangleCount = largeFixtureTriangleCount(spec);
  const positions = new Float64Array(triangleCount * 9);

  const dTheta = (THETA_MAX - THETA_MIN) / longitudinalSegments;
  const dPhi = (2 * Math.PI) / tubeSegments;

  let triangleIndex = 0;
  const writeTriangle = (a: Vec3, b: Vec3, c: Vec3): void => {
    const base = triangleIndex * 9;
    positions[base] = a[0];
    positions[base + 1] = a[1];
    positions[base + 2] = a[2];
    positions[base + 3] = b[0];
    positions[base + 4] = b[1];
    positions[base + 5] = b[2];
    positions[base + 6] = c[0];
    positions[base + 7] = c[1];
    positions[base + 8] = c[2];
    triangleIndex++;
  };

  for (let i = 0; i < longitudinalSegments; i++) {
    const theta0 = THETA_MIN + i * dTheta;
    const theta1 = THETA_MIN + (i + 1) * dTheta;
    for (let j = 0; j < tubeSegments; j++) {
      const phi0 = j * dPhi;
      const phi1 = ((j + 1) % tubeSegments) * dPhi;

      const v00 = vertexAt(theta0, phi0);
      const v10 = vertexAt(theta1, phi0);
      const v11 = vertexAt(theta1, phi1);
      const v01 = vertexAt(theta0, phi1);

      writeTriangle(v00, v10, v11);
      writeTriangle(v00, v11, v01);
    }
  }

  return { positions, normals: null, triangleCount };
}

const TARGET_BYTES = 120 * 1024 * 1024; // ~120 MB

export function generateLargeFixture(outDir: string): { path: string; byteLength: number; triangleCount: number } {
  const spec = planLargeFixture(TARGET_BYTES);
  const soup = buildLargeFixtureSoup(spec);
  const bytes = writeStlBinary(soup, { headerText: 'DQCAD perf fixture: standin arch' });

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'standin-arch-large.stl');
  writeFileSync(path, bytes);

  return { path, byteLength: bytes.byteLength, triangleCount: soup.triangleCount };
}

// Run directly (`tsx scripts/generate-large-fixture.ts` / `npm run
// fixtures:generate-large`) vs. imported (e.g. by the perf test, to
// regenerate on demand) — same "only run main() when this is the
// entrypoint" pattern scripts/generate-fixtures.ts uses.
function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href;
}

if (isMainModule()) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'generated');
  const result = generateLargeFixture(outDir);
  const mb = (result.byteLength / (1024 * 1024)).toFixed(1);
  console.log(
    `Generated ${result.path} — ${mb} MB, ${result.triangleCount.toLocaleString()} triangles.`,
  );
}
