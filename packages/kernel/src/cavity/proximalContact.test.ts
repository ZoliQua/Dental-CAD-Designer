// packages/kernel/src/cavity/proximalContact.test.ts
//
// Phase 5 Task 5 — Class II proximal box contact adaptation (cavity/
// proximalContact.ts) on the MOD fixture + CLOSED-FORM synthetic neighbours
// (the P4 T6 synthetic-neighbour pattern: axis-aligned outward-wound boxes at
// a known gap g from the fixture's planar proximal faces, so the expected
// travel g + δ and the achieved penetration −δ are closed-form).
//
// Proves the task's THREE HARD INVARIANTS plus determinism:
//  1. OUTLINE PINNED — every cavity-outline vertex byte-identical after
//     adaptation; indices byte-identical; every non-movable position
//     byte-identical (the T6 stitch survives).
//  2. SEAM G1 SURVIVES — seam dihedral re-measured AFTER adaptation (the T4
//     instrument), before/after both < 5°, REPORTED.
//  3. GENUINE MEASUREMENT — the reported achieved contact equals an
//     INDEPENDENT closest-point measurement against the neighbour mesh
//     computed by this test (never a prescription re-read), and the
//     falsifiable clamp case (neighbour too far → travel clamped) reports an
//     honestly-LARGE residual + a clamp warning, never a silent "achieved".
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import { buildOcclusalPatch, type ProximalFaceBoundary } from './occlusalPatch.ts';
import { measureSeamDihedral } from './seamDihedral.ts';
import {
  adaptProximalContacts,
  DEFAULT_PROXIMAL_MAX_TRAVEL_MM,
  DEFAULT_SEAM_ANCHOR_BAND_MM,
  PROXIMAL_CONTACT_REFINEMENT_ITERATIONS,
  ProximalColumnNotOnPatchError,
  ProximalColumnOverlapError,
  ProximalNeighborMeshError,
  ProximalBandTooWideError,
  type ProximalAdaptationInput,
} from './proximalContact.ts';
import { NonWatertightMeshError } from '../sdf/pseudonormals.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const AXIS: Vec3 = [0, 0, 1];
const PEN = 0.02; // proximalContactPenetrationMm (profile value; tests pass it explicitly)

// --- outward-wound axis-aligned box (CCW from outside) — the P4 T6 pattern ---
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const idx = [
    0, 3, 2, 0, 2, 1, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 7, 6, 3, 6, 2, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

/** Synthetic neighbours at closed-form gap g from the fixture's proximal
 * planes x = ±halfLen: tall/wide watertight boxes whose facing planes are at
 * x = −(halfLen+g) (mesial side, −x) and x = +(halfLen+g) (distal side, +x) —
 * every proximal-face point projects onto the facing plane, so the true
 * distance IS g exactly (and the sign convention is trustworthy: closed,
 * outward-wound neighbours — the P4 sign caveat does not apply). */
function neighborAtGap(halfLen: number, gapMm: number, side: 'minusX' | 'plusX'): IndexedMesh {
  const face = halfLen + gapMm;
  return side === 'minusX' ? outwardBox([-face - 2, -5, -1], [-face, 5, 10]) : outwardBox([face, -5, -1], [face + 2, 5, 10]);
}

function sha256(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(new Float64Array(mesh.positions).buffer));
  h.update(Buffer.from(new Uint32Array(mesh.indices).buffer));
  return h.digest('hex');
}

function coordKey(p: readonly number[]): string {
  return `${p[0]}|${p[1]}|${p[2]}`;
}

/** The proximal face on the −x / +x side, found GEOMETRICALLY (the patch's
 * internal 'mesial'/'distal' labels are patch-local, not asserted here). */
function faceOnSide(faces: readonly ProximalFaceBoundary[], sign: -1 | 1): ProximalFaceBoundary {
  const f = faces.find((face) => Math.sign(face.columnPoints[0]![0]) === sign);
  if (!f) throw new Error(`no proximal face on side ${sign}`);
  return f;
}

/** Independent genuine measurement: min signed distance from the ADAPTED
 * proximal-face vertex positions to the neighbour mesh (sign from the closest
 * triangle's outward face normal — the P1 convention; trustworthy here on the
 * closed outward-wound synthetic neighbours). */
function independentMinSignedDistance(adapted: IndexedMesh, face: ProximalFaceBoundary, neighbor: IndexedMesh): number {
  const vmap = new Map<string, number>();
  const vCount = adapted.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const k = `${adapted.positions[v * 3]}|${adapted.positions[v * 3 + 1]}|${adapted.positions[v * 3 + 2]}`;
    if (!vmap.has(k)) vmap.set(k, v);
  }
  const bvh = buildBvh(neighbor);
  let min = Infinity;
  const measure = (p: Vec3): void => {
    const cp = closestPoint(neighbor, bvh, p);
    const t = cp.triangleIndex;
    const i0 = neighbor.indices[t * 3]!;
    const i1 = neighbor.indices[t * 3 + 1]!;
    const i2 = neighbor.indices[t * 3 + 2]!;
    const q = neighbor.positions;
    const ax = q[i1 * 3]! - q[i0 * 3]!, ay = q[i1 * 3 + 1]! - q[i0 * 3 + 1]!, az = q[i1 * 3 + 2]! - q[i0 * 3 + 2]!;
    const bx = q[i2 * 3]! - q[i0 * 3]!, by = q[i2 * 3 + 1]! - q[i0 * 3 + 1]!, bz = q[i2 * 3 + 2]! - q[i0 * 3 + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const rel = [p[0] - cp.point[0], p[1] - cp.point[1], p[2] - cp.point[2]];
    const sd = (rel[0]! * nx + rel[1]! * ny + rel[2]! * nz) < 0 ? -cp.distance : cp.distance;
    if (sd < min) min = sd;
  };
  // measure at the ADAPTED positions of the column vertices + the free-run rim
  for (const p of face.columnPoints) {
    const vi = vmap.get(coordKey(p));
    if (vi !== undefined) {
      // pinned column vertex — adapted position == original
      measure([adapted.positions[vi * 3]!, adapted.positions[vi * 3 + 1]!, adapted.positions[vi * 3 + 2]!]);
    } else {
      // moved column vertex — its ORIGINAL coord is gone from the adapted
      // mesh; find its adapted position via the original patch is not needed
      // for a MIN over the face: the moved vertices are found below by
      // scanning all adapted vertices near the face plane. (Handled by caller
      // tests via the op's own per-vertex report; here we approximate the face
      // set as pinned rim + all adapted vertices within the column's bbox.)
      void vi;
    }
  }
  for (const p of face.freeRunPoints) measure(p as Vec3);
  // moved vertices: every adapted vertex within the column bbox inflated by
  // the max travel (catches the displaced rim wherever it went)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of face.columnPoints) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const m = DEFAULT_PROXIMAL_MAX_TRAVEL_MM + 1e-9;
  for (let v = 0; v < vCount; v++) {
    const x = adapted.positions[v * 3]!, y = adapted.positions[v * 3 + 1]!, z = adapted.positions[v * 3 + 2]!;
    if (x >= minX - m && x <= maxX + m && y >= minY - m && y <= maxY + m && z >= minZ - m && z <= maxZ + m) {
      measure([x, y, z]);
    }
  }
  return min;
}

// ---------------------------------------------------------------------------
// Shared fixture + patch (immutable inputs — safe to share across tests)
// ---------------------------------------------------------------------------
const fx = modCavityMesh();
const HALF_LEN = fx.lengthMm / 2;
const patch = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
const mesialFace = faceOnSide(patch.proximalFaces, -1);
const distalFace = faceOnSide(patch.proximalFaces, 1);

function adaptationsAtGap(gapMm: number, targetPenetrationMm = PEN): ProximalAdaptationInput[] {
  return [
    { label: 'mesial', columnPoints: mesialFace.columnPoints, freeRunPoints: mesialFace.freeRunPoints, neighborMesh: neighborAtGap(HALF_LEN, gapMm, 'minusX'), targetPenetrationMm },
    { label: 'distal', columnPoints: distalFace.columnPoints, freeRunPoints: distalFace.freeRunPoints, neighborMesh: neighborAtGap(HALF_LEN, gapMm, 'plusX'), targetPenetrationMm },
  ];
}

describe('buildOcclusalPatch — proximalFaces (Task 5 currency)', () => {
  it('exposes two proximal faces whose column endpoints + free run lie bit-exactly on the outline', () => {
    expect(patch.proximalFaces).toHaveLength(2);
    const outlineSet = new Set(fx.cavityOutline.map((p) => coordKey(p)));
    for (const face of patch.proximalFaces) {
      const col = face.columnPoints;
      expect(col.length).toBe(patch.crossSegments + 1);
      // endpoints are outline vertices (pinned by construction)
      expect(outlineSet.has(coordKey(col[0]!))).toBe(true);
      expect(outlineSet.has(coordKey(col[col.length - 1]!))).toBe(true);
      // the free run is entirely on the outline
      for (const p of face.freeRunPoints) expect(outlineSet.has(coordKey(p))).toBe(true);
      // free run shares the column's endpoints (the zip contract)
      expect(coordKey(face.freeRunPoints[0]!)).toBe(coordKey(col[0]!));
      expect(coordKey(face.freeRunPoints[face.freeRunPoints.length - 1]!)).toBe(coordKey(col[col.length - 1]!));
    }
    // one face per proximal side
    expect(Math.sign(mesialFace.columnPoints[0]![0])).toBe(-1);
    expect(Math.sign(distalFace.columnPoints[0]![0])).toBe(1);
  });
});

describe('adaptProximalContacts — closed-form contact (synthetic neighbours at gap g)', () => {
  it('reaches target penetration on BOTH boxes within documented residual (mean+max REPORTED per box)', () => {
    const gaps = [0.05, 0.1, 0.2, 0.4];
    const residuals: Record<string, number[]> = { mesial: [], distal: [] };
    for (const g of gaps) {
      const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(g));
      expect(res.boxes).toHaveLength(2);
      expect(res.clampedBoxes).toHaveLength(0);
      for (const box of res.boxes) {
        // closed-form: travel = g + δ (planar neighbour, Newton exact)
        expect(Math.abs(box.travelMm - (g + PEN))).toBeLessThan(1e-9);
        expect(Math.abs(box.initialSignedDistanceMm - g)).toBeLessThan(1e-9);
        // achieved (GENUINE, closest-point vs neighbour) = −δ
        expect(Math.abs(box.achievedSignedDistanceMm - -PEN)).toBeLessThan(1e-9);
        expect(box.contactResidualMm).toBeLessThan(1e-9);
        expect(box.faceResidualMm).toBeLessThan(1e-9);
        expect(box.clampBound).toBe(false);
        expect(box.movedVertexCount).toBeGreaterThan(0);
        residuals[box.label]!.push(box.contactResidualMm);
      }
      // @errorBound carried: max residual over boxes
      expect(res.errorBoundMm).not.toBeNull();
      expect(res.errorBoundMm!).toBeLessThan(1e-9);
    }
    for (const label of ['mesial', 'distal']) {
      const rs = residuals[label]!;
      const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
      const max = Math.max(...rs);
      console.log(`[PROXIMAL CONTACT ${label}] residual over gaps ${JSON.stringify(gaps)}: mean=${(mean * 1e6).toFixed(4)}nm max=${(max * 1e6).toFixed(4)}nm (target ${PEN}mm penetration)`);
    }
  });

  it('the reported achieved contact MATCHES an independent closest-point measurement (genuine, not a prescription re-read)', () => {
    const g = 0.1;
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(g));
    const mesial = res.boxes.find((b) => b.label === 'mesial')!;
    const independent = independentMinSignedDistance(res.mesh, mesialFace, neighborAtGap(HALF_LEN, g, 'minusX'));
    expect(Math.abs(mesial.faceMinSignedDistanceMm - independent)).toBeLessThan(1e-12);
  });

  it('target 0 (touch) and a PRE-PENETRATING neighbour (negative travel) both converge on the driven vertex', () => {
    // touch: δ = 0 → travel = g, achieved 0
    const touch = adaptProximalContacts(patch.mesh, adaptationsAtGap(0.1, 0));
    for (const box of touch.boxes) {
      expect(Math.abs(box.travelMm - 0.1)).toBeLessThan(1e-9);
      expect(Math.abs(box.achievedSignedDistanceMm)).toBeLessThan(1e-9);
    }
    // pre-penetrating: neighbour face 0.1mm INSIDE the proximal plane → the
    // driven vertex retracts (travel ≈ −0.08) to sit at −δ; the PINNED rim
    // still penetrates 0.1 — honestly reported via faceMinSignedDistance /
    // faceResidual (the pinned outline cannot retract; a downstream
    // interpenetration gate must catch it — see @errorBound).
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(-0.1));
    for (const box of res.boxes) {
      expect(Math.abs(box.travelMm - -0.08)).toBeLessThan(1e-9);
      expect(Math.abs(box.achievedSignedDistanceMm - -PEN)).toBeLessThan(1e-9);
      expect(box.contactResidualMm).toBeLessThan(1e-9);
      expect(box.faceMinSignedDistanceMm).toBeLessThanOrEqual(-0.1 + 1e-9);
      expect(box.faceResidualMm).toBeGreaterThan(0.07);
    }
    expect(res.errorBoundMm!).toBeGreaterThan(0.07); // conservative bound carries the rim penetration
  });
});

describe('adaptProximalContacts — HARD INVARIANT 1: outline PINNED byte-exact', () => {
  it('every outline vertex, every non-movable position and the index buffer are byte-identical after adaptation', () => {
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(0.1));
    // indices byte-identical
    expect(Buffer.from(res.mesh.indices.buffer, res.mesh.indices.byteOffset, res.mesh.indices.byteLength).equals(
      Buffer.from(patch.mesh.indices.buffer, patch.mesh.indices.byteOffset, patch.mesh.indices.byteLength),
    )).toBe(true);
    // outline ring byte-identical: every outline coordinate is STILL a vertex
    // coordinate of the adapted mesh (bit-exact)
    const adaptedCoords = new Set<string>();
    for (let v = 0; v < res.mesh.positions.length / 3; v++) {
      adaptedCoords.add(`${res.mesh.positions[v * 3]}|${res.mesh.positions[v * 3 + 1]}|${res.mesh.positions[v * 3 + 2]}`);
    }
    for (const p of fx.cavityOutline) expect(adaptedCoords.has(coordKey(p)), `outline vertex ${coordKey(p)} drifted`).toBe(true);
    // vertex-level: positions identical EXCEPT exactly the moved vertices
    const moved = res.boxes.reduce((n, b) => n + b.movedVertexCount, 0);
    let changed = 0;
    for (let v = 0; v < patch.mesh.positions.length / 3; v++) {
      const same =
        Object.is(res.mesh.positions[v * 3], patch.mesh.positions[v * 3]) &&
        Object.is(res.mesh.positions[v * 3 + 1], patch.mesh.positions[v * 3 + 1]) &&
        Object.is(res.mesh.positions[v * 3 + 2], patch.mesh.positions[v * 3 + 2]);
      if (!same) changed++;
    }
    expect(changed).toBe(moved);
    expect(changed).toBeGreaterThan(0);
    // the input patch was NOT mutated (immutable meshes)
    expect(sha256(patch.mesh)).toBe(sha256(buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS).mesh));
  });
});

describe('adaptProximalContacts — HARD INVARIANT 2: seam G1 survives (re-measured AFTER)', () => {
  it('seam dihedral before/after both < 5° — REPORTED (band-pinned seam support ⇒ after == before)', () => {
    const before = measureSeamDihedral(patch.mesh, fx.mesh, patch.seamEdges, {
      excludeToothTriangles: new Set(patch.cavityTriangleIndices),
    });
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(0.4));
    const after = measureSeamDihedral(res.mesh, fx.mesh, patch.seamEdges, {
      excludeToothTriangles: new Set(patch.cavityTriangleIndices),
    });
    console.log(
      `[PROXIMAL CONTACT seam] dihedral BEFORE max=${before.maxDeg.toFixed(4)}° mean=${before.meanDeg.toFixed(4)}° | ` +
        `AFTER max=${after.maxDeg.toFixed(4)}° mean=${after.meanDeg.toFixed(4)}° (n=${after.sampleCount})`,
    );
    expect(before.maxDeg).toBeLessThan(5);
    expect(after.maxDeg).toBeLessThan(5);
    // the seam anchor band pins the seam-boundary-triangle support entirely →
    // the measurement is EXACTLY unchanged (stronger than the < 5° gate)
    expect(after.maxDeg).toBe(before.maxDeg);
    expect(after.meanDeg).toBe(before.meanDeg);
  });

  it('the seam survives even a CLAMPED (max-travel) adaptation', () => {
    const before = measureSeamDihedral(patch.mesh, fx.mesh, patch.seamEdges, {
      excludeToothTriangles: new Set(patch.cavityTriangleIndices),
    });
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(5));
    const after = measureSeamDihedral(res.mesh, fx.mesh, patch.seamEdges, {
      excludeToothTriangles: new Set(patch.cavityTriangleIndices),
    });
    expect(res.clampedBoxes.length).toBe(2);
    expect(after.maxDeg).toBe(before.maxDeg);
  });
});

describe('adaptProximalContacts — HARD INVARIANT 3: falsifiable clamp (unreachable target)', () => {
  it('a neighbour too far for the travel bound → clamp warning + honestly-LARGE residual, never a silent "achieved"', () => {
    const g = 5; // needs travel 5.02 > DEFAULT_PROXIMAL_MAX_TRAVEL_MM
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(g));
    expect(res.clampedBoxes).toEqual(['mesial', 'distal']);
    for (const box of res.boxes) {
      expect(box.clampBound).toBe(true);
      expect(Math.abs(box.travelMm - DEFAULT_PROXIMAL_MAX_TRAVEL_MM)).toBeLessThan(1e-9);
      // the GENUINE measurement reports the remaining GAP (positive), not −δ:
      const expectedRemaining = g - DEFAULT_PROXIMAL_MAX_TRAVEL_MM;
      expect(Math.abs(box.achievedSignedDistanceMm - expectedRemaining)).toBeLessThan(1e-9);
      // residual is honestly LARGE (≈ 3.52mm), nowhere near "achieved"
      expect(box.contactResidualMm).toBeGreaterThan(3);
      console.log(
        `[PROXIMAL CONTACT clamp ${box.label}] target −${PEN}mm UNREACHABLE (gap ${g}mm, travel clamped at ` +
          `${box.travelMm.toFixed(3)}mm) → achieved ${box.achievedSignedDistanceMm.toFixed(4)}mm, residual ` +
          `${box.contactResidualMm.toFixed(4)}mm, clampBound=${box.clampBound}`,
      );
    }
    // the conservative error bound carries the honest residual
    expect(res.errorBoundMm!).toBeGreaterThan(3);
  });
});

describe('adaptProximalContacts — degenerate starts (both remaining root-find regimes)', () => {
  it('gap 0 (driven vertex exactly ON the neighbour surface): the inward-normal fallback still reaches −δ', () => {
    const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(0));
    for (const box of res.boxes) {
      expect(Math.abs(box.initialSignedDistanceMm)).toBeLessThan(1e-12);
      expect(Math.abs(box.travelMm - PEN)).toBeLessThan(1e-9);
      expect(Math.abs(box.achievedSignedDistanceMm - -PEN)).toBeLessThan(1e-9);
      expect(box.clampBound).toBe(false);
    }
  });

  it('a rim buried DEEP inside the neighbour clamps at −maxTravel (retraction bound) with an honest residual', () => {
    // Mesial neighbour swallowing the whole rim: box x ∈ [−7.4, −3] — the rim
    // (x=−5) sits 2mm inside its +x face. Retracting to −δ needs travel −1.98,
    // beyond the ±1.5 bound → clamped at −1.5, honestly-large measured residual.
    const deep = outwardBox([-7.4, -5, -1], [-3, 5, 10]);
    const inputs = adaptationsAtGap(0.1);
    const res = adaptProximalContacts(patch.mesh, [{ ...inputs[0]!, neighborMesh: deep }, inputs[1]!]);
    const mesial = res.boxes.find((b) => b.label === 'mesial')!;
    expect(Math.abs(mesial.initialSignedDistanceMm - -2)).toBeLessThan(1e-9);
    expect(mesial.clampBound).toBe(true);
    expect(Math.abs(mesial.travelMm - -DEFAULT_PROXIMAL_MAX_TRAVEL_MM)).toBeLessThan(1e-9);
    // achieved GENUINELY measured: still 0.5mm inside (not −δ) — residual ~0.48
    expect(Math.abs(mesial.achievedSignedDistanceMm - -0.5)).toBeLessThan(1e-9);
    expect(mesial.contactResidualMm).toBeGreaterThan(0.4);
    expect(res.clampedBoxes).toContain('mesial');
    // the distal box (normal gap) is unaffected
    const distal = res.boxes.find((b) => b.label === 'distal')!;
    expect(distal.clampBound).toBe(false);
    expect(distal.contactResidualMm).toBeLessThan(1e-9);
  });
});

describe('adaptProximalContacts — determinism', () => {
  it('double run byte-identical + committed sha256 pin', () => {
    const a = adaptProximalContacts(patch.mesh, adaptationsAtGap(0.1));
    const b = adaptProximalContacts(patch.mesh, adaptationsAtGap(0.1));
    const ha = sha256(a.mesh);
    expect(ha).toBe(sha256(b.mesh));
    console.log(`[PROXIMAL CONTACT GOLDEN] sha256 = ${ha}`);
    expect(ha).toBe('f80d5255ec926abeb9b174f37a952c8c464916c75b4a26368cf199f8155a25ac');
  });
});

describe('adaptProximalContacts — properties (fc.pre-guarded)', () => {
  it('for any reachable gap/target: residual small, outline pinned, no clamp', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.02, max: 1.2, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        (g, pen) => {
          fc.pre(g + pen < DEFAULT_PROXIMAL_MAX_TRAVEL_MM - 1e-6); // reachable
          const res = adaptProximalContacts(patch.mesh, adaptationsAtGap(g, pen));
          for (const box of res.boxes) {
            expect(box.clampBound).toBe(false);
            expect(box.contactResidualMm).toBeLessThan(1e-6);
          }
          // outline pinned
          const coords = new Set<string>();
          for (let v = 0; v < res.mesh.positions.length / 3; v++) {
            coords.add(`${res.mesh.positions[v * 3]}|${res.mesh.positions[v * 3 + 1]}|${res.mesh.positions[v * 3 + 2]}`);
          }
          for (const p of fx.cavityOutline) expect(coords.has(coordKey(p))).toBe(true);
        },
      ),
      { numRuns: 24 },
    );
  });
});

describe('adaptProximalContacts — typed errors + option validation', () => {
  const good = (): ProximalAdaptationInput[] => adaptationsAtGap(0.1);

  it('rejects a column point that is not a patch vertex', () => {
    const bad = good();
    const b0 = { ...bad[0]!, columnPoints: [[99, 99, 99], ...bad[0]!.columnPoints.slice(1)] as Vec3[] };
    expect(() => adaptProximalContacts(patch.mesh, [b0, bad[1]!])).toThrow(ProximalColumnNotOnPatchError);
  });

  it('rejects a free-run point that is not a patch vertex', () => {
    const bad = good();
    const b0 = { ...bad[0]!, freeRunPoints: [[99, 99, 99], ...bad[0]!.freeRunPoints.slice(1)] as Vec3[] };
    expect(() => adaptProximalContacts(patch.mesh, [b0, bad[1]!])).toThrow(ProximalColumnNotOnPatchError);
  });

  it('rejects a neighbour mesh without triangles', () => {
    const bad = good();
    const b0 = { ...bad[0]!, neighborMesh: { positions: new Float64Array(0), indices: new Uint32Array(0) } };
    expect(() => adaptProximalContacts(patch.mesh, [b0, bad[1]!])).toThrow(ProximalNeighborMeshError);
  });

  it('M1: REJECTS a non-watertight neighbour (no well-defined inside/outside for the sign)', () => {
    // An OPEN neighbour (single triangle, boundary edges) has no consistent
    // "inside" — deriving a penetration sign against it is meaningless. Pre-fix
    // it was measured anyway (indices.length !== 0 passed); post-fix the
    // pseudonormal precompute rejects it, so an over-penetrating design can no
    // longer slip through the interpenetration gate on a raw-scan neighbour.
    const bad = good();
    const openMesh: IndexedMesh = {
      positions: new Float64Array([-3, -1, 2, -3, 1, 2, -3, 0, 4]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    expect(() => adaptProximalContacts(patch.mesh, [{ ...bad[0]!, neighborMesh: openMesh }, bad[1]!])).toThrow(NonWatertightMeshError);
  });

  it('rejects two adaptations claiming the same column (overlapping movable sets)', () => {
    const bad = good();
    expect(() => adaptProximalContacts(patch.mesh, [bad[0]!, { ...bad[1]!, columnPoints: bad[0]!.columnPoints, freeRunPoints: bad[0]!.freeRunPoints }])).toThrow(
      ProximalColumnOverlapError,
    );
  });

  it('rejects a seam anchor band that leaves no movable rim', () => {
    expect(() => adaptProximalContacts(patch.mesh, good(), { seamAnchorBandMm: 50 })).toThrow(ProximalBandTooWideError);
  });

  it('rejects a band whose support window is positive but contains NO interior vertex (coarse column)', () => {
    // crossSegments 3 → 4-point column, interior vertices at ≈1/3 and 2/3 of
    // the arc; a band of 0.45·arc leaves a (0.45, 0.55)·arc window with no
    // vertex inside → the movable rim is empty even though support > 0.
    const coarse = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS, { crossSegments: 3 });
    const face = faceOnSide(coarse.proximalFaces, -1);
    let arc = 0;
    for (let i = 1; i < face.columnPoints.length; i++) {
      const a = face.columnPoints[i - 1]!;
      const b = face.columnPoints[i]!;
      arc += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const input: ProximalAdaptationInput = {
      label: 'mesial',
      columnPoints: face.columnPoints,
      freeRunPoints: face.freeRunPoints,
      neighborMesh: neighborAtGap(HALF_LEN, 0.1, 'minusX'),
      targetPenetrationMm: PEN,
    };
    expect(() => adaptProximalContacts(coarse.mesh, [input], { seamAnchorBandMm: 0.45 * arc })).toThrow(ProximalBandTooWideError);
  });

  it('rejects non-finite target / bad options / short column', () => {
    const bad = good();
    expect(() => adaptProximalContacts(patch.mesh, [{ ...bad[0]!, targetPenetrationMm: Number.NaN }, bad[1]!])).toThrow(TypeError);
    expect(() => adaptProximalContacts(patch.mesh, good(), { maxTravelMm: 0 })).toThrow(TypeError);
    expect(() => adaptProximalContacts(patch.mesh, good(), { seamAnchorBandMm: -1 })).toThrow(TypeError);
    expect(() => adaptProximalContacts(patch.mesh, [{ ...bad[0]!, columnPoints: bad[0]!.columnPoints.slice(0, 2) }, bad[1]!])).toThrow(TypeError);
  });

  it('echoes the documented algorithm parameters (journaling currency)', () => {
    const res = adaptProximalContacts(patch.mesh, good());
    expect(res.maxTravelMm).toBe(DEFAULT_PROXIMAL_MAX_TRAVEL_MM);
    expect(res.seamAnchorBandMm).toBe(DEFAULT_SEAM_ANCHOR_BAND_MM);
    expect(PROXIMAL_CONTACT_REFINEMENT_ITERATIONS).toBe(4);
  });
});
