// packages/kernel/src/anatomy/morph.test.ts
//
// Phase 4 Task 6 — the anatomy morph (anatomy/morph.ts). A fully SYNTHETIC,
// closed-form scenario: a tessellated-cylinder "tooth" between two proximal
// neighbour boxes + an antagonist box, whose target contacts are known exactly.
// Proves: proximal penetration reaches the target (residual REPORTED), the
// antagonist reaches 0 (residual REPORTED), the cervical/margin seal is
// preserved (deviation REPORTED + asserted), 0-strength ≡ identity (bit-
// identical), determinism (byte-identical mesh hash), and the plan/solve
// (slider) split.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  planAnatomyMorph,
  solveAnatomyMorph,
  morphAnatomy,
  DEFAULT_MORPH_OPTIONS,
  MorphContactMeshError,
  type AnatomyMorphInput,
  type MorphOptions,
  type IndexedMesh,
  type Vec3,
} from '../index.ts';

// --- outward-wound axis-aligned box (CCW from outside) ---
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // 0..3 bottom
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // 4..7 top
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

// --- tessellated cylinder "tooth": axis +z, cervical at z=0, occlusal at z=H ---
function cylinderTooth(radius: number, height: number, rings: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = (height * r) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.cos(th), radius * Math.sin(th), z);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function marginCircle(radius: number, z: number, n = 48): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([radius * Math.cos(th), radius * Math.sin(th), z]);
  }
  return loop;
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

const R = 1.2;
const H = 5;
const PEN = 0.02; // proximalContactPenetrationMm (profile)
const OCC = 0; // occlusalContactMm (profile)

// Localize the deformation tightly for this small synthetic tooth so plenty of
// 3-D far-field anchors remain (unisolvent). These are ALGORITHM options.
const TEST_OPTIONS: Partial<MorphOptions> = {
  contactInfluenceRadiusMm: 0.8,
  contactFacingRadiusMm: 1.0,
  cervicalSealBandMm: 0.6,
};

function baseInput(overrides?: Partial<AnatomyMorphInput>): AnatomyMorphInput {
  return {
    placedMesh: cylinderTooth(R, H, 11, 24),
    marginLoop: marginCircle(R, 0),
    contacts: [
      // distal neighbour at +x (gap 0.1), mesial at -x (gap 0.1). Tall in z (no
      // z-edge near the contact) so the facing-region heatmap sign is clean.
      { kind: 'proximalDistal', mesh: outwardBox([R + 0.1, -2, 2.3], [3, 2, 4.7]), targetPenetrationMm: PEN },
      { kind: 'proximalMesial', mesh: outwardBox([-3, -2, 2.3], [-(R + 0.1), 2, 4.7]), targetPenetrationMm: PEN },
      // antagonist above (gap 0.1), wider than the tooth dome (clean -z face).
      { kind: 'antagonist', mesh: outwardBox([-2, -2, H + 0.1], [2, 2, H + 2]), targetPenetrationMm: OCC },
    ],
    options: TEST_OPTIONS,
    ...overrides,
  };
}

describe('morphAnatomy — analytic contacts', () => {
  it('reaches proximal penetration = 0.02 and antagonist = 0 (residuals REPORTED)', () => {
    const result = morphAnatomy(baseInput());
    const byKind = Object.fromEntries(result.contacts.map((c) => [c.kind, c]));
    for (const c of result.contacts) {
      console.log(
        `[MORPH synthetic] ${c.kind}: target -${c.targetPenetrationMm}mm | achieved signedDist=${(c.achievedSignedDistanceMm * 1000).toFixed(4)}µm ` +
          `residual=${(c.contactResidualMm * 1000).toFixed(4)}µm | regionMin=${(c.regionMinSignedDistanceMm * 1000).toFixed(2)}µm`,
      );
    }
    console.log(`[MORPH synthetic] maxContactResidual=${(result.maxContactResidualMm! * 1000).toFixed(4)}µm controlPoints=${result.controlPointCount}`);

    // Proximal contacts penetrate the neighbour by ~0.02 mm.
    expect(byKind['proximalDistal']!.achievedSignedDistanceMm).toBeCloseTo(-PEN, 5);
    expect(byKind['proximalMesial']!.achievedSignedDistanceMm).toBeCloseTo(-PEN, 5);
    // Antagonist just touches (~0).
    expect(byKind['antagonist']!.achievedSignedDistanceMm).toBeCloseTo(-OCC, 5);
    // Residuals are sub-micron (direct solve + flat-face root-find).
    expect(result.maxContactResidualMm!).toBeLessThan(1e-4); // < 0.1 µm
    // Facing-region penetration stays close to the target (no wild overshoot);
    // a clean contact heatmap over a proper neighbour surface.
    for (const c of result.contacts) {
      expect(c.regionMinSignedDistanceMm).toBeGreaterThan(-0.15);
    }
  });

  it('preserves the marginal seal (cervical deviation REPORTED + bounded)', () => {
    const result = morphAnatomy(baseInput());
    console.log(`[MORPH synthetic] marginSealMaxDeviation=${(result.marginSealMaxDeviationMm * 1000).toFixed(4)}µm (band pinned)`);
    // The cervical band is pinned (zero-displacement anchors) so it stays put,
    // well under the 10 µm marginal-seal budget.
    expect(result.marginSealMaxDeviationMm).toBeLessThan(0.010);
  });
});

describe('morphAnatomy — 0-strength ≡ identity', () => {
  it('is bit-identical to the placed mesh when every contact strength is 0', () => {
    const input = baseInput();
    const placed = input.placedMesh;
    const result = morphAnatomy(input, { proximalMesial: 0, proximalDistal: 0, antagonist: 0 });
    expect(Buffer.from(result.mesh.positions.buffer)).toEqual(Buffer.from(placed.positions.buffer));
    // Every contact reports its (unchanged) clearance ~0.1 mm outside.
    for (const c of result.contacts) expect(c.achievedSignedDistanceMm).toBeGreaterThan(0);
  });
});

describe('morphAnatomy — determinism (Task-6 crux)', () => {
  it('byte-identical morphed-mesh hash across two independent runs', () => {
    const h1 = hashMesh(morphAnatomy(baseInput()).mesh);
    const h2 = hashMesh(morphAnatomy(baseInput()).mesh);
    expect(h2).toBe(h1);
  });
});

describe('morphAnatomy — plan/solve slider split', () => {
  it('a re-solve at the same strength reproduces the full-strength morph exactly', () => {
    const input = baseInput();
    const plan = planAnatomyMorph(input);
    const full = solveAnatomyMorph(plan, { proximalDistal: 1, proximalMesial: 1, antagonist: 1 });
    const viaConvenience = morphAnatomy(input);
    expect(Buffer.from(full.mesh.positions.buffer)).toEqual(Buffer.from(viaConvenience.mesh.positions.buffer));
  });

  it('lowering a slider reduces that contact\'s penetration monotonically', () => {
    const plan = planAnatomyMorph(baseInput());
    const s10 = solveAnatomyMorph(plan, { proximalDistal: 1 });
    const s05 = solveAnatomyMorph(plan, { proximalDistal: 0.5 });
    const s00 = solveAnatomyMorph(plan, { proximalDistal: 0 });
    const dist = (r: typeof s10): number => r.contacts.find((c) => c.kind === 'proximalDistal')!.achievedSignedDistanceMm;
    // strength 1 penetrates (negative), 0.5 less, 0 clears (positive).
    expect(dist(s10)).toBeLessThan(dist(s05));
    expect(dist(s05)).toBeLessThan(dist(s00));
    expect(dist(s00)).toBeGreaterThan(0);
  });

  it('re-solving is deterministic (byte-identical) for the same plan + strengths', () => {
    const plan = planAnatomyMorph(baseInput());
    const a = solveAnatomyMorph(plan, { proximalDistal: 0.7 });
    const b = solveAnatomyMorph(plan, { proximalDistal: 0.7 });
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
  });
});

describe('morphAnatomy — immutability + guards', () => {
  it('never mutates the placed mesh', () => {
    const input = baseInput();
    const before = Float64Array.from(input.placedMesh.positions);
    morphAnatomy(input);
    expect(input.placedMesh.positions).toEqual(before);
  });

  it('throws MorphContactMeshError for a contact mesh with no triangles', () => {
    const input = baseInput({
      contacts: [{ kind: 'antagonist', mesh: { positions: new Float64Array([0, 0, 9]), indices: new Uint32Array(0) }, targetPenetrationMm: 0 }],
    });
    expect(() => morphAnatomy(input)).toThrow(MorphContactMeshError);
  });

  it('exposes the documented algorithm defaults', () => {
    expect(DEFAULT_MORPH_OPTIONS.contactRefinementIterations).toBe(4);
    expect(DEFAULT_MORPH_OPTIONS.cervicalSealBandMm).toBeGreaterThan(0);
  });
});

describe('morphAnatomy — strength clamping', () => {
  it('clamps strength > 1 to 1 and < 0 (and NaN) to 1/0 respectively', () => {
    const plan = planAnatomyMorph(baseInput());
    const at = (s: number): number =>
      solveAnatomyMorph(plan, { proximalDistal: s }).contacts.find((c) => c.kind === 'proximalDistal')!.achievedSignedDistanceMm;
    // >1 clamps to 1 (identical to full strength); <0 clamps to 0 (identity).
    expect(at(5)).toBeCloseTo(at(1), 9);
    expect(at(-3)).toBeCloseTo(at(0), 9);
    // NaN falls back to full strength (1).
    expect(at(Number.NaN)).toBeCloseTo(at(1), 9);
  });
});

describe('morphAnatomy — cervical anchor fallback (coarse placement off the finish line)', () => {
  it('pins the nearest cervical ring when the seal BAND is empty (minCervicalAnchors)', () => {
    // A tiny seal band leaves no vertex within it; the fallback pins the
    // closest-to-the-loop vertices so the cervical collar is still anchored.
    const plan = planAnatomyMorph(baseInput({ options: { ...TEST_OPTIONS, cervicalSealBandMm: 1e-6 } }));
    expect(plan.cervicalAnchorCount).toBeGreaterThan(0);
    const result = solveAnatomyMorph(plan);
    expect(result.marginSealMaxDeviationMm).toBeLessThan(0.010);
  });
});

describe('morphAnatomy — contact vertex exactly on the neighbour surface', () => {
  it('handles a coincident closest point (approach-direction fallback to the outward normal)', () => {
    // Neighbour box whose -x face sits exactly at the tooth radius (x = R): the
    // contact vertex is ON the surface (closest distance 0) — exercises the
    // approach-direction fallback in the root-find.
    const input = baseInput({
      contacts: [{ kind: 'proximalDistal', mesh: (() => {
        const b = outwardBox([R, -2, 2.3], [3, 2, 4.7]);
        return b;
      })(), targetPenetrationMm: 0.02 }],
    });
    const result = morphAnatomy(input);
    // It penetrates toward the target (negative), bounded — the fallback kept a
    // valid inward direction.
    const c = result.contacts.find((x) => x.kind === 'proximalDistal')!;
    expect(c.achievedSignedDistanceMm).toBeLessThanOrEqual(0);
  });
});
