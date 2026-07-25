// packages/kernel/src/cavity/cavity.test-fixtures.ts
//
// TEST-ONLY analytic fixture for the Phase 5 inlay/onlay pipeline — the P5
// equivalent of margin/marginRidge.test-fixtures.ts's `shoulderPrepMesh`.
// Not exported from packages/kernel/src/index.ts (same convention as every
// other *.test-fixtures.ts here). This module SEEDS the `cavity/` domain that
// Phase 5 Task 2 (cavity region analysis) will build out.
//
// ## What this fixture is
//
// A synthetic posterior tooth (a closed-form BLOCK with a two-cusp "valley
// roof" — NOT real anatomy, by design: PLAN.md's Phase 5 acceptance says
// "fixture MOD cavity" and the brief says the tooth "does NOT need real
// anatomy; it needs closed-form geometry") into which a machined MOD
// (mesial-occlusal-distal) cavity is constructed DIRECTLY — profile-swept,
// like `shoulderPrepMesh`, NOT boolean-subtracted. The direct construction is
// what keeps the cavity OUTLINE exact: every outline vertex is a real mesh
// vertex sitting on a known analytic plane/line, not a boolean-tessellated
// seam whose vertices land wherever the intersection solver put them (the
// brief's stated reason to prefer direct construction, and why later tasks can
// feed `cavityOutline` to the margin machinery as the exact "margin currency").
//
// ## The MOD cavity geometry (all closed-form)
//
// Coordinate frame: X = mesiodistal, Y = buccolingual, Z = occlusogingival
// (occlusal = +Z), base at z = 0. The cavity is symmetric about the YZ plane
// (x = 0) and the XZ plane (y = 0). Insertion axis = +Z (occlusal draw).
//
//   - The OCCLUSAL OPENING is a rectangle at z = `tableZ`, buccolingual
//     half-width `isthmusHalfWidthMm` (= isthmusWidthMm / 2), running the full
//     mesiodistal length — this rectangle's two long edges (the buccal and
//     lingual occlusal margins) plus the two proximal "U" drops ARE the
//     cavosurface outline (see below).
//   - The floor is STEPPED: shallow (`floorZ = tableZ - isthmusDepthMm`) in
//     the central ISTHMUS zone `x ∈ [-isthmusHalfLenMm, +isthmusHalfLenMm]`,
//     and deeper (`gingivalFloorZ = tableZ - boxDepthMm`) in the two PROXIMAL
//     BOX zones at each mesiodistal end (each `boxLengthMm` long). The two
//     transverse step walls between them (at x = ±isthmusHalfLenMm) are the
//     boxes' pulpal/axial walls.
//   - Every cavity wall DRAFTS outward toward the occlusal by the half-angle
//     `taperDeg` (a single divergence angle — the insertion draft), so a floor
//     of depth `d` has half-width `isthmusHalfWidthMm - d*tan(taperDeg)`; the
//     occlusal opening (all walls) stays at `isthmusHalfWidthMm`.
//   - The cavity BREAKS THROUGH both proximal faces (x = ±lengthMm/2) — true
//     "MOD": at each end the box opening is a notch in the proximal face down
//     to the gingival floor, so the outline drops down that face (a proximal
//     "U"). The proximal frame around each notch is the residual buccal/lingual
//     wall + the material below the gingival floor.
//
// ### Deliberate, documented simplifications (honesty over embellishment)
//
//   1. UNIFORM buccolingual width: the proximal boxes share the isthmus's BL
//      opening width (`isthmusHalfWidthMm`); they differ from the isthmus ONLY
//      in floor DEPTH (deeper gingival floor). This keeps the buccal/lingual
//      axial walls continuous PLANES (no compound "wider AND deeper" corner),
//      which is what makes the direct construction robustly watertight and the
//      region classification purely analytic. The boxes are therefore
//      distinguished by depth + mesiodistal zone, not by a separate BL width.
//      If a later task needs genuinely wider boxes, extend then (YAGNI).
//   2. SHARP internal line angles (no fillets). `shoulderPrepMesh`'s optional
//      fillet is not reproduced here — the sharp corners at the proximal box
//      line angles are exactly the corner-case currency Phase 5 Task 2 tests
//      the margin machinery against ("sharp corners at box line angles").
//
// ## The exact outline ring (`cavityOutline`)
//
// Returned as an ordered, closed (first ≠ last) polyline of vertices that are
// EVERY ONE a vertex of `mesh`. Along the two occlusal margins it is dense
// (one point per mesiodistal station); at the two proximal boxes it turns
// through the SHARP box line angles (corner-exact). Every point lies exactly
// on its analytic locus (occlusal-margin points: z = tableZ, |y| =
// isthmusHalfWidthMm; proximal-U points: |x| = lengthMm/2) up to Float64
// rounding of the interpolation arithmetic alone — there is no separate
// "mesh approximates a curved surface" error term, exactly as
// `shoulderPrepMesh`'s "exact ring" note describes for its sharp variant.
//
// ## Watertightness / winding
//
// Faces are emitted with a shared-coordinate vertex table (coincident points
// are one vertex, so the outer shell, cavity surface, step ribbons and
// proximal frames share edges → a closed 2-manifold), then run once through
// the kernel's deterministic `orientNormalsConsistently` so the returned mesh
// has globally consistent OUTWARD winding regardless of per-face emission
// order. Tests assert watertight / single-component / manifold / positive
// signed volume / zero degenerate triangles via `analyzeMesh`.
import type { IndexedMesh } from '../mesh/types.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';

type Vec3 = readonly [number, number, number];

export interface ModCavityMeshOptions {
  /** Mesiodistal length of the tooth block (mm). Default 10. */
  lengthMm?: number;
  /** Buccolingual width of the tooth block (mm). Default 9. */
  widthMm?: number;
  /** Occlusal table height (mm, Z) — the cavity opening / occlusal-margin
   * plane. Default 6. */
  tableZ?: number;
  /** Cusp-tip height ABOVE `tableZ` (mm) — the buccal & lingual cusps rise
   * this far above the occlusal margin. Default 1.5. */
  cuspHeightMm?: number;
  /** Buccolingual width of the cavity occlusal opening (mm). Default 2.5. */
  isthmusWidthMm?: number;
  /** Isthmus floor depth below `tableZ` (mm) — the shallow central floor.
   * Default 2.0. */
  isthmusDepthMm?: number;
  /** Proximal-box gingival-floor depth below `tableZ` (mm) — the deep box
   * floor; MUST exceed `isthmusDepthMm`. Default 3.5. */
  boxDepthMm?: number;
  /** Mesiodistal length of EACH proximal box (mm) — the isthmus occupies the
   * remaining central `lengthMm - 2*boxLengthMm`. Default 2.5. */
  boxLengthMm?: number;
  /** Wall divergence half-angle (degrees) — the insertion draft. Default 6. */
  taperDeg?: number;
  /** ONLAY variant knob: lower the BUCCAL cusp by `reducedCuspDropMm`, giving
   * Phase 5 Task 7's cusp-coverage extension a reduced cusp to restore.
   * Default false. */
  reducedCusp?: boolean;
  /** How far `reducedCusp` lowers the buccal cusp tip (mm); must be <
   * `cuspHeightMm` so the reduced cusp stays above `tableZ`. Default 1.0. */
  reducedCuspDropMm?: number;
  /** Mesiodistal subdivisions PER ZONE (mesial box / isthmus / distal box) —
   * controls outline density along the occlusal margins. Default 6. */
  mdSegmentsPerZone?: number;
}

export interface ModCavityMesh {
  readonly mesh: IndexedMesh;
  /** The exact cavosurface outline: an ordered, closed (first ≠ last) ring of
   * vertices, every one a vertex of `mesh`. */
  readonly cavityOutline: Vec3[];
  // --- echoed closed-form parameters (Phase 5 Task 2 tests classification
  //     against these) ---
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly tableZ: number;
  /** Isthmus (shallow) floor Z. */
  readonly floorZ: number;
  /** Proximal-box (deep) gingival floor Z. */
  readonly gingivalFloorZ: number;
  /** Cavity occlusal-opening half-width (Y), shared by isthmus and boxes. */
  readonly isthmusHalfWidthMm: number;
  /** Isthmus floor half-width (Y), after draft. */
  readonly isthmusFloorHalfWidthMm: number;
  /** Box gingival-floor half-width (Y), after draft. */
  readonly boxFloorHalfWidthMm: number;
  /** Wall draft half-angle (radians). */
  readonly taperRad: number;
  /** Central isthmus half-length in X (isthmus = x ∈ [-this, +this]). */
  readonly isthmusHalfLenMm: number;
  readonly boxLengthMm: number;
  /** Buccal cusp tip Z (lowered when `reducedCusp`). */
  readonly cuspZBuccal: number;
  /** Lingual cusp tip Z. */
  readonly cuspZLingual: number;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** Endpoints are pinned to EXACTLY `a` and `b` (not `a + (b-a)*n/n`, which can
 * round to a different last ULP) so adjacent zones — and the pulpal-wall /
 * proximal-frame code that references the same boundary x directly — produce
 * bit-identical station coordinates that the vertex-dedup map actually merges.
 * A one-ULP mismatch here silently un-welds a shared ring into a boundary
 * seam (found by the property test). */
function linspace(a: number, b: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) {
    out.push(i === 0 ? a : i === segments ? b : a + ((b - a) * i) / segments);
  }
  return out;
}

/** Ear-clip a SIMPLE polygon given as 2D (u,v) points; returns triangles as
 * index triples into `poly`. Orientation-agnostic (normalizes to CCW first).
 * O(n²) — n is tiny here (a proximal-frame cap is a 10-vertex polygon). */
function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  // Signed area → ensure CCW.
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
      if (cross(ax, ay, bx, by, cx, cy) <= 0) continue; // reflex or collinear
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
    if (!clipped) break; // degenerate; caller's analyzeMesh assert will catch a bad cap
  }
  if (v.length === 3) tris.push([v[0]!, v[1]!, v[2]!]);
  return tris;
}

/**
 * The analytic MOD-cavity fixture — see this module's doc. Deterministic and
 * Float64 throughout.
 */
export function modCavityMesh(opts: ModCavityMeshOptions = {}): ModCavityMesh {
  const lengthMm = opts.lengthMm ?? 10;
  const widthMm = opts.widthMm ?? 9;
  const tableZ = opts.tableZ ?? 6;
  const cuspHeightMm = opts.cuspHeightMm ?? 1.5;
  const isthmusWidthMm = opts.isthmusWidthMm ?? 2.5;
  const isthmusDepthMm = opts.isthmusDepthMm ?? 2.0;
  const boxDepthMm = opts.boxDepthMm ?? 3.5;
  const boxLengthMm = opts.boxLengthMm ?? 2.5;
  const taperDeg = opts.taperDeg ?? 6;
  const reducedCusp = opts.reducedCusp ?? false;
  const reducedCuspDropMm = opts.reducedCuspDropMm ?? 1.0;
  const mdSegmentsPerZone = opts.mdSegmentsPerZone ?? 6;

  // --- validation (a fixture that violates these is not closed-form-knowable) ---
  const halfLen = lengthMm / 2;
  const isthmusHalfLenMm = halfLen - boxLengthMm;
  const isthmusHalfWidthMm = isthmusWidthMm / 2;
  const taperRad = (taperDeg * Math.PI) / 180;
  const tan = Math.tan(taperRad);
  const floorZ = tableZ - isthmusDepthMm;
  const gingivalFloorZ = tableZ - boxDepthMm;
  const isthmusFloorHalfWidthMm = isthmusHalfWidthMm - isthmusDepthMm * tan;
  const boxFloorHalfWidthMm = isthmusHalfWidthMm - boxDepthMm * tan;
  const cuspZLingual = tableZ + cuspHeightMm;
  const cuspZBuccal = reducedCusp ? tableZ + cuspHeightMm - reducedCuspDropMm : tableZ + cuspHeightMm;

  if (!(boxLengthMm > 0 && isthmusHalfLenMm > 0)) {
    throw new RangeError('modCavityMesh: need boxLengthMm > 0 and 2*boxLengthMm < lengthMm (a real isthmus)');
  }
  if (!(boxDepthMm > isthmusDepthMm)) {
    throw new RangeError('modCavityMesh: boxDepthMm must exceed isthmusDepthMm (the box is the DEEP floor)');
  }
  if (!(gingivalFloorZ > 0)) {
    throw new RangeError('modCavityMesh: boxDepthMm too large — gingival floor would fall below the base (z=0)');
  }
  if (!(boxFloorHalfWidthMm > 0)) {
    throw new RangeError('modCavityMesh: taper/depth too large — the drafted box floor would have non-positive width');
  }
  if (!(isthmusHalfWidthMm > 0 && isthmusHalfWidthMm < widthMm / 2)) {
    throw new RangeError('modCavityMesh: need 0 < isthmusWidthMm < widthMm');
  }
  if (!(reducedCuspDropMm < cuspHeightMm)) {
    throw new RangeError('modCavityMesh: reducedCuspDropMm must be < cuspHeightMm (reduced cusp stays above the table)');
  }
  if (!(mdSegmentsPerZone >= 1)) {
    throw new RangeError('modCavityMesh: mdSegmentsPerZone must be >= 1');
  }

  // --- shared-coordinate vertex table (coincident points → one vertex) ---
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
    if (ia === ib || ib === ic || ia === ic) return; // skip a degenerate (coincident corner)
    triangles.push([ia, ib, ic]);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    tri(a, b, c);
    tri(a, c, d);
  };

  // --- geometry generators (all as functions of x) ---
  const MB = (x: number): Vec3 => [x, -isthmusHalfWidthMm, tableZ]; // buccal occlusal margin
  const ML = (x: number): Vec3 => [x, +isthmusHalfWidthMm, tableZ]; // lingual occlusal margin

  // Outer silhouette chain (material outside boundary) from MB → around → ML.
  const outerChain = (x: number): Vec3[] => [
    MB(x),
    [x, -widthMm / 2, cuspZBuccal], // buccal cusp tip
    [x, -widthMm / 2, 0], // buccal base corner
    [x, +widthMm / 2, 0], // lingual base corner
    [x, +widthMm / 2, cuspZLingual], // lingual cusp tip
    ML(x),
  ];

  // Cavity chain (pocket boundary), SHARP internal line angles. The ISTHMUS
  // chain is corners-only (MB → floor-buccal → floor-lingual → ML). The BOX
  // chain additionally carries a "shoulder" vertex on each axial wall AT THE
  // ISTHMUS FLOOR DEPTH (`floorZ`): because every wall is one drafted plane,
  // the isthmus floor corner lies exactly on the box wall's edge line — making
  // it a shared vertex (not a T-junction) is what lets the box↔isthmus floor
  // step close with a single non-degenerate pulpal-wall quad instead of a
  // zero-area flap. The shoulder sits at the isthmus floor's OWN (y,z), so the
  // box chain's shoulder === the isthmus chain's floor corner (shared).
  const shoulderB = (x: number): Vec3 => [x, -isthmusFloorHalfWidthMm, floorZ];
  const shoulderL = (x: number): Vec3 => [x, +isthmusFloorHalfWidthMm, floorZ];
  const cavityChain = (x: number, deep: boolean): Vec3[] => {
    if (!deep) {
      return [MB(x), shoulderB(x), shoulderL(x), ML(x)]; // isthmus: shoulder === floor corner
    }
    return [
      MB(x),
      shoulderB(x), // wall shoulder at isthmus-floor depth (shared with isthmus chain)
      [x, -boxFloorHalfWidthMm, gingivalFloorZ], // deep box floor buccal corner
      [x, +boxFloorHalfWidthMm, gingivalFloorZ], // deep box floor lingual corner
      shoulderL(x),
      ML(x),
    ];
  };

  // Full ordered mesiodistal station list (mesial box, isthmus, distal box).
  const mesialXs = linspace(-halfLen, -isthmusHalfLenMm, mdSegmentsPerZone);
  const isthmusXs = linspace(-isthmusHalfLenMm, +isthmusHalfLenMm, mdSegmentsPerZone);
  const distalXs = linspace(+isthmusHalfLenMm, +halfLen, mdSegmentsPerZone);
  const fullXs = [...mesialXs, ...isthmusXs.slice(1), ...distalXs.slice(1)];

  // 1) OUTER SHELL — continuous prism swept over the full station list.
  for (let s = 0; s < fullXs.length - 1; s++) {
    const a = outerChain(fullXs[s]!);
    const b = outerChain(fullXs[s + 1]!);
    for (let i = 0; i < a.length - 1; i++) quad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
  }

  // 2) CAVITY SURFACE — swept per zone at that zone's depth.
  const sweepCavity = (xs: number[], deep: boolean): void => {
    for (let s = 0; s < xs.length - 1; s++) {
      const a = cavityChain(xs[s]!, deep);
      const b = cavityChain(xs[s + 1]!, deep);
      for (let i = 0; i < a.length - 1; i++) quad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
    }
  };
  sweepCavity(mesialXs, true);
  sweepCavity(isthmusXs, false);
  sweepCavity(distalXs, true);

  // 3) PULPAL WALLS — the box↔isthmus floor step at x = ±isthmusHalfLenMm.
  // A single transverse trapezoid per transition: the box's deep floor edge
  // (fb_box → fl_box at `gingivalFloorZ`) up to the shoulder line
  // (shoulderB → shoulderL at `floorZ`). Its four edges are each shared with a
  // box-zone wall/floor quad or the isthmus-zone floor quad (the shoulders are
  // shared vertices), so no zero-area flap is needed.
  const pulpalWall = (x: number): void => {
    quad(
      shoulderB(x),
      [x, -boxFloorHalfWidthMm, gingivalFloorZ],
      [x, +boxFloorHalfWidthMm, gingivalFloorZ],
      shoulderL(x),
    );
  };
  pulpalWall(-isthmusHalfLenMm);
  pulpalWall(+isthmusHalfLenMm);

  // 4) PROXIMAL FRAMES — caps at x = ±halfLen (box depth), break-through notch.
  const frame = (x: number): void => {
    const oc = outerChain(x); // MB → ... → ML (6 pts)
    const cc = cavityChain(x, true); // MB → ... → ML
    // Closed material polygon: outer chain, then cavity interior reversed
    // (drop the shared ML at cc end and MB at cc start).
    const poly: Vec3[] = [...oc, ...cc.slice(1, cc.length - 1).reverse()];
    const uv = poly.map((p) => [p[1], p[2]] as [number, number]); // project to (Y,Z) at const x
    for (const [ia, ib, ic] of earClip(uv)) tri(poly[ia]!, poly[ib]!, poly[ic]!);
  };
  frame(-halfLen);
  frame(+halfLen);

  // --- assemble + deterministically orient outward ---
  const flatPositions = new Float64Array(positions);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  const oriented = orientNormalsConsistently({ positions: flatPositions, indices }).mesh;

  // --- the exact outline ring (every point a vertex of the mesh) ---
  const cavityOutline: Vec3[] = [];
  // buccal occlusal margin, mesial → distal
  for (const x of fullXs) cavityOutline.push(MB(x));
  // distal proximal U (down buccal wall, across floor, up lingual wall) — box depth
  {
    const cc = cavityChain(+halfLen, true); // MB → ... → ML
    for (let i = 1; i < cc.length; i++) cavityOutline.push(cc[i]!); // skip MB (already added), include through ML
  }
  // lingual occlusal margin, distal → mesial (skip the distal ML just added)
  for (let i = fullXs.length - 2; i >= 0; i--) cavityOutline.push(ML(fullXs[i]!));
  // mesial proximal U (up-around back toward MB) — reverse of the cavity chain,
  // excluding the shared ML(-halfLen) and the closing MB(-halfLen).
  {
    const cc = cavityChain(-halfLen, true);
    for (let i = cc.length - 2; i >= 1; i--) cavityOutline.push(cc[i]!);
  }

  return {
    mesh: oriented,
    cavityOutline,
    lengthMm,
    widthMm,
    tableZ,
    floorZ,
    gingivalFloorZ,
    isthmusHalfWidthMm,
    isthmusFloorHalfWidthMm,
    boxFloorHalfWidthMm,
    taperRad,
    isthmusHalfLenMm,
    boxLengthMm,
    cuspZBuccal,
    cuspZLingual,
  };
}
