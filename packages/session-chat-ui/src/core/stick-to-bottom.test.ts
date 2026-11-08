import { describe, expect, it } from 'vitest';
import { landedAtEnd } from './stick-to-bottom';

describe('landedAtEnd', () => {
  it('a move down within a pixel of the end lands there', () => {
    expect(landedAtEnd(40, 1)).toBe(true);
    expect(landedAtEnd(40, 1.5)).toBe(false);
  });

  it('a sub-pixel snap under a pixel from the end is not a reader leaving', () => {
    // Measured at device scale 1.25: scrollTop 184718.4 against an end of 184719.
    expect(landedAtEnd(-0.2, 0.6)).toBe(true);
  });

  it('an upward step of a whole pixel leaves the end, even from exactly there', () => {
    expect(landedAtEnd(-1, 1)).toBe(false);
    expect(landedAtEnd(-1, 1.6)).toBe(false);
  });
});
