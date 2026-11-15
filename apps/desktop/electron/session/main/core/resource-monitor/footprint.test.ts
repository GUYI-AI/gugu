import { describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', () => ({ readFile: async (file: string) => { const text = files.get(file); if (text === undefined) throw new Error('ENOENT'); return text; } }));
import { footprintReader, readLinuxFootprints, setMacFootprintReader } from './footprint';

describe('process footprint', () => {
  it('reads anonymous resident plus swap on Linux, leaving exited or old-kernel processes to RSS', async () => {
    files.set('/proc/1/status', 'Name:\tgugu\nVmRSS:\t  900 kB\nRssAnon:\t  300 kB\nRssFile:\t  600 kB\nVmSwap:\t  20 kB\n');
    files.set('/proc/2/status', 'Name:\told\nVmRSS:\t  900 kB\n');
    expect(await readLinuxFootprints([1, 2, 3])).toEqual(new Map([[1, 320 * 1024]]));
  });
  it('uses the native helper on macOS only when it is there, and nothing on Windows', () => {
    expect(footprintReader('linux')).toBe(readLinuxFootprints);
    expect(footprintReader('darwin')).toBeNull();
    const helper = async () => new Map<number, number>();
    setMacFootprintReader(() => helper);
    expect(footprintReader('darwin')).toBe(helper);
    expect(footprintReader('win32')).toBeNull();
  });
});
