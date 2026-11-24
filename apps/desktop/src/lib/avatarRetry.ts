/**
 * @@@avatar-retry — a picture that failed to load gets one more try when the network comes back or the window is
 * focused again. Without it a failure stuck for good while its url stayed the same: a short backend outage at app start
 * left avatars blank until their row remounted (yangchichi 11-24). One generation for every avatar, bumped by those two
 * events; only avatars that failed listen (Avatar), so a focus does not re-render the rest.
 */
let generation = 0
const listeners = new Set<() => void>()

function bump(): void {
  generation += 1
  for (const listener of listeners) listener()
}

export function subscribeAvatarRetry(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('online', bump)
    window.addEventListener('focus', bump)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('online', bump)
      window.removeEventListener('focus', bump)
    }
  }
}

export function avatarRetryGeneration(): number {
  return generation
}

/** An avatar that has not failed listens to nothing. */
export function subscribeNoAvatarRetry(): () => void {
  return () => {}
}
