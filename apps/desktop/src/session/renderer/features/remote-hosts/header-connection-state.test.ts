import { describe, expect, it } from 'vitest';
import type { HostConnectionState } from './connection-status';
import { headerConnectionState } from './header-connection-state';

describe('headerConnectionState', () => {
  it.each<[HostConnectionState | null, ReturnType<typeof headerConnectionState>]>([
    ['connected', 'online'],
    ['connecting', 'connecting'],
    ['asleep', 'connecting'],
    ['offline', 'device_offline'],
    ['wake-failed', 'device_offline'],
    ['sign-in', null],
    [null, null],
  ])('%s → %s', (state, expected) => {
    expect(headerConnectionState(state)).toBe(expected);
  });
});
