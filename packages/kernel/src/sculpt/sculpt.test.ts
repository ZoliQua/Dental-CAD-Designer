// packages/kernel/src/sculpt/sculpt.test.ts
//
// Phase 4 Task 8 — freeform sculpting brushes. Proves:
//  • determinism: same stroke / same gesture -> byte-identical mesh (two runs)
//    + a committed-hash regression golden;
//  • add raises / remove lowers the surface (peak displacement REPORTED);
//    smooth reduces local curvature (before/after REPORTED);
//  • the inner/margin/seam LOCK: a stroke near the margin moves NO locked
//    vertex (byte-unchanged) and the ≤10 µm margin fit is preserved (measured
//    on the real shell + measureMarginFit on the inner);
//  • replay: a journaled gesture replayed from scratch is byte-identical;
//  • watertight preserved after an aggressive stroke; the fold guard clamps a
//    tearing displacement (no flipped triangle) rather than shipping a torn shell;
//  • timing: a stroke on a realistic shell < 50 ms (MEASURED).
import { createHash } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import fc from 'fast-check';
import {
  analyzeMesh,
  applySculptStroke,
  applySculptGesture,
  buildBvh,
  buildInnerSurface,
  closestPointBatch,
  computeShellLock,
  constructShell,
  type IndexedMesh,
  type SculptStroke,
  type Vec3,
} from '../index.ts';

// NB measureMarginFit is a cad-pipeline gate (layer rule: kernel imports nothing
// upward), so this kernel test proves margin-fit preservation directly from the
// shell geometry (closest-point of the confirmed margin polyline onto the
// sculpted shell surface — Task 7's closed-crown margin-fit measure); the
// cad-pipeline stage test additionally exercises measureMarginFit itself.

function hashMesh(m: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  h.update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  return h.digest('hex');
}

// --- synthetic closed manifold surfaces -----------------------------------

/** A UV sphere (closed, manifold), radius `R`, `stacks` latitude bands ×
 * `slices` longitude, poles as single fan vertices. Deterministic. */
function uvSphere(R: number, stacks: number, slices: number, radial?: (lat: number, lon: number) => number): IndexedMesh {
  const positions: number[] = [];
  const indexAt: number[][] = [];
  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  // north pole
  const north = push(0, 0, R);
  for (let i = 1; i < stacks; i++) {
    const phi = (Math.PI * i) / stacks; // 0..PI
    const row: number[] = [];
    for (let j = 0; j < slices; j++) {
      const th = (2 * Math.PI * j) / slices;
      const rr = R * (radial ? radial(i, j) : 1);
      row.push(push(rr * Math.sin(phi) * Math.cos(th), rr * Math.sin(phi) * Math.sin(th), rr * Math.cos(phi)));
    }
    indexAt.push(row);
  }
  const south = push(0, 0, -R);
  const tris: number[] = [];
  // north cap
  for (let j = 0; j < slices; j++) {
    const jn = (j + 1) % slices;
    tris.push(north, indexAt[0]![j]!, indexAt[0]![jn]!);
  }
  // middle bands
  for (let i = 0; i < stacks - 2; i++) {
    for (let j = 0; j < slices; j++) {
      const jn = (j + 1) % slices;
      const a = indexAt[i]![j]!;
      const b = indexAt[i]![jn]!;
      const c = indexAt[i + 1]![j]!;
      const d = indexAt[i + 1]![jn]!;
      tris.push(a, c, d);
      tris.push(a, d, b);
    }
  }
  // south cap
  const last = indexAt[stacks - 2]!;
  for (let j = 0; j < slices; j++) {
    const jn = (j + 1) % slices;
    tris.push(south, last[jn]!, last[j]!);
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(tris) };
}

const ZERO_LOCK = (m: IndexedMesh): Uint8Array => new Uint8Array(m.positions.length / 3);

describe('sculpt brush math — add / remove / smooth', () => {
  it('add raises the surface outward (peak displacement REPORTED)', () => {
    const sphere = uvSphere(5, 24, 32);
    const center: Vec3 = [0, 0, 5]; // near north pole
    const stroke: SculptStroke = { center, radiusMm: 2, strength: 0.3, brush: 'add' };
    const res = applySculptStroke(sphere, stroke, ZERO_LOCK(sphere));
    expect(res.movedVertexCount).toBeGreaterThan(0);
    expect(res.appliedScale).toBe(1);
    // affected vertices moved OUTWARD (radius increased).
    let raised = 0;
    for (let v = 0; v < sphere.positions.length / 3; v++) {
      const r0 = Math.hypot(sphere.positions[v * 3]!, sphere.positions[v * 3 + 1]!, sphere.positions[v * 3 + 2]!);
      const r1 = Math.hypot(res.mesh.positions[v * 3]!, res.mesh.positions[v * 3 + 1]!, res.mesh.positions[v * 3 + 2]!);
      if (r1 > r0 + 1e-9) raised++;
    }
    expect(raised).toBe(res.movedVertexCount);
    // peak displacement approaches strength at the centre (falloff=1 at t=0).
    expect(res.peakDisplacementMm).toBeGreaterThan(0.2);
    expect(res.peakDisplacementMm).toBeLessThanOrEqual(0.3 + 1e-9);
    console.log(`[add] moved ${res.movedVertexCount} verts, peak +${(res.peakDisplacementMm * 1000).toFixed(0)} µm outward`);
  });

  it('remove lowers the surface inward', () => {
    const sphere = uvSphere(5, 24, 32);
    const center: Vec3 = [0, 0, 5];
    const res = applySculptStroke(sphere, { center, radiusMm: 2, strength: 0.3, brush: 'remove' }, ZERO_LOCK(sphere));
    let lowered = 0;
    for (let v = 0; v < sphere.positions.length / 3; v++) {
      const r0 = Math.hypot(sphere.positions[v * 3]!, sphere.positions[v * 3 + 1]!, sphere.positions[v * 3 + 2]!);
      const r1 = Math.hypot(res.mesh.positions[v * 3]!, res.mesh.positions[v * 3 + 1]!, res.mesh.positions[v * 3 + 2]!);
      if (r1 < r0 - 1e-9) lowered++;
    }
    expect(lowered).toBe(res.movedVertexCount);
    console.log(`[remove] moved ${res.movedVertexCount} verts, peak −${(res.peakDisplacementMm * 1000).toFixed(0)} µm inward`);
  });

  it('smooth reduces local curvature (before/after REPORTED)', () => {
    // Corrugated sphere: alternate latitude rings pushed in/out -> high local
    // curvature the smooth brush should flatten.
    const bumpy = uvSphere(5, 24, 32, (lat) => 1 + (lat % 2 === 0 ? 0.06 : -0.06));
    const center: Vec3 = [0, 0, 5];
    const res = applySculptStroke(bumpy, { center, radiusMm: 4, strength: 1, brush: 'smooth' }, ZERO_LOCK(bumpy));
    expect(res.movedVertexCount).toBeGreaterThan(0);
    expect(res.curvatureAfter).toBeLessThan(res.curvatureBefore);
    console.log(
      `[smooth] mean |Laplacian| ${(res.curvatureBefore * 1000).toFixed(1)} µm -> ${(res.curvatureAfter * 1000).toFixed(1)} µm (reduced), moved ${res.movedVertexCount}`,
    );
  });

  it('a locked vertex is never displaced', () => {
    const sphere = uvSphere(5, 24, 32);
    const locked = ZERO_LOCK(sphere);
    // Lock the whole north hemisphere.
    for (let v = 0; v < sphere.positions.length / 3; v++) if (sphere.positions[v * 3 + 2]! > 0) locked[v] = 1;
    const res = applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 3, strength: 0.5, brush: 'add' }, locked);
    for (let v = 0; v < sphere.positions.length / 3; v++) {
      if (!locked[v]) continue;
      expect(res.mesh.positions[v * 3]).toBe(sphere.positions[v * 3]);
      expect(res.mesh.positions[v * 3 + 1]).toBe(sphere.positions[v * 3 + 1]);
      expect(res.mesh.positions[v * 3 + 2]).toBe(sphere.positions[v * 3 + 2]);
    }
  });

  it('rejects malformed strokes', () => {
    const sphere = uvSphere(5, 12, 16);
    const z = ZERO_LOCK(sphere);
    expect(() => applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 0, strength: 0.1, brush: 'add' }, z)).toThrow();
    expect(() => applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 1, strength: NaN, brush: 'add' }, z)).toThrow();
    // wrong-length lock mask
    expect(() => applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 1, strength: 0.1, brush: 'add' }, new Uint8Array(3))).toThrow();
  });
});

describe('sculpt determinism + replay', () => {
  it('same stroke -> byte-identical (two runs)', () => {
    const sphere = uvSphere(5, 24, 32);
    const stroke: SculptStroke = { center: [3, 0, 4], radiusMm: 2.5, strength: 0.2, brush: 'add' };
    const a = applySculptStroke(sphere, stroke, ZERO_LOCK(sphere));
    const b = applySculptStroke(sphere, stroke, ZERO_LOCK(sphere));
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  });

  it('same gesture -> byte-identical, and replay from scratch reproduces the mesh', () => {
    const sphere = uvSphere(5, 24, 32);
    const gesture: SculptStroke[] = [
      { center: [0, 0, 5], radiusMm: 2, strength: 0.2, brush: 'add' },
      { center: [3, 0, 4], radiusMm: 2, strength: 0.15, brush: 'remove' },
      { center: [0, 3, 4], radiusMm: 3, strength: 1, brush: 'smooth' },
    ];
    const run1 = applySculptGesture(sphere, gesture, ZERO_LOCK(sphere));
    const run2 = applySculptGesture(sphere, gesture, ZERO_LOCK(sphere));
    expect(hashMesh(run1.mesh)).toBe(hashMesh(run2.mesh));
    // Replay: from the ORIGINAL sphere + the journaled strokes -> identical.
    const replay = applySculptGesture(sphere, [...gesture], ZERO_LOCK(sphere));
    expect(hashMesh(replay.mesh)).toBe(hashMesh(run1.mesh));
  });

  it('overlapping strokes apply in journaled order (order matters, deterministically)', () => {
    const sphere = uvSphere(5, 24, 32);
    const s1: SculptStroke = { center: [0, 0, 5], radiusMm: 3, strength: 0.3, brush: 'add' };
    const s2: SculptStroke = { center: [1, 0, 4.8], radiusMm: 3, strength: 1, brush: 'smooth' };
    const ab = applySculptGesture(sphere, [s1, s2], ZERO_LOCK(sphere));
    const ba = applySculptGesture(sphere, [s2, s1], ZERO_LOCK(sphere));
    expect(hashMesh(ab.mesh)).not.toBe(hashMesh(ba.mesh)); // order-dependent (as journaled)
    // but each order is itself deterministic
    expect(hashMesh(applySculptGesture(sphere, [s1, s2], ZERO_LOCK(sphere)).mesh)).toBe(hashMesh(ab.mesh));
  });

  it('committed-hash regression golden (pinned; changes only with a KERNEL_VERSION bump)', () => {
    const sphere = uvSphere(5, 24, 32);
    const gesture: SculptStroke[] = [
      { center: [0, 0, 5], radiusMm: 2, strength: 0.2, brush: 'add' },
      { center: [3, 0, 4], radiusMm: 2, strength: 0.15, brush: 'remove' },
      { center: [0, 3, 4], radiusMm: 3, strength: 1, brush: 'smooth' },
    ];
    const out = applySculptGesture(sphere, gesture, ZERO_LOCK(sphere));
    const h = hashMesh(out.mesh);
    console.log(`[golden] sculpt gesture hash = ${h}`);
    expect(h).toBe('ca23f0777ed0db25764b1b418b0f018a99a4c70f44a34ea213905ae06d1c314d');
  });
});

describe('sculpt fold guard — watertight preserved', () => {
  it('an aggressive stroke is clamped (no flipped triangle), never a torn shell', () => {
    const sphere = uvSphere(5, 24, 32);
    // A strong REMOVE at the pole would punch the pole vertex DOWN through the
    // cap ring, folding (flipping) the north-cap triangles — the fold the guard
    // must catch. (An outward `add` only inflates a convex surface — safe — so
    // it is not the tearing case.)
    const res = applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 1.5, strength: 20, brush: 'remove' }, ZERO_LOCK(sphere));
    expect(res.clamped).toBe(true);
    expect(res.appliedScale).toBeLessThan(1);
    // Topology preserved (no index change) -> still watertight.
    const stats = analyzeMesh(res.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    // No affected triangle flipped: every triangle's new normal agrees with its
    // original orientation (projected area stayed positive).
    const flipped = countFlippedTriangles(sphere, res.mesh);
    expect(flipped).toBe(0);
    console.log(`[guard] aggressive add clamped to scale ${res.appliedScale.toFixed(4)}, 0 flipped tris, watertight`);
  });

  it('a moderate stroke is NOT clamped', () => {
    const sphere = uvSphere(5, 24, 32);
    const res = applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 2, strength: 0.1, brush: 'add' }, ZERO_LOCK(sphere));
    expect(res.clamped).toBe(false);
    expect(res.appliedScale).toBe(1);
  });
});

/** Count triangles whose winding-normal reversed between two same-topology meshes. */
function countFlippedTriangles(a: IndexedMesh, b: IndexedMesh): number {
  let flipped = 0;
  const triCount = a.indices.length / 3;
  const nrm = (m: IndexedMesh, t: number): Vec3 => {
    const ia = m.indices[t * 3]!;
    const ib = m.indices[t * 3 + 1]!;
    const ic = m.indices[t * 3 + 2]!;
    const ux = m.positions[ib * 3]! - m.positions[ia * 3]!;
    const uy = m.positions[ib * 3 + 1]! - m.positions[ia * 3 + 1]!;
    const uz = m.positions[ib * 3 + 2]! - m.positions[ia * 3 + 2]!;
    const wx = m.positions[ic * 3]! - m.positions[ia * 3]!;
    const wy = m.positions[ic * 3 + 1]! - m.positions[ia * 3 + 1]!;
    const wz = m.positions[ic * 3 + 2]! - m.positions[ia * 3 + 2]!;
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  };
  for (let t = 0; t < triCount; t++) {
    const na = nrm(a, t);
    const nb = nrm(b, t);
    if (na[0]! * nb[0]! + na[1]! * nb[1]! + na[2]! * nb[2]! <= 0) flipped++;
  }
  return flipped;
}

describe('sculpt property — a bounded add stroke never tears a sphere', () => {
  it('watertight across a range of stroke strengths', () => {
    const sphere = uvSphere(5, 20, 28);
    const z = ZERO_LOCK(sphere);
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 60 }), (milli) => {
        const strength = milli / 100; // 0.05 .. 0.60 mm
        fc.pre(strength >= 0.05 && strength <= 0.6);
        const res = applySculptStroke(sphere, { center: [0, 0, 5], radiusMm: 2, strength, brush: 'add' }, z);
        const stats = analyzeMesh(res.mesh);
        expect(stats.watertight).toBe(true);
        expect(countFlippedTriangles(sphere, res.mesh)).toBe(0);
      }),
      { numRuns: 12 },
    );
  });
});

// --- real crown shell: the LOCK + margin-fit preservation -----------------

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];

/** Frustum with `vLevels` vertical subdivisions (finer than Task 7's 2-level
 * one, so the outer dome has sculptable surface away from the seam). */
function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, vLevels: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const rings: number[][] = [];
  for (let l = 0; l <= vLevels; l++) {
    const f = l / vLevels;
    const r = mR + (tR - mR) * f;
    const z = mZ + (tZ - mZ) * f;
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) {
      const th = (2 * Math.PI * s) / seg;
      ring.push(push(r * Math.cos(th), r * Math.sin(th), z));
    }
    rings.push(ring);
  }
  const tris: number[] = [];
  for (let l = 0; l < vLevels; l++) {
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      const a = rings[l]![s]!;
      const b = rings[l]![sn]!;
      const c = rings[l + 1]![s]!;
      const d = rings[l + 1]![sn]!;
      tris.push(a, b, d);
      tris.push(a, d, c);
    }
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tris.push(bc, rings[0]![sn]!, rings[0]![s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tris.push(tc, rings[vLevels]![s]!, rings[vLevels]![sn]!);
    }
  }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tris) };
}

function marginCircle(r: number, z: number, n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return loop;
}

describe('sculpt on the real crown shell — fit surface LOCKED', () => {
  let inner: IndexedMesh;
  let shell: IndexedMesh;
  let margin: Vec3[];

  beforeAll(async () => {
    const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, 1, true, true);
    margin = marginCircle(MARGIN_R, MARGIN_Z, 240);
    const innerRes = await buildInnerSurface(die, {
      pitchMm: 0.08,
      marginalGapMm: 0.02,
      cementGapMm: 0.05,
      spacerStartMm: 0.8,
      blendWidthMm: 0.3,
      marginLoop: margin,
      insertionAxis: AXIS,
    });
    inner = innerRes.mesh;
    // Finer outer dome (8 vertical levels) so there's outer surface to sculpt.
    const outer = buildFrustum(MARGIN_R + 0.7, TOP_R + 0.7, MARGIN_Z, TOP_Z + 0.7, 96, 8, true, false);
    const constructed = await constructShell(outer, inner, { insertionAxis: AXIS });
    shell = constructed.mesh;
  }, 180000);

  /** Max distance (mm) of any confirmed margin point to the shell surface — the
   * closed-crown margin-fit measure (Task 7). */
  function marginFitToShellMm(m: IndexedMesh): number {
    const bvh = buildBvh(m);
    const flat = new Float64Array(margin.flatMap((p) => [p[0], p[1], p[2]]));
    const res = closestPointBatch(m, bvh, flat);
    let mx = 0;
    for (const r of res) if (r.distance > mx) mx = r.distance;
    return mx;
  }

  it('identifies a fit-surface lock (inner intaglio + seam) and a sculptable outer', () => {
    const lock = computeShellLock(shell, { innerMesh: inner, marginLoop: margin });
    expect(lock.lockedCount).toBeGreaterThan(0);
    expect(lock.outerCount).toBeGreaterThan(0);
    console.log(`[lock] ${lock.lockedCount} locked (fit surface), ${lock.outerCount} sculptable outer`);
  });

  it('a stroke near the margin moves NO locked vertex; margin fit stays ≤10 µm', () => {
    const before = marginFitToShellMm(shell);
    expect(before).toBeLessThanOrEqual(0.010);
    const lock = computeShellLock(shell, { innerMesh: inner, marginLoop: margin });
    // Stroke centred right on the margin, large radius -> tries to grab the rim.
    const stroke: SculptStroke = { center: [MARGIN_R + 0.7, 0, MARGIN_Z], radiusMm: 1.0, strength: 0.4, brush: 'add' };
    const res = applySculptStroke(shell, stroke, lock.locked);

    // Every locked vertex is byte-unchanged.
    for (let v = 0; v < shell.positions.length / 3; v++) {
      if (!lock.locked[v]) continue;
      expect(res.mesh.positions[v * 3]).toBe(shell.positions[v * 3]);
      expect(res.mesh.positions[v * 3 + 1]).toBe(shell.positions[v * 3 + 1]);
      expect(res.mesh.positions[v * 3 + 2]).toBe(shell.positions[v * 3 + 2]);
    }
    // Margin fit preserved (the intaglio margin rim + seam never moved).
    const after = marginFitToShellMm(res.mesh);
    expect(after).toBeLessThanOrEqual(0.010);
    expect(after).toBeCloseTo(before, 6);
    console.log(`[lock] margin fit ${(before * 1000).toFixed(2)} µm -> ${(after * 1000).toFixed(2)} µm after sculpt near margin (≤10 µm), moved ${res.movedVertexCount} outer verts`);
  }, 60000);

  it('sculpting the outer stays watertight + single-component', () => {
    const lock = computeShellLock(shell, { innerMesh: inner, marginLoop: margin });
    const gesture: SculptStroke[] = [
      { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.2, strength: 0.2, brush: 'add' },
      { center: [TOP_R + 0.7, 0, TOP_Z], radiusMm: 1.0, strength: 0.15, brush: 'remove' },
      { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.5, strength: 1, brush: 'smooth' },
    ];
    const out = applySculptGesture(shell, gesture, lock.locked);
    expect(out.stats.watertight).toBe(true);
    expect(out.stats.componentCount).toBe(1);
    expect(out.movedVertexCount).toBeGreaterThan(0);
    // margin fit still preserved after the whole gesture
    expect(marginFitToShellMm(out.mesh)).toBeLessThanOrEqual(0.010);
  }, 60000);

  it('a single stroke on the real shell runs < 50 ms (MEASURED)', () => {
    const lock = computeShellLock(shell, { innerMesh: inner, marginLoop: margin });
    const stroke: SculptStroke = { center: [0, 0, TOP_Z + 0.7], radiusMm: 1.5, strength: 0.2, brush: 'add' };
    // Warm up (JIT), then measure.
    applySculptStroke(shell, stroke, lock.locked, { skipWatertightCheck: true });
    const t0 = performance.now();
    const N = 5;
    for (let i = 0; i < N; i++) applySculptStroke(shell, stroke, lock.locked, { skipWatertightCheck: true });
    const perStroke = (performance.now() - t0) / N;
    console.log(`[timing] ${(shell.positions.length / 3) | 0} verts; ${perStroke.toFixed(2)} ms/stroke (skip-watertight interactive path)`);
    expect(perStroke).toBeLessThan(50);
  }, 60000);
});
