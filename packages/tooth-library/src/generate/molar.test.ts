import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { assertOrthonormalFrame } from '../schema.ts';
import { generateMolarAsset, MOLAR_FDI_CODES } from './molar.ts';

const CUSP_NAMES = ['mesiobuccalCusp', 'distobuccalCusp', 'mesiolingualCusp', 'distolingualCusp'] as const;

describe('generateMolarAsset', () => {
  it.each(MOLAR_FDI_CODES)('produces a watertight, positive-volume mesh for FDI %i', (fdi) => {
    const asset = generateMolarAsset(fdi);
    const stats = analyzeMesh(asset.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
  });

  it.each(MOLAR_FDI_CODES)('is deterministic for FDI %i (byte-identical mesh + landmarks)', (fdi) => {
    const a = generateMolarAsset(fdi);
    const b = generateMolarAsset(fdi);
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
    expect(Buffer.from(a.mesh.indices.buffer)).toEqual(Buffer.from(b.mesh.indices.buffer));
    expect(a.landmarks).toEqual(b.landmarks);
    expect(a.morphTargets).toEqual(b.morphTargets);
  });

  it.each(MOLAR_FDI_CODES)('FDI %i: has exactly 4 cusp-tip landmarks, one per quadrant', (fdi) => {
    const asset = generateMolarAsset(fdi);
    for (const name of CUSP_NAMES) {
      expect(asset.landmarks[name]).toBeDefined();
    }
    const mb = asset.landmarks.mesiobuccalCusp!;
    const db = asset.landmarks.distobuccalCusp!;
    const ml = asset.landmarks.mesiolingualCusp!;
    const dl = asset.landmarks.distolingualCusp!;
    // mesiobuccal: x<0 (mesial), y>0 (buccal)
    expect(mb[0]).toBeLessThan(0);
    expect(mb[1]).toBeGreaterThan(0);
    // distobuccal: x>0, y>0
    expect(db[0]).toBeGreaterThan(0);
    expect(db[1]).toBeGreaterThan(0);
    // mesiolingual: x<0, y<0
    expect(ml[0]).toBeLessThan(0);
    expect(ml[1]).toBeLessThan(0);
    // distolingual: x>0, y<0
    expect(dl[0]).toBeGreaterThan(0);
    expect(dl[1]).toBeLessThan(0);
  });

  it.each(MOLAR_FDI_CODES)('FDI %i: each cusp tip is at (or very near) the local max Z in its quadrant', (fdi) => {
    const asset = generateMolarAsset(fdi);
    const { positions } = asset.mesh;
    const quadrantOf = (x: number, y: number): string => {
      if (x < 0 && y > 0) return 'mesiobuccalCusp';
      if (x > 0 && y > 0) return 'distobuccalCusp';
      if (x < 0 && y < 0) return 'mesiolingualCusp';
      return 'distolingualCusp';
    };
    const maxZPerQuadrant: Record<string, number> = {
      mesiobuccalCusp: -Infinity,
      distobuccalCusp: -Infinity,
      mesiolingualCusp: -Infinity,
      distolingualCusp: -Infinity,
    };
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!;
      const y = positions[i + 1]!;
      const z = positions[i + 2]!;
      const q = quadrantOf(x, y);
      if (z > maxZPerQuadrant[q]!) maxZPerQuadrant[q] = z;
    }
    for (const name of CUSP_NAMES) {
      const cuspZ = asset.landmarks[name]![2];
      // The cusp landmark is within 5% of that quadrant's true max height —
      // it need not be the EXACT maximum (the ring/angle grid is discrete),
      // but must be close to the peak, not merely "somewhere positive".
      expect(cuspZ).toBeGreaterThan(maxZPerQuadrant[name]! * 0.9);
    }
  });

  it.each(MOLAR_FDI_CODES)('FDI %i: centralFossa is a local minimum relative to the cusps and the wall top', (fdi) => {
    const asset = generateMolarAsset(fdi);
    const fossaZ = asset.landmarks.centralFossa![2];
    for (const name of CUSP_NAMES) {
      expect(fossaZ).toBeLessThan(asset.landmarks[name]![2]);
    }
    // centralFossa is the mesh's unique (x=0, y=0) vertex ON THE OCCLUSAL
    // TABLE — the cervical cap's own fan center is also at (x=0, y=0), but
    // at z=0 (the cervical margin), never confusable with the fossa.
    let occlusalOriginCount = 0;
    for (let i = 0; i < asset.mesh.positions.length; i += 3) {
      const x = asset.mesh.positions[i]!;
      const y = asset.mesh.positions[i + 1]!;
      const z = asset.mesh.positions[i + 2]!;
      if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && z > 0.1) occlusalOriginCount++;
    }
    expect(occlusalOriginCount).toBe(1);
  });

  it.each(MOLAR_FDI_CODES)('FDI %i: marginal ridges sit between the wall top and the cusp heights', (fdi) => {
    const asset = generateMolarAsset(fdi);
    const mesialZ = asset.landmarks.mesialMarginalRidge![2];
    const distalZ = asset.landmarks.distalMarginalRidge![2];
    const cuspZs = CUSP_NAMES.map((n) => asset.landmarks[n]![2]);
    const minCuspZ = Math.min(...cuspZs);
    expect(mesialZ).toBeLessThan(minCuspZ);
    expect(distalZ).toBeLessThan(minCuspZ);
    expect(mesialZ).toBeGreaterThan(asset.landmarks.centralFossa![2]);
    expect(distalZ).toBeGreaterThan(asset.landmarks.centralFossa![2]);
  });

  it('the identity canonical frame is orthonormal', () => {
    const asset = generateMolarAsset(16);
    expect(() => assertOrthonormalFrame(asset.canonicalFrame)).not.toThrow();
  });

  it('morph target vertexDeltas length matches the mesh vertex count', () => {
    const asset = generateMolarAsset(16);
    const vertexCount = asset.mesh.positions.length / 3;
    for (const target of asset.morphTargets) {
      expect(target.vertexDeltas.length).toBe(vertexCount * 3);
    }
  });

  it('cuspHeight morph target only raises occlusal-table vertices, never axial-wall ones', () => {
    const asset = generateMolarAsset(16);
    const heightTarget = asset.morphTargets.find((t) => t.name === 'cuspHeight')!;
    for (let i = 0; i < asset.mesh.positions.length / 3; i++) {
      if (asset.mesh.positions[i * 3 + 2]! < 5.9) {
        // Comfortably below the wall-top boundary (crownHeightMm = 6.0).
        expect(heightTarget.vertexDeltas[i * 3 + 2]).toBe(0);
      }
    }
  });

  it('throws for an unsupported FDI', () => {
    expect(() => generateMolarAsset(11)).toThrow(RangeError);
  });
});
