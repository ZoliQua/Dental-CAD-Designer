// packages/kernel/src/bridge/ridgeCrest.ts
//
// Phase 9 Task 5 (ADR-022 Decision 4): the edentulous-ridge CREST fitted from
// the case's gingiva MESH — the `RidgeCrestCylinder` the pontic interface ops
// (`shapePonticBase`, `measurePonticRelief`) consume, which so far came only
// from the synthetic bridge fixture's analytic crest.
//
// ## The fit
//
// 1. Window: every triangle with all three vertices inside the region ball
//    whose unit normal faces up (normal · upHint ≥ minUpCos) — the crest top,
//    not the ridge's flanks, walls or base.
// 2. Axis (PCA over the crest normals): on a cylinder every surface normal is
//    ⟂ the axis, so the axis is the eigenvector of the SMALLEST eigenvalue of
//    the area-weighted normal covariance Σ A·n nᵀ — exact for a cylinder
//    whatever the window's shape (a point-cloud PCA would depend on the
//    window's extent). A window with no curvature across the ridge (the middle
//    eigenvalue ≈ 0) has no axis and is refused.
// 3. Cross-section: the window's vertices projected onto the plane ⟂ the axis
//    get an algebraic (Kåsa) circle fit, refined by Gauss–Newton on the
//    geometric residual (distance to the circle).
// 4. Frame: up = upHint made ⟂ the axis (the crest must lie on its + side);
//    buccal = up × axis, with the axis sign chosen so buccal agrees with
//    buccalHint; mesialDistal × buccal = up (ponticInterface's convention).
//    The axis point is the region centre's foot on the axis.
//
// @errorBound For vertices exactly on a cylinder the fit is exact up to
// Float64 rounding (radius, axis direction and axis line — the closed-form
// tests assert < 1e-9). For a real scan it is a least-squares fit; the
// result carries the MEASURED deviation of the window's vertices from the
// fitted cylinder (`radialResidualMaxMm` / `radialResidualRmsMm`, measured,
// not estimated) and the normals' spread about the fitted axis
// (`axisSpreadRad` = atan √(λmin/λmid), 0 for an exact cylinder). The fit only
// shapes the pontic base: the relief is MEASURED against the gingiva mesh
// itself (`measurePonticRelief`), so a fit error shows up as relief deviation
// and is judged by the ponticRelief gate — never hidden.
//
// `.ts` extension: reachable from the Node worker entry's import closure.
import type { Vec3 } from '../bvh/geometry.ts';
import { DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4 } from '../intake/degenerate.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { jacobiEigenSymmetric3x3 } from '../register/kabsch.ts';
import type { RidgeCrestCylinder } from './ponticInterface.ts';

/** Default facing threshold: face normals within ≈ 78° of the up hint. */
export const RIDGE_CREST_DEFAULT_MIN_UP_COS = 0.2;
/** Fewest window vertices a fit is attempted on. */
export const RIDGE_CREST_MIN_VERTICES = 12;
/** λmid / λmax below this ⇒ no curvature across the ridge ⇒ no axis. */
const RIDGE_CREST_DEGENERATE_RATIO = 1e-6;
const GAUSS_NEWTON_MAX_ITERATIONS = 50;

export interface RidgeCrestRegion {
  /** The region centre — a point on the crest over the pontic site (mm). */
  centerMm: Vec3;
  /** Ball radius of the window (mm). */
  radiusMm: number;
}

export interface RidgeCrestFitOptions {
  /** The occlusal direction (e.g. the bridge's shared insertion axis). */
  upHint: Vec3;
  /** Any vector pointing buccally (fixes the buccal side and the axis sign). */
  buccalHint: Vec3;
  minUpCos?: number;
}

export interface RidgeCrestFit {
  crest: RidgeCrestCylinder;
  faceCount: number;
  vertexCount: number;
  /** @errorBound — measured deviation of the window from the fitted cylinder. */
  radialResidualMaxMm: number;
  radialResidualRmsMm: number;
  /** Spread of the crest normals about the fitted axis (rad). */
  axisSpreadRad: number;
  regionRadiusMm: number;
  minUpCos: number;
}

export class RidgeCrestRegionTooSmallError extends Error {
  readonly vertexCount: number;
  constructor(vertexCount: number) {
    super(
      `fitRidgeCrestCylinder: only ${vertexCount} up-facing crest vertices in the window (need ${RIDGE_CREST_MIN_VERTICES}) — widen the region or move it onto the ridge crest`,
    );
    this.name = 'RidgeCrestRegionTooSmallError';
    this.vertexCount = vertexCount;
  }
}

/** The window shows no curvature across the ridge — no cylinder axis. */
export class RidgeCrestDegenerateError extends Error {
  constructor(ratio: number) {
    super(
      `fitRidgeCrestCylinder: the crest normals do not curve across the ridge (λmid/λmax = ${ratio.toExponential(2)}) — no axis can be fitted`,
    );
    this.name = 'RidgeCrestDegenerateError';
  }
}

/** The hints cannot orient the fitted crest (parallel to the axis, or the
 * crest lies below its axis along the up hint). */
export class RidgeCrestOrientationError extends Error {
  constructor(reason: string) {
    super(`fitRidgeCrestCylinder: cannot orient the fitted crest — ${reason}`);
    this.name = 'RidgeCrestOrientationError';
  }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

function unit(v: Vec3, name: string): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 0) || !Number.isFinite(l))
    throw new RangeError(`fitRidgeCrestCylinder: ${name} must be a finite non-zero vector`);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Solves the 3×3 system `m x = b` (Gaussian elimination, partial pivoting). */
function solve3(m: number[][], b: number[]): [number, number, number] {
  const a = m.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const p = a[col]![col]!;
    if (p === 0) throw new RidgeCrestDegenerateError(0);
    for (let r = col + 1; r < 3; r++) {
      const f = a[r]![col]! / p;
      for (let k = col; k < 4; k++) a[r]![k] = a[r]![k]! - f * a[col]![k]!;
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = a[r]![3]!;
    for (let k = r + 1; k < 3; k++) s -= a[r]![k]! * x[k]!;
    x[r] = s / a[r]![r]!;
  }
  return [x[0]!, x[1]!, x[2]!];
}

/**
 * Fits the ridge crest cylinder to `gingivaMesh` inside `region` — see the
 * module doc for the window, the fit, the frame and `@errorBound`. Pure and
 * deterministic (source order throughout, fixed iteration budget).
 *
 * @throws {RangeError} invalid region / hints / options.
 * @throws {RidgeCrestRegionTooSmallError} too few up-facing window vertices.
 * @throws {RidgeCrestDegenerateError} no curvature across the ridge.
 * @throws {RidgeCrestOrientationError} the hints cannot orient the result.
 */
export function fitRidgeCrestCylinder(
  gingivaMesh: IndexedMesh,
  region: RidgeCrestRegion,
  options: RidgeCrestFitOptions,
): RidgeCrestFit {
  if (!(Number.isFinite(region.radiusMm) && region.radiusMm > 0)) {
    throw new RangeError(
      `fitRidgeCrestCylinder: region.radiusMm must be finite and > 0, got ${region.radiusMm}`,
    );
  }
  const minUpCos = options.minUpCos ?? RIDGE_CREST_DEFAULT_MIN_UP_COS;
  if (!(Number.isFinite(minUpCos) && minUpCos >= 0 && minUpCos < 1)) {
    throw new RangeError(`fitRidgeCrestCylinder: minUpCos must be in [0, 1), got ${minUpCos}`);
  }
  const upHint = unit(options.upHint, 'upHint');
  const buccalHint = unit(options.buccalHint, 'buccalHint');
  const { positions, indices } = gingivaMesh;
  const c = region.centerMm;
  const r2 = region.radiusMm * region.radiusMm;
  const vertexCount = positions.length / 3;
  const inBall = (v: number): boolean => {
    const dx = positions[v * 3]! - c[0];
    const dy = positions[v * 3 + 1]! - c[1];
    const dz = positions[v * 3 + 2]! - c[2];
    return dx * dx + dy * dy + dz * dz <= r2;
  };

  // ---- 1. window + 2. normal covariance --------------------------------
  const used = new Uint8Array(vertexCount);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let faceCount = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    if (!inBall(i0) || !inBall(i1) || !inBall(i2)) continue;
    const ax = positions[i1 * 3]! - positions[i0 * 3]!;
    const ay = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!;
    const az = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
    const bx = positions[i2 * 3]! - positions[i0 * 3]!;
    const by = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!;
    const bz = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
    const n: Vec3 = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const lenSq = dot(n, n);
    if (lenSq <= DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) continue;
    const len = Math.sqrt(lenSq);
    const u: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
    if (dot(u, upHint) < minUpCos) continue;
    const area = len / 2;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) cov[i]![j] = cov[i]![j]! + area * u[i]! * u[j]!;
    used[i0] = 1;
    used[i1] = 1;
    used[i2] = 1;
    faceCount++;
  }
  const window: number[] = [];
  for (let v = 0; v < vertexCount; v++) if (used[v] === 1) window.push(v);
  if (window.length < RIDGE_CREST_MIN_VERTICES)
    throw new RidgeCrestRegionTooSmallError(window.length);

  const { eigenvalues, eigenvectors } = jacobiEigenSymmetric3x3([
    [cov[0]![0]!, cov[0]![1]!, cov[0]![2]!],
    [cov[1]![0]!, cov[1]![1]!, cov[1]![2]!],
    [cov[2]![0]!, cov[2]![1]!, cov[2]![2]!],
  ]);
  const order = [0, 1, 2].sort((p, q) => eigenvalues[p]! - eigenvalues[q]! || p - q);
  const lMin = Math.max(0, eigenvalues[order[0]!]!);
  const lMid = eigenvalues[order[1]!]!;
  const lMax = eigenvalues[order[2]!]!;
  const ratio = lMax > 0 ? lMid / lMax : 0;
  if (!(ratio > RIDGE_CREST_DEGENERATE_RATIO)) throw new RidgeCrestDegenerateError(ratio);
  const k = order[0]!;
  let axis = unit([eigenvectors[0][k]!, eigenvectors[1][k]!, eigenvectors[2][k]!], 'axis');
  const axisSpreadRad = Math.atan(Math.sqrt(lMin / lMid));

  // ---- 3. cross-section circle ------------------------------------------
  const along = dot(upHint, axis);
  const upRaw: Vec3 = [
    upHint[0] - along * axis[0],
    upHint[1] - along * axis[1],
    upHint[2] - along * axis[2],
  ];
  if (Math.hypot(upRaw[0], upRaw[1], upRaw[2]) < 1e-6) {
    throw new RidgeCrestOrientationError('the up hint is parallel to the ridge axis');
  }
  const e1 = unit(upRaw, 'up');
  const e2 = cross(axis, e1);
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (const v of window) {
    gx += positions[v * 3]!;
    gy += positions[v * 3 + 1]!;
    gz += positions[v * 3 + 2]!;
  }
  const g: Vec3 = [gx / window.length, gy / window.length, gz / window.length];
  const us = new Float64Array(window.length);
  const vs = new Float64Array(window.length);
  window.forEach((v, i) => {
    const d: Vec3 = [
      positions[v * 3]! - g[0],
      positions[v * 3 + 1]! - g[1],
      positions[v * 3 + 2]! - g[2],
    ];
    us[i] = dot(d, e1);
    vs[i] = dot(d, e2);
  });
  // Kåsa: minimize Σ (u² + v² + D u + E v + F)².
  let suu = 0,
    suv = 0,
    svv = 0,
    su = 0,
    sv = 0,
    szu = 0,
    szv = 0,
    sz = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i]!;
    const v = vs[i]!;
    const z = u * u + v * v;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    su += u;
    sv += v;
    szu += z * u;
    szv += z * v;
    sz += z;
  }
  const [D, E, F] = solve3(
    [
      [suu, suv, su],
      [suv, svv, sv],
      [su, sv, us.length],
    ],
    [-szu, -szv, -sz],
  );
  let cu = -D / 2;
  let cv = -E / 2;
  let radius = Math.sqrt(Math.max(0, cu * cu + cv * cv - F));
  // Gauss–Newton on the geometric residual dᵢ − R.
  for (let it = 0; it < GAUSS_NEWTON_MAX_ITERATIONS; it++) {
    const jtj = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const jtr = [0, 0, 0];
    for (let i = 0; i < us.length; i++) {
      const du = us[i]! - cu;
      const dv = vs[i]! - cv;
      const d = Math.hypot(du, dv);
      if (d === 0) continue;
      const row = [-du / d, -dv / d, -1];
      const res = d - radius;
      for (let p = 0; p < 3; p++) {
        jtr[p] = jtr[p]! + row[p]! * res;
        for (let q = 0; q < 3; q++) jtj[p]![q] = jtj[p]![q]! + row[p]! * row[q]!;
      }
    }
    const step = solve3(jtj, [-jtr[0]!, -jtr[1]!, -jtr[2]!]);
    cu += step[0];
    cv += step[1];
    radius += step[2];
    if (Math.hypot(step[0], step[1], step[2]) <= 1e-15 * (1 + radius)) break;
  }
  let maxRes = 0;
  let sumSq = 0;
  for (let i = 0; i < us.length; i++) {
    const res = Math.hypot(us[i]! - cu, vs[i]! - cv) - radius;
    maxRes = Math.max(maxRes, Math.abs(res));
    sumSq += res * res;
  }

  // ---- 4. frame -----------------------------------------------------------
  const center3: Vec3 = [
    g[0] + e1[0] * cu + e2[0] * cv,
    g[1] + e1[1] * cu + e2[1] * cv,
    g[2] + e1[2] * cu + e2[2] * cv,
  ];
  if (!(-cu > 0)) {
    // g − center3 = −cu·e1 − cv·e2: the window must lie on the +up side.
    throw new RidgeCrestOrientationError(
      'the crest window lies below its fitted axis along the up hint',
    );
  }
  let buccal = cross(e1, axis);
  const side = dot(buccal, buccalHint);
  if (Math.abs(side) < 0.1)
    throw new RidgeCrestOrientationError('the buccal hint is (nearly) parallel to the ridge axis');
  if (side < 0) {
    axis = scale(axis, -1);
    buccal = scale(buccal, -1);
  }
  const t = dot([c[0] - center3[0], c[1] - center3[1], c[2] - center3[2]], axis);
  const axisPointMm: Vec3 = [
    center3[0] + axis[0] * t,
    center3[1] + axis[1] * t,
    center3[2] + axis[2] * t,
  ];

  return {
    crest: { axisPointMm, mesialDistalDir: axis, buccalDir: buccal, upDir: e1, radiusMm: radius },
    faceCount,
    vertexCount: window.length,
    radialResidualMaxMm: maxRes,
    radialResidualRmsMm: Math.sqrt(sumSq / us.length),
    axisSpreadRad,
    regionRadiusMm: region.radiusMm,
    minUpCos,
  };
}
