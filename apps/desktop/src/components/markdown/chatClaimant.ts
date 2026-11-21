import { claimantOf, type FileOpenerCandidate } from '@shared/extensions/file-openers'
import type { InstalledApps } from '@/session/renderer/features/extensions/installed-extensions'

/** The App on this device that opens a chat's file of this name — a tap's answer (`claimantOf`) — or null. */
export function chatClaimantHere(installed: InstalledApps, name: string): FileOpenerCandidate | null {
  const apps = installed.manifests.filter((manifest) => installed.isEnabled(manifest.id))
  return claimantOf(name, apps, 'chat', (key) => installed.openWithDefaults[key] ?? null)
}
