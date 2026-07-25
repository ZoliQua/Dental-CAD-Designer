import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { assertOrthonormalFrame } from '../schema.ts';
import { generateIncisorAsset, INCISOR_FDI_CODES } from './incisor.ts';

describe('generateIncisorAsset', () => {
  it.each(INCISOR_FDI_CODES)('produces a watertight, positive-volume mesh for FDI %i', (fdi) => {
    const asset = generateIncisorAsset(fdi);
    const stats = analyzeMesh(asset.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
    expect(stats.signedVolumeMm3).not.toBeNull();
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
  });

  it.each(INCISOR_FDI_CODES)('is deterministic for FDI %i (byte-identical mesh + landmarks)', (fdi) => {
    const a = generateIncisorAsset(fdi);
    const b = generateIncisorAsset(fdi);
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
    expect(Buffer.from(a.mesh.indices.buffer)).toEqual(Buffer.from(b.mesh.indices.buffer));
    expect(a.landmarks).toEqual(b.landmarks);
    expect(a.morphTargets).toEqual(b.morphTargets);
  });

  it('produces a byte-identical mesh across repeated calls even interleaved with other FDIs', () => {
    // Guards against any hidden shared mutable state across generator calls
    // (e.g. an accidentally-module-scoped accumulator array).
    const first = generateIncisorAsset(11);
    generateIncisorAsset(12);
    generateIncisorAsset(21);
    const second = generateIncisorAsset(11);
    expect(Buffer.from(first.mesh.positions.buffer)).toEqual(Buffer.from(second.mesh.positions.buffer));
  });

  it("central incisor (11) is analytically larger than lateral incisor (12)", () => {
    const central = generateIncisorAsset(11);
    const lateral = generateIncisorAsset(12);
    const centralHeight = Math.max(...Array.from(central.mesh.positions.filter((_, i) => i % 3 === 2)));
    const lateralHeight = Math.max(...Array.from(lateral.mesh.positions.filter((_, i) => i % 3 === 2)));
    expect(centralHeight).toBeGreaterThan(lateralHeight);
  });

  it('11 and 21 (bilateral pair) are identical in shape (mirror-symmetric size params)', () => {
    const a = generateIncisorAsset(11);
    const b = generateIncisorAsset(21);
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
  });

  it.each(INCISOR_FDI_CODES)(
    "FDI %i: incisalEdge landmark is the most-occlusal point (max Z) of the ENTIRE mesh",
    (fdi) => {
      const asset = generateIncisorAsset(fdi);
      let maxZ = -Infinity;
      for (let i = 2; i < asset.mesh.positions.length; i += 3) {
        const z = asset.mesh.positions[i]!;
        if (z > maxZ) maxZ = z;
      }
      const incisalEdgeZ = asset.landmarks.incisalEdge![2];
      expect(incisalEdgeZ).toBeCloseTo(maxZ, 9);
      // And it must be the UNIQUE max — no tie (see APEX_RISE_FRACTION doc).
      let countAtMax = 0;
      for (let i = 2; i < asset.mesh.positions.length; i += 3) {
        if (Math.abs(asset.mesh.positions[i]! - maxZ) < 1e-9) countAtMax++;
      }
      expect(countAtMax).toBe(1);
    },
  );

  it.each(INCISOR_FDI_CODES)('FDI %i: cingulum sits lingual (negative buccoLingual) of the midline', (fdi) => {
    const asset = generateIncisorAsset(fdi);
    expect(asset.landmarks.cingulum![1]).toBeLessThan(0);
  });

  it.each(INCISOR_FDI_CODES)(
    'FDI %i: mesial/distal marginal ridges are lingual, and mesially/distally offset from pure lingual',
    (fdi) => {
      const asset = generateIncisorAsset(fdi);
      const mesial = asset.landmarks.mesialMarginalRidge!;
      const distal = asset.landmarks.distalMarginalRidge!;
      expect(mesial[1]).toBeLessThan(0); // lingual half
      expect(distal[1]).toBeLessThan(0);
      expect(mesial[0]).toBeLessThan(0); // mesial = negative x
      expect(distal[0]).toBeGreaterThan(0); // distal = positive x
    },
  );

  it.each(INCISOR_FDI_CODES)('FDI %i: mesial/distal contact points are the mesiodistal extremes', (fdi) => {
    const asset = generateIncisorAsset(fdi);
    let maxAbsX = 0;
    for (let i = 0; i < asset.mesh.positions.length; i += 3) {
      maxAbsX = Math.max(maxAbsX, Math.abs(asset.mesh.positions[i]!));
    }
    expect(Math.abs(asset.landmarks.mesialContact![0])).toBeCloseTo(maxAbsX, 6);
    expect(Math.abs(asset.landmarks.distalContact![0])).toBeCloseTo(maxAbsX, 6);
  });

  it('the identity canonical frame is orthonormal', () => {
    const asset = generateIncisorAsset(11);
    expect(() => assertOrthonormalFrame(asset.canonicalFrame)).not.toThrow();
  });

  it('morph target vertexDeltas length matches the mesh vertex count', () => {
    const asset = generateIncisorAsset(11);
    const vertexCount = asset.mesh.positions.length / 3;
    for (const target of asset.morphTargets) {
      expect(target.vertexDeltas.length).toBe(vertexCount * 3);
    }
  });

  it('cuspHeight morph target raises the apex and leaves the cervical margin untouched', () => {
    const asset = generateIncisorAsset(11);
    const heightTarget = asset.morphTargets.find((t) => t.name === 'cuspHeight')!;
    // Cervical-ring vertices (z == 0) get zero height delta.
    for (let i = 0; i < asset.mesh.positions.length / 3; i++) {
      if (Math.abs(asset.mesh.positions[i * 3 + 2]!) < 1e-12) {
        expect(heightTarget.vertexDeltas[i * 3 + 2]).toBe(0);
      }
    }
    // The apex vertex gets a strictly positive height delta.
    let apexIndex = -1;
    let maxZ = -Infinity;
    for (let i = 0; i < asset.mesh.positions.length / 3; i++) {
      const z = asset.mesh.positions[i * 3 + 2]!;
      if (z > maxZ) {
        maxZ = z;
        apexIndex = i;
      }
    }
    expect(heightTarget.vertexDeltas[apexIndex * 3 + 2]).toBeGreaterThan(0);
  });

  it('throws for an unsupported FDI', () => {
    expect(() => generateIncisorAsset(16)).toThrow(RangeError);
  });
});
