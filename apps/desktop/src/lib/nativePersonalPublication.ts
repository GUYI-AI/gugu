import { nativePersonalPublicationChannel } from '../session/shared/core/sessions/sessionEvents'

const observed = new Map<string, string>()
/** Native ACK is only a wake hint; the account journal remains the projection writer. */
export function reportNativePersonalPublication(accountId: string, revision?: string | null): void {
  if (revision == null) return
  if (!/^(0|[1-9]\d*)$/.test(revision)) throw new Error('Invalid native publication revision')
  if (BigInt(observed.get(accountId) ?? '0') >= BigInt(revision)) return
  observed.set(accountId, revision)
  window.dispatchEvent(new CustomEvent(nativePersonalPublicationChannel.name, { detail: { accountId, revision } }))
}
