import { describe, expect, it, vi } from 'vitest'
import { phoneMarket } from '../../../../apps/desktop/src/components/appSlot/phoneMarket'
import { currentMarketHost, type CloudMarketEntry } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

function catalog() {
  const version = (version: string, publishedAt: string) => ({
    version, publishedAt,
    manifest: { id: 'notes', name: 'Notes', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['phone'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } },
    apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: '', sha256: 'a'.repeat(64), bytes: 10,
    bundle: `notes/${version}/app.guguext`, icon: `notes/${version}/icon.png`, source: { repo: 'owner/apps', path: 'notes', commit: 'a'.repeat(40) }, yanked: null,
  })
  return { version: 1, apps: [{ id: 'notes', deprecated: null, featured: true, versions: [version('2.0.0', '2026-10-20T00:00:00Z'), version('1.0.0', '2026-09-01T00:00:00Z')] }] }
}

function market() {
  const metas: Record<string, unknown> = {
    'meta/notes/2.0.0.json': { about: { en: 'Notes, kept.' }, screenshots: ['media/notes/preview.png'], releaseNotes: '' },
    'meta/notes/1.0.0.json': { releaseNotes: '', readme: null },
  }
  const read = vi.fn(async (path: string) => {
    if (path === 'index.json') return new TextEncoder().encode(JSON.stringify(catalog()))
    if (!(path in metas)) throw new Error(`404 ${path}`)
    return new TextEncoder().encode(JSON.stringify(metas[path]))
  })
  return {
    read,
    market: phoneMarket(read, () => currentMarketHost('9.0.0', 'phone'), { read: async () => null, write: async () => undefined }, undefined, (path) => `https://example.org/market/${path}`),
  }
}

describe('the phone market supplies the shared browsing and product components', () => {
  it('uses the selected version for the icon and retains the first release date for New', async () => {
    const { market: source } = market()
    expect(await source.entries()).toMatchObject([{ version: '2.0.0', firstPublishedAt: '2026-09-01T00:00:00Z', iconUrl: 'https://example.org/market/notes/2.0.0/icon.png' }])
  })

  it('reads only the requested version\'s store listing and never downloads the package to browse it', async () => {
    const { market: source, read } = market()
    expect(await source.listing('notes', '2.0.0')).toEqual({ about: { en: 'Notes, kept.' }, screenshots: ['https://example.org/market/media/notes/preview.png'] })
    expect(read.mock.calls.map(([path]) => path)).toEqual(['meta/notes/2.0.0.json'])
    await expect(source.listing('notes', '1.0.0')).rejects.toThrow(/notes@1\.0\.0 has no store listing/)
  })

  it('reports a failed read rather than caching it as an absent listing', async () => {
    const { market: source, read } = market()
    read.mockRejectedValueOnce(new Error('offline'))
    await expect(source.listing('notes', '2.0.0')).rejects.toThrow('offline')
  })
})

const page = vi.hoisted(() => ({ entries: vi.fn<() => Promise<CloudMarketEntry[]>>() }))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({ phoneApps: { market: { entries: page.entries, listing: async () => ({ about: {}, screenshots: [] }), onRefreshed: () => () => {} } } }))
const { phoneMarketCatalog, phoneMarketRows } = await import('../../../../apps/desktop/src/components/settings/phoneMarketPage')

describe('the phone\'s market catalog', () => {
  const ids = (items: { manifest: { id: string } }[]) => items.map((item) => item.manifest.id)

  it('lists every App once, and a search narrows it', async () => {
    const all = await market().market.entries()
    page.entries.mockResolvedValue(all)
    expect(ids((await phoneMarketCatalog.fetch('phone')).entries)).toEqual(['notes'])
    expect(ids(phoneMarketRows(all, 'notes'))).toEqual(['notes'])
    expect(phoneMarketRows(all, 'nothing-like-it')).toEqual([])
  })

  // 重启后第一帧(owner 10-30):上次画出来的那一份从 localStorage 同步读回来(`local`),❌ 先画骨架。
  it('keeps the catalog it read for the next start, each App stored once', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) })
    try {
      const all = await market().market.entries()
      page.entries.mockResolvedValue(all)
      await phoneMarketCatalog.refresh('phone')
      await phoneMarketCatalog.fetch('phone')
      const kept = stored.get('gugu.appsShelf.v1:phone')
      expect(kept && JSON.parse(kept).items.map((item: { manifest: { id: string } }) => item.manifest.id)).toEqual(['notes'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
