// @vitest-environment jsdom
// What is left of the former panel cache (transitional, the apps commit deletes it): the two account-state row kinds.
import { expect,it,vi } from 'vitest'
import { createAccountStateStore } from '@/components/assistant/assistant-panel-cache'
import type { AgentWatchLocalStore,LocalRow } from '@/session/shared/remote-sessions/local-store'
function fixture(){
 let owner:string|null='owner';const durable=new Map<string,LocalRow>()
 const store:AgentWatchLocalStore={readAll:async()=>[...durable.values()],read:async(_store,key)=>durable.get(key)??null,put:async(_store,row)=>{durable.set(row.key,structuredClone(row))},delete:async(_store,key)=>{durable.delete(key)},clear:async()=>{durable.clear()}}
 return {setOwner:(value:string|null)=>{owner=value},manager:()=>createAccountStateStore({store:async()=>store,accountId:()=>owner}),durable}
}
it('keeps account application state in the durable store and never exposes another account’s copy',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready
 const valid=(v:unknown):v is {channels:string[]}=>!!v&&typeof v==='object'&&Array.isArray((v as {channels:unknown}).channels)
 const state=manager.accountState('owner','wechat',valid);state.save({channels:['connected']});await manager.flush()
 const restarted=f.manager(),copy=restarted.accountState('owner','wechat',valid)
 const heard=vi.fn();restarted.subscribe(heard);await restarted.ready
 expect(heard).toHaveBeenCalled()
 expect(copy.peek()).toEqual({channels:['connected']})
 f.setOwner('other');expect(copy.peek()).toBeUndefined();copy.save({channels:['wrong-account']})
 expect(restarted.accountState('other','wechat',valid).peek()).toBeUndefined()
 f.setOwner('owner');expect(copy.peek()).toEqual({channels:['connected']});await restarted.flush()
})
it('holds no panel snapshot or body rows any more (they are the assistantPanel replica and the body cache)',async()=>{
 const f=fixture()
 f.durable.set('assistant-panel.v1:["owner","assistant"]:snapshot',{key:'assistant-panel.v1:["owner","assistant"]:snapshot',savedAt:1,owner:'owner',assistant:'assistant',kind:'snapshot',value:{}})
 const manager=f.manager();await manager.ready
 expect(manager.accountState('owner','snapshot',(v):v is unknown=>v!==undefined).peek()).toBeUndefined()
})
