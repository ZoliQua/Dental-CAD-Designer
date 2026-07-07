import { describe, expect, it } from 'vitest';
import { formatMm } from './formatMm';

describe('formatMm', () => {
  it.each<[number, string]>([
    [12.3456, '12.346 mm'],
    [123.456789, '123.457 mm'],
    [0.1234, '0.123 mm (123 µm)'],
    [0.00051, '0.001 mm (1 µm)'],
    [0.999, '0.999 mm (999 µm)'],
    [1, '1.000 mm'], // exactly the sub-mm/mm boundary — no µm parenthetical
    [1.0004, '1.000 mm'],
    [0, '0.000 mm (0 µm)'],
    [-0.5, '-0.500 mm (-500 µm)'],
    [NaN, '—'],
    [Infinity, '—'],
    [-Infinity, '—'],
  ])('formatMm(%s) === %s', (input, expected) => {
    expect(formatMm(input)).toBe(expected);
  });
});
