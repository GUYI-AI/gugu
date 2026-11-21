// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {Session} from '@supabase/supabase-js'
import type {ChatChannelList} from '@gugu/core/cloud/chatChannels'
import {createReactHarness} from '../../../support/testHarness'
import {publishRendererSession} from '../../../../apps/desktop/src/lib/sessionPublication'
import {chatChannels} from '../../../../apps/desktop/src/components/connections/connection-replicas'
import {useReplica} from '../../../../apps/desktop/src/lib/replica'
const f=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('@/lib/chatChannels',()=>({rendererChatChannelsClient:()=>({list:f.list})}))
let h:ReturnType<typeof createReactHarness>
beforeEach(()=>{h=createReactHarness()})
const connected={kinds:['wechat'],channels:[{kind:'wechat',accountLabel:'test',agentId:null,isDefault:false,connectedAt:'2026-10-27',health:{state:'running'},lastInboundAt:null,lastOutboundAt:null}],suggestedAgentId:null} as ChatChannelList
// A view of the channels as WechatAppConnection reads them: the replica itself.
function Probe({id}:{id:string}){const r=useReplica(chatChannels,[]);return <span data-testid={id}>{r.state}|{r.state==='value'&&!('absent' in r.value)?r.value.channels.length:'-'}</span>}
const signIn=(owner:string)=>publishRendererSession('SIGNED_IN',{user:{id:owner},access_token:'fixture'} as Session)
afterEach(()=>{h.cleanup();publishRendererSession('SIGNED_OUT',null)})
it('a reopened view shows the connection read before on its first frame and keeps it when the service is offline',async()=>{
 signIn('wechat-local-owner');chatChannels.set([],connected)
 const network=Promise.withResolvers<ChatChannelList>();f.list.mockReturnValue(network.promise)
 await h.render(<Probe id="one"/>);expect(h.container.textContent).toBe('value|1')
 await act(async()=>{network.reject(Error('offline'))})
 expect(h.container.textContent).toBe('value|1')
})
it('updates every mounted app view after confirmation and clears visible state on an account switch',async()=>{
 signIn('wechat-update-owner');f.list.mockReturnValue(new Promise(()=>{}))
 await h.render(<><Probe id="one"/><Probe id="two"/></>)
 await act(async()=>chatChannels.at().set(connected))
 expect([...h.container.querySelectorAll('span')].map(e=>e.textContent)).toEqual(['value|1','value|1'])
 await act(async()=>signIn('different-account'))
 expect([...h.container.querySelectorAll('span')].every(e=>e.textContent==='unknown|-')).toBe(true)
})
