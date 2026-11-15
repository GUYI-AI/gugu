import { useEffect } from 'react'
import { replica, useReplica, type Reading } from '../../lib/replica'
import type { MarketOffer } from '../extensionBundle/installOffers'
import { appsHere } from './appsHere'

/**
 * The market's Apps this device can install, each its version for here (161 10-15): what a group's 「用 X 打开 · 安装」 offer
 * and a widget's offer look among. Read from the index in hand (main's cache on the desktop, the phone's own), never
 * fetched for a file. Device scope, no arguments: `appsHere` is this device's App host (main, or the phone's store). Host push: the index fetched again and
 * changed (`appsHere.onMarketChanged`) reads it again, through one module-level watcher counted by the surfaces showing it.
 * A market that cannot be read is the reading's error (❌ an empty market). Not kept across restarts (≈1.7 KB per App).
 */
export const marketOffers = replica({
  name: 'marketOffers',
  scope: 'device',
  read: async (): Promise<MarketOffer[]> => {
    if (!appsHere) throw new Error('Apps do not run here')
    const answer = await appsHere.marketOffers()
    if (!answer.success || !answer.data) throw new Error(answer.error ?? 'The App market could not be read')
    return answer.data
  },
  fresh: Infinity,
})

let users = 0
let stop: (() => void) | null = null

function watch(): () => void {
  if (users++ === 0 && appsHere) {
    stop = appsHere.onMarketChanged(() => void marketOffers.refresh())
    // A value from before the watch began may have missed a change: read it again (❌ a first read on its way).
    if (marketOffers.peek().state === 'value') void marketOffers.refresh()
  }
  return () => {
    if (--users === 0) {
      stop?.()
      stop = null
    }
  }
}

/** What the market offers here, while `asked` (false: nothing asked, unknown). */
export function useMarketOffers(asked: boolean): Reading<MarketOffer[]> {
  const reading = useReplica(marketOffers, asked && appsHere ? [] : null)
  useEffect(() => (asked && appsHere ? watch() : undefined), [asked])
  return reading
}
