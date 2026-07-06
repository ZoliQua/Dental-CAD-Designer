import { describe, expect, it } from 'vitest';
import { generateMatcapPixels, MATCAP_TEXTURE_SIZE } from './shading';

describe('generateMatcapPixels', () => {
  it('returns an RGBA buffer of the requested size', () => {
    const pixels = generateMatcapPixels(8);
    expect(pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(pixels.length).toBe(8 * 8 * 4);
  });

  it('is fully opaque everywhere (alpha channel always 255)', () => {
    const size = 16;
    const pixels = generateMatcapPixels(size);
    for (let i = 0; i < size * size; i++) {
      expect(pixels[i * 4 + 3]).toBe(255);
    }
  });

  it('every channel is a valid 8-bit value', () => {
    const pixels = generateMatcapPixels(16);
    for (const value of pixels) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  it('is deterministic for a given size', () => {
    expect(Array.from(generateMatcapPixels(32))).toEqual(Array.from(generateMatcapPixels(32)));
  });

  it('uses the module default MATCAP_TEXTURE_SIZE consistently', () => {
    const pixels = generateMatcapPixels(MATCAP_TEXTURE_SIZE);
    expect(pixels.length).toBe(MATCAP_TEXTURE_SIZE * MATCAP_TEXTURE_SIZE * 4);
  });

  it('the pixel facing the light is brighter than the pixel facing away from it', () => {
    const size = 64;
    const pixels = generateMatcapPixels(size);
    // Light direction is normalize([0.35, 0.55, 0.75]) — texture-space +x
    // (toward the light's x/y component) is near the top-left quadrant
    // given the row flip in generateMatcapPixels; sample a pixel near the
    // center offset toward (+x, +y) vs its mirror at (-x, -y).
    const offset = Math.floor(size * 0.2);
    const center = size / 2;
    const litIndex = (Math.floor(center - offset) * size + Math.floor(center + offset)) * 4;
    const shadowIndex = (Math.floor(center + offset) * size + Math.floor(center - offset)) * 4;
    const litBrightness = pixels[litIndex]! + pixels[litIndex + 1]! + pixels[litIndex + 2]!;
    const shadowBrightness = pixels[shadowIndex]! + pixels[shadowIndex + 1]! + pixels[shadowIndex + 2]!;
    expect(litBrightness).toBeGreaterThan(shadowBrightness);
  });

  it('the silhouette edge (corner pixels) does not read as fully black or fully white', () => {
    const size = 16;
    const pixels = generateMatcapPixels(size);
    const cornerIndex = 0; // top-left corner: outside the inscribed circle, clamped to the rim.
    const r = pixels[cornerIndex]!;
    const g = pixels[cornerIndex + 1]!;
    const b = pixels[cornerIndex + 2]!;
    expect(r + g + b).toBeGreaterThan(0);
    expect(r + g + b).toBeLessThan(255 * 3);
  });
});
