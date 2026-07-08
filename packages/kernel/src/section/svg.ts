// packages/kernel/src/section/svg.ts
//
// `sectionToSvg`: a pure, dependency-free function turning already-2D
// (plane-local) section polylines into an SVG document string — no mesh,
// no plane, no manifold-3d, so it's trivially snapshot-testable with small
// literal polylines (svg.test.ts). `projectPolylinesToPlaneXY` below is the
// (equally pure) bridge from `polyline.ts`'s 3D world-frame
// `SectionPolyline`s to this module's 2D input shape.
import type { Vec3 } from '../bvh/geometry.ts';
import type { PlaneBasis } from './plane.ts';
import { projectToPlaneXY } from './plane.ts';
import type { SectionPolyline } from './polyline.ts';

/** A polyline already projected into a plane's local 2D `(u, v)` mm
 * coordinates — `points` is flat (length = pointCount * 2), same
 * "first point not repeated for a closed loop" convention as
 * `SectionPolyline.points`. */
export interface SectionSvgPolyline {
  points: Float64Array;
  closed: boolean;
}

/** Projects every point of every `SectionPolyline` (3D, world/kernel mm)
 * onto `basis`'s local 2D frame — see plane.ts's `projectToPlaneXY` for the
 * exact identity. Pure, no I/O. */
export function projectPolylinesToPlaneXY(
  polylines: readonly SectionPolyline[],
  basis: PlaneBasis,
): SectionSvgPolyline[] {
  return polylines.map((polyline) => {
    const pointCount = polyline.points.length / 3;
    const points2d = new Float64Array(pointCount * 2);
    for (let i = 0; i < pointCount; i++) {
      const p: Vec3 = [
        polyline.points[i * 3]!,
        polyline.points[i * 3 + 1]!,
        polyline.points[i * 3 + 2]!,
      ];
      const [u, v] = projectToPlaneXY(basis, p);
      points2d[i * 2] = u;
      points2d[i * 2 + 1] = v;
    }
    return { points: points2d, closed: polyline.closed };
  });
}

export interface SectionToSvgOptions {
  /** mm-per-SVG-user-unit — defaults to 1 (a "mm-true" viewBox: 1 SVG unit
   * === 1 mm, so the file can be measured/printed at 1:1 scale by any SVG
   * consumer that respects `viewBox`/physical units). A caller wanting a
   * larger on-screen preview should scale via CSS/the `<svg>` element's own
   * `width`/`height`, not this option — this option changes what a
   * `viewBox` UNIT physically means, not how big the file's pixel dimensions
   * are. */
  scale?: number;
  /** Stroke width, in mm (same unit convention as `scale`). */
  strokeWidth?: number;
  /** Extra margin (mm) added around the polylines' bounding box, on every
   * side, before computing the viewBox. */
  paddingMm?: number;
}

const DEFAULT_SCALE = 1;
const DEFAULT_STROKE_WIDTH_MM = 0.1;
const DEFAULT_PADDING_MM = 1;

function formatNumber(value: number): string {
  // Full Float64 precision would bloat the file with digits far below any
  // display/print resolution this project cares about (CLAUDE.md: 1 µm
  // display resolution) — 6 decimal places is 1 nm at the mm scale used
  // throughout, comfortably below that, while keeping the file readable.
  return value.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function polylinePath(polyline: SectionSvgPolyline, scale: number): string {
  const pointCount = polyline.points.length / 2;
  if (pointCount === 0) return '';
  const commands: string[] = [];
  for (let i = 0; i < pointCount; i++) {
    const x = polyline.points[i * 2]! / scale;
    const y = polyline.points[i * 2 + 1]! / scale;
    commands.push(`${i === 0 ? 'M' : 'L'}${formatNumber(x)},${formatNumber(y)}`);
  }
  if (polyline.closed) {
    commands.push('Z');
  }
  return commands.join(' ');
}

/**
 * Renders `polylines` (already 2D, plane-local mm — see
 * `projectPolylinesToPlaneXY`) as a standalone SVG document: one `<path>`
 * per polyline (closed polylines get a `Z`-terminated, fillable path;
 * open polylines get an unterminated, stroke-only path), a `viewBox`
 * covering every polyline's extent plus `paddingMm` padding, sized so 1
 * viewBox unit === `options.scale` mm (default 1 — mm-true). Pure string
 * building, no DOM/browser API — safe to call from a worker or Node.
 */
export function sectionToSvg(
  polylines: readonly SectionSvgPolyline[],
  options: SectionToSvgOptions = {},
): string {
  const scale = options.scale ?? DEFAULT_SCALE;
  const strokeWidth = (options.strokeWidth ?? DEFAULT_STROKE_WIDTH_MM) / scale;
  const padding = (options.paddingMm ?? DEFAULT_PADDING_MM) / scale;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polyline of polylines) {
    const pointCount = polyline.points.length / 2;
    for (let i = 0; i < pointCount; i++) {
      const x = polyline.points[i * 2]! / scale;
      const y = polyline.points[i * 2 + 1]! / scale;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Empty input (or a degenerate all-empty-polylines set): fall back to a
  // trivial 1x1 viewBox around the origin rather than an Infinity/-Infinity
  // (NaN-producing) box.
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const viewMinX = minX - padding;
  const viewMinY = minY - padding;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;

  const paths = polylines
    .map((polyline) => polylinePath(polyline, scale))
    .filter((d) => d.length > 0)
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="#000000" stroke-width="${formatNumber(strokeWidth)}" vector-effect="non-scaling-stroke"/>`,
    )
    .join('\n  ');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${formatNumber(viewMinX)} ${formatNumber(viewMinY)} ${formatNumber(width)} ${formatNumber(height)}" ` +
    `width="${formatNumber(width)}mm" height="${formatNumber(height)}mm">\n` +
    `  ${paths}\n` +
    `</svg>\n`
  );
}
