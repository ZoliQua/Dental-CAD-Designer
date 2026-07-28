// packages/kernel/src/bridge/frameworkCutback.test-fixtures.ts
//
// Phase 6 Task 5 — the closed-form "shell unit" fixture for the framework
// CUTBACK op. A crown/abutment unit is a thin closed SOLID: an OUTER anatomic
// surface (buccal/occlusal) and an INNER intaglio (fit) surface, meeting at the
// MARGIN rim. `closedShellUnit` builds exactly that as a watertight closed
// 2-manifold with an analytically-known partition, so the cutback's three hard
// invariants are each measurable in closed form:
//   • the intaglio (fit) vertices are byte-preserved (a known vertex set),
//   • the margin rim is byte-preserved (the outer ring at z=0, the taper's
//     zero locus),
//   • the outer anatomy is offset inward by exactly the veneering space on the
//     flat top cap (planar ⇒ exact) and by `d·cos(π/n)` on the faceted wall
//     (the documented facet term).
//
// ## The geometry — a capped hollow cylinder ("thimble"), open at the bottom
//
//   axis = +z. Solid material fills the region between an OUTER surface and an
//   inner CAVITY:
//     • outer wall   — cylinder radius R, z ∈ [0, H]      (+radial normal)
//     • outer dome   — spherical cap, sphere centre (0,0,H) radius R, apex at
//                       (0,0,H+R)                          (radial-from-centre
//                       normal; a DOME not a flat cap so the wall/dome junction
//                       normal is purely radial and the outer surface shrinks
//                       cleanly under an inward cutback — the realistic
//                       occlusal-surface case, no sharp-edge fold artifact)
//     • margin rim   — annulus r ≤ ρ ≤ R at z = 0         (−z normal; the
//                       finish line is its OUTER edge, ρ = R)
//     • cavity wall  — cylinder radius r, z ∈ [0, h]      (−radial normal:
//                       faces INTO the cavity = out of the solid)
//     • cavity ceil  — disk radius r at z = h             (−z normal)
//   with r < R and h < H. Closed, genus-0, watertight (every boundary edge is
//   shared by exactly two of the five surfaces). Orientation is fixed to
//   consistently-outward by `orientNormalsConsistently` (the connector-loft
//   assembly precedent), so the cutback op's area-weighted vertex normals point
//   out of the solid and an inward cutback is `−normal`.
//
// ## The partition (what the op must respect)
//
//   FIT (preserved byte-exact): every cavity-wall + cavity-ceiling vertex
//   (`fitVertexMask[i] === true`) — including the inner margin ring (ρ = r,
//   z = 0). OUTER (cut back): every outer-wall + outer-top-cap vertex. The
//   MARGIN taper loop is the outer ring at (R, z = 0); an outer-wall vertex at
//   (R, θ, z) is exactly `z` from it (its own angle's loop vertex is the closest
//   point), so the taper weight is `smoothstep(z / band)` on the wall — 0 at the
//   rim (seal preserved), 1 beyond the band (full veneering space).
//
// Deterministic, Float64, parameterized. Analytic bookkeeping (ring→vertex
// index maps, the outer/inner triangle ranges for submesh extraction) is
// returned so the tests assert the closed-form facts directly, never a
// regenerated blob (the P6 T1 fixture discipline).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';

export interface ClosedShellUnitOptions {
  /** Outer radius R (mm). Default 3.0. */
  readonly outerRadiusMm?: number;
  /** Inner (cavity) radius r (mm), r < R. Default 1.0 (⇒ 2.0 mm axial wall). */
  readonly innerRadiusMm?: number;
  /** Outer height H (mm). Default 4.0. */
  readonly outerHeightMm?: number;
  /** Cavity ceiling height h (mm), h < H. Default 2.0 (⇒ 2.0 mm occlusal wall). */
  readonly innerHeightMm?: number;
  /** Segments per ring n. Default 48. */
  readonly segments?: number;
  /** Outer-wall z-rings (≥ 2 so interior full-weight rings exist). Default 8. */
  readonly outerWallRings?: number;
  /** Cavity-wall z-rings. Default 6. */
  readonly innerWallRings?: number;
  /** Outer-top DOME latitude rings (≥ 2). Default 6. The outer top is a spherical
   * dome (sphere centre (0,0,H), radius R) rather than a flat cap: a flat cap's
   * sharp 90° rim would give its rim vertices a 45° normal that tucks the cap
   * under itself even at a clinical cutback. A dome's wall/cap junction normal is
   * purely radial (both sides radial), so the dome SHRINKS cleanly (like a sphere
   * offset inward) — the realistic occlusal-surface case. */
  readonly domeRings?: number;
}

export interface ClosedShellUnit {
  /** The watertight closed unit solid (consistently outward-oriented). */
  readonly mesh: IndexedMesh;
  /** Per-vertex fit mask (true = intaglio, preserved byte-exact). */
  readonly fitVertexMask: boolean[];
  /** The prep-margin taper loop — the outer ring at (R, z = 0). */
  readonly marginLoop: Vec3[];
  /** `outerWallRingIndices[ri][s]` → vertex index (ri = 0..outerWallRings). */
  readonly outerWallRingIndices: number[][];
  /** The outer DOME APEX vertex index (at (0,0,H+R)) — the sphere pole. */
  readonly outerTopCenterIndex: number;
  /** `innerWallRingIndices[ri][s]` → vertex index (ri = 0..innerWallRings). */
  readonly innerWallRingIndices: number[][];
  /** The cavity-ceiling centre vertex index (at (0,0,h)). */
  readonly innerTopCenterIndex: number;
  /** Half-open triangle range [start,end) of the OUTER surface (wall + cap). */
  readonly outerTriRange: readonly [number, number];
  /** Half-open triangle range [start,end) of the INNER (fit) surface. */
  readonly innerTriRange: readonly [number, number];
  readonly params: Required<ClosedShellUnitOptions>;
}

/** Builds the closed-form shell unit — see this file's doc. */
export function closedShellUnit(options: ClosedShellUnitOptions = {}): ClosedShellUnit {
  const R = options.outerRadiusMm ?? 3.0;
  const r = options.innerRadiusMm ?? 1.0;
  const H = options.outerHeightMm ?? 4.0;
  const h = options.innerHeightMm ?? 2.0;
  const n = options.segments ?? 48;
  const kW = options.outerWallRings ?? 8;
  const kI = options.innerWallRings ?? 6;
  const kD = options.domeRings ?? 6;
  if (!(R > r && r > 0)) throw new Error('closedShellUnit: require R > r > 0');
  if (!(H > h && h > 0)) throw new Error('closedShellUnit: require H > h > 0');
  if (!(n >= 3 && kW >= 2 && kI >= 1 && kD >= 2)) throw new Error('closedShellUnit: require n>=3, kW>=2, kI>=1, kD>=2');

  const positions: number[] = [];
  const fit: boolean[] = [];
  const pushVertex = (x: number, y: number, z: number, isFit: boolean): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    fit.push(isFit);
    return idx;
  };
  const angle = (s: number): number => (2 * Math.PI * s) / n;

  // Outer wall rings (fit = false).
  const outerWallRingIndices: number[][] = [];
  for (let ri = 0; ri <= kW; ri++) {
    const z = (ri / kW) * H;
    const ring: number[] = [];
    for (let s = 0; s < n; s++) ring.push(pushVertex(R * Math.cos(angle(s)), R * Math.sin(angle(s)), z, false));
    outerWallRingIndices.push(ring);
  }
  // Outer DOME (fit = false): sphere centre (0,0,H), radius R. Intermediate
  // latitude rings j = 1..kD-1 (φ from just below π/2 up toward 0) + the apex.
  // The base latitude φ = π/2 IS the wall-top ring (radius R, z = H) — reused.
  const domeRingIndices: number[][] = [];
  for (let j = 1; j < kD; j++) {
    const phi = (Math.PI / 2) * ((kD - j) / kD); // j=1 → near base; j=kD-1 → near apex
    const ringRadius = R * Math.sin(phi);
    const ringZ = H + R * Math.cos(phi);
    const ring: number[] = [];
    for (let s = 0; s < n; s++) ring.push(pushVertex(ringRadius * Math.cos(angle(s)), ringRadius * Math.sin(angle(s)), ringZ, false));
    domeRingIndices.push(ring);
  }
  const outerTopCenterIndex = pushVertex(0, 0, H + R, false); // dome apex (sphere pole)

  // Cavity wall rings (fit = true) + ceiling centre (fit = true).
  const innerWallRingIndices: number[][] = [];
  for (let ri = 0; ri <= kI; ri++) {
    const z = (ri / kI) * h;
    const ring: number[] = [];
    for (let s = 0; s < n; s++) ring.push(pushVertex(r * Math.cos(angle(s)), r * Math.sin(angle(s)), z, true));
    innerWallRingIndices.push(ring);
  }
  const innerTopCenterIndex = pushVertex(0, 0, h, true);

  // Faces. Winding is arbitrary here; orientNormalsConsistently fixes all to
  // outward at the end (the closed-solid assembly precedent).
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    tris.push(a, b, c, a, c, d);
  };

  // --- OUTER surface: wall quads + dome bands + apex fan ---
  const outerTriStart = tris.length / 3;
  for (let ri = 0; ri < kW; ri++) {
    for (let s = 0; s < n; s++) {
      const s1 = (s + 1) % n;
      quad(outerWallRingIndices[ri]![s]!, outerWallRingIndices[ri]![s1]!, outerWallRingIndices[ri + 1]![s1]!, outerWallRingIndices[ri + 1]![s]!);
    }
  }
  // Dome: wall-top ring → dome ring 1 → ... → dome ring kD-1 → apex.
  const domeRingsAll = [outerWallRingIndices[kW]!, ...domeRingIndices];
  for (let d = 0; d < domeRingsAll.length - 1; d++) {
    for (let s = 0; s < n; s++) {
      const s1 = (s + 1) % n;
      quad(domeRingsAll[d]![s]!, domeRingsAll[d]![s1]!, domeRingsAll[d + 1]![s1]!, domeRingsAll[d + 1]![s]!);
    }
  }
  const apexRing = domeRingsAll[domeRingsAll.length - 1]!;
  for (let s = 0; s < n; s++) tris.push(outerTopCenterIndex, apexRing[s]!, apexRing[(s + 1) % n]!);
  const outerTriEnd = tris.length / 3;

  // --- MARGIN rim annulus at z=0 (outer ring 0 ↔ inner ring 0) ---
  const outerRing0 = outerWallRingIndices[0]!;
  const innerRing0 = innerWallRingIndices[0]!;
  for (let s = 0; s < n; s++) {
    const s1 = (s + 1) % n;
    quad(outerRing0[s]!, innerRing0[s]!, innerRing0[s1]!, outerRing0[s1]!);
  }

  // --- INNER (fit) surface: cavity wall quads + ceiling fan ---
  const innerTriStart = tris.length / 3;
  for (let ri = 0; ri < kI; ri++) {
    for (let s = 0; s < n; s++) {
      const s1 = (s + 1) % n;
      quad(innerWallRingIndices[ri]![s]!, innerWallRingIndices[ri]![s1]!, innerWallRingIndices[ri + 1]![s1]!, innerWallRingIndices[ri + 1]![s]!);
    }
  }
  const ceilRing = innerWallRingIndices[kI]!;
  for (let s = 0; s < n; s++) tris.push(innerTopCenterIndex, ceilRing[s]!, ceilRing[(s + 1) % n]!);
  const innerTriEnd = tris.length / 3;

  const raw: IndexedMesh = { positions: new Float64Array(positions), indices: new Uint32Array(tris) };
  // Orient consistently outward — this may PERMUTE triangle winding but NEVER
  // reorders triangles, so the outer/inner tri ranges stay valid.
  const oriented = orientNormalsConsistently(raw).mesh;

  const marginLoop: Vec3[] = outerRing0.map((vi) => [positions[vi * 3]!, positions[vi * 3 + 1]!, positions[vi * 3 + 2]!]);

  return {
    mesh: oriented,
    fitVertexMask: fit,
    marginLoop,
    outerWallRingIndices,
    outerTopCenterIndex,
    innerWallRingIndices,
    innerTopCenterIndex,
    outerTriRange: [outerTriStart, outerTriEnd],
    innerTriRange: [innerTriStart, innerTriEnd],
    params: { outerRadiusMm: R, innerRadiusMm: r, outerHeightMm: H, innerHeightMm: h, segments: n, outerWallRings: kW, innerWallRings: kI, domeRings: kD },
  };
}

/** Compacts the triangles [triStart, triEnd) of `mesh` into a standalone mesh
 * (only the referenced vertices, re-indexed) — used to feed the fit vs. outer
 * surfaces to `measureWallThickness` for the framework thickness gate. */
export function submeshFromTriRange(mesh: IndexedMesh, triStart: number, triEnd: number): IndexedMesh {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = triStart; t < triEnd; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = mesh.indices[t * 3 + c]!;
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
