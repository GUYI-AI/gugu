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
  watch: { start: () => appsHere!.onMarketChanged(() => void marketOffers.refresh()) },
})


/** What the market offers here, while `asked` (false: nothing asked, unknown). */
export function useMarketOffers(asked: boolean): Reading<MarketOffer[]> {
  return useReplica(marketOffers, asked && appsHere ? [] : null)
}
