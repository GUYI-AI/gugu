import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureAccountClosureReceipt, createAccountClosureLocalCleanup, restoreAccountClosureScope, type AccountClosureScope } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureLocalCleanup'
const scope={ownerId:'A',localOperationId:'stable-operation'}
function fixture(){
 let receipt:string|null='opaque-private-proof'
 let journalScope:AccountClosureScope|null=scope
 const native={receipt:{put:vi.fn(async(_scope:AccountClosureScope,value:string)=>{receipt=value}),get:vi.fn(async()=>receipt),remove:vi.fn(async()=>{receipt=null})},eraseLocal:vi.fn(async()=>({status:'complete' as 'complete'|'pending',retainedUnattributed:[] as string[]}))}
 const journal={write:vi.fn(async(value:AccountClosureScope)=>{journalScope=value}),read:vi.fn(async()=>journalScope),remove:vi.fn(async()=>{journalScope=null})}
 return{native,journal,receipt:()=>receipt,flow:createAccountClosureLocalCleanup({scope,native,journal})}
}
afterEach(()=>vi.useRealTimers())
describe('shared native closure receipt lifecycle',()=>{
 it('keeps the receipt during pending and explicitly removes it only after complete',async()=>{
  vi.useFakeTimers();const f=fixture();f.native.eraseLocal.mockResolvedValueOnce({status:'pending',retainedUnattributed:[]})
  const work=f.flow.finish('deleted');await vi.advanceTimersByTimeAsync(0)
  expect(f.receipt()).toBe('opaque-private-proof');expect(f.native.receipt.remove).not.toHaveBeenCalled();expect(f.native.eraseLocal).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1999);expect(f.native.eraseLocal).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1);expect((await work).status).toBe('complete');expect(f.native.eraseLocal).toHaveBeenCalledTimes(2);expect(f.receipt()).toBeNull()
  expect(f.native.receipt.remove).toHaveBeenCalledExactlyOnceWith(scope);expect(f.journal.remove).toHaveBeenCalledExactlyOnceWith(scope)
 })
 it.each(['failed','expired'] as const)('%s removes the proof without invoking erase',async terminal=>{
  const f=fixture();await f.flow.finish(terminal);expect(f.native.eraseLocal).not.toHaveBeenCalled();expect(f.receipt()).toBeNull()
 })
 it('stops after five pending attempts, preserves the proof, and permits a later manual continuation',async()=>{
  vi.useFakeTimers();const f=fixture();f.native.eraseLocal.mockResolvedValue({status:'pending',retainedUnattributed:[]})
  const work=f.flow.finish('deleted');await vi.advanceTimersByTimeAsync(8000)
  expect((await work).status).toBe('pending');expect(f.native.eraseLocal).toHaveBeenCalledTimes(5);expect(f.receipt()).not.toBeNull()
  await vi.advanceTimersByTimeAsync(20000);expect(f.native.eraseLocal).toHaveBeenCalledTimes(5)
  f.native.eraseLocal.mockResolvedValue({status:'complete',retainedUnattributed:['exported-files']});expect((await f.flow.finish('deleted')).status).toBe('complete');expect(f.flow.getSnapshot().retainedUnattributed).toEqual(['exported-files'])
 })
 it('never erases without a receipt or hides native storage failure',async()=>{
  const missing=fixture();missing.native.receipt.get.mockResolvedValue(null);expect((await missing.flow.finish('deleted')).status).toBe('unconfirmed');expect(missing.native.eraseLocal).not.toHaveBeenCalled()
  const failed=fixture();failed.native.receipt.get.mockRejectedValue(new Error('private native failure'));expect((await failed.flow.finish('deleted')).status).toBe('failed');expect(failed.native.eraseLocal).not.toHaveBeenCalled();expect(JSON.stringify(failed.flow.getSnapshot())).not.toContain('private')
 })
 it('cancels pending timers without touching the retained receipt',async()=>{
  vi.useFakeTimers();const f=fixture();f.native.eraseLocal.mockResolvedValue({status:'pending',retainedUnattributed:[]})
  const work=f.flow.finish('deleted');await vi.advanceTimersByTimeAsync(0);f.flow.cancel();await work;await vi.advanceTimersByTimeAsync(20000)
  expect(f.native.eraseLocal).toHaveBeenCalledTimes(1);expect(f.receipt()).not.toBeNull()
 })
 it('persists the same localOperationId across restart and never writes a secret into the scope journal',async()=>{
  const f=fixture();const captured=await captureAccountClosureReceipt('A','new-private-proof',f.native,f.journal)
  expect(await restoreAccountClosureScope('A',f.journal)).toEqual(captured);expect(f.native.receipt.put).toHaveBeenCalledExactlyOnceWith(captured,'new-private-proof')
  expect(JSON.stringify(f.journal.write.mock.calls)).not.toContain('private-proof')
  await expect(restoreAccountClosureScope('B',f.journal)).rejects.toThrow('scope mismatch')
 })
})
