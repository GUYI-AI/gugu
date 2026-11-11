/**
 * Virtualizer — unit tests.
 *
 * Covers the core BIT arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { Virtualizer } from './virtualizer';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildVirt(heights: number[]): Virtualizer {
  const v = new Virtualizer();
  v.setCount(heights.length, (i) => heights[i]);
  // Confirm initial sizes by running setSize (simulating measured heights).
  for (let i = 0; i < heights.length; i++) {
    v.setSize(i, heights[i]);
  }
  return v;
}

// ── Basic API ─────────────────────────────────────────────────────────────────

describe('Virtualizer — basic', () => {
  it('top(0) is always 0', () => {
    const v = buildVirt([10, 20, 30]);
    expect(v.top(0)).toBe(0);
  });

  it('top(i) equals cumulative sum of rows before i', () => {
    const v = buildVirt([10, 20, 30]);
    expect(v.top(1)).toBe(10);
    expect(v.top(2)).toBe(30);
    expect(v.top(3)).toBe(60);
  });

  it('total() equals sum of all sizes', () => {
    const v = buildVirt([10, 20, 30]);
    expect(v.total()).toBe(60);
  });

  it('setSize updates top and total', () => {
    const v = buildVirt([10, 20, 30]);
    v.setSize(1, 50);
    expect(v.top(2)).toBe(60); // 10 + 50
    expect(v.total()).toBe(90);
  });

  it('findIndex locates the correct row for a pixel offset', () => {
    const v = buildVirt([10, 20, 30]);
    expect(v.findIndex(0)).toBe(0);
    expect(v.findIndex(9)).toBe(0);
    expect(v.findIndex(10)).toBe(1);
    expect(v.findIndex(29)).toBe(1);
    expect(v.findIndex(30)).toBe(2);
    expect(v.findIndex(59)).toBe(2);
  });
});
