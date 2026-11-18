import { expect, it } from 'vitest';
import { fitLiveWindow } from './geometry';

it('maps every state with the real source aspect ratio, including portrait computer windows', () => {
  for (const source of [{ width: 960, height: 600 }, { width: 723, height: 960 }]) {
    for (const available of [{ width: 160, height: 300 }, { width: 390, height: 640 }, { width: 844, height: 342 }, { width: 1100, height: 800 }]) {
      const fitted = fitLiveWindow(source, available)!;
      expect(fitted.width / fitted.height).toBeCloseTo(source.width / source.height, 10);
      expect(fitted.width).toBeLessThanOrEqual(available.width + 1e-9);
      expect(fitted.height).toBeLessThanOrEqual(available.height + 1e-9);
      expect(fitted.width / source.width).toBeCloseTo(fitted.height / source.height, 10);
    }
  }
});
it('does not invent geometry before a frame or accept non-finite sizes', () => {
  expect(fitLiveWindow(null, { width: 390, height: 844 })).toBeNull();
  expect(fitLiveWindow({ width: 0, height: 600 }, { width: 390, height: 844 })).toBeNull();
  expect(fitLiveWindow({ width: Infinity, height: 600 }, { width: 390, height: 844 })).toBeNull();
  expect(fitLiveWindow({ width: 960, height: 600 }, { width: NaN, height: 844 })).toBeNull();
});
