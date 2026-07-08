// TEST-ONLY mesh fixtures for this directory's tests. Not exported from
// packages/kernel/src/index.ts (same "test fixtures stay out of the shipped
// API" convention as ../boolean/manifold.test-fixtures.ts, whose
// `icosphereMesh` polyline.test.ts also reuses directly for the
// acceptance-critical sphere tests).
import type { IndexedMesh } from '../mesh/types.ts';

/**
 * A UV (latitude/longitude) sphere: every vertex is placed by its exact
 * closed-form spherical parametrization
 * `(R sinφ cosθ, R sinφ sinθ, R cosφ)` — unlike an icosphere (built by
 * repeated midpoint-subdivision + re-projection), EVERY vertex here is
 * exact by construction (up to `Math.sin`/`Math.cos`'s own ~1 ULP
 * rounding, ~1e-16 relative — utterly negligible at this task's 1e-3 mm
 * acceptance budget), and an entire LATITUDE RING (fixed `k`) shares the
 * same exact Z coordinate. That makes this fixture the right tool for an
 * EXACT (zero-tessellation-error) section test: cutting exactly at a
 * ring's Z lands the plane through `lonSegments` mesh vertices simultaneously
 * (this module's `sectionMesh`'s "ON" classification for every one of
 * them), and the resulting section polyline IS that ring — every point
 * exactly at distance `radius` from the origin, not merely close to it.
 * See polyline.test.ts's "exact vertex-ring" describe block.
 *
 * `latSegments` rings lie strictly between the poles (`k = 1..latSegments-1`,
 * indices 0..latSegments-2 in the returned `ringZ`/`ringStartIndex`
 * bookkeeping below is NOT returned — callers needing a specific ring's Z
 * should recompute it via `uvSphereRingZ`).
 */
export function uvSphereMesh(radius: number, latSegments: number, lonSegments: number): IndexedMesh {
  const positions: number[] = [];
  const faces: number[] = [];

  const northPole = 0;
  positions.push(0, 0, radius);

  const ringIndices: number[][] = [];
  for (let k = 1; k < latSegments; k++) {
    const phi = (k * Math.PI) / latSegments;
    const ring: number[] = [];
    for (let j = 0; j < lonSegments; j++) {
      const theta = (j * 2 * Math.PI) / lonSegments;
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);
      ring.push(positions.length / 3);
      positions.push(x, y, z);
    }
    ringIndices.push(ring);
  }

  const southPole = positions.length / 3;
  positions.push(0, 0, -radius);

  const firstRing = ringIndices[0]!;
  for (let j = 0; j < lonSegments; j++) {
    faces.push(northPole, firstRing[j]!, firstRing[(j + 1) % lonSegments]!);
  }
  for (let k = 0; k < ringIndices.length - 1; k++) {
    const ringA = ringIndices[k]!;
    const ringB = ringIndices[k + 1]!;
    for (let j = 0; j < lonSegments; j++) {
      const jNext = (j + 1) % lonSegments;
      faces.push(ringA[j]!, ringB[j]!, ringB[jNext]!);
      faces.push(ringA[j]!, ringB[jNext]!, ringA[jNext]!);
    }
  }
  const lastRing = ringIndices[ringIndices.length - 1]!;
  for (let j = 0; j < lonSegments; j++) {
    faces.push(southPole, lastRing[(j + 1) % lonSegments]!, lastRing[j]!);
  }

  return { positions: new Float64Array(positions), indices: new Uint32Array(faces) };
}

/** Exact Z (mm) of `uvSphereMesh`'s ring `k` (1..latSegments-1) — the
 * closed-form counterpart to that mesh's own per-vertex Z, so a test can
 * pick `plane.point = [0, 0, uvSphereRingZ(radius, latSegments, k)]`
 * without re-deriving the parametrization. */
export function uvSphereRingZ(radius: number, latSegments: number, k: number): number {
  const phi = (k * Math.PI) / latSegments;
  return radius * Math.cos(phi);
}

/**
 * An OPEN hemisphere shell: the same UV-sphere parametrization as
 * `uvSphereMesh` above, but only the rings from the north pole down to (and
 * including) the equator (`k = 0..latSegments/2`, `latSegments` must be
 * even) — no south pole, no bands below the equator, so the equator ring
 * (`k = latSegments/2`, Z = 0) is left as an un-capped BOUNDARY loop (every
 * one of its edges belongs to exactly one triangle). A section plane
 * through the polar axis (e.g. `point=[0,0,0]`, `normal=[0,1,0]`) crosses
 * this shell in one continuous arc from the boundary loop, up over the
 * pole, back down to the boundary loop on the other side — an OPEN
 * polyline whose two endpoints land exactly on that open boundary (see
 * polyline.test.ts's open-mesh describe block).
 */
export function openHemisphereMesh(radius: number, latSegments: number, lonSegments: number): IndexedMesh {
  if (latSegments % 2 !== 0) {
    throw new Error('openHemisphereMesh: latSegments must be even (equator must land on a sampled ring)');
  }
  const positions: number[] = [];
  const faces: number[] = [];

  const northPole = 0;
  positions.push(0, 0, radius);

  const equatorK = latSegments / 2;
  const ringIndices: number[][] = [];
  for (let k = 1; k <= equatorK; k++) {
    const phi = (k * Math.PI) / latSegments;
    const ring: number[] = [];
    for (let j = 0; j < lonSegments; j++) {
      const theta = (j * 2 * Math.PI) / lonSegments;
      ring.push(positions.length / 3);
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
    ringIndices.push(ring);
  }

  const firstRing = ringIndices[0]!;
  for (let j = 0; j < lonSegments; j++) {
    faces.push(northPole, firstRing[j]!, firstRing[(j + 1) % lonSegments]!);
  }
  for (let k = 0; k < ringIndices.length - 1; k++) {
    const ringA = ringIndices[k]!;
    const ringB = ringIndices[k + 1]!;
    for (let j = 0; j < lonSegments; j++) {
      const jNext = (j + 1) % lonSegments;
      faces.push(ringA[j]!, ringB[j]!, ringB[jNext]!);
      faces.push(ringA[j]!, ringB[jNext]!, ringA[jNext]!);
    }
  }

  return { positions: new Float64Array(positions), indices: new Uint32Array(faces) };
}

/**
 * A torus (tube revolved around the Z axis, major radius `majorRadius` in
 * the XY plane, minor/tube radius `minorRadius`). The tube parametrization
 * is deliberately phase-offset by half a minor step (`phi` starts at
 * `π/minorSegments`, not `0`) so that Z=0 (the natural "cut through the
 * donut hole" plane) never lands exactly ON a sampled tube vertex for an
 * EVEN `minorSegments` — every major-segment ring is cut by genuine
 * (non-degenerate) edge interpolation, exercising the general case rather
 * than the exact-on-vertex path `uvSphereMesh` above already covers. See
 * polyline.test.ts's torus point-count sanity test.
 */
export function torusMesh(
  majorRadius: number,
  minorRadius: number,
  majorSegments: number,
  minorSegments: number,
): IndexedMesh {
  if (minorSegments % 2 !== 0) {
    throw new Error('torusMesh: minorSegments must be even (see module doc\'s phase-offset reasoning)');
  }
  const positions: number[] = [];
  const index = (i: number, j: number): number =>
    ((i % majorSegments) + majorSegments) % majorSegments * minorSegments +
    (((j % minorSegments) + minorSegments) % minorSegments);

  for (let i = 0; i < majorSegments; i++) {
    const theta = (i * 2 * Math.PI) / majorSegments;
    for (let j = 0; j < minorSegments; j++) {
      const phi = Math.PI / minorSegments + (j * 2 * Math.PI) / minorSegments;
      const r = majorRadius + minorRadius * Math.cos(phi);
      positions.push(r * Math.cos(theta), r * Math.sin(theta), minorRadius * Math.sin(phi));
    }
  }

  const faces: number[] = [];
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = index(i, j);
      const b = index(i + 1, j);
      const c = index(i + 1, j + 1);
      const d = index(i, j + 1);
      faces.push(a, b, c, a, c, d);
    }
  }

  return { positions: new Float64Array(positions), indices: new Uint32Array(faces) };
}
