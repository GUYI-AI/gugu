// Shared header glyphs: SSH surfaces add the observed cause and recovery action beside the glyph.
import type { ConnectionState } from '@/components/connection/connectionState';
import { isSshAttention, type HostConnectionState } from './connection-status';

export function headerConnectionState(state: HostConnectionState | null): ConnectionState | null {
  if (isSshAttention(state)) return state === 'waitingIdle' ? 'connecting' : 'device_offline';
  switch (state) {
    case 'connected':
      return 'online';
    // The directory still lists it, or a cloud computer is asleep / being woken: reads keep retrying.
    case 'connecting':
    case 'reconnecting':
    case 'asleep':
    case 'waking':
      return 'connecting';
    case 'offline':
    case 'wake-failed':
      return 'device_offline';
    case 'sign-in':
    case 'outdated':
    case 'updating':
    case 'update-failed':
    case null:
      return null;
  }
}
