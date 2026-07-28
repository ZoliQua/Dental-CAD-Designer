// packages/kernel/src/bridge/ponticInterface.ts
//
// Phase 6 Task 3 — the PONTIC GINGIVAL INTERFACE (kernel op). A bridge pontic
// is a suspended library tooth whose BASE (the gingival-facing underside) is
// shaped against the edentulous-ridge (gingiva) mesh per clinical STYLE —
// hygienic / modified ridge-lap / ovate — at the CONFIGURED relief/pressure,
// with the PLAN acceptance that the MEASURED pontic-gingiva relation matches the
// configured value within ±20 µm per style.
//
// This module ships TWO independent halves — the P5 seam-dihedral lesson made
// concrete: build (and validate) the MEASUREMENT INSTRUMENT before it judges any
// construction.
//
//   1. `shapePonticBase` — the deterministic CONSTRUCTION. Builds the base as an
//      analytic offset of the ridge crest cylinder (`base = crest + t(φ)·n(φ)`,
//      radial signed distance to the cylinder is EXACTLY t(φ)), with a per-style
//      target field t(φ) and an honest PATCH partition (hygienic: uniform over
//      the whole base; ridge-lap: relief over the BUCCAL contact patch, lingual
//      relieved region separate; ovate: −depth over the seat patch). Produces the
//      base surface mesh + a DENSE, mesh-resolution-independent sample set (each
//      sample carrying its intended patch + target).
//   2. `measurePonticRelief` — the blend-independent MEASUREMENT. Per sample:
//      `signedClosestPoint` to the gingiva mesh (sign: + outside/clearance,
//      − inside/penetration). Buckets by the sample's GEOMETRIC patch, reports
//      per-patch deviation-from-target min/max/mean — the PRIMARY (acceptance)
//      patch strictly separate from the relieved/transition/outside regions (the
//      P5 "never dilute the patch measurement over non-patch regions" rule).
//
// ## The ridge frame (fixture = analytic crest cylinder; real scan = tracked)
//
// The fixture's crest is a circular cylinder (bridge.test-fixtures.ts). This op
// takes that crest analytically as a `RidgeCrestCylinder` (axis line + radius +
// orthonormal md/buccal/up frame). A real edentulous-ridge SCAN would instead
// supply a sampled crest curve + normal field — that generalization is a
// tracked-pending (the whole phase is synthetic-fixture-driven, matching P5).
// The MEASUREMENT already reads only the gingiva MESH (scan-general); only the
// CONSTRUCTION's crest parametrization is cylinder-specific here.
//
// ## Buccal / lingual convention (documented)
//
// Angle φ is measured from `up` (apex/occlusal) toward `buccal`: φ=0 is the crest
// apex, φ>0 is the BUCCAL slope, φ<0 the LINGUAL slope. Buccal = +buccalDir.
//
// @errorBound The base vertices lie EXACTLY on the analytic offset cylinder
// (Float64 cos/sin rounding only) — the construction hits the configured relief
// exactly at every sample. The MEASUREMENT's `signedClosestPoint` is exact
// distance TO THE MESH (inherits its own @errorBound); the gingiva mesh itself
// approximates the analytic crest by INSCRIBED CHORDS (bridge.test-fixtures.ts's
// documented "between-sample chord" term), which are strictly INSIDE the arc, so
// a measured relief reads `configured + [0, sagitta]`, one-sided, with
// `sagitta = max_i R·(1 − cos(Δφ_i/2))` over the sampled angular band (Δφ_i the
// crest tessellation's angular steps). `shapePonticBase` surfaces this bound as
// `errorBoundMm`; it is < 20 µm for the acceptance fixture's crest resolution
// (verified + reported by the tests). The X (mesiodistal) direction carries NO
// sagitta — the crest cylinder is ruled along its axis, so the swept mesh edges
// lie exactly on the surface.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Pseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PonticInterfaceStyle = 'hygienic' | 'ridgeLap' | 'ovate';

/** The analytic crest cylinder of the pontic-site ridge — the CONSTRUCTION's
 * parametrization (the fixture's closed-form crest; a real scan would supply a
 * sampled crest curve instead — see the module doc). The crest surface is
 * `axisPointMm + x·mesialDistalDir + radiusMm·(cosφ·upDir + sinφ·buccalDir)`. */
export interface RidgeCrestCylinder {
  /** A point on the crest cylinder AXIS (the fixture's `(0,0,crestCenterZMm)`). */
  readonly axisPointMm: Vec3;
  /** Unit cylinder-axis (mesiodistal) direction. */
  readonly mesialDistalDir: Vec3;
  /** Unit buccal direction (⟂ axis) — φ>0 side. */
  readonly buccalDir: Vec3;
  /** Unit apex/occlusal direction (⟂ axis & buccal) — apex = axisPoint+R·up. */
  readonly upDir: Vec3;
  /** Crest cylinder radius (mm). */
  readonly radiusMm: number;
}

/** Which honest patch a base sample belongs to (see the module doc). `primary`
 * is the per-style ACCEPTANCE patch; the rest are reported SEPARATELY, never
 * diluting the primary. */
export type PonticPatch = 'primary' | 'transition' | 'relieved' | 'outside';

/** Per-style construction parameters. The CONFIGURED relief values
 * (`clearanceMm` / `reliefMm` / `depthMm`) MUST be supplied by the caller from
 * the clinical profile (CLAUDE.md invariant 7 — never defaulted here). The patch
 * ANGLES / opening / emergence are GEOMETRIC shaping params (not clinical
 * defaults). */
export interface PonticInterfaceParams {
  /** hygienic: uniform base clearance above the ridge (configured, mm). */
  readonly clearanceMm?: number;
  /** ridge-lap: buccal contact-patch relief (configured, mm). */
  readonly reliefMm?: number;
  /** ridge-lap: additional lingual opening beyond `reliefMm` (geometric, mm). */
  readonly lingualOpeningMm?: number;
  /** ridge-lap: half-angle (rad) of the central transition band; contact patch
   * is φ≥this, relieved region φ≤−this. */
  readonly contactTransitionHalfAngleRad?: number;
  /** ovate: seat penetration depth INTO the ridge (configured, mm, >0). */
  readonly depthMm?: number;
  /** ovate: seat patch half-angle (rad) — |φ|≤this penetrates by depth. */
  readonly seatHalfAngleRad?: number;
  /** ovate: base emergence (clearance) at the seat's outer edge (geometric, mm). */
  readonly emergenceMm?: number;
}

/** The base footprint over the ridge — the mesiodistal (station) span and the
 * angular (buccolingual) span the pontic base covers. */
export interface PonticBaseFootprint {
  /** Station range along the crest axis (mm, relative to `axisPointMm`'s md
   * coordinate — i.e. the fixture's X). */
  readonly stationMinMm: number;
  readonly stationMaxMm: number;
  /** Angular half-span (rad) about the apex the base spans on EACH side
   * (buccal +, lingual −). */
  readonly angularHalfSpanRad: number;
}

/** How finely to build the base MESH (viz/assembly) and the DENSE measurement
 * sample grid (independent of the mesh — always ≥ the mesh grid). */
export interface PonticBaseResolution {
  /** Base-mesh station subdivisions (≥1). */
  readonly meshStations: number;
  /** Base-mesh angular subdivisions (≥1). */
  readonly meshAngularSegments: number;
  /** Dense measurement station samples (≥ meshStations+1). */
  readonly sampleStations: number;
  /** Dense measurement angular samples (≥ meshAngularSegments+1). */
  readonly sampleAngularSegments: number;
}

/** One dense base sample — carries the point plus its GEOMETRIC patch + the
 * intended target offset (mm; + outward/clearance, − inward/penetration). */
export interface PonticBaseSample {
  readonly pointMm: Vec3;
  readonly stationMm: number;
  readonly angleRad: number;
  readonly targetMm: number;
  readonly patch: PonticPatch;
}

export interface ShapePonticBaseResult {
  readonly style: PonticInterfaceStyle;
  /** The shaped base surface (open patch, outward-wound = away from the ridge). */
  readonly mesh: IndexedMesh;
  /** Dense, mesh-resolution-independent samples for the measurement. */
  readonly samples: readonly PonticBaseSample[];
  /** The configured target for the PRIMARY (acceptance) patch (mm; signed). */
  readonly primaryTargetMm: number;
  /** The @errorBound (mm) — max crest inscribed-chord sagitta over the sampled
   * angular band (see module doc). */
  readonly errorBoundMm: number;
}

export class PonticInterfaceParamError extends Error {
  constructor(message: string) {
    super(`ponticInterface: ${message}`);
    this.name = 'PonticInterfaceParamError';
  }
}

// ---------------------------------------------------------------------------
// Small Float64 vector helpers (module-local — the repo's per-module convention)
// ---------------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function assertUnit(v: Vec3, what: string): void {
  const l = len(v);
  if (!(Math.abs(l - 1) <= 1e-6)) {
    throw new PonticInterfaceParamError(`${what} must be a unit vector, got length ${l}`);
  }
}

function assertFinitePositive(name: string, value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || !(value > 0)) {
    throw new PonticInterfaceParamError(`${name} must be a finite value > 0 (configured via the clinical profile), got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Per-style target field t(φ) + patch classification
// ---------------------------------------------------------------------------

/** Cubic smoothstep on [0,1] (C¹, deterministic). */
function smoothstep(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

interface StyleField {
  /** Signed target offset at angle φ (mm). */
  readonly target: (phi: number) => number;
  /** Geometric patch classification at angle φ. */
  readonly patch: (phi: number) => PonticPatch;
  /** The configured PRIMARY-patch target (mm, signed). */
  readonly primaryTargetMm: number;
}

function buildStyleField(style: PonticInterfaceStyle, params: PonticInterfaceParams): StyleField {
  if (style === 'hygienic') {
    const clearance = assertFinitePositive('clearanceMm', params.clearanceMm);
    return {
      target: () => clearance,
      patch: () => 'primary',
      primaryTargetMm: clearance,
    };
  }
  if (style === 'ridgeLap') {
    const relief = assertFinitePositive('reliefMm', params.reliefMm);
    const opening = params.lingualOpeningMm ?? 0.5;
    const phiC = params.contactTransitionHalfAngleRad ?? (15 * Math.PI) / 180;
    if (!(Number.isFinite(opening) && opening > 0)) {
      throw new PonticInterfaceParamError(`lingualOpeningMm must be finite > 0, got ${opening}`);
    }
    if (!(Number.isFinite(phiC) && phiC > 0)) {
      throw new PonticInterfaceParamError(`contactTransitionHalfAngleRad must be finite > 0, got ${phiC}`);
    }
    return {
      // Buccal (φ≥+phiC): relief. Lingual (φ≤−phiC): relief+opening. Middle: ramp.
      target: (phi) => {
        if (phi >= phiC) return relief;
        if (phi <= -phiC) return relief + opening;
        // s: 0 at +phiC (buccal edge), 1 at −phiC (lingual edge).
        const s = (phiC - phi) / (2 * phiC);
        return relief + opening * smoothstep(s);
      },
      patch: (phi) => (phi >= phiC ? 'primary' : phi <= -phiC ? 'relieved' : 'transition'),
      primaryTargetMm: relief,
    };
  }
  // ovate
  const depth = assertFinitePositive('depthMm', params.depthMm);
  const phiS = params.seatHalfAngleRad ?? (25 * Math.PI) / 180;
  const emergence = params.emergenceMm ?? 0.5;
  if (!(Number.isFinite(phiS) && phiS > 0)) {
    throw new PonticInterfaceParamError(`seatHalfAngleRad must be finite > 0, got ${phiS}`);
  }
  if (!(Number.isFinite(emergence) && emergence > 0)) {
    throw new PonticInterfaceParamError(`emergenceMm must be finite > 0, got ${emergence}`);
  }
  const transitionWidth = phiS; // seat edge → +emergence over one more phiS band.
  return {
    // Seat (|φ|≤phiS): −depth. Outside: ramp from −depth to +emergence.
    target: (phi) => {
      const a = Math.abs(phi);
      if (a <= phiS) return -depth;
      const s = Math.min(1, (a - phiS) / transitionWidth);
      return -depth + (depth + emergence) * smoothstep(s);
    },
    patch: (phi) => (Math.abs(phi) <= phiS ? 'primary' : 'outside'),
    primaryTargetMm: -depth,
  };
}

// ---------------------------------------------------------------------------
// The crest cylinder geometry
// ---------------------------------------------------------------------------

/** Base surface point at station x (along md, relative to axisPoint's md coord)
 * + angle φ, offset by signed t (mm) along the outward radial normal. */
function basepoint(crest: RidgeCrestCylinder, x: number, phi: number, t: number): Vec3 {
  const radial: Vec3 = add(scale(crest.upDir, Math.cos(phi)), scale(crest.buccalDir, Math.sin(phi)));
  const r = crest.radiusMm + t;
  return add(add(crest.axisPointMm, scale(crest.mesialDistalDir, x)), scale(radial, r));
}

/** Signed distance from a world point to the analytic INFINITE crest cylinder
 * (+ outside, − inside) — the closed-form cross-check for the measurement. */
export function analyticCylinderSignedDistanceMm(crest: RidgeCrestCylinder, point: Vec3): number {
  const rel = sub(point, crest.axisPointMm);
  const along = dot(rel, crest.mesialDistalDir);
  const perp: Vec3 = sub(rel, scale(crest.mesialDistalDir, along));
  return len(perp) - crest.radiusMm;
}

/**
 * A deterministic synthetic gingival SEAT RING on the crest apex over the site —
 * the pontic's cervical seat, used as the placement origin (a pontic has NO prep
 * margin). A circle of `radiusMm` in the (mesialDistal, buccal) plane centred at
 * the crest apex above `siteStationMm`. Shared by the stage AND the worker so
 * their placements are BYTE-IDENTICAL (the determinism contract).
 */
export function synthPonticSeatRing(
  crest: RidgeCrestCylinder,
  siteStationMm: number,
  radiusMm: number,
  segments: number,
): Vec3[] {
  if (!(radiusMm > 0)) throw new PonticInterfaceParamError(`seat ring radiusMm must be > 0, got ${radiusMm}`);
  if (!(Number.isInteger(segments) && segments >= 3)) {
    throw new PonticInterfaceParamError(`seat ring segments must be an integer >= 3, got ${segments}`);
  }
  const apex = add(add(crest.axisPointMm, scale(crest.mesialDistalDir, siteStationMm)), scale(crest.upDir, crest.radiusMm));
  const ring: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    ring.push(add(apex, add(scale(crest.mesialDistalDir, radiusMm * c), scale(crest.buccalDir, radiusMm * s))));
  }
  return ring;
}

// ---------------------------------------------------------------------------
// shapePonticBase — the construction
// ---------------------------------------------------------------------------

function linspace(a: number, b: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) {
    out.push(i === 0 ? a : i === segments ? b : a + ((b - a) * i) / segments);
  }
  return out;
}

/**
 * Shape the pontic base against the crest cylinder per style — see the module
 * doc. Pure, deterministic, Float64. Returns the base surface mesh (open patch)
 * + dense measurement samples + the @errorBound.
 *
 * @throws {PonticInterfaceParamError} for a non-unit frame axis, a degenerate
 * footprint/resolution, or a missing/invalid configured relief value.
 */
export function shapePonticBase(
  crest: RidgeCrestCylinder,
  style: PonticInterfaceStyle,
  params: PonticInterfaceParams,
  footprint: PonticBaseFootprint,
  resolution: PonticBaseResolution,
): ShapePonticBaseResult {
  assertUnit(crest.mesialDistalDir, 'mesialDistalDir');
  assertUnit(crest.buccalDir, 'buccalDir');
  assertUnit(crest.upDir, 'upDir');
  if (!(crest.radiusMm > 0)) throw new PonticInterfaceParamError(`radiusMm must be > 0, got ${crest.radiusMm}`);
  if (!(footprint.stationMaxMm > footprint.stationMinMm)) {
    throw new PonticInterfaceParamError('footprint stationMaxMm must be > stationMinMm');
  }
  if (!(footprint.angularHalfSpanRad > 0 && footprint.angularHalfSpanRad < Math.PI / 2)) {
    throw new PonticInterfaceParamError('footprint angularHalfSpanRad must be in (0, π/2)');
  }
  const { meshStations, meshAngularSegments, sampleStations, sampleAngularSegments } = resolution;
  for (const [n, v] of [
    ['meshStations', meshStations], ['meshAngularSegments', meshAngularSegments],
    ['sampleStations', sampleStations], ['sampleAngularSegments', sampleAngularSegments],
  ] as const) {
    if (!(Number.isInteger(v) && v >= 1)) throw new PonticInterfaceParamError(`${n} must be an integer >= 1, got ${v}`);
  }

  const field = buildStyleField(style, params);
  const phiHalf = footprint.angularHalfSpanRad;

  // ---- Base MESH (open patch, grid over station × angle) ----
  const xsMesh = linspace(footprint.stationMinMm, footprint.stationMaxMm, meshStations);
  const phisMesh = linspace(-phiHalf, phiHalf, meshAngularSegments);
  const positions: number[] = [];
  const rows: number[][] = []; // vertex ids per station row
  for (const x of xsMesh) {
    const row: number[] = [];
    for (const phi of phisMesh) {
      const p = basepoint(crest, x, phi, field.target(phi));
      row.push(positions.length / 3);
      positions.push(p[0], p[1], p[2]);
    }
    rows.push(row);
  }
  const triangles: number[] = [];
  for (let si = 0; si < rows.length - 1; si++) {
    const a = rows[si]!;
    const b = rows[si + 1]!;
    for (let ai = 0; ai < a.length - 1; ai++) {
      // Wound so the face normal points OUTWARD (+radial, away from the ridge):
      // station increases along +md, angle along +buccal — this order gives
      // md × dφ ≈ +radial for the fixture frame.
      triangles.push(a[ai]!, b[ai]!, b[ai + 1]!);
      triangles.push(a[ai]!, b[ai + 1]!, a[ai + 1]!);
    }
  }
  const mesh: IndexedMesh = {
    positions: new Float64Array(positions),
    indices: new Uint32Array(triangles),
  };

  // ---- Dense measurement samples (independent of the mesh grid) ----
  const xsSample = linspace(footprint.stationMinMm, footprint.stationMaxMm, sampleStations);
  const phisSample = linspace(-phiHalf, phiHalf, sampleAngularSegments);
  const samples: PonticBaseSample[] = [];
  for (const x of xsSample) {
    for (const phi of phisSample) {
      const t = field.target(phi);
      samples.push({
        pointMm: basepoint(crest, x, phi, t),
        stationMm: x,
        angleRad: phi,
        targetMm: t,
        patch: field.patch(phi),
      });
    }
  }

  return {
    style,
    mesh,
    samples,
    primaryTargetMm: field.primaryTargetMm,
    errorBoundMm: crestSagittaBoundMm(crest.radiusMm, phiHalf, sampleAngularSegments),
  };
}

/** The crest inscribed-chord sagitta bound (mm) over an angular band sampled at
 * `angularSegments` steps across `[-phiHalf,+phiHalf]` — `R·(1−cos(Δφ/2))` with
 * `Δφ = 2·phiHalf/angularSegments`. See the module @errorBound. NOTE: this is
 * the bound for the CONSTRUCTION's own sampling; the acceptance additionally
 * accounts for the GINGIVA MESH's crest resolution (the test reports both). */
export function crestSagittaBoundMm(radiusMm: number, phiHalf: number, angularSegments: number): number {
  const dphi = (2 * phiHalf) / angularSegments;
  return radiusMm * (1 - Math.cos(dphi / 2));
}

// ---------------------------------------------------------------------------
// measurePonticRelief — the instrument (validate BEFORE it judges)
// ---------------------------------------------------------------------------

export interface PonticReliefPatchStats {
  readonly count: number;
  /** The configured/intended target for this patch (mm, signed). */
  readonly targetMm: number;
  /** Measured signed-distance min/max/mean over the patch (mm). */
  readonly minSignedMm: number;
  readonly maxSignedMm: number;
  readonly meanSignedMm: number;
  /** Deviation = measured − target: min/max/mean and the worst |·| (mm). */
  readonly minDeviationMm: number;
  readonly maxDeviationMm: number;
  readonly meanDeviationMm: number;
  readonly maxAbsDeviationMm: number;
}

export interface PonticReliefMeasurement {
  readonly style: PonticInterfaceStyle;
  /** The ACCEPTANCE patch stats (hygienic whole base / ridge-lap buccal contact
   * / ovate seat). `maxAbsDeviationMm ≤ 20 µm` is the acceptance. */
  readonly primary: PonticReliefPatchStats;
  /** Non-primary patches, reported SEPARATELY (never diluting `primary`). */
  readonly secondary: Readonly<Record<string, PonticReliefPatchStats>>;
  /** Max |meshSDF − analyticCylinderSDF| over all samples (mm), when a crest was
   * supplied — the instrument-vs-analytic cross-check. `null` otherwise. */
  readonly analyticCrossCheckMaxGapMm: number | null;
}

interface Acc {
  count: number;
  target: number; // uses the last sample's target as the patch's nominal
  sumSigned: number;
  minSigned: number;
  maxSigned: number;
  sumDev: number;
  minDev: number;
  maxDev: number;
  maxAbsDev: number;
}

function newAcc(): Acc {
  return {
    count: 0, target: NaN, sumSigned: 0, minSigned: Infinity, maxSigned: -Infinity,
    sumDev: 0, minDev: Infinity, maxDev: -Infinity, maxAbsDev: 0,
  };
}

function accPush(acc: Acc, signed: number, target: number): void {
  const dev = signed - target;
  acc.count++;
  acc.target = target;
  acc.sumSigned += signed;
  acc.minSigned = Math.min(acc.minSigned, signed);
  acc.maxSigned = Math.max(acc.maxSigned, signed);
  acc.sumDev += dev;
  acc.minDev = Math.min(acc.minDev, dev);
  acc.maxDev = Math.max(acc.maxDev, dev);
  acc.maxAbsDev = Math.max(acc.maxAbsDev, Math.abs(dev));
}

function accStats(acc: Acc): PonticReliefPatchStats {
  return {
    count: acc.count,
    targetMm: acc.target,
    minSignedMm: acc.minSigned,
    maxSignedMm: acc.maxSigned,
    meanSignedMm: acc.sumSigned / acc.count,
    minDeviationMm: acc.minDev,
    maxDeviationMm: acc.maxDev,
    meanDeviationMm: acc.sumDev / acc.count,
    maxAbsDeviationMm: acc.maxAbsDev,
  };
}

/**
 * Measure the pontic-base relief field against the gingiva mesh — the
 * blend-independent instrument (see the module doc). Per sample: exact signed
 * distance to `gingivaMesh` (`signedClosestPoint`), sign + outside/clearance,
 * − inside/penetration. Buckets by the sample's GEOMETRIC patch; reports the
 * PRIMARY (acceptance) patch stats strictly separate from the relieved /
 * transition / outside patches. Pass `crest` to additionally cross-check the
 * mesh SDF against the analytic cylinder SDF.
 *
 * `bvh`/`pseudonormals` MUST be built from `gingivaMesh` (same contract as
 * `signedClosestPoint`).
 */
export function measurePonticRelief(
  gingivaMesh: IndexedMesh,
  bvh: Bvh,
  pseudonormals: Pseudonormals,
  samples: readonly PonticBaseSample[],
  crest?: RidgeCrestCylinder,
): PonticReliefMeasurement {
  const primary = newAcc();
  const secAcc: Record<string, Acc> = {};
  let maxGap = 0;
  let anyCrest = false;
  for (const s of samples) {
    const signed = signedClosestPoint(gingivaMesh, bvh, pseudonormals, s.pointMm).signedDistance;
    if (s.patch === 'primary') {
      accPush(primary, signed, s.targetMm);
    } else {
      const key = s.patch;
      (secAcc[key] ??= newAcc());
      accPush(secAcc[key]!, signed, s.targetMm);
    }
    if (crest) {
      anyCrest = true;
      const analytic = analyticCylinderSignedDistanceMm(crest, s.pointMm);
      maxGap = Math.max(maxGap, Math.abs(signed - analytic));
    }
  }
  const secondary: Record<string, PonticReliefPatchStats> = {};
  for (const [k, a] of Object.entries(secAcc)) secondary[k] = accStats(a);
  if (primary.count === 0) {
    throw new PonticInterfaceParamError('no primary-patch samples — the base footprint/style produced an empty acceptance patch');
  }
  return {
    style: samplesStyle(samples),
    primary: accStats(primary),
    secondary,
    analyticCrossCheckMaxGapMm: anyCrest ? maxGap : null,
  };
}

/** Infer the style from the sample patch composition (hygienic: all primary;
 * ridge-lap: has a `relieved` patch; ovate: has an `outside` patch). Reported in
 * the measurement for auditability. */
function samplesStyle(samples: readonly PonticBaseSample[]): PonticInterfaceStyle {
  let hasRelieved = false;
  let hasOutside = false;
  for (const s of samples) {
    if (s.patch === 'relieved') hasRelieved = true;
    else if (s.patch === 'outside') hasOutside = true;
  }
  if (hasRelieved) return 'ridgeLap';
  if (hasOutside) return 'ovate';
  return 'hygienic';
}
