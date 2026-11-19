import { readSelfIdentityBridge } from './selfIdentityBridge'
import { createSelectStore, type SelectStore } from './selectStore'

export interface UnfinishedAgentCreateView {
  ownerUserId: string
  busy: boolean
  run: (operationId: string, action: 'continue' | 'delete') => void
}
const KEY = '__GUGU_UNFINISHED_AGENT_CREATES__'
type BridgeWindow = Window & { [KEY]?: SelectStore<UnfinishedAgentCreateView | null> }
const store = () => {
  const target = window as BridgeWindow
  return target[KEY] ??= createSelectStore<UnfinishedAgentCreateView | null>(null)
}

// Only the cross-component interaction controller. Rows are read through their account replica.
export function publishUnfinishedAgentCreates(view: UnfinishedAgentCreateView | null): void {
  store().publish(view)
  store().notify()
}
export function readUnfinishedAgentCreates(): UnfinishedAgentCreateView | null {
  const view = store().get()
  return view?.ownerUserId === readSelfIdentityBridge()?.getSnapshot()?.userId ? view ?? null : null
}
export function subscribeUnfinishedAgentCreates(listener: () => void): () => void {
  const offView = store().subscribe(listener)
  const offIdentity = readSelfIdentityBridge()?.subscribe(listener)
  return () => { offView(); offIdentity?.() }
}
