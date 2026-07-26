// packages/kernel/src/bridge/bridge.test-fixtures.ts
//
// TEST-ONLY analytic fixture for the Phase 6 bridge (multi-unit) pipeline — the
// P6 equivalent of margin/marginRidge.test-fixtures.ts's `shoulderPrepMesh` and
// cavity/cavity.test-fixtures.ts's `modCavityMesh`. Not exported from
// packages/kernel/src/index.ts (same convention as every other
// *.test-fixtures.ts here). This module SEEDS the `bridge/` domain that Phase 6
// Tasks 2+ (shared axis, pontic interface, connectors, assembly) build out.
//
// ## What this fixture is
//
// A closed-form 3-unit posterior bridge SCENE: two shoulder-prep abutment dies
// (REUSED verbatim from `shoulderPrepMesh` — the exact-ring die) placed at
// closed-form positions flanking a pontic-site gingiva RIDGE segment (a
// closed-form convex "loaf" whose crest lies on an analytic cylinder), with an
// optional antagonist plane. Every component is an INDEPENDENT watertight solid
// (NOT booleaned together — Task 1 seeds the geometry; Task 6 does the union),
// deterministic (byte-identical across builds), Float64, and parameterized
// (span, die dims, ridge profile, tilt, antagonist).
//
// ## The two abutment dies + the exactness policy (BE HONEST)
//
// Each die is a `shoulderPrepMesh` in its OWN local frame (base at z=0, axis
// +Z, margin ring exactly on the analytic circle r=marginRadiusMm at
// z=marginHeightMm — see that fixture's "exact ring" doc), then placed by a
// RIGID transform `world = translate(R_y(tiltRad) · local)`:
//
//   - MESIAL die: tilt 0, translation (-spanMm/2, 0, 0).
//   - DISTAL die: translation (+spanMm/2, 0, 0), tilt `tiltDeg` about the Y
//     (buccolingual) axis — the mesiodistal tilt knob.
//
// **Exactness — what is BITWISE vs BOUNDED (do not overclaim):**
//
//   1. Each die's LOCAL margin ring is BITWISE on its analytic circle — that is
//      `shoulderPrepMesh`'s own guarantee (`(r·cosθ, r·sinθ, marginHeightMm)`
//      exactly, Float64 cos/sin rounding only), re-exposed as `localMarginRing`
//      and re-asserted (bridge.fixture.test.ts).
//   2. A PURE TRANSLATION (both dies at `tiltDeg === 0`) touches only X (and Y,
//      here 0), never Z: so every placed ring vertex has `worldZ === marginHeightMm`
//      BITWISE (no arithmetic on the Z coordinate). The in-plane radius about the
//      translated centre equals `marginRadiusMm` only to a BOUND (true error ~ a few ULPs ≈ 4e-16 mm; asserted < 1e-14) —
//      a single Float64 rounding of the coordinate sum `local + t` — NOT bitwise
//      (because `(a + t) − t` rounds). Stated honestly as a bound, measured in
//      the test.
//   3. The SHARED INSERTION AXIS is BITWISE at `tiltDeg === 0`: both dies'
//      `insertionAxis === [0, 0, 1]` exactly (R_y(0) has `cos 0 === 1`,
//      `sin 0 === 0`, so `R_y(0)·ẑ === ẑ` and translation does not rotate a
//      direction). This is the falsifiable shared-axis case for Task 2: a valid
//      common axis exists. With `tiltDeg > 0` the distal axis is
//      `[sin(tiltRad), 0, cos(tiltRad)]`; the angle between axes is `tiltRad`
//      EXACTLY (analytic), reproduced to rotation-rounding tolerance — so NO
//      undercut-free shared axis exists (Task 2's falsifiable non-parallel case).
//
// ## The pontic-site gingiva RIDGE (closed-form, closed solid)
//
// A convex "loaf" swept along X (mesiodistal) over `[-ridgeHalfLengthMm,
// +ridgeHalfLengthMm]`. Its CREST is a circular cylinder of radius
// `crestRadiusMm` whose axis is the line `(x, 0, crestCenterZMm)`: the crest
// surface is `z = crestCenterZMm + sqrt(crestRadiusMm² − y²)` for
// `|y| ≤ crestRadiusMm`, and the crest APEX line is `(x, 0, crestCenterZMm +
// crestRadiusMm)`. A CLOSED SOLID is PREFERRED over an open surface (the P5
// exactness precedent — `modCavityMesh` is a closed solid): the cross-section is
// the crest arc closed off by two vertical walls down to a flat base at z=0, so
// a signed-distance relief measurement (Task 3) is well-defined against a real
// closed manifold.
//
//   - Crest ARC vertices lie BITWISE on the analytic cylinder (same
//     `crestCenterZMm + sqrt(R² − y²)` formula that defines it), and the apex
//     vertices are BITWISE at `crestCenterZMm + crestRadiusMm` (special-cased at
//     y === 0 to avoid `sqrt(R·R) ≠ R` rounding). The discrete surface BETWEEN
//     crest samples is the inscribed chord (strictly below the arc) — the only
//     ridge surface-error term Task 3 must account for, exactly as
//     `shoulderPrepMesh`'s "between-ring" story. Documented, not hidden.
//
// ## Watertightness / winding
//
// Each die inherits `shoulderPrepMesh`'s already-outward winding; a RIGID
// transform (rotation det = +1, then translation) preserves topology AND
// orientation, so the placed die is watertight/manifold with no re-orientation.
// The ridge (and antagonist) are built with a shared-coordinate vertex table
// (coincident points → one vertex) then run once through the kernel's
// deterministic `orientNormalsConsistently`. Tests assert watertight /
// single-component / manifold / positive signed volume via `analyzeMesh`.
import type { IndexedMesh } from '../mesh/types.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { shoulderPrepMesh, type ShoulderPrepMeshOptions } from '../margin/marginRidge.test-fixtures.ts';

type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Small self-contained helpers (TEST-ONLY fixture files in this repo keep these
// local rather than cross-importing — see cavity.test-fixtures.ts's own note).
// ---------------------------------------------------------------------------

/** Endpoints pinned to EXACTLY `a`/`b` (not `a + (b-a)*n/n`, which can round to
 * a different last ULP) so shared boundary stations dedup cleanly — the
 * cavity.test-fixtures.ts `linspace` rationale. */
function linspace(a: number, b: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) {
    out.push(i === 0 ? a : i === segments ? b : a + ((b - a) * i) / segments);
  }
  return out;
}

/** Ear-clip a SIMPLE polygon given as 2D (u,v); returns index triples into
 * `poly`. Orientation-agnostic (normalizes to CCW). O(n²), n tiny. Copied from
 * cavity.test-fixtures.ts (self-contained fixture convention). */
function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ux, uy] = poly[i]!;
    const [vx, vy] = poly[(i + 1) % n]!;
    area2 += ux * vy - vx * uy;
  }
  if (area2 < 0) idx.reverse();
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const pointInTri = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): boolean => {
    const d1 = cross(ax, ay, bx, by, px, py);
    const d2 = cross(bx, by, cx, cy, px, py);
    const d3 = cross(cx, cy, ax, ay, px, py);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  const tris: [number, number, number][] = [];
  const v = idx.slice();
  let guard = 0;
  while (v.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!;
      const b = v[i]!;
      const c = v[(i + 1) % v.length]!;
      const [ax, ay] = poly[a]!;
      const [bx, by] = poly[b]!;
      const [cx, cy] = poly[c]!;
      if (cross(ax, ay, bx, by, cx, cy) <= 0) continue;
      let anyInside = false;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        const [px, py] = poly[p]!;
        if (pointInTri(px, py, ax, ay, bx, by, cx, cy)) {
          anyInside = true;
          break;
        }
      }
      if (anyInside) continue;
      tris.push([a, b, c]);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) tris.push([v[0]!, v[1]!, v[2]!]);
  return tris;
}

/** A shared-coordinate mesh builder (coincident points → one vertex), returning
 * an `orientNormalsConsistently`-cleaned closed solid — the modCavityMesh
 * assembly pattern. */
function makeSweptSolid(
  crossSections: readonly Vec3[][],
  capFirst: readonly Vec3[],
  capLast: readonly Vec3[],
): IndexedMesh {
  const vertexIndex = new Map<string, number>();
  const positions: number[] = [];
  const vid = (p: Vec3): number => {
    const key = `${p[0]}|${p[1]}|${p[2]}`;
    const existing = vertexIndex.get(key);
    if (existing !== undefined) return existing;
    const i = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    vertexIndex.set(key, i);
    return i;
  };
  const triangles: [number, number, number][] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    const ia = vid(a);
    const ib = vid(b);
    const ic = vid(c);
    if (ia === ib || ib === ic || ia === ic) return;
    triangles.push([ia, ib, ic]);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    tri(a, b, c);
    tri(a, c, d);
  };
  // Side walls between adjacent cross-sections.
  for (let s = 0; s < crossSections.length - 1; s++) {
    const a = crossSections[s]!;
    const b = crossSections[s + 1]!;
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      quad(a[i]!, a[j]!, b[j]!, b[i]!);
    }
  }
  // End caps: ear-clip the ring projected to (Y,Z) at constant X.
  const cap = (ring: readonly Vec3[]): void => {
    const uv = ring.map((p) => [p[1], p[2]] as [number, number]);
    for (const [ia, ib, ic] of earClip(uv)) tri(ring[ia]!, ring[ib]!, ring[ic]!);
  };
  cap(capFirst);
  cap(capLast);

  const flatPositions = new Float64Array(positions);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return orientNormalsConsistently({ positions: flatPositions, indices }).mesh;
}

// ---------------------------------------------------------------------------
// Rigid placement (rotation about Y, then translation). det(R_y) = +1 so
// orientation is preserved — a placed `shoulderPrepMesh` stays watertight and
// outward-wound with no re-orientation.
// ---------------------------------------------------------------------------

/** `R_y(tiltRad) · p` — rotation about the Y (buccolingual) axis. At
 * `tiltRad === 0`, `cos 0 === 1` and `sin 0 === 0` in IEEE-754, so this returns
 * `p` BITWISE (the pure-translation exactness case relies on this). */
function rotateY(p: Vec3, cos: number, sin: number): Vec3 {
  return [p[0] * cos + p[2] * sin, p[1], -p[0] * sin + p[2] * cos];
}

function placePoint(p: Vec3, cos: number, sin: number, t: Vec3): Vec3 {
  const r = rotateY(p, cos, sin);
  return [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
}

function placeMesh(mesh: IndexedMesh, cos: number, sin: number, t: Vec3): IndexedMesh {
  const out = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const world = placePoint([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!], cos, sin, t);
    out[i] = world[0];
    out[i + 1] = world[1];
    out[i + 2] = world[2];
  }
  // indices unchanged (rigid transform preserves topology + winding).
  return { positions: out, indices: mesh.indices.slice() };
}

/** The analytic local margin ring of a `shoulderPrepMesh`, reconstructed with
 * the SAME formula `revolveProfile` uses circumferentially — so these points are
 * BITWISE identical to the mesh's own P2-ring vertices (the "exact ring"). */
function localMarginRing(marginRadiusMm: number, marginHeightMm: number, segments: number): Vec3[] {
  const ring: Vec3[] = [];
  for (let s = 0; s < segments; s++) {
    const theta = (2 * Math.PI * s) / segments;
    ring.push([marginRadiusMm * Math.cos(theta), marginRadiusMm * Math.sin(theta), marginHeightMm]);
  }
  return ring;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BridgeFixtureOptions {
  /** Mesiodistal distance (mm) between the two abutment die axes — the dies sit
   * at x = ∓spanMm/2, the pontic site at x = 0. Default 14 (dies + ridge do not
   * overlap at the defaults). */
  spanMm?: number;
  /** Mesiodistal tilt (degrees) of the DISTAL die about the Y (buccolingual)
   * axis — 0 (default) ⇒ both die axes are +Z (a shared insertion axis exists,
   * Task 2's positive case); > 0 ⇒ the distal axis is
   * `[sin, 0, cos]` (no undercut-free shared axis — Task 2's falsifiable case). */
  tiltDeg?: number;
  /** Options forwarded to BOTH `shoulderPrepMesh` dies (die dims / segments). */
  dieOptions?: ShoulderPrepMeshOptions;
  /** Ridge crest cylinder radius (mm). Default 3. */
  ridgeCrestRadiusMm?: number;
  /** Ridge crest cylinder axis height (mm, Z) — crest apex at
   * `ridgeCrestCenterZMm + ridgeCrestRadiusMm`, crest feet at z = center. Default 1. */
  ridgeCrestCenterZMm?: number;
  /** Ridge mesiodistal half-length (mm) — the ridge spans x ∈ [-this, +this].
   * Default 2.5. */
  ridgeHalfLengthMm?: number;
  /** Crest arc samples across the semicircle (must be even so an EXACT apex
   * vertex lands at y = 0). Default 32. */
  ridgeCrestSegments?: number;
  /** Mesiodistal (X) subdivisions of the ridge sweep. Default 8. */
  ridgeStations?: number;
  /** Add a flat horizontal antagonist slab above the scene. Default false. */
  withAntagonist?: boolean;
  /** Antagonist slab bottom height (mm, Z). Default 12. */
  antagonistZMm?: number;
}

/** One placed abutment die + its closed-form placement metadata. */
export interface BridgeAbutmentDie {
  readonly mesh: IndexedMesh;
  /** The unit insertion axis (world) — `[0,0,1]` for the untilted (mesial) die;
   * `[sin(tiltRad),0,cos(tiltRad)]` for the tilted (distal) die. */
  readonly insertionAxis: Vec3;
  /** Rigid placement: `R_y(tiltRad)` then `+translationMm`. */
  readonly translationMm: Vec3;
  readonly tiltRad: number;
  /** Analytic margin-circle parameters (LOCAL frame). */
  readonly marginRadiusMm: number;
  readonly marginHeightMm: number;
  /** The LOCAL margin ring (bitwise on the analytic circle). */
  readonly localMarginRing: Vec3[];
  /** The WORLD (placed) margin ring — `placePoint(localMarginRing)`. Every point
   * is a vertex of `mesh`. */
  readonly worldMarginRing: Vec3[];
  /** The WORLD margin-circle centre (`place([0,0,marginHeightMm])`). */
  readonly worldMarginCenterMm: Vec3;
}

/** The closed-form pontic-site gingiva ridge. */
export interface BridgeRidge {
  readonly mesh: IndexedMesh;
  /** Crest cylinder radius / axis height / apex height (mm). Crest surface is
   * `z = crestCenterZMm + sqrt(crestRadiusMm² − y²)`. */
  readonly crestRadiusMm: number;
  readonly crestCenterZMm: number;
  readonly crestApexZMm: number;
  readonly halfLengthMm: number;
  /** The crest apex line's constant Z (`crestApexZMm`) and the X stations along
   * it — every `(x, 0, crestApexZMm)` is a mesh vertex (the apex edge). */
  readonly apexStationsX: number[];
}

export interface BridgeFixture {
  readonly mesial: BridgeAbutmentDie;
  readonly distal: BridgeAbutmentDie;
  readonly ridge: BridgeRidge;
  /** Present only when `withAntagonist`. */
  readonly antagonist: IndexedMesh | null;
  // echoed params
  readonly spanMm: number;
  readonly tiltDeg: number;
}

function buildDie(
  dieOptions: ShoulderPrepMeshOptions | undefined,
  translationMm: Vec3,
  tiltRad: number,
): BridgeAbutmentDie {
  const { mesh: local, marginRadiusMm, marginHeightMm } = shoulderPrepMesh(dieOptions);
  const segments = dieOptions?.segments ?? 128;
  const cos = Math.cos(tiltRad);
  const sin = Math.sin(tiltRad);
  const mesh = placeMesh(local, cos, sin, translationMm);
  const ring = localMarginRing(marginRadiusMm, marginHeightMm, segments);
  const worldMarginRing = ring.map((p) => placePoint(p, cos, sin, translationMm));
  const worldMarginCenterMm = placePoint([0, 0, marginHeightMm], cos, sin, translationMm);
  return {
    mesh,
    insertionAxis: [sin, 0, cos],
    translationMm,
    tiltRad,
    marginRadiusMm,
    marginHeightMm,
    localMarginRing: ring,
    worldMarginRing,
    worldMarginCenterMm,
  };
}

function buildRidge(
  crestRadiusMm: number,
  crestCenterZMm: number,
  halfLengthMm: number,
  crestSegments: number,
  stations: number,
): BridgeRidge {
  if (!(crestRadiusMm > 0)) throw new RangeError('bridgeFixture: ridgeCrestRadiusMm must be > 0');
  if (!(crestCenterZMm > 0)) throw new RangeError('bridgeFixture: ridgeCrestCenterZMm must be > 0 (crest feet above the base)');
  if (!(halfLengthMm > 0)) throw new RangeError('bridgeFixture: ridgeHalfLengthMm must be > 0');
  if (!(crestSegments >= 2 && crestSegments % 2 === 0)) {
    throw new RangeError('bridgeFixture: ridgeCrestSegments must be an even integer >= 2 (an exact apex at y=0)');
  }
  if (!(stations >= 1)) throw new RangeError('bridgeFixture: ridgeStations must be >= 1');

  const R = crestRadiusMm;
  const zc = crestCenterZMm;
  // Crest y-samples across the full semicircle, endpoints + apex pinned exactly.
  const ys = linspace(-R, R, crestSegments);
  const crestZ = (y: number): number => (y === 0 ? zc + R : zc + Math.sqrt(R * R - y * y));

  // Closed cross-section ring (in Y-Z at station x): crest arc, then down the
  // right wall to the base, across to the left base — ordered so the polygon is
  // simple. Feet at (±R, zc); base at (±R, 0).
  const crossSection = (x: number): Vec3[] => {
    const ring: Vec3[] = [];
    for (const y of ys) ring.push([x, y, crestZ(y)]); // -R..+R over the crest
    ring.push([x, R, 0]); // right base
    ring.push([x, -R, 0]); // left base
    return ring;
  };

  const xs = linspace(-halfLengthMm, halfLengthMm, stations);
  const crossSections = xs.map((x) => crossSection(x));
  const mesh = makeSweptSolid(crossSections, crossSections[0]!, crossSections[crossSections.length - 1]!);

  return {
    mesh,
    crestRadiusMm: R,
    crestCenterZMm: zc,
    crestApexZMm: zc + R,
    halfLengthMm,
    apexStationsX: xs.slice(),
  };
}

/** A thin closed antagonist slab spanning the scene, bottom at `zBottom`.
 * Swept along X (like the ridge) so `makeSweptSolid`'s constant-X, (Y,Z)-plane
 * end caps are well-defined. */
function buildAntagonist(spanMm: number, zBottom: number): IndexedMesh {
  const hx = spanMm / 2 + 5;
  const hy = 6;
  const zTop = zBottom + 1;
  // Cross-section: a (Y,Z) rectangle at station x.
  const ring = (x: number): Vec3[] => [
    [x, -hy, zBottom],
    [x, hy, zBottom],
    [x, hy, zTop],
    [x, -hy, zTop],
  ];
  return makeSweptSolid([ring(-hx), ring(hx)], ring(-hx), ring(hx));
}

/**
 * The analytic 3-unit posterior bridge fixture — see this module's doc.
 * Deterministic and Float64 throughout. Every component is an independent
 * watertight closed solid (Task 1 seeds geometry; the union is Task 6).
 */
export function bridgeFixture(opts: BridgeFixtureOptions = {}): BridgeFixture {
  const spanMm = opts.spanMm ?? 14;
  const tiltDeg = opts.tiltDeg ?? 0;
  const ridgeCrestRadiusMm = opts.ridgeCrestRadiusMm ?? 3;
  const ridgeCrestCenterZMm = opts.ridgeCrestCenterZMm ?? 1;
  const ridgeHalfLengthMm = opts.ridgeHalfLengthMm ?? 2.5;
  const ridgeCrestSegments = opts.ridgeCrestSegments ?? 32;
  const ridgeStations = opts.ridgeStations ?? 8;
  const withAntagonist = opts.withAntagonist ?? false;
  const antagonistZMm = opts.antagonistZMm ?? 12;

  if (!(spanMm > 0)) throw new RangeError('bridgeFixture: spanMm must be > 0');
  if (!Number.isFinite(tiltDeg) || tiltDeg < 0 || tiltDeg >= 90) {
    throw new RangeError('bridgeFixture: tiltDeg must be in [0, 90)');
  }

  const tiltRad = (tiltDeg * Math.PI) / 180;
  const mesial = buildDie(opts.dieOptions, [-spanMm / 2, 0, 0], 0);
  const distal = buildDie(opts.dieOptions, [spanMm / 2, 0, 0], tiltRad);
  const ridge = buildRidge(ridgeCrestRadiusMm, ridgeCrestCenterZMm, ridgeHalfLengthMm, ridgeCrestSegments, ridgeStations);
  const antagonist = withAntagonist ? buildAntagonist(spanMm, antagonistZMm) : null;

  return { mesial, distal, ridge, antagonist, spanMm, tiltDeg };
}
