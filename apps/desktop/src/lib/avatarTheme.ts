import { useSyncExternalStore } from 'react'
import { readEffectiveHostTheme, subscribeToHostTheme } from '../session/renderer/lib/theme/host-theme'

/** Subscribe directly so avatars in every React root follow the host's actual theme. */
export function useAvatarTheme() {
  return useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
}
export { readEffectiveHostTheme as readAvatarTheme } from '../session/renderer/lib/theme/host-theme'
