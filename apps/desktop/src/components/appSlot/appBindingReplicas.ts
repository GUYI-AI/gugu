import { events, rpc } from '@/session/renderer/lib/ipc'
import { replica } from '@/lib/replica'
import { fetchInstalledApps, LOCAL_HOST, type InstalledApps } from '@/session/renderer/features/extensions/installed-extensions'
import type { ExtensionManifest } from '@/session/shared/extensions/manifest'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'
import type { ComposerActionView } from '@/session/shared/extensions/composer-actions'
import type { GrantedSurfaceBinding, StoredUnreadBinding } from '@/session/shared/extensions/unread-binding'

/**
 * #1925 / #1927 What main grants this account's Apps over its conversations. Pushed by main's inventory channel
 * (each model's `watch`). Not kept across restarts: an authority stamp is checked again after a restart.
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
  // A note naming an App undraws it at once (a later install changes what it was granted); everything is read again.
  watch: {
    start: () => events.on(extensionsInventoryChangedChannel, (note?: { extensionId?: string }) => {
      const extensionId = note?.extensionId
      if (extensionId && appSurfaceBindings.peek().state === 'value') {
        appSurfaceBindings.at().set((old) => {
          if (!old || !(extensionId in old.bindings)) return old
          const { [extensionId]: _gone, ...bindings } = old.bindings
          return { ...old, bindings }
        })
      }
      void appSurfaceBindings.refresh()
    }),
  },
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
  watch: { start: () => events.on(extensionsInventoryChangedChannel, () => { void appUnreadBindings.refresh() }) },
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
  // A note naming no App may be about any of them.
  watch: {
    group: (extensionId) => extensionId,
    start: (_owner, extensionId) => events.on(extensionsInventoryChangedChannel, (note?: { extensionId?: string }) => {
      if (!note?.extensionId || note.extensionId === extensionId) void appComposerActions.refresh(extensionId)
    }),
  },
})
