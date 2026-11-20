import { describe, expect, it, vi } from 'vitest';
import { captureColorWitness } from './projection-capture-witness';
const blue = [26, 96, 190] as const, red = [190, 40, 26] as const;
describe('source PNG paint witness', () => {
  it('rejects the stale source and returns the exact observed PNG, without taking another capture', async () => {
    const capture = vi.fn().mockResolvedValueOnce('blue-png').mockResolvedValueOnce('red-png');
    const rgb = vi.fn(async (data: string) => data === 'blue-png' ? blue : red);
    const result = await captureColorWitness({ capture, rgb, expected: red, until: async condition => {
      expect(await condition()).toBe(false); expect(await condition()).toBe(true);
    } });
    expect(result).toEqual({ data: 'red-png', attempts: 2, firstRgb: blue, rgb: red });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(rgb.mock.calls.map(call => call[0])).toEqual(['blue-png', 'red-png']);
  });
  it('fails rather than publishing a permanently stale PNG and preserves the wait failure', async () => {
    const timeout = new Error('existing fixture wait failure');
    const work = captureColorWitness({ capture: async () => 'blue-png', rgb: async () => blue, expected: red,
      until: async condition => { expect(await condition()).toBe(false); throw timeout; } });
    await expect(work).rejects.toMatchObject({ cause: timeout });
    await expect(work).rejects.toThrow('"rgb":[26,96,190]');
  });
  it('does not accept completion without a witness or hide a failed independent pixel read', async () => {
    await expect(captureColorWitness({ capture: async () => 'red-png', rgb: async () => red, expected: red,
      until: async () => {} })).rejects.toThrow('without a witnessed PNG');
    const broken = new Error('independent PNG decode failed');
    await expect(captureColorWitness({ capture: async () => 'red-png', rgb: async () => { throw broken; }, expected: red,
      until: async condition => { await condition(); } })).rejects.toMatchObject({ cause: broken });
  });
});
