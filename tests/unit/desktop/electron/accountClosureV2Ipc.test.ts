import { describe, expect, it, vi } from 'vitest'
import { registerDesktopClosureV2Ipc } from '../../../../apps/desktop/electron/account-closure/v2-ipc'
import type { AccountClosureV2Native } from '../../../../apps/desktop/src/platform/accountClosureV2'
const handle={localOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',nativeGeneration:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',localRevision:3}
function fixture() {
 let invoke!: (event:unknown,input:unknown)=>Promise<unknown>
 const frame={}, sender={mainFrame:frame}, window={isDestroyed:()=>false,webContents:sender}
 const native=Object.fromEntries(['readPolicy','discover','capture','sendCode','prepare','confirm','recover','cancel','finalize'].map(k=>[k,vi.fn(async()=>({safe:true}))])) as unknown as AccountClosureV2Native
 const get=vi.fn(async()=>native)
 registerDesktopClosureV2Ipc({handle:(_channel:string,fn:unknown)=>{invoke=fn as typeof invoke}} as never,()=>window as never,get)
 return {invoke,native,get,event:{sender,senderFrame:frame}}
}
describe('V2 main-frame command boundary',()=>{
 it('rejects other windows and embedded frames before native service access',async()=>{
  const f=fixture()
  for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{}}]){
   expect(await f.invoke(event,{type:'capture'})).toEqual({ok:false,code:'wrong_local_owner'})
  }
  expect(f.get).not.toHaveBeenCalled()
 })
 it('rejects renderer receipt, server proof, target, owner and arbitrary commands',async()=>{
  const f=fixture()
  for(const input of [
   {type:'recover',handle,receipt:'private'},{type:'confirm',handle,deleted:true},{type:'capture',url:'https://other.invalid'},
   {type:'prepare',handle:{...handle,ownerId:'foreign'}},{type:'eraseLocal',handle},{type:'capture',handle},
   {type:'confirm',handle,confirmation:{code:'123456',acknowledgeForfeit:true,confirmationId:'chosen'}},
  ])expect(await f.invoke(f.event,input)).toMatchObject({ok:false})
  expect(f.get).not.toHaveBeenCalled()
 })
 it('forwards only the safe intent and bounded code to the independent native method',async()=>{
  const f=fixture()
  expect(await f.invoke(f.event,{type:'confirm',handle,confirmation:{code:'123456',acknowledgeForfeit:true}})).toEqual({ok:true,value:{safe:true}})
  expect(f.native.confirm).toHaveBeenCalledExactlyOnceWith(handle,{code:'123456',acknowledgeForfeit:true})
  expect(f.native.recover).not.toHaveBeenCalled()
 })
 it('publishes only fixed failure categories, not transport details',async()=>{
  const f=fixture()
  vi.mocked(f.native.recover).mockRejectedValueOnce(Object.assign(Error('receipt secret/path'),{code:'private_internal_error'}))
  expect(await f.invoke(f.event,{type:'recover',handle})).toEqual({ok:false,code:'closure_unavailable'})
  vi.mocked(f.native.recover).mockRejectedValueOnce({code:'wrong_local_owner',receipt:'private'})
  expect(await f.invoke(f.event,{type:'recover',handle})).toEqual({ok:false,code:'wrong_local_owner'})
 })
})
