import { useEffect } from 'react'
import { replica, useReplica, type Reading } from '../../lib/replica'
import type { MarketOffer } from '../extensionBundle/installOffers'
import { appsHere } from './appsHere'

/**
 * The market's Apps this device can install (161 10-15), read from the index in hand (never fetched for a file). Pushed by
 * `appsHere.onMarketChanged`. Unreadable is the reading's error (❌ an empty market). Not kept (≈1.7 KB per App).
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
    // A value from before the watch may have missed a change: read it again.
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
