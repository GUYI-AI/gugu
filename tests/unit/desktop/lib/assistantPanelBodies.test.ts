// @vitest-environment jsdom
// The panel bodies' content cache (lib/assistantPanelBodies): immutable bodies keyed by item + sha, kept in IndexedDB,
// bound to their account, dropped once a snapshot no longer lists them, bounded to 32 MB.
import { expect,it } from 'vitest'
import type { AssistantPanelItem,AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { createAssistantPanelBodies } from '@/lib/assistantPanelBodies'
import type { AgentWatchLocalStore,LocalRow } from '@/session/shared/remote-sessions/local-store'
const item:AssistantPanelItem={assistant_user_id:'assistant',owner_user_id:'owner',domain:'integrations',resource_key:'catalog:mail',device_id:'home',revision:'1',data:{providerId:'mail'},body_item_id:'body',body_sha256:'a'.repeat(64),deleted_at:null,observed_at:null,updated_at:'2026-10-27'}
const snapshot=(items:AssistantPanelItem[]):AssistantPanelSnapshot=>({version:1,revision:'2',items,application:[]})
function fixture(){
 let owner='owner';const durable=new Map<string,LocalRow>()
 const store:AgentWatchLocalStore={readAll:async()=>[...durable.values()],read:async(_store,key)=>durable.get(key)??null,put:async(_store,row)=>{durable.set(row.key,structuredClone(row))},delete:async(_store,key)=>{durable.delete(key)},clear:async()=>{durable.clear()}}
 return {setOwner:(value:string)=>{owner=value},bodies:()=>createAssistantPanelBodies({store:async()=>store,active:(o)=>o===owner})}
}
it('keeps a body across a restart for its account only',async()=>{
 const f=fixture(),first=f.bodies();await first.ready
 first.save('owner','assistant',item,new TextEncoder().encode('detail'));await first.flush()
 const restarted=f.bodies();await restarted.ready
 expect(new TextDecoder().decode(restarted.peek('owner','assistant',item))).toBe('detail')
 f.setOwner('other');expect(restarted.peek('owner','assistant',item)).toBeUndefined()
})
it('drops bodies a newer snapshot no longer lists (a replaced or removed item), not the listed ones',async()=>{
 const f=fixture(),bodies=f.bodies();await bodies.ready
 const other={...item,resource_key:'catalog:git',body_item_id:'body-2',body_sha256:'b'.repeat(64)}
 bodies.save('owner','assistant',item,new TextEncoder().encode('mail'));bodies.save('owner','assistant',other,new TextEncoder().encode('git'))
 bodies.forgetUnlisted('owner','assistant',snapshot([other]));await bodies.flush()
 const restarted=f.bodies();await restarted.ready
 expect(restarted.peek('owner','assistant',item)).toBeUndefined()
 expect(new TextDecoder().decode(restarted.peek('owner','assistant',other))).toBe('git')
})
it('keeps only the connection catalog bodies, and refuses one larger than the whole budget',async()=>{
 const f=fixture(),bodies=f.bodies();await bodies.ready
 bodies.save('owner','assistant',{...item,domain:'memory'},new TextEncoder().encode('note'))
 expect(bodies.peek('owner','assistant',{...item,domain:'memory'})).toBeUndefined()
 bodies.save('owner','assistant',item,new Uint8Array(13*1024*1024))
 expect(bodies.peek('owner','assistant',item)).toBeUndefined()
})
