// The page header's three connection states (shared with the phone: components/connection) read off the desktop's
// richer per-machine state (hostConnectionState). Only the link is said here; sign-in and version problems are not a
// connection state and keep their own outlet (the scope notice / chat row), so the header shows nothing for them.
import type { ConnectionState } from '@/components/connection/connectionState';
import type { HostConnectionState } from './connection-status';

export function headerConnectionState(state: HostConnectionState | null): ConnectionState | null {
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
