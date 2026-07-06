// apps/client/src/engine/shading.ts
//
// Shading presets for SceneManager (Task 6 §4): `matcap` (a bundled neutral
// clay-like matcap, generated procedurally as a data texture — no network
// fetch, no binary asset checked in) and `clinical` (hemisphere fill light +
// a slightly warm directional key light, lighting a plain MeshStandardMaterial).
//
// This module is split into a PURE part (`generateMatcapPixels`, plain math,
// no DOM/Three touched — unit tested) and an impure part that actually
// builds Three.js/Canvas objects (`createMatcapTexture`,
// `createShadingMaterial`, `createClinicalLights`) — those can only run in a
// browser (canvas + WebGL context) and are exercised by the manual viewer
// check instead (see this task's report).
import {
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  Texture,
} from 'three';

export type ShadingPreset = 'matcap' | 'clinical';

export const MATCAP_TEXTURE_SIZE = 128;

/** Ivory/clay base tone — same family as the Phase 0 placeholder's
 * `0xd8d0c0` mesh color, reused here for both presets so switching shading
 * doesn't jarringly change the perceived material. */
const BASE_COLOR_RGB: readonly [number, number, number] = [214, 205, 190];
/** Warm rim-light tone, brightened toward the silhouette edge of the matcap
 * sphere (`rim` term below) for a bit of subsurface-like falloff. */
const RIM_COLOR_RGB: readonly [number, number, number] = [255, 250, 240];
/** Ambient floor (Lambert term is never fully black) + Lambert weight — kept
 * as named constants rather than inline magic numbers. */
const AMBIENT_FLOOR = 0.35;
const LAMBERT_WEIGHT = 1 - AMBIENT_FLOOR;
const RIM_STRENGTH = 0.6;
const RIM_POWER = 3;

function normalize3(v: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Fixed key-light direction the matcap sphere is "lit" from (upper-left-
 * front, in the same +X/+Y/+Z convention as engine/standardViews.ts) — a
 * matcap's whole point is that this lighting is BAKED into the texture, so
 * this is the only place the direction is chosen. */
const MATCAP_LIGHT_DIR = normalize3([0.35, 0.55, 0.75]);

/**
 * Procedurally renders a classic "shaded sphere" matcap as a flat RGBA pixel
 * buffer (row-major, top-to-bottom) — the standard matcap technique treats
 * `(u, v)` texture coordinates as the `(x, y)` of a view-space unit-sphere
 * normal (`z = sqrt(1 - x^2 - y^2)`), so sampling this texture by a mesh
 * normal's view-space xy after a matcap material transform reproduces
 * consistent, orientation-independent shading. Pure function — deterministic
 * for a given `size`, no DOM/Three.js/randomness — see this module's test.
 */
export function generateMatcapPixels(size: number): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const [lx, ly, lz] = MATCAP_LIGHT_DIR;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let nx = ((px + 0.5) / size) * 2 - 1;
      // Flip the row axis so +ny (texture "up") corresponds to +Y in the
      // light direction above — matches how the texture will visually read
      // once mapped (light appears to come from the upper-left).
      let ny = 1 - ((py + 0.5) / size) * 2;

      const r2 = nx * nx + ny * ny;
      if (r2 > 1) {
        // Outside the sphere's silhouette: every (u, v) in the square
        // texture is still sampled at some grazing angle by some normal
        // near the silhouette edge, so clamp to the unit circle rather than
        // leaving an unlit/undefined corner.
        const r = Math.sqrt(r2);
        nx /= r;
        ny /= r;
      }
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));

      const ndotl = Math.max(0, nx * lx + ny * ly + nz * lz);
      const diffuse = AMBIENT_FLOOR + LAMBERT_WEIGHT * ndotl;
      const rim = Math.pow(1 - nz, RIM_POWER) * RIM_STRENGTH;

      const index = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        const shaded = BASE_COLOR_RGB[c]! * diffuse;
        pixels[index + c] = shaded + rim * (RIM_COLOR_RGB[c]! - shaded);
      }
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Wraps `generateMatcapPixels` into a `CanvasTexture` — browser-only (uses
 * `document.createElement('canvas')` + `ImageData`), called exactly once by
 * SceneManager's constructor and shared by every matcap-mode material (see
 * SceneManager's dispose() doc for why the shared texture is disposed
 * separately from any one mesh's material).
 */
export function createMatcapTexture(): Texture {
  const size = MATCAP_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('shading: 2D canvas context unavailable — cannot build the matcap texture');
  }
  const imageData = new ImageData(generateMatcapPixels(size), size, size);
  ctx.putImageData(imageData, 0, 0);
  const texture = new Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Builds the per-mesh material for `preset`. `matcapTexture` is the single
 * shared texture from `createMatcapTexture()` (ignored for `clinical`). */
export function createShadingMaterial(
  preset: ShadingPreset,
  matcapTexture: Texture,
): MeshMatcapMaterial | MeshStandardMaterial {
  if (preset === 'matcap') {
    return new MeshMatcapMaterial({ matcap: matcapTexture, color: 0xffffff, side: DoubleSide });
  }
  return new MeshStandardMaterial({
    color: new Color(BASE_COLOR_RGB[0] / 255, BASE_COLOR_RGB[1] / 255, BASE_COLOR_RGB[2] / 255),
    roughness: 0.7,
    metalness: 0.02,
    side: DoubleSide,
  });
}

/** The `clinical` preset's light rig: a neutral hemisphere fill + a
 * slightly warm-tinted directional key light (Task 6 §4: "hemisphere +
 * directional, slight warm tint"). Created once by SceneManager and left in
 * the scene regardless of the active preset — `MeshMatcapMaterial` ignores
 * scene lights entirely, so leaving these on while `matcap` is active is
 * harmless (no extra draw cost worth guarding against for Phase 1's
 * few-mesh scenes). */
export function createClinicalLights(): { hemisphere: HemisphereLight; directional: DirectionalLight } {
  const hemisphere = new HemisphereLight(0xffffff, 0x3a3a3a, 1.1);
  // 0xfff1e0: warm-white, same family as clinical operatory lighting rather
  // than a neutral/cool CAD-viewer light.
  const directional = new DirectionalLight(0xfff1e0, 1.3);
  directional.position.set(0.4, 0.9, 0.6);
  return { hemisphere, directional };
}
