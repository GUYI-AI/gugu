// @vitest-environment jsdom
import {act} from 'react'
import type {Session} from '@supabase/supabase-js'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness,waitForCondition} from '../../../support/testHarness'
import { assistantPanel } from '../../../../apps/desktop/src/components/assistant/assistant-panel-replica'
// A panel snapshot changing (the replica the connections watch follows): an assistant's panel entry is written.
const panelChanged = () => assistantPanel.set(['assistant-under-test'], { revision: String(Date.now()) } as never)
import {IntegrationsProvider,useIntegrationsContext} from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import {connectorState} from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-connector-status'
import {assistantApplicationCounts} from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'
import {publishRendererSession} from '../../../../apps/desktop/src/lib/sessionPublication'
const f=vi.hoisted(()=>({account:null as null|'ok'|'reauth',readFails:false,host:null as unknown,hosts:new Map<string,unknown>(),run:0}))
vi.mock('@renderer/features/library/library-host',()=>({useLibraryHost:()=>f.host,keepLibraryHost:(h:{key:string})=>{f.hosts.set(h.key,h);return h},libraryHostOf:(k:string)=>f.hosts.get(k),peekLibraryHost:(k:string)=>f.hosts.get(k),isTooOld:()=>false}))
vi.mock('@renderer/lib/chat/chat-mention-provider',()=>({registerIssueMentionIcons:vi.fn()}))
vi.mock('@/components/assistant/assistant-app-client',()=>({reportAssistantAppChange:vi.fn(async()=>{})}))
vi.mock('@renderer/lib/ipc',()=>({rpcOn:()=>({})}))
// The assistant's panel rows its connection list is read from (`connectionList`): the catalog entry and, once saved, the account.
const failure=()=>Object.assign(Error('snapshot unavailable'),{code:'transport-failed'})
const rows=()=>[{resource_key:'catalog:dingtalk',data:{providerId:'dingtalk'}},
 ...(f.account?[{resource_key:'account',observed_at:'2026-10-26',data:{providerId:'dingtalk',accountId:'default',configured:true,checkResult:f.account,checkedAt:50}}]:[])]
let h:ReturnType<typeof createReactHarness>,connect:()=>Promise<unknown>
function Probe(){
 const v=useIntegrationsContext()
 connect=()=>v.connectIntegration('dingtalk',{})
 const count=v.integrations&&v.configuredConnections&&v.connectionStatus?assistantApplicationCounts(v.integrations,v.configuredConnections,v.connectionStatus,{absent:true}).connected:'?'
 return <div data-testid="state" data-state={connectorState(v.configuredConnections?.dingtalk,v.connectionStatus?.dingtalk,v.connectionCheckError ?? v.configuredConnectionsError,true)} data-has-list={v.hasList}>{v.connectionStatus?.dingtalk?.connected?'connected':'off'}|{String(v.configuredConnections?.dingtalk===true)}|{count}</div>
}
beforeEach(()=>{
 f.account=null;f.readFails=false;h=createReactHarness();f.run+=1
 publishRendererSession('SIGNED_IN',{user:{id:'connection-refresh-owner'},access_token:'fixture'} as Session)
 const panel={ownerId:`owner-${f.run}`,assistantId:'assistant-under-test',deviceId:'home',invalidate:vi.fn(()=>panelChanged()),
  collection:async()=>{if(f.readFails)throw failure();return rows()},snapshot:async()=>{if(f.readFails)throw failure();return {items:[],application:[]}}}
 f.host={key:`panel:owner:assistant:${f.run}`,assistantPanelExpected:true,assistantPanel:panel,integrations:{
  connect:async()=>{f.account='ok';return{success:true}},
 }}
})
afterEach(()=>{h.cleanup()})
async function mount(){await h.render(<IntegrationsProvider><Probe/></IntegrationsProvider>);await waitForCondition(()=>h.container.textContent==='off|false|0','initial state')}
it('refreshes the mounted detail state, list state and profile count after authorization completes',async()=>{
 await mount()
 await act(async()=>{await connect()})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','updated connection state')
 expect((f.host as {assistantPanel:{invalidate:unknown}}).assistantPanel.invalidate).toHaveBeenCalledOnce()
})
it('receives another surface’s connection publication without reopening the page',async()=>{
 await mount()
 await act(async()=>{f.account='ok';panelChanged()})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','updated connection state')
})

it('keeps the last published connection during a failed cloud refresh and applies a later authorization failure',async()=>{
 await mount()
 await act(async()=>{await connect()})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','connected')
 await act(async()=>{f.readFails=true;panelChanged()})
 const state=h.container.querySelector('[data-testid="state"]')!
 expect(state.getAttribute('data-state')).toBe('connected')
 expect(state.getAttribute('data-has-list')).toBe('true')
 await act(async()=>{f.readFails=false;f.account=null;panelChanged()})
 await waitForCondition(()=>h.container.textContent==='off|false|0','published disconnect')
 expect(state.getAttribute('data-state')).toBe('notConnected')
 // A new credential result is still authoritative even though an earlier read failed.
 await act(async()=>{f.account='reauth';panelChanged()})
 await waitForCondition(()=>state.getAttribute('data-state')==='needsReauth','published authorization failure')
 expect(state.getAttribute('data-state')).toBe('needsReauth')
})
