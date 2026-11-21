import { replica, useReplica, type Reading } from '../../lib/replica'
import { useEffect } from 'react'
import { marketUpdates, PHONE_HOST, type MarketUpdates } from '@/session/renderer/features/extensions/installed-extensions'
import type { CloudMarketEntry, MarketListItem } from '@/session/shared/extensions/market'
import { definePhoneMarket } from '@/session/renderer/features/extensions/market-replicas'
import { keepShelf, keptShelfItems } from '@/session/renderer/features/extensions/panel/kept-shelf'
import { searchApps } from '@/session/shared/extensions/app-search'
import { marketCategoryOf, marketCategoryRank } from '@/session/shared/extensions/catalog'
import type { ProductPageApi } from '@/session/renderer/features/extensions/panel/app-product-page'
import type { AppPlatform } from '@shared/extensions/app-platforms'
import { phoneApps } from '../appSlot/phoneApps'

export { PHONE_HOST }

/** Where the last catalog drawn is kept for the next start's first frame (kept-shelf.ts). */
const shelfKey = (platform: AppPlatform) => platform === 'phone' ? PHONE_HOST : 'phone-desktop-market'

/**
 * The market catalog the phone browses, per platform it is for (`phone`: Apps for this phone; `desktop`: Apps for the
 * person's computers). Read from the phone's App store; read again when the store fetches a changed index.
 */
export const phoneMarketCatalog = replica({
  name: 'phoneMarketCatalog',
  scope: 'device',
  read: async (_owner: string, platform: AppPlatform): Promise<{ entries: CloudMarketEntry[] }> => {
    const entries = await (platform === 'phone' ? phoneApps.market.entries() : phoneApps.market.entries(false, platform))
    keepShelf(shelfKey(platform), entries, null)
    return { entries }
  },
  local: (_owner: string, platform: AppPlatform) => {
    const kept = keptShelfItems<CloudMarketEntry, null>(shelfKey(platform))
    return kept ? { entries: kept.items } : undefined
  },
  fresh: Infinity,
  watch: { start: () => phoneApps.market.onRefreshed((refreshed) => { if (refreshed.outcome === 'changed') void phoneMarketCatalog.refresh() }) },
})

export function phoneMarketRows(entries: Awaited<ReturnType<typeof phoneApps.market.entries>>, query: string): MarketListItem[] {
  const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]))
  const records = entries.map((entry) => ({ ...entry, state: 'market' as const }))
  return searchApps(records, { query }).items.map((record) => marketItem(byId.get(record.manifest.id)!)).sort((a, b) =>
    marketCategoryRank(marketCategoryOf(a.manifest)) - marketCategoryRank(marketCategoryOf(b.manifest)) ||
    a.manifest.name.localeCompare(b.manifest.name) || a.manifest.id.localeCompare(b.manifest.id),
  )
}

export function phoneSearchRows(items: readonly MarketListItem[], query: string): MarketListItem[] {
  return phoneMarketRows(items.map(({ manifest, cloud }) => ({ manifest, ...cloud }) as CloudMarketEntry), query)
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

/** `marketUpdates('phone')` (owner 10-19): the offered version per App installed from the market, and ones no longer there. */
export function useOfferedVersions(): Reading<MarketUpdates> {
  const reading = useReplica(marketUpdates, [PHONE_HOST])
  useEffect(() => {
    // 「更新到 vX」 from the index in hand at once; the download site is asked behind it, and when the index it brings is
    // another, the buttons are read again from that one (market-snapshot.ts).
    const offRefreshed = phoneApps.market.onRefreshed((refreshed) => refreshed.outcome === 'changed' && void marketUpdates.refresh(PHONE_HOST))
    // @@@effect-flow(command) - asks the phone's store to fetch the market index; its answer arrives as the onRefreshed push above
    void phoneApps.market.refresh()
    return offRefreshed
  }, [])
  return reading
}

definePhoneMarket({
  marketListing: phoneProductApi.marketListing,
  marketHistory: phoneProductApi.marketHistory,
  onRefreshed: (listener) => phoneApps.market.onRefreshed(listener),
})
