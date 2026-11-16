import { useEffect } from 'react'
import { events, rpc } from '@/session/renderer/lib/ipc'
import { replica } from '@/lib/replica'
import { fetchInstalledApps, LOCAL_HOST, type InstalledApps } from '@/session/renderer/features/extensions/installed-extensions'
import type { ExtensionManifest } from '@/session/shared/extensions/manifest'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'
import type { ComposerActionView } from '@/session/shared/extensions/composer-actions'
import type { GrantedSurfaceBinding, StoredUnreadBinding } from '@/session/shared/extensions/unread-binding'

/**
 * #1925 / #1927 What main grants this account's Apps over its conversations. Pushed by main's inventory channel
 * (`useAppBindingPush`). Not kept across restarts: an authority stamp is checked again after a restart.
 */

/** One App as installed here: what its update, or a reinstall from another publisher, changes. Another App's never does. */
export function installedAs(installed: InstalledApps, manifest: ExtensionManifest): string {
  return JSON.stringify([manifest, installed.origins[manifest.id] ?? null, installed.publishers[manifest.id] ?? null])
}

/** Each App's binding as main verified it, and each App as installed when it was read (a later change lapses it). */
export type SurfaceBindings = { bindings: Record<string, GrantedSurfaceBinding>; installed: Record<string, string> }

export const appSurfaceBindings = replica({
  name: 'appSurfaceBindings',
  scope: 'account',
  read: async (owner: string): Promise<SurfaceBindings> => {
    const apps = await fetchInstalledApps(LOCAL_HOST)
    const installed = Object.fromEntries(apps.manifests.map((manifest) => [manifest.id, installedAs(apps, manifest)]))
    const result = await rpc.extensions.conversationSurfaceBindings({ ownerId: owner })
    if (!result.success || result.data.ownerId !== owner) throw new Error('App conversation surface authority unavailable')
    return { bindings: result.data.bindings, installed }
  },
  fresh: Infinity,
})

export const appUnreadBindings = replica({
  name: 'appUnreadBindings',
  scope: 'account',
  read: async (owner: string): Promise<Record<string, StoredUnreadBinding>> => {
    const result = await rpc.extensions.conversationUnreadBindings({ ownerId: owner })
    if (!result.success || result.data.ownerId !== owner) throw new Error('Unread binding authority unavailable')
    return result.data.bindings
  },
  fresh: Infinity,
})

export const appComposerActions = replica({
  name: 'appComposerActions',
  scope: 'account',
  read: async (owner: string, extensionId: string, authority: string): Promise<ComposerActionView[]> => {
    const result = await rpc.extensions.conversationComposerActions({ ownerId: owner, extensionId, authority })
    if (!result.success) throw new Error(result.error)
    return result.data.actions
  },
  fresh: Infinity,
})

/** A note from main: the App it names is undrawn at once; everything is read again. */
export function inventoryChanged(note: { extensionId?: string } | undefined): void {
  const extensionId = note?.extensionId
  if (extensionId) {
    const without = (old: SurfaceBindings | undefined) => {
      if (!old || !(extensionId in old.bindings)) return old
      const { [extensionId]: _gone, ...bindings } = old.bindings
      return { ...old, bindings }
    }
    if (appSurfaceBindings.peek().state === 'value') appSurfaceBindings.at().set(without)
  }
  void appSurfaceBindings.refresh()
  void appUnreadBindings.refresh()
  // A note naming no App may be about any of them.
  void appComposerActions.refresh(...(extensionId ? [extensionId] as [string] : []))
}

let users = 0
let stop: (() => void) | null = null
/** The composer entries shown in this run: what the watcher reads again when it starts. */
const composerEntries = new Map<string, [extensionId: string, authority: string]>()

/** Follow main's notes while a surface shows any of these (ref-counted, one subscription for all of them). */
function watch(): () => void {
  if (users++ === 0) {
    stop = events.on(extensionsInventoryChangedChannel, inventoryChanged)
    // Values from before the watch may have missed a note: read again what is already there.
    if (appSurfaceBindings.peek().state === 'value') void appSurfaceBindings.refresh()
    if (appUnreadBindings.peek().state === 'value') void appUnreadBindings.refresh()
    for (const args of composerEntries.values()) {
      if (appComposerActions.peek(...args).state === 'value') void appComposerActions.refresh(...args)
    }
  }
  return () => {
    if (--users === 0) {
      stop?.()
      stop = null
    }
  }
}

export function useAppBindingPush(active: boolean, composer?: [extensionId: string, authority: string]): void {
  const [extensionId, authority] = composer ?? []
  useEffect(() => {
    if (!active) return
    if (extensionId !== undefined && authority !== undefined) composerEntries.set(JSON.stringify([extensionId, authority]), [extensionId, authority])
    return watch()
  }, [active, extensionId, authority])
}
