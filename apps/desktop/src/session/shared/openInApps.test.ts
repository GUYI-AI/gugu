import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getResolvedIconPath, OPEN_IN_APPS, type PlatformKey } from './openInApps';

// The renderer looks an icon up by its file name (useOpenInApps' glob over this folder); a name with no file draws nothing.
describe('open-in app icons', () => {
  it('every program has its icon file on every platform', () => {
    const images = resolve(__dirname, '../assets/images');
    const platforms: PlatformKey[] = ['darwin', 'win32', 'linux'];
    const missing = Object.values(OPEN_IN_APPS).flatMap((app) =>
      platforms.map((platform) => getResolvedIconPath(app, platform)).filter((icon) => !existsSync(resolve(images, icon))));
    expect([...new Set(missing)]).toEqual([]);
  });
});
