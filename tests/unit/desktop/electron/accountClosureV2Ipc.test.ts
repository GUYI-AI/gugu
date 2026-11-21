import { describe, expect, it, vi } from 'vitest'
import { registerAccountClosedNoticeIpc, registerDesktopClosureAgentResumeIpc, registerDesktopClosureV2Ipc } from '../../../../apps/desktop/electron/account-closure/v2-ipc'
import type { AccountClosureV2Native } from '../../../../apps/desktop/src/platform/accountClosureV2'
import { resumeDesktopAgentsAfterAccountClosure } from '../../../../apps/desktop/src/platform/desktopAccountClosureV2'
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

function resumeFixture() {
 let invoke!: (event:unknown,input:unknown)=>Promise<unknown>
 const frame={},sender={mainFrame:frame},window={isDestroyed:()=>false,webContents:sender}
 const resume=vi.fn(async(_ownerId:string)=>{}),get=vi.fn(async()=>({resumePausedAgents:resume}))
 registerDesktopClosureAgentResumeIpc({handle:(_channel:string,fn:unknown)=>{invoke=fn as typeof invoke}} as never,()=>window as never,get)
 return {invoke,resume,get,event:{sender,senderFrame:frame}}
}
describe('separate owner-bound manual Agent enable',()=>{
 it('requires the captured owner as the only input and rejects other frames before native effects',async()=>{
  const f=resumeFixture()
  for(const input of [undefined,{},[],{ownerId:'bad'},{ownerId:handle.localOperationId,receipt:'chosen'}])
   expect(await f.invoke(f.event,input)).toEqual({ok:false,code:'invalid_scope'})
  expect(await f.invoke({...f.event,senderFrame:{}},{ownerId:handle.localOperationId})).toEqual({ok:false,code:'wrong_local_owner'})
  expect(f.get).not.toHaveBeenCalled()
 })
 it('forwards the original owner and preserves only fixed native error categories',async()=>{
  const f=resumeFixture(),input={ownerId:handle.localOperationId}
  expect(await f.invoke(f.event,input)).toEqual({ok:true})
  expect(f.resume).toHaveBeenCalledExactlyOnceWith(input.ownerId)
  f.resume.mockRejectedValueOnce(Object.assign(Error('private detail'),{code:'wrong_local_owner'}))
  expect(await f.invoke(f.event,input)).toEqual({ok:false,code:'wrong_local_owner'})
 })
 it('sends the clicked owner through the renderer facade without silently swallowing a rejection',async()=>{
  const invoke=vi.fn(async()=>({ok:true}))
  vi.stubGlobal('window',{electronAPI:{invoke}})
  try {
   await resumeDesktopAgentsAfterAccountClosure(handle.localOperationId)
   expect(invoke).toHaveBeenCalledExactlyOnceWith('account-closure:resume-paused',{ownerId:handle.localOperationId})
   invoke.mockResolvedValueOnce({ok:false,code:'wrong_local_owner'} as never)
   await expect(resumeDesktopAgentsAfterAccountClosure(handle.localOperationId)).rejects.toMatchObject({code:'wrong_local_owner'})
  } finally { vi.unstubAllGlobals() }
 })
})

function noticeFixture(initial:Record<string,unknown>={}) {
 let invoke!: (event:unknown,input:unknown)=>unknown
 const frame={},sender={mainFrame:frame},window={isDestroyed:()=>false,webContents:sender}
 const file={state:structuredClone(initial)}
 const read=vi.fn(()=>structuredClone(file.state)),write=vi.fn((next:Record<string,unknown>)=>{file.state=structuredClone(next)})
 registerAccountClosedNoticeIpc({handle:(_channel:string,fn:unknown)=>{invoke=fn as typeof invoke}} as never,()=>window as never,{read,write})
 return {invoke,file,read,write,event:{sender,senderFrame:frame}}
}
describe('one-shot account-closed notice across the relaunch',()=>{
 it('rejects other frames and anything but mark/take before touching the state file',()=>{
  const f=noticeFixture()
  expect(f.invoke({...f.event,senderFrame:{}},{type:'mark'})).toEqual({ok:false})
  for(const input of [undefined,'mark',{},{type:'clear'},{type:'take',owner:'x'}])expect(f.invoke(f.event,input)).toEqual({ok:false})
  expect(f.read).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled()
 })
 it('marks beside other host state, then exactly one take reads and clears it',()=>{
  const f=noticeFixture({windowTone:'dark'})
  expect(f.invoke(f.event,{type:'mark'})).toEqual({ok:true,value:true})
  expect(f.file.state).toEqual({windowTone:'dark',accountClosedNotice:true})
  expect(f.invoke(f.event,{type:'take'})).toEqual({ok:true,value:true})
  expect(f.invoke(f.event,{type:'take'})).toEqual({ok:true,value:false})
  expect(f.file.state).toEqual({windowTone:'dark'});expect(f.write).toHaveBeenCalledTimes(2)
 })
 it('reports an unreadable state file as a failure, never as a shown notice',()=>{
  const f=noticeFixture();f.read.mockImplementationOnce(()=>{throw Object.assign(Error('EACCES'),{code:'EACCES'})})
  expect(f.invoke(f.event,{type:'take'})).toEqual({ok:false})
 })
})
