import { readSelfIdentityBridge } from './selfIdentityBridge'

export interface UnfinishedAgentCreateView {
  ownerUserId: string
  rows: ReadonlyArray<{ operationId: string; name: string }>
  busy: boolean
  run: (operationId: string, action: 'continue' | 'delete') => void
}
const KEY = '__GUGU_UNFINISHED_AGENT_CREATES__'
const EVENT = 'gugu:unfinished-agent-creates'
type BridgeWindow = Window & { [KEY]?: UnfinishedAgentCreateView }

// Separate renderer bundle: only display fields and explicit actions cross this boundary.
export function publishUnfinishedAgentCreates(view: UnfinishedAgentCreateView | null): void {
  const target = window as BridgeWindow
  if (view) target[KEY] = view
  else delete target[KEY]
  window.dispatchEvent(new Event(EVENT))
}
export function readUnfinishedAgentCreates(): UnfinishedAgentCreateView | null {
  const view = (window as BridgeWindow)[KEY]
  return view?.ownerUserId === readSelfIdentityBridge()?.getSnapshot()?.userId ? view ?? null : null
}
export function subscribeUnfinishedAgentCreates(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  const offIdentity = readSelfIdentityBridge()?.subscribe(listener)
  return () => { window.removeEventListener(EVENT, listener); offIdentity?.() }
}
