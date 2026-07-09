// packages/kernel/src/section/svg.test.ts
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { normalizePlane } from './plane.ts';
import type { SectionPolyline } from './polyline.ts';
import { projectPolylinesToPlaneXY, sectionToSvg, type SectionSvgPolyline } from './svg.ts';

describe('sectionToSvg — snapshot', () => {
  it('renders a closed square and an open segment (default options)', () => {
    const square: SectionSvgPolyline = {
      // 2mm x 2mm square, closed.
      points: new Float64Array([0, 0, 2, 0, 2, 2, 0, 2]),
      closed: true,
    };
    const openSegment: SectionSvgPolyline = {
      points: new Float64Array([-1, -1, 3, -1]),
      closed: false,
    };
    const svg = sectionToSvg([square, openSegment]);
    expect(svg).toMatchSnapshot();
  });

  it('respects scale, strokeWidth, and paddingMm options', () => {
    const triangle: SectionSvgPolyline = {
      points: new Float64Array([0, 0, 10, 0, 5, 10]),
      closed: true,
    };
    const svg = sectionToSvg([triangle], { scale: 1, strokeWidth: 0.2, paddingMm: 2 });
    expect(svg).toMatchSnapshot();
  });

  it('scale != 1: the width/height SVG attributes state the true physical mm extent, not the viewBox-unit magnitude', () => {
    // A 10mm x 10mm square with scale:2 and the default 1mm padding: the
    // viewBox is in units of 2mm each (scale=2), so the viewBox's own
    // width/height number is 6 (= 10mm / 2 + 2 * (1mm padding / 2)) — but
    // the `width`/`height` attributes are documented (and labeled "mm") as
    // the physical extent, which is 6 viewBox-units * 2mm/unit = 12mm, NOT
    // the bare viewBox-unit number "6". Regression test for a bug where the
    // viewBox-unit magnitude was reported directly, mislabeled "mm".
    const square: SectionSvgPolyline = {
      points: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
      closed: true,
    };
    const svg = sectionToSvg([square], { scale: 2 });
    expect(svg).toContain('width="12mm" height="12mm"');
    expect(svg).toContain('viewBox="-0.5 -0.5 6 6"');
  });

  it('is a pure function: identical input produces identical output', () => {
    const polyline: SectionSvgPolyline = {
      points: new Float64Array([0, 0, 1, 1, 2, 0]),
      closed: false,
    };
    expect(sectionToSvg([polyline])).toBe(sectionToSvg([polyline]));
  });

  it('produces a valid (non-NaN, non-Infinity) viewBox for empty input', () => {
    const svg = sectionToSvg([]);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
    expect(svg).toContain('<svg');
  });

  it('closed paths end with Z, open paths do not', () => {
    const closed: SectionSvgPolyline = { points: new Float64Array([0, 0, 1, 0, 1, 1]), closed: true };
    const open: SectionSvgPolyline = { points: new Float64Array([0, 0, 1, 0, 1, 1]), closed: false };
    const closedSvg = sectionToSvg([closed]);
    const openSvg = sectionToSvg([open]);
    expect(closedSvg).toMatch(/Z"/);
    expect(openSvg).not.toMatch(/Z"/);
  });
});

describe('projectPolylinesToPlaneXY', () => {
  it('projects a 3D polyline on the XY plane (z=0) consistently with the basis e1/e2 axes', () => {
    // normalizePlane's deterministic "least-aligned axis" construction for
    // normal=(0,0,1) picks e1=(0,-1,0), e2=(1,0,0) (a 90-degree-rotated
    // frame, not the identity) — see plane.ts's `normalizePlane` doc. The
    // projection is `(e1.p, e2.p)`, so for p=(1,2,0): u = -1*2 = -2,
    // v = 1*1 = 1 — asserted directly against the basis rather than assumed.
    const basis = normalizePlane({ point: [0, 0, 0], normal: [0, 0, 1] });
    expect(basis.e1[0]).toBeCloseTo(0, 12);
    expect(basis.e1[1]).toBeCloseTo(-1, 12);
    expect(basis.e1[2]).toBeCloseTo(0, 12);
    expect(basis.e2[0]).toBeCloseTo(1, 12);
    expect(basis.e2[1]).toBeCloseTo(0, 12);
    expect(basis.e2[2]).toBeCloseTo(0, 12);

    const polyline: SectionPolyline = {
      points: new Float64Array([1, 2, 0, 3, 4, 0]),
      closed: true,
    };
    const [projected] = projectPolylinesToPlaneXY([polyline], basis);
    expect(Array.from(projected!.points)).toEqual([-2, 1, -4, 3]);
    expect(projected!.closed).toBe(true);
  });

  it('round-trips through sectionToSvg for a tilted plane without NaN', () => {
    const basis = normalizePlane({ point: [0, 0, 0], normal: [1, 1, 1] });
    const p0: Vec3 = [1, -0.5, -0.5];
    const p1: Vec3 = [-0.5, 1, -0.5];
    const p2: Vec3 = [-0.5, -0.5, 1];
    const polyline: SectionPolyline = {
      points: new Float64Array([...p0, ...p1, ...p2]),
      closed: true,
    };
    const [projected] = projectPolylinesToPlaneXY([polyline], basis);
    const svg = sectionToSvg([projected!]);
    expect(svg).not.toContain('NaN');
  });
});
