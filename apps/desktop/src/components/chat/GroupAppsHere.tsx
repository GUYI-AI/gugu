import { rendererLogger } from '@/lib/log'
import { replica, useReplica } from '../../lib/replica'
import { useAuth } from '../../store/auth'
import { isInstallRefused } from '../../session/shared/extensions/attachment-install'
import { useInstalledApps, type RailApp } from '../../session/renderer/features/extensions/installed-extensions'
import { appsHere } from '../appSlot/appsHere'
import { HERE_HOST } from '../appSlot/hereHost'
import { sharedAppPackages } from '../extensionBundle/packageReplicas'
import { installPackageOf, type PackageCard } from '../extensionBundle/sharedPackages'

const log = rendererLogger('chat/group-apps')

/** A group App of this group: installed here, or only shared here as a card (installed from it when picked). */
export type GroupApp = RailApp & { card?: PackageCard }

/** Which of these Apps have a file in this group's folder (`appInChat`); one that cannot be asked is left out and logged, not all of them. */
export async function appsWithFilesIn(chatId: string, extensionIds: readonly string[]): Promise<string[]> {
  if (!appsHere) return []
  const ids = await Promise.all(extensionIds.map(async (extensionId) => {
    try {
      const result = await appsHere!.appInChat({ chatId, extensionId })
      if (!result.success) log.warn({ appId: extensionId, chatId, error: result.error }, 'could not read whether a group App is in this group')
      return result.success && result.data && 'files' in result.data && result.data.files.length > 0 ? extensionId : null
    } catch (error) {
      log.warn({ appId: extensionId, chatId, error }, 'could not read whether a group App is in this group')
      return null
    }
  }))
  return ids.filter((id): id is string => id !== null)
}

/** The installed group Apps (space-separated ids) that have a file in a chat's folder — its `claimedBy`, as `appInChat` answers it. */
export const groupAppsWithFiles = replica({
  name: 'groupAppsWithFiles',
  scope: 'account',
  read: async (_owner: string, chatId: string, extensionIds: string): Promise<string[]> => appsWithFilesIn(chatId, extensionIds.split(' ').filter(Boolean)),
})

/**
 * The group Apps that are in this group, for its side panel (owner 11-27: an App is opened beside the group it is in);
 * null until it is known. An installed App is in the group when the group's folder has a file it opens, however the file
 * got there; one not installed here is in it when its card was shared here.
 */
export function useGroupApps(chatId: string): GroupApp[] | null {
  const installed = useInstalledApps(HERE_HOST)
  const { user } = useAuth()
  const shared = useReplica(sharedAppPackages, appsHere && user?.id ? [chatId] : null)
  // Apps that open a chat's files and name none of their own (`chatFile`: asking for those makes their file).
  const candidates = installed.state === 'value'
    ? installed.value.appsIn('chat').filter((app) => !installed.value.mainTabOf(app.extensionId)
      && !installed.value.manifestFor(app.extensionId)?.contributes.tabs.some((tab) => tab.chatFile))
    : null
  const withFiles = useReplica(groupAppsWithFiles, appsHere && candidates ? [chatId, candidates.map((app) => app.extensionId).join(' ')] : null)
  if (installed.state !== 'value' || !candidates || withFiles.state !== 'value') return null
  const here = candidates.filter((app) => withFiles.value.includes(app.extensionId))
  const cards = shared.state === 'value'
    ? shared.value.filter((pkg) => !installed.value.manifestFor(pkg.appId))
      .map((pkg): GroupApp => ({ extensionId: pkg.appId, name: pkg.manifest.name, kind: '', iconDataUrl: null, card: pkg.card }))
    : null
  return cards ? [...here, ...cards] : here
}

/** A group App picked in its group's side panel: opened there, or installed from its card first — the card's own install, its consent included. */
export async function openGroupApp(app: GroupApp, chatId: string, open: (extensionId: string) => void): Promise<void> {
  if (!app.card) return open(app.extensionId)
  if (!appsHere) return
  const result = await appsHere.installAttachment({ ...installPackageOf(app.card), chatId })
  if (!result.success) return log.error({ appId: app.extensionId, error: result.error }, 'the group App picked in its group did not install')
  if (result.data && isInstallRefused(result.data)) return log.info({ appId: app.extensionId, reason: result.data.reason }, 'the group App picked in its group was refused')
  open(app.extensionId)
}
