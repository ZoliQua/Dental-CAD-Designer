// apps/client/src/engine/colormap.ts
//
// Pure diverging colormap (blue -> white -> red) for the surface-distance
// heatmap's per-vertex rendering (Task 9). Deliberately has NO Three.js/DOM
// import — this file only ever returns plain [r, g, b] triples in [0, 1]
// (linear-space floats, matching what a Three.js `vertexColors` material
// samples from a `color` BufferAttribute); SceneManager.ts is the only place
// that ever touches an actual Three.js object (CLAUDE.md's Float32-render-
// copy-only-in-engine rule; this module stays render-agnostic so it's
// trivially unit-testable — see colormap.test.ts's value->RGB table).
//
// `packages/kernel`/`packages/kernel-workers` compute DISTANCES only, always
// Float64 mm (see jobs.ts's `DistanceHeatmapResult`) — colors are strictly a
// downstream, display-only concern that belongs in apps/client/src/engine,
// never in the kernel layer (this task's brief: "colormap math in engine —
// no kernel dependency on colors").

/** Inclusive display range a distance value is mapped against — `min` maps
 * to pure blue, the midpoint `(min+max)/2` to white, `max` to pure red.
 * `min` and `max` need not straddle zero: an UNSIGNED heatmap's natural
 * range is `[0, someMax]` (blue at "touching", red at "farthest") — see
 * `computeAutoRange`'s doc for when the range IS symmetric about zero. */
export interface ColorRange {
  min: number;
  max: number;
}

/** Linear-space RGB triple, each component in [0, 1]. */
export type Rgb = readonly [number, number, number];

const BLUE: Rgb = [0.1, 0.35, 0.85];
const WHITE: Rgb = [1, 1, 1];
const RED: Rgb = [0.85, 0.15, 0.1];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Maps `value` to a color within `range` via the blue -> white -> red
 * 3-stop diverging gradient: `range.min` -> blue, the range's midpoint ->
 * white, `range.max` -> red. Values outside `[range.min, range.max]` are
 * CLAMPED to the nearest endpoint color, not extrapolated — a heatmap
 * legend's whole point is that its endpoints are the displayed extremes.
 *
 * A degenerate range (`range.max <= range.min` — e.g. every queried point is
 * exactly 0 mm from the target, as in `heatmap(A, A)`) returns white for
 * every value: there is nothing to diverge FROM, and white reads as
 * "no meaningful variation" rather than an arbitrary tinted flat color.
 */
export function colorForValue(value: number, range: ColorRange): Rgb {
  if (!(range.max > range.min)) {
    return WHITE;
  }
  const t = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
  return t <= 0.5 ? lerpRgb(BLUE, WHITE, t / 0.5) : lerpRgb(WHITE, RED, (t - 0.5) / 0.5);
}

/** Fraction of the (sorted-ascending) `values` at or below the returned
 * value — linear interpolation between the two bracketing samples (same
 * convention as e.g. numpy's default `linear` percentile interpolation).
 * `values` must be non-empty and already sorted ascending. */
function percentileOfSorted(sortedValues: Float64Array, percentile: number): number {
  if (sortedValues.length === 1) {
    return sortedValues[0]!;
  }
  const rank = percentile * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedValues[lowerIndex]!;
  const upper = sortedValues[upperIndex]!;
  return lower + (upper - lower) * (rank - lowerIndex);
}

/** Default auto-range percentile — the brief's "percentile auto-range"
 * clips the handful of most extreme outlier vertices (e.g. a stray sliver
 * triangle far from the rest of the surface) out of the color range, so
 * the vast majority of the surface still shows meaningful color contrast
 * instead of being crushed into one end of the gradient by a few outliers. */
export const DEFAULT_AUTO_RANGE_PERCENTILE = 0.98;

/**
 * Computes a symmetric-about-zero OR zero-anchored auto display range from
 * `distances`, at `percentile` (default 98th) of the distances' MAGNITUDE —
 * see `DEFAULT_AUTO_RANGE_PERCENTILE`'s doc for why a percentile (not the
 * bare max) is used.
 *
 * - If every distance is >= 0 (the common, unsigned heatmap case — see
 *   jobs.ts's `DistanceHeatmapPayload.signed`), the range is `[0, magnitude]`
 *   — blue anchored at exactly 0 (`colorForValue`'s "touching" endpoint),
 *   red at the percentile-clipped max. This matches this task's brief's own
 *   notation for the unsigned case ("blue−0 → white → red+").
 * - If any distance is negative (a signed heatmap with some vertices on the
 *   "inside"), the range is symmetric: `[-magnitude, magnitude]` — white
 *   lands exactly on the true surface (0 mm), blue is "furthest inside", red
 *   is "furthest outside". This is the brief's "symmetric range" case.
 *
 * Returns `{ min: 0, max: 0 }` for an empty `distances` (nothing to range
 * over — `colorForValue` already treats a degenerate range as all-white).
 */
export function computeAutoRange(
  distances: Float64Array,
  percentile: number = DEFAULT_AUTO_RANGE_PERCENTILE,
): ColorRange {
  if (distances.length === 0) {
    return { min: 0, max: 0 };
  }
  let hasNegative = false;
  const magnitudes = new Float64Array(distances.length);
  for (let i = 0; i < distances.length; i++) {
    const v = distances[i]!;
    if (v < 0) hasNegative = true;
    magnitudes[i] = Math.abs(v);
  }
  magnitudes.sort();
  const magnitude = percentileOfSorted(magnitudes, percentile);
  return hasNegative ? { min: -magnitude, max: magnitude } : { min: 0, max: magnitude };
}

/**
 * Converts a Float64 mm distance array into a Float32 per-vertex RGB color
 * buffer (length `distances.length * 3`) ready for a Three.js `color`
 * `BufferAttribute` — see SceneManager.ts's `applyColors`. This is the ONE
 * place a heatmap's Float64 distances become Float32 — matching CLAUDE.md's
 * "Float32Array only in engine render copies" rule; `distances` itself is
 * never downcast or mutated.
 */
export function distancesToVertexColors(distances: Float64Array, range: ColorRange): Float32Array {
  const colors = new Float32Array(distances.length * 3);
  for (let i = 0; i < distances.length; i++) {
    const [r, g, b] = colorForValue(distances[i]!, range);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  return colors;
}
