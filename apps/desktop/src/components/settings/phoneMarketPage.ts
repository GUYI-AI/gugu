import { reaction } from 'mobx'
import { useEffect, useState } from 'react'
import { chatDb } from '@/lib/supabase'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { rendererLogger } from '@/lib/log'
import type { CloudMarketEntry, MarketListItem } from '@/session/shared/extensions/market'
import { marketHome, type MarketHome } from '@/session/shared/extensions/market-home'
import { keepShelf, keptShelf } from '@/session/renderer/features/extensions/panel/kept-shelf'
import { searchApps } from '@/session/shared/extensions/app-search'
import { marketCategoryOf, marketCategoryRank } from '@/session/shared/extensions/catalog'
import type { ProductPageApi } from '@/session/renderer/features/extensions/panel/app-product-page'
import { phoneApps } from '../appSlot/phoneApps'

const log = rendererLogger('app-slot/phone-market-page')

/** Only transport differs: the same catalog and home/search rules as the desktop. */
export async function readPhoneMarketPage() {
  const ranking = Promise.resolve(chatDb.rpc('market_install_ranking')).then(({ data, error }) => {
    if (error) throw error
    return new Map(((data ?? []) as { app_id: string; score: number }[]).map((row) => [row.app_id, row.score]))
  }).catch((error: unknown) => {
    log.warn({ error: String(error) }, 'App market install ranking unreadable')
    return null
  })
  const [entries, scores] = await Promise.all([phoneApps.market.entries(), ranking])
  const home = marketHome(entries, scores)
  keepShelf(PHONE_HOST, entries, home, null)
  return pageOf(entries, home)
}

/** 这台手机在市场缓存里的名字(桌面按机器分,手机只有自己)。 */
export const PHONE_HOST = 'phone'

/** 上次画出来的那一页(kept-shelf.ts):重启后第一帧先画它,❌ 等排名那一趟网络。 */
export function keptPhoneMarketPage() {
  const kept = keptShelf<CloudMarketEntry, null>(PHONE_HOST)
  return kept ? pageOf(kept.items, kept.home) : undefined
}

function pageOf(entries: CloudMarketEntry[], home: MarketHome<CloudMarketEntry>) {
  return {
    entries,
    featured: home.featured.map(marketItem),
    home: {
      remaining: home.remaining.map(marketItem),
      newest: home.newest.map(marketItem),
      popular: home.popular === null ? null : home.popular.map(marketItem),
    },
  }
}

export function phoneMarketRows(entries: Awaited<ReturnType<typeof phoneApps.market.entries>>, query: string): MarketListItem[] {
  const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]))
  const records = entries.map((entry) => ({ ...entry, state: 'market' as const }))
  return searchApps(records, { query }).items.map((record) => marketItem(byId.get(record.manifest.id)!)).sort((a, b) =>
    marketCategoryRank(marketCategoryOf(a.manifest)) - marketCategoryRank(marketCategoryOf(b.manifest)) ||
    a.manifest.name.localeCompare(b.manifest.name) || a.manifest.id.localeCompare(b.manifest.id),
  )
}

function marketItem({ manifest, ...cloud }: CloudMarketEntry): MarketListItem {
  return { manifest, cloud, ref: { extensionId: manifest.id, version: cloud.version } }
}

export const phoneProductApi: ProductPageApi = {
  marketListing: async ({ extensionId, version }) => {
    try {
      return { success: true as const, data: await phoneApps.market.listing(extensionId, version) }
    } catch (error) {
      return { success: false as const, error: String(error) }
    }
  },
  // 桌面主进程的 marketRead 同一个形状:页面那一套(精选卡的首帧占位图)两端一样调。
  marketRead: async ({ path }) => {
    try {
      const bytes = await phoneApps.market.media(path)
      let binary = ''
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
      return { success: true as const, data: { base64: btoa(binary) } }
    } catch (error) {
      return { success: false as const, error: String(error) }
    }
  },
  marketHistory: async ({ extensionId }) => {
    try {
      return { success: true, data: await phoneApps.market.history(extensionId) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },
}

/**
 * The version the market offers this phone for each App installed here from it, and the ones no longer in the market (owner
 * 10-19, as the desktop says); null when the market was not reached. Since owner 10-19 they also update by themselves
 * (phoneApps `autoUpdate`); here the person sees one is waiting, and its settings page offers it.
 */
async function offeredVersions(): Promise<{ updates: Record<string, string>; gone: string[] } | null> {
  const result = await phoneApps.marketUpdates()
  return result.success
    ? { updates: Object.fromEntries(Object.entries(result.data.updates).map(([id, update]) => [id, update.version])), gone: result.data.gone ?? [] }
    : null
}

/** What the market says of the Apps installed here. 161 10-15: else their fixes never reach the phone. */
export function useOfferedVersions() {
  const [updates, setUpdates] = useState<Record<string, string>>({})
  const [gone, setGone] = useState<string[]>([])
  useEffect(() => {
    // 「更新到 vX」 from the index in hand at once; the download site is asked behind it, and when the index it brings is
    // another, the buttons are read again from that one (market-snapshot.ts) — none, if nothing came.
    const read = () =>
      void phoneApps.ready().then(offeredVersions).then((offered) => {
        if (!offered) return
        setUpdates(offered.updates)
        setGone(offered.gone)
      }, () => undefined)
    read()
    const offRefreshed = phoneApps.market.onRefreshed((refreshed) => refreshed.outcome === 'changed' && read())
    // What is installed changed (an App updated by itself, owner 10-19): what the market has to say about it is read again.
    const offInstalled = reaction(() => installedExtensionsStore.manifests.map((manifest) => `${manifest.id}@${manifest.version}`).join(' '), read)
    void phoneApps.market.refresh()
    return () => {
      offRefreshed()
      offInstalled()
    }
  }, [])
  return { updates, gone }
}
