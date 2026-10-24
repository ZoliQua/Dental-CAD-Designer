// Phase 9 Task 4 — the premolar placeholder generator (two cusps: buccal +
// lingual), built on the same posterior ring machinery as the molar.
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { assertOrthonormalFrame } from '../schema.ts';
import { generatePremolarAsset, PREMOLAR_FDI_CODES } from './premolar.ts';

describe('generatePremolarAsset', () => {
  it('covers both premolars of every quadrant', () => {
    expect([...PREMOLAR_FDI_CODES].sort()).toEqual([14, 15, 24, 25, 34, 35, 44, 45]);
  });

  it.each(PREMOLAR_FDI_CODES)(
    'produces a watertight, positive-volume, single-component mesh for FDI %i',
    (fdi) => {
      const asset = generatePremolarAsset(fdi);
      const stats = analyzeMesh(asset.mesh);
      expect(asset.toothType).toBe('premolar');
      expect(stats.watertight).toBe(true);
      expect(stats.manifoldEdges).toBe(true);
      expect(stats.componentCount).toBe(1);
      expect(stats.degenerateCount).toBe(0);
      expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
      assertOrthonormalFrame(asset.canonicalFrame);
    },
  );

  it.each(PREMOLAR_FDI_CODES)('is deterministic for FDI %i', (fdi) => {
    const a = generatePremolarAsset(fdi);
    const b = generatePremolarAsset(fdi);
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
    expect(Buffer.from(a.mesh.indices.buffer)).toEqual(Buffer.from(b.mesh.indices.buffer));
    expect(a.landmarks).toEqual(b.landmarks);
  });

  it.each(PREMOLAR_FDI_CODES)(
    'FDI %i: a buccal and a lingual cusp, each the peak of its half, the buccal one taller',
    (fdi) => {
      const asset = generatePremolarAsset(fdi);
      const buccal = asset.landmarks['buccalCusp']!;
      const lingual = asset.landmarks['lingualCusp']!;
      expect(buccal[1]).toBeGreaterThan(0);
      expect(lingual[1]).toBeLessThan(0);
      expect(buccal[2]).toBeGreaterThan(lingual[2]);
      let maxBuccal = -Infinity;
      let maxLingual = -Infinity;
      const { positions } = asset.mesh;
      for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1]!;
        const z = positions[i + 2]!;
        if (y > 0) maxBuccal = Math.max(maxBuccal, z);
        else maxLingual = Math.max(maxLingual, z);
      }
      expect(buccal[2]).toBeGreaterThan(maxBuccal * 0.97);
      expect(lingual[2]).toBeGreaterThan(maxLingual * 0.97);
    },
  );

  it.each(PREMOLAR_FDI_CODES)(
    'FDI %i: the central fossa lies between the cusps, below both',
    (fdi) => {
      const { landmarks } = generatePremolarAsset(fdi);
      const fossa = landmarks['centralFossa']!;
      expect(fossa[2]).toBeLessThan(landmarks['buccalCusp']![2]);
      expect(fossa[2]).toBeLessThan(landmarks['lingualCusp']![2]);
      expect(landmarks['mesialMarginalRidge']![0]).toBeLessThan(0);
      expect(landmarks['distalMarginalRidge']![0]).toBeGreaterThan(0);
    },
  );

  it('rejects a non-premolar FDI', () => {
    expect(() => generatePremolarAsset(16)).toThrow(RangeError);
  });
});
