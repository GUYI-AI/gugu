// @vitest-environment jsdom
import { expect,it,vi } from 'vitest'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { useAssistantIntegrationSummaries } from '../../../../apps/desktop/src/components/assistant/useAssistantIntegrationSummaries'
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica'
// The detail entries are the signed-in account's replica (`assistantIntegrationDetail`).
followRendererSession('SIGNED_IN','summary-account')

it('keeps localized names and descriptions across fresh list arrays without another body read',async()=>{
 const h=createReactHarness(),renders:string[]=[]
 const body=vi.fn(async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'mail',name:'Mailbox',description:'English summary',auth:{methods:[]}},'zh-CN':{id:'mail',name:'邮箱',description:'中文说明',auth:{methods:[]}}})))
 const panel={ownerId:'cache-owner',assistantId:'cache-assistant',collection:async()=>[{resource_key:'catalog:mail',data:{providerId:'mail'}}],body} as unknown as AssistantPanelFiles
 const items=()=>[{id:'mail',name:'mail',description:'',metadataOnly:true}] as IntegrationMetadata[]
 function Probe({rows,locale}:{rows:IntegrationMetadata[];locale:string}){const value=useAssistantIntegrationSummaries(panel,rows,locale);const text=`${value[0]!.name}|${value[0]!.description}`;renders.push(text);return <span>{text}</span>}
 try{
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(h.container.textContent).toBe('Mailbox|English summary')
  const first=renders.length
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(renders.slice(first)).not.toContain('Application|')
  expect(h.container.textContent).toBe('Mailbox|English summary')
  expect(body).toHaveBeenCalledTimes(1)
  await h.render(<Probe rows={items()} locale="zh-CN"/> )
  expect(h.container.textContent).toBe('邮箱|中文说明')
  expect(body).toHaveBeenCalledTimes(2)
  const beforeEnglish=renders.length
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(renders.slice(beforeEnglish).every(text=>text==='Mailbox|English summary')).toBe(true)
  expect(body).toHaveBeenCalledTimes(2)
 }finally{h.cleanup()}
})

it('shares in-flight enrichment across list refreshes, keeps it after remount, and scopes it to the account',async () => {
 const h=createReactHarness(),pending=Promise.withResolvers<Uint8Array>()
 const body=vi.fn(()=>pending.promise)
 const panel={ownerId:'pending-owner',assistantId:'assistant',collection:async()=>[{resource_key:'catalog:mail',data:{providerId:'mail'}}],body} as unknown as AssistantPanelFiles
 const rows=()=>[{id:'mail',name:'mail',description:'',metadataOnly:true}] as IntegrationMetadata[]
 function Probe({current=panel}:{current?:AssistantPanelFiles}){const value=useAssistantIntegrationSummaries(current,rows(),'en-US');return <span>{value[0]!.name}|{value[0]!.description}</span>}
 try {
  await h.render(<Probe/>); await h.render(<Probe/>)
  expect(body).toHaveBeenCalledTimes(1)
  await act(async()=>pending.resolve(new TextEncoder().encode(JSON.stringify({version:1,en:{id:'mail',name:'Mailbox',description:'Cached',auth:{methods:[]}}}))))
  expect(h.container.textContent).toBe('Mailbox|Cached')
  await h.render(null); await h.render(<Probe current={{...panel} as AssistantPanelFiles}/> )
  expect(h.container.textContent).toBe('Mailbox|Cached')
  expect(body).toHaveBeenCalledTimes(1)
  await h.render(<Probe current={{...panel,ownerId:'another-owner',body:async()=>{throw new Error('unavailable')}} as AssistantPanelFiles}/> )
  expect(h.container.textContent).toBe('Application|')
 } finally { h.cleanup() }
})
it('updates a custom app description when its published content version changes',async()=>{
 const h=createReactHarness();let version='one'
 const panel={ownerId:'version-owner',assistantId:'version-assistant',collection:async()=>[{resource_key:'catalog:mail',body_sha256:version,data:{providerId:'mail'}}],body:async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'mail',name:'Mailbox',description:version,auth:{methods:[]}}}))} as unknown as AssistantPanelFiles
 function Probe(){const items=useAssistantIntegrationSummaries(panel,[{id:'mail',name:'mail',description:'',catalogVersion:version,metadataOnly:true}] as IntegrationMetadata[],'en-US');return <span>{items[0]!.description}</span>}
 try{await h.render(<Probe/>);expect(h.container.textContent).toBe('one');version='two';await h.render(<Probe/>);expect(h.container.textContent).toBe('two')}finally{h.cleanup()}
})

it('fills a missing description and a legacy name from each entry; a broken entry keeps its row as it is',async()=>{
 const h=createReactHarness()
 const entries:Record<string,unknown>={
  'own-tool':{version:1,en:{id:'own-tool',name:'Own tool',description:'Own description',auth:{methods:[]}}},
  legacy:{version:1,en:{id:'legacy',name:'Company mail',auth:{methods:[]}}},
  malformed:{version:1,en:{id:'malformed',name:'Malformed',description:{bad:true},auth:{methods:[]}}},
 }
 const body=vi.fn(async(row:{data:{providerId:string}})=>{
  if(row.data.providerId==='broken')throw new Error('unreadable')
  return new TextEncoder().encode(JSON.stringify(entries[row.data.providerId]))
 })
 const ids=['own-tool','legacy','malformed','broken']
 const panel={ownerId:'fill-owner',assistantId:'fill-assistant',collection:async()=>ids.map(id=>({resource_key:`catalog:${id}`,data:{providerId:id}})),body} as unknown as AssistantPanelFiles
 const rows=[
  {id:'own-tool',name:'Own tool',description:'',metadataOnly:true},
  {id:'legacy',name:'legacy',description:'Saved description',metadataOnly:true,summaryNameMissing:true},
  {id:'malformed',name:'Malformed',description:'',metadataOnly:true},
  {id:'broken',name:'Broken',description:'',metadataOnly:true},
 ] as IntegrationMetadata[]
 function Probe(){return <ul>{useAssistantIntegrationSummaries(panel,rows,'en-US').map(item=><li key={item.id}>{item.name}|{item.description}</li>)}</ul>}
 try{
  await h.render(<Probe/>)
  await vi.waitFor(()=>expect(h.container.querySelector('li')?.textContent).toBe('Own tool|Own description'))
  const text=[...h.container.querySelectorAll('li')].map(li=>li.textContent)
  expect(text[1]).toBe('Company mail|Saved description')
  expect(text[2]).toBe('Malformed|')
  expect(text[3]).toBe('Broken|')
 }finally{h.cleanup()}
})

it('built-in apps are not downloaded for their list text',async()=>{
 const h=createReactHarness()
 const body=vi.fn(async()=>{throw new TypeError('download unavailable')})
 const panel={ownerId:'builtin-owner',assistantId:'builtin-assistant',collection:async()=>[{resource_key:'catalog:feishu',data:{providerId:'feishu'}}],body} as unknown as AssistantPanelFiles
 function Probe(){return <span>{useAssistantIntegrationSummaries(panel,[{id:'feishu',name:'feishu',description:'',metadataOnly:true}] as IntegrationMetadata[],'zh-CN')[0]!.name}</span>}
 try{await h.render(<Probe/>);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))});expect(h.container.textContent).toBe('飞书');expect(body).not.toHaveBeenCalled()}finally{h.cleanup()}
})
