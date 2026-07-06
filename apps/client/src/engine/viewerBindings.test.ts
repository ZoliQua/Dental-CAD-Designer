import { describe, expect, it } from 'vitest';
import { MOUSE } from 'three';
import { DEFAULT_VIEWER_BINDINGS, toOrbitControlsMouseMap, type ViewerBindings } from './viewerBindings';

describe('DEFAULT_VIEWER_BINDINGS', () => {
  it('is the conventional left=rotate/middle=zoom/right=pan layout', () => {
    expect(DEFAULT_VIEWER_BINDINGS).toEqual({ left: 'rotate', middle: 'zoom', right: 'pan' });
  });
});

describe('toOrbitControlsMouseMap', () => {
  it('translates the default bindings to THREE.MOUSE constants', () => {
    expect(toOrbitControlsMouseMap(DEFAULT_VIEWER_BINDINGS)).toEqual({
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.PAN,
    });
  });

  it('respects an arbitrary remapping (structure supports settings-UI overrides later)', () => {
    const swapped: ViewerBindings = { left: 'pan', middle: 'rotate', right: 'zoom' };
    expect(toOrbitControlsMouseMap(swapped)).toEqual({
      LEFT: MOUSE.PAN,
      MIDDLE: MOUSE.ROTATE,
      RIGHT: MOUSE.DOLLY,
    });
  });

  it('every action maps to a distinct THREE.MOUSE constant', () => {
    const map = toOrbitControlsMouseMap({ left: 'rotate', middle: 'pan', right: 'zoom' });
    const values = Object.values(map);
    expect(new Set(values).size).toBe(values.length);
  });
});
