import { useEffect, useState } from 'react'
import { rendererLogger } from '@/lib/log'
import { useReplica } from '../../lib/replica'
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

/**
 * The group Apps that are in this group, for its side panel (owner 11-27: an App is opened beside the group it is in).
 * An installed App is in the group when the group's folder has a file it opens — the folder's `claimedBy`, as `appInChat`
 * answers it — however the file got there; one not installed here is in it when its card was shared here.
 */
export function useGroupApps(chatId: string): GroupApp[] {
  const reading = useInstalledApps(HERE_HOST)
  const installed = reading.state === 'value' ? reading.value : null
  const { user } = useAuth()
  const shared = useReplica(sharedAppPackages, appsHere && user?.id ? [chatId] : null)
  const [inGroup, setInGroup] = useState<readonly string[]>([])
  useEffect(() => {
    if (!installed || !appsHere) return
    let live = true
    // Apps that open a chat's files and name none of their own (`chatFile`: asking for those makes their file).
    const candidates = installed.appsIn('chat').filter((app) => !installed.mainTabOf(app.extensionId)
      && !installed.manifestFor(app.extensionId)?.contributes.tabs.some((tab) => tab.chatFile))
    void Promise.all(candidates.map(async (app) => {
      const result = await appsHere!.appInChat({ chatId, extensionId: app.extensionId })
      return result.success && result.data && 'files' in result.data && result.data.files.length > 0 ? app.extensionId : null
    })).then((ids) => { if (live) setInGroup(ids.filter((id): id is string => id !== null)) })
    return () => { live = false }
  }, [installed, chatId])
  if (!installed) return []
  const here = installed.appsIn('chat').filter((app) => inGroup.includes(app.extensionId))
  const cards = shared.state === 'value' ? shared.value.filter((pkg) => !installed.manifestFor(pkg.appId)) : []
  return [...here, ...cards.map((pkg): GroupApp => ({ extensionId: pkg.appId, name: pkg.manifest.name, kind: '', iconDataUrl: null, card: pkg.card }))]
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
