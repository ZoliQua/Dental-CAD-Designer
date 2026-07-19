// packages/kernel/src/offset/marchingCubes.test.ts
//
// Analytic-first tests for the marching-cubes extraction stage (this
// project's "tests first, analytic first" rule): the scalar fields below
// are closed-form sphere SDFs written directly into grids (no mesh, no BVH
// — the extraction is tested in isolation from the sampling stage), so
// every expected value is analytic. Covers: transcription-pinning table
// invariants (mcTables.ts), watertight/manifold/winding output, the
// per-vertex chord `@errorBound`, nonzero iso values, the +Infinity
// sentinel policy (including the deliberately-tight-band guardrail test),
// determinism hashes, and slab/whole-grid equivalence.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/analyze.ts';
import { weldVertices } from '../intake/weld.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { EDGE_TABLE, TRI_TABLE } from './mcTables.ts';
import { marchingCubes, marchingCubesSlab, muClampEpsilon, type ScalarGrid } from './marchingCubes.ts';

/** Analytic sphere SDF `f(p) = |p - center| - radius` sampled on a regular
 * grid — Float64 (ScalarGrid accepts it; no Float32 round-trip so the
 * chord-bound assertions are exact). `bandMm`, when given, replaces every
 * sample with `|f| > bandMm` by the +Infinity sentinel, mimicking
 * sdf/grid.ts's banded output (but by true distance, not triangle bboxes —
 * strictly tighter, which is what the tight-band test needs). */
function sphereGrid(
  radius: number,
  pitchMm: number,
  halfExtent: number,
  bandMm?: number,
  center: readonly [number, number, number] = [0, 0, 0],
): ScalarGrid {
  const n = Math.ceil((2 * halfExtent) / pitchMm) + 1;
  const origin = [-halfExtent + center[0], -halfExtent + center[1], -halfExtent + center[2]] as const;
  const grid = new Float64Array(n * n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = origin[0] + ix * pitchMm - center[0];
        const y = origin[1] + iy * pitchMm - center[1];
        const z = origin[2] + iz * pitchMm - center[2];
        const f = Math.hypot(x, y, z) - radius;
        grid[iz * n * n + iy * n + ix] = bandMm !== undefined && Math.abs(f) > bandMm ? Number.POSITIVE_INFINITY : f;
      }
    }
  }
  return { grid, dims: [n, n, n], origin, pitchMm };
}

function weldSoup(soup: { positions: Float64Array; triangleCount: number }): IndexedMesh {
  return weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });
}

function hashSoup(soup: { positions: Float64Array }): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(soup.positions.buffer, soup.positions.byteOffset, soup.positions.byteLength));
  return hash.digest('hex');
}

describe('mcTables — transcription-pinning invariants (see mcTables.ts module doc)', () => {
  it('has 256 edge-table entries and 256 * 16 tri-table entries', () => {
    expect(EDGE_TABLE.length).toBe(256);
    expect(TRI_TABLE.length).toBe(256 * 16);
  });

  it('EDGE_TABLE is complement-symmetric: EDGE_TABLE[i] === EDGE_TABLE[255 - i]', () => {
    for (let i = 0; i < 256; i++) {
      expect(EDGE_TABLE[i]).toBe(EDGE_TABLE[255 - i]);
    }
  });

  it('every TRI_TABLE row references exactly the edges EDGE_TABLE marks crossed, in -1-terminated triples', () => {
    for (let config = 0; config < 256; config++) {
      const used = new Set<number>();
      let count = 0;
      let terminated = false;
      for (let k = 0; k < 16; k++) {
        const v = TRI_TABLE[config * 16 + k]!;
        if (v === -1) {
          terminated = true;
          continue;
        }
        expect(terminated).toBe(false); // -1 only ever terminates, never interleaves
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(11);
        used.add(v);
        count++;
      }
      expect(count % 3).toBe(0);
      const expected = new Set<number>();
      for (let bit = 0; bit < 12; bit++) {
        if ((EDGE_TABLE[config]! & (1 << bit)) !== 0) expected.add(bit);
      }
      expect([...used].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
    }
  });
});

describe('marchingCubes — analytic sphere field', () => {
  const radius = 1;
  const pitch = 0.1;
  const scalarGrid = sphereGrid(radius, pitch, 1.5);

  it('extracts a watertight, manifold, single-component surface with outward (CCW-from-outside) winding', () => {
    const soup = marchingCubes(scalarGrid, 0);
    expect(soup.triangleCount).toBeGreaterThan(0);
    const stats = analyzeMesh(weldSoup(soup));
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    // Positive signed volume == outward winding (the module doc's "Winding"
    // section), and it must approximate the analytic ball volume.
    const analytic = (4 / 3) * Math.PI * radius ** 3;
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
    expect(Math.abs(stats.signedVolumeMm3! - analytic) / analytic).toBeLessThan(0.02);
  });

  it('places every vertex within the chord @errorBound of the analytic surface: |f(v) - iso| <= pitch/2 + clamp term', () => {
    const soup = marchingCubes(scalarGrid, 0);
    const bound = pitch / 2 + muClampEpsilon(pitch) * pitch;
    let maxErr = 0;
    for (let i = 0; i < soup.positions.length; i += 3) {
      const f = Math.hypot(soup.positions[i]!, soup.positions[i + 1]!, soup.positions[i + 2]!) - radius;
      maxErr = Math.max(maxErr, Math.abs(f));
    }
    expect(maxErr).toBeLessThanOrEqual(bound);
  });

  it('a nonzero iso value extracts the offset level set (radius + iso), both signs', () => {
    for (const iso of [0.25, -0.25]) {
      const soup = marchingCubes(scalarGrid, iso);
      expect(soup.triangleCount).toBeGreaterThan(0);
      const bound = pitch / 2 + muClampEpsilon(pitch) * pitch;
      for (let i = 0; i < soup.positions.length; i += 3) {
        const r = Math.hypot(soup.positions[i]!, soup.positions[i + 1]!, soup.positions[i + 2]!);
        expect(Math.abs(r - (radius + iso))).toBeLessThanOrEqual(bound);
      }
      const stats = analyzeMesh(weldSoup(soup));
      expect(stats.watertight).toBe(true);
    }
  });

  it('returns an empty soup when the iso value is outside the field range (no crossing anywhere)', () => {
    // Field range on this grid is [-radius, ~sqrt(3)*1.5 - 1]; iso = -2 is
    // below every sample.
    const soup = marchingCubes(scalarGrid, -2);
    expect(soup.triangleCount).toBe(0);
    expect(soup.positions.length).toBe(0);
  });

  it('throws for a non-finite iso value', () => {
    expect(() => marchingCubes(scalarGrid, Number.NaN)).toThrow(TypeError);
    expect(() => marchingCubes(scalarGrid, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('marchingCubes — +Infinity sentinel policy (banded grids)', () => {
  const radius = 1;
  const pitch = 0.1;
  const iso = 0.2;

  it('an ADEQUATE band (>= |iso| + sqrt(3)*pitch) is bit-identical to the dense grid extraction', () => {
    const dense = marchingCubes(sphereGrid(radius, pitch, 1.6), iso);
    const adequateBand = Math.abs(iso) + Math.sqrt(3) * pitch + 1e-9;
    const banded = marchingCubes(sphereGrid(radius, pitch, 1.6, adequateBand), iso);
    expect(banded.triangleCount).toBe(dense.triangleCount);
    expect(hashSoup(banded)).toBe(hashSoup(dense));
    // ... and the result is a real closed surface (nothing clipped).
    const stats = analyzeMesh(weldSoup(banded));
    expect(stats.watertight).toBe(true);
  });

  it('GUARDRAIL — a deliberately TIGHT band never generates a vertex from a sentinel-valued cell (every output coordinate is finite)', () => {
    // Band narrower than |iso| + sqrt(3)*pitch: cells straddling the iso
    // surface can now touch sentinel corners. The documented policy is to
    // SKIP such cells wholesale — the output may be clipped/open (asserted
    // below as a real consequence, proving the band actually was too
    // tight), but no vertex may ever be interpolated from a sentinel value.
    const tightBand = Math.abs(iso) + 0.2 * pitch;
    const soup = marchingCubes(sphereGrid(radius, pitch, 1.6, tightBand), iso);
    expect(soup.triangleCount).toBeGreaterThan(0);
    for (let i = 0; i < soup.positions.length; i++) {
      expect(Number.isFinite(soup.positions[i]!)).toBe(true);
    }
    const stats = analyzeMesh(weldSoup(soup));
    expect(stats.watertight).toBe(false); // holes where cells were skipped — the documented tight-band failure mode
  });
});

describe('marchingCubes — determinism and slab equivalence', () => {
  const scalarGrid = sphereGrid(0.8, 0.12, 1.2);

  it('double run produces byte-identical soup (determinism hash)', () => {
    const first = marchingCubes(scalarGrid, 0.1);
    const second = marchingCubes(scalarGrid, 0.1);
    expect(hashSoup(second)).toBe(hashSoup(first));
  });

  it('concatenating marchingCubesSlab over every z-slab reproduces marchingCubes byte-identically', () => {
    const whole = marchingCubes(scalarGrid, 0.1);
    const parts: Float64Array[] = [];
    let total = 0;
    for (let z = 0; z <= scalarGrid.dims[2] - 2; z++) {
      const slab = marchingCubesSlab(scalarGrid, 0.1, z);
      parts.push(slab.positions);
      total += slab.positions.length;
    }
    const concatenated = new Float64Array(total);
    let offset = 0;
    for (const part of parts) {
      concatenated.set(part, offset);
      offset += part.length;
    }
    expect(concatenated.length).toBe(whole.positions.length);
    expect(hashSoup({ positions: concatenated })).toBe(hashSoup(whole));
  });

  it('marchingCubesSlab rejects an out-of-range z', () => {
    expect(() => marchingCubesSlab(scalarGrid, 0, -1)).toThrow(RangeError);
    expect(() => marchingCubesSlab(scalarGrid, 0, scalarGrid.dims[2] - 1)).toThrow(RangeError);
  });
});
