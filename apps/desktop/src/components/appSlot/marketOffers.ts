import { replica } from '../../lib/replica'
import type { MarketOffer } from '../extensionBundle/installOffers'
import { appsHere } from './appsHere'

/** The market's Apps this device can install (161 10-15), from the index in hand, pushed by `appsHere.onMarketChanged`. */
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

