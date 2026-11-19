// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * The market's offers for this device (`marketOffers`, a device replica): read from the index in hand, read again when the
 * index was fetched again and changed (a host push through one ref-counted watcher), an unreadable market is an error.
 */
const host = vi.hoisted(() => ({ listeners: new Set<() => void>(), offers: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: {
    marketOffers: host.offers,
    onMarketChanged: (listener: () => void) => { host.listeners.add(listener); return () => { host.listeners.delete(listener) } },
  },
}))
const { useMarketOffers, marketOffers } = await import('../../../../apps/desktop/src/components/appSlot/marketOffers')
const { queryClient } = await import('../../../../apps/desktop/src/lib/replica')

const offer = (id: string) => ({ manifest: { id }, version: '1.0.0' })
let root: Root
let seen: ReturnType<typeof useMarketOffers>
function Probe({ asked }: { asked: boolean }) {
  seen = useMarketOffers(asked)
  return null
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const render = async (asked = true) => { await act(async () => root.render(<Probe asked={asked} />)); await settle() }

beforeEach(() => {
  queryClient.clear()
  host.listeners.clear()
  host.offers.mockReset().mockResolvedValue({ success: true, data: [offer('vote')] })
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(async () => root.unmount()))

describe('marketOffers', () => {
  it('nothing asked: unknown, and no read; asked: the offers of the index in hand, read once', async () => {
    await render(false)
    expect(seen.state).toBe('unknown'); expect(host.offers).not.toHaveBeenCalled()
    await render(true)
    expect(seen).toMatchObject({ state: 'value', value: [offer('vote')] })
    await render(true)
    expect(host.offers).toHaveBeenCalledTimes(1)
  })

  it('the index fetched again and changed: read again where shown (one watcher, however many surfaces)', async () => {
    await render()
    expect(host.listeners.size).toBe(1)
    host.offers.mockResolvedValue({ success: true, data: [offer('vote'), offer('poll')] })
    await act(async () => { for (const listener of host.listeners) listener() })
    await settle()
    expect(seen.state === 'value' && seen.value.map((entry) => entry.manifest.id)).toEqual(['vote', 'poll'])
    await act(async () => root.unmount())
    expect(host.listeners.size).toBe(0)
    root = createRoot(document.createElement('div'))
  })

  it('an unreadable market is the reading\'s error, ❌ an empty market', async () => {
    host.offers.mockResolvedValue({ success: false, error: 'unreadable' })
    await render()
    expect(seen.state).toBe('error')
    await expect(marketOffers.fetch()).rejects.toThrow('unreadable')
  })
})
