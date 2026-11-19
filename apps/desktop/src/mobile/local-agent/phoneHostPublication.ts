import type { IOSOwnerPublicationState } from '../ios-runtime/iosOwnerPublication'
import { rendererLogger } from '@/lib/log'

type Source = typeof import('../ios-runtime/startIOSOwnerPublication')
const waiting: IOSOwnerPublicationState = { status: 'waiting', binding: null, error: null }
let source: Source | null = null
let loading: Promise<Source> | null = null
let failure: IOSOwnerPublicationState | null = null
let stop: (() => void) | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())
const attach = () => {
  if (source && listeners.size && !stop) stop = source.subscribeIOSOwnerPublication(changed)
}

/** Read the existing App-root publication only on iOS. Never start an auth owner. */
function load(): Promise<Source> {
  if (source) return Promise.resolve(source)
  if (!loading) loading = import('../ios-runtime/startIOSOwnerPublication').then(value => {
    source = value; failure = null; attach(); changed(); return value
  }).catch(error => {
    loading = null
    rendererLogger('ios/phone-host').error({ error }, 'Cannot observe native phone identity')
    failure = { status: 'failed', binding: null, error: { code: 'publication_unavailable', message: 'Native phone identity is unavailable' } }
    changed(); throw error
  })
  return loading
}
export const getPhoneHostPublication = (): IOSOwnerPublicationState => source?.getIOSOwnerPublicationSnapshot() ?? failure ?? waiting
export function subscribePhoneHostPublication(listener: () => void): () => void {
  listeners.add(listener); attach()
  void load().catch(() => undefined) // Failure remains visible in the projection.
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { stop?.(); stop = null }
  }
}
export async function retryPhoneHostPublication(): Promise<void> {
  const current = await load()
  await current.retryIOSOwnerPublication()
}
