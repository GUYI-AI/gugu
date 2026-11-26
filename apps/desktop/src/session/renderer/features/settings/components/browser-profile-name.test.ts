import { describe, expect, it } from 'vitest';
import { isBrowserProfileNameTaken } from './browser-profile-name';

const profiles = [{ id: 'default', name: 'Default' }, { id: 'work', name: 'Work' }];

describe('isBrowserProfileNameTaken', () => {
  it('refuses a second profile called the same, spaces and case aside', () => {
    expect(isBrowserProfileNameTaken('Default', profiles)).toBe(true);
    expect(isBrowserProfileNameTaken('  default ', profiles)).toBe(true);
    expect(isBrowserProfileNameTaken('Personal', profiles)).toBe(false);
  });

  it('lets a profile keep its own name when renamed', () => {
    expect(isBrowserProfileNameTaken('Default', profiles, 'default')).toBe(false);
    expect(isBrowserProfileNameTaken('Work', profiles, 'default')).toBe(true);
  });
});
