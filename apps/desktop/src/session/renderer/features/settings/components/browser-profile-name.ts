import type { BrowserProfile } from '@shared/browser';

/**
 * Whether another browser profile is already called `name` (trimmed, letters' case ignored): two profiles both called
 * 「Default」 cannot be told apart in the default-profile menu. `exceptId` = the profile being renamed.
 */
export function isBrowserProfileNameTaken(name: string, profiles: readonly BrowserProfile[], exceptId?: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  return profiles.some((profile) => profile.id !== exceptId && profile.name.trim().toLocaleLowerCase() === wanted);
}
