import { describe, expect, it, vi } from 'vitest'
import { createDesktopClosureV2Service } from '../../../../apps/desktop/electron/account-closure/v2-service'
import { createClosureOperationRecords } from '../../../../apps/desktop/electron/account-closure/operation-record'
import { createDesktopClosureService } from '../../../../apps/desktop/electron/account-closure/service'
import { ClosureV2HttpFailure, type ClosureV2Auth, type ClosureV2Binding, type ClosureV2Reply, type ClosureV2Route } from '../../../../apps/desktop/electron/account-closure/v2-http'
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', SID='cccccccc-cccc-4ccc-8ccc-cccccccccccc', OP='dddddddd-dddd-4ddd-8ddd-dddddddddddd', PREP='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', REQUEST='ffffffff-ffff-4fff-8fff-ffffffffffff'
const policy={protocol_version:2 as const,available:true,deletion:'immediate' as const,credit_treatment:'forfeit_remaining' as const,consent_version:'immediate-forfeit-v1' as const,device_preparation_required:true as const}
function fixture() {
 const values=new Map<string,string>(), effects:string[]=[]
 let auth:ClosureV2Auth|null|undefined={ownerId:A,sessionId:SID,accessToken:'native-fixture-only'}, failWrite=false, finish=true
 let server:ClosureV2Reply|null=null, reject=false
 const lost=new Set<ClosureV2Route>(), before=new Set<ClosureV2Route>()
 let transform:((reply:ClosureV2Reply)=>ClosureV2Reply)|null=null
 let after: (()=>void)|null=null
 const secrets={getSecret:async(k:string)=>values.get(k)??null,setSecret:async(k:string,v:string)=>{if(failWrite)throw Error('private'); values.set(k,v)}}
 const http={
 policy:vi.fn(async()=>policy),
 post:vi.fn(async(route:ClosureV2Route,binding:ClosureV2Binding, extra:Record<string,string|number|boolean|null>={},_auth?:ClosureV2Auth):Promise<ClosureV2Reply>=>{
  if(before.has(route)) throw new ClosureV2HttpFailure('outcome_unknown',true)
  if(route==='result' && !server)throw new ClosureV2HttpFailure('not_found',true)
  if(!server)server={operation:{id:OP,state:'open',revision:1,challengeGeneration:0,requestId:null,requestState:null,request:null,confirmation:null,canReleasePreparation:false},preparation:null}
  const s=server, o=s.operation
  if(route!=='result')o.revision++
  if(route==='challenge'){
   o.challengeGeneration=extra.generation as number;o.requestId=REQUEST;o.requestState='challenge'
   o.request={id:REQUEST,state:'challenge',expiresAt:new Date(Date.now()+600000).toISOString(),lastError:null,canRetry:false}
  }
  if(route==='prepare_device')s.preparation={nativeGeneration:binding.nativeGeneration,serverGeneration:PREP,prepared:true,cancelled:false}
  if(route==='confirm'){
   o.confirmation={id:binding.confirmationId!,challengeGeneration:extra.generation as number,state:reject?'rejected':'deleted',errorCode:reject?'verification_failed':null}
   o.state=reject?'open':'deleted'
  }
  if(route==='cancel'){
   o.state='closed_before_confirm';o.canReleasePreparation=true
   s.preparation={nativeGeneration:binding.nativeGeneration,serverGeneration:s.preparation?.serverGeneration??null,prepared:false,cancelled:true}
  }
  after?.();after=null
  if(lost.has(route))throw new ClosureV2HttpFailure('outcome_unknown',true)
  const reply=transform?transform(structuredClone(s)):structuredClone(s)
  if(route==='confirm'&&reject)throw new ClosureV2HttpFailure('verification_failed',false,reply)
  return reply
 })
 }
 const restart=()=>{
  const local=createDesktopClosureService({profileBinding:'test-profile',secrets,currentOwner:async()=>auth===undefined?undefined:auth?.ownerId??null,
   stopOwner:async()=>{effects.push('stop')},steps:[{name:'first',run:async()=>{effects.push('first');return true}},{name:'second',run:async()=>{effects.push('second');return finish}}],
   retained:async()=>['workspace-files']})
  const records=createClosureOperationRecords({profileBinding:'test-profile',secrets,underAuth:local.underAuth,identity:async()=>auth&&{ownerId:auth.ownerId,sessionId:auth.sessionId}})
  const native=createDesktopClosureV2Service({local,records,http,auth:async()=>auth,deviceId:async()=>A})
  return {native,local,records}
 }
 const original=restart()
 return {...original, restart, effects, values, http, lost, before,
  auth:(v:typeof auth)=>{auth=v}, failure:(v:boolean)=>{failWrite=v}, finish:(v:boolean)=>{finish=v}, reject:()=>{reject=true},
  transform:(v:typeof transform)=>{transform=v}, after:(fn:()=>void)=>{after=fn}, server:()=>server!,
 }
}
async function prepared(f:ReturnType<typeof fixture>){
 const cap=await f.native.capture(), code=await f.native.sendCode(cap.handle)
 return f.native.prepare(code.handle)
}
describe('native V2 custody and trusted receiver',()=>{
 it('captures before effects, emits no capability and cannot expose it through legacy public scope',async()=>{
  const f=fixture(), cap=await f.native.capture()
  expect(f.http.post).not.toHaveBeenCalled();expect(f.effects).toEqual([])
  const record=await f.records.readNative({ownerId:A,localOperationId:cap.handle.localOperationId})
  expect(record.receipt).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(cap)).not.toContain(record.receipt)
  expect(JSON.stringify(cap)).not.toContain(record.cleanupScopeId)
  await expect(f.local.native.receipt.get({ownerId:A,localOperationId:cap.handle.localOperationId})).rejects.toMatchObject({code:'closure_context_missing'})
 })
 it('never sends an operation when atomic capture failed',async()=>{
  const f=fixture();f.failure(true)
  await expect(f.native.capture()).rejects.toMatchObject({code:'closure_storage_unavailable'})
  expect(f.http.post).not.toHaveBeenCalled();expect(f.effects).toEqual([])
 })
 it('persists unknown register and recovers only original result across restart/Auth loss',async()=>{
  const f=fixture(),cap=await f.native.capture();f.lost.add('register')
  await expect(f.native.sendCode(cap.handle)).rejects.toMatchObject({code:'outcome_unknown'})
  f.auth(null);const n=f.restart().native, pending=await n.discover()
  expect(pending).toMatchObject({pendingEffect:'register',recoveryOnly:true})
  const before=f.http.post.mock.calls.length
  expect(await n.recover(pending!.handle)).toMatchObject({phase:'registered',pendingEffect:null})
  expect(f.http.post.mock.calls.slice(before).map(c=>c[0])).toEqual(['result'])
 })
 it('closes the original unregistered operation by explicit authoritative tombstone, not 404',async()=>{
  const f=fixture(),cap=await f.native.capture();f.before.add('register')
  await expect(f.native.sendCode(cap.handle)).rejects.toThrow()
  const pending=(await f.native.discover())!
  await expect(f.native.recover(pending.handle)).rejects.toMatchObject({code:'not_found'})
  expect(await f.native.discover()).toMatchObject({pendingEffect:'register'})
  const closed=await f.native.cancel(pending.handle)
  expect(closed.phase).toBe('cancelled')
  expect(f.http.post.mock.calls.map(c=>c[0])).toEqual(['register','result','result','cancel'])
 })
 it('recovers lost preparation generation under closed policy, then cancels and stays paused',async()=>{
  const f=fixture(),cap=await f.native.capture(),code=await f.native.sendCode(cap.handle)
  f.lost.add('prepare_device');await expect(f.native.prepare(code.handle)).rejects.toThrow()
  expect(await f.local.isSealed(A)).toBe(true)
  f.http.policy.mockRejectedValue(new ClosureV2HttpFailure('closure_unavailable'))
  const n=f.restart().native,pending=(await n.discover())!
  const closed=await n.cancel(pending.handle)
  expect(closed).toMatchObject({phase:'cancelled',agentsPaused:true})
  expect(f.http.post.mock.calls.slice(-2).map(c=>c[0])).toEqual(['result','cancel'])
  expect(f.http.post.mock.calls.at(-1)![2]).toMatchObject({server_generation:PREP})
  expect(await f.local.isSealed(A)).toBe(false)
 })
 it('can cancel local preparation whose HTTP never arrived without using absence as release',async()=>{
  const f=fixture(),cap=await f.native.capture(),code=await f.native.sendCode(cap.handle)
  f.before.add('prepare_device');await expect(f.native.prepare(code.handle)).rejects.toThrow()
  const pending=(await f.native.discover())!
  await f.native.recover(pending.handle)
  expect(await f.local.isSealed(A)).toBe(true)
  const closed=await f.native.cancel((await f.native.discover())!.handle)
  expect(closed.phase).toBe('cancelled');expect(await f.local.isSealed(A)).toBe(false)
 })
 it('known rejected confirmation clears only that intent, keeps seal, and requires cancel ACK',async()=>{
  const f=fixture(),ready=await prepared(f);f.reject()
  await expect(f.native.confirm(ready.handle,{code:'000000',acknowledgeForfeit:true})).rejects.toMatchObject({code:'verification_failed'})
  const known=(await f.native.discover())!
  expect(known).toMatchObject({phase:'prepared',pendingEffect:null,recoveryOnly:false})
  expect(await f.local.isSealed(A)).toBe(true)
  expect((await f.native.cancel(known.handle)).phase).toBe('cancelled')
 })
 it('lost rejected response keeps confirm unknown until original result matches original nonce and generation',async()=>{
  const f=fixture(),ready=await prepared(f);f.reject();f.lost.add('confirm')
  await expect(f.native.confirm(ready.handle,{code:'000000',acknowledgeForfeit:true})).rejects.toThrow()
  const pending=(await f.native.discover())!
  await expect(f.native.cancel(pending.handle)).rejects.toMatchObject({code:'closure_recovery_required'})
  f.transform(reply=>({...reply,operation:{...reply.operation,confirmation:{...reply.operation.confirmation!,id:A}}}))
  const mismatch=await f.native.recover(pending.handle)
  expect(mismatch.pendingEffect).toBe('confirm');expect(await f.local.isSealed(A)).toBe(true)
  f.transform(null)
  const matched=await f.native.recover(mismatch.handle)
  expect(matched.pendingEffect).toBeNull();expect(await f.local.isSealed(A)).toBe(true)
  expect(f.http.post.mock.calls.filter(c=>c[0]==='confirm')).toHaveLength(1)
 })
 it('does not unseal for missing release flag or cancelled marker',async()=>{
  const f=fixture(),ready=await prepared(f)
  f.transform(reply=>({...reply,operation:{...reply.operation,canReleasePreparation:null}}))
  expect(await f.native.cancel(ready.handle)).toMatchObject({phase:'cancel-pending'})
  expect(await f.local.isSealed(A)).toBe(true)
  f.transform(reply=>({...reply,preparation:{...reply.preparation!,cancelled:null}}))
  expect(await f.native.recover((await f.native.discover())!.handle)).toMatchObject({phase:'cancel-pending'})
  expect(await f.local.isSealed(A)).toBe(true)
  f.transform(null);expect((await f.native.recover((await f.native.discover())!.handle)).phase).toBe('cancelled')
 })
 it('rejects stale handles and changed SID before any network or stop',async()=>{
  const f=fixture(),cap=await f.native.capture(),code=await f.native.sendCode(cap.handle),count=f.http.post.mock.calls.length
  await expect(f.native.prepare(cap.handle)).rejects.toMatchObject({code:'scope_conflict'})
  f.auth({ownerId:A,sessionId:B,accessToken:'new-SID'})
  await expect(f.native.prepare(code.handle)).rejects.toMatchObject({code:'wrong_local_owner'})
  expect(f.http.post).toHaveBeenCalledTimes(count);expect(f.effects).toEqual([])
 })
 it('a B switch during a successful delete cannot commit A result or erase B; signed-out recovery can finish A',async()=>{
  const f=fixture(),ready=await prepared(f)
  f.after(()=>f.auth({ownerId:B,sessionId:B,accessToken:'B'}))
  await expect(f.native.confirm(ready.handle,{code:'123456',acknowledgeForfeit:true})).rejects.toMatchObject({code:'wrong_local_owner'})
  expect(f.effects).toEqual(['stop']);expect(await f.native.discover()).toBeNull()
  f.auth(null);const resumed=f.restart().native,pending=(await resumed.discover())!
  expect((await resumed.recover(pending.handle)).phase).toBe('local-complete')
  expect(f.http.post.mock.calls.filter(c=>c[0]==='confirm')).toHaveLength(1)
 })
 it('retains capability/checkpoints during local cleanup failure and does not re-confirm on resume',async()=>{
  const f=fixture(),ready=await prepared(f);f.finish(false)
  const partial=await f.native.confirm(ready.handle,{code:'123456',acknowledgeForfeit:true})
  expect(partial.phase).toBe('deleted')
  const record=await f.records.readNative({ownerId:A,localOperationId:ready.handle.localOperationId})
  expect(record.receipt).toMatch(/^[a-f0-9]{64}$/)
  await expect(f.native.finalize(partial.handle)).rejects.toMatchObject({code:'closure_not_complete'})
  f.finish(true);f.auth(null);const resumed=f.restart().native
  const complete=await resumed.recover((await resumed.discover())!.handle)
  expect(complete.phase).toBe('local-complete')
  expect(f.effects.filter(x=>x==='first')).toHaveLength(1)
  expect((await resumed.finalize(complete.handle)).phase).toBe('finalized')
  expect((await f.records.readNative({ownerId:A,localOperationId:ready.handle.localOperationId})).receipt).toBeNull()
 })
 it('rejects foreign preparation generations before destructive effects',async()=>{
  const f=fixture(),ready=await prepared(f)
  f.transform(reply=>({...reply,preparation:{...reply.preparation!,nativeGeneration:B}}))
  await expect(f.native.confirm(ready.handle,{code:'123456',acknowledgeForfeit:true})).rejects.toMatchObject({code:'scope_conflict'})
  expect(f.effects).toEqual(['stop']);expect(await f.local.isSealed(A)).toBe(true)
 })
 it('matches the attempted challenge and complete request binding before clearing a lost send',async()=>{
  const f=fixture(),cap=await f.native.capture();f.lost.add('challenge')
  await expect(f.native.sendCode(cap.handle)).rejects.toThrow()
  f.transform(reply=>({...reply,operation:{...reply.operation,request:{...reply.operation.request!,id:A}}}))
  const bad=await f.native.recover((await f.native.discover())!.handle)
  expect(bad.pendingEffect).toBe('challenge');expect(bad.serverOperation?.challengeExpiresAt).toBeNull()
  f.transform(null);const good=await f.native.recover(bad.handle)
  expect(good).toMatchObject({pendingEffect:null,phase:'challenge',serverOperation:{challengeExpiresAt:expect.any(String)}})
  expect(f.http.post.mock.calls.filter(c=>c[0]==='challenge')).toHaveLength(1)
 })
 it('serializes mutating native commands while a network effect is pending',async()=>{
  const f=fixture(),cap=await f.native.capture()
  let release!:()=>void; const wait=new Promise<void>(resolve=>{release=resolve})
  const implementation=f.http.post.getMockImplementation()!
  f.http.post.mockImplementationOnce(async(...args)=>{await wait;return implementation(...args)})
  const running=f.native.sendCode(cap.handle)
  await vi.waitFor(()=>expect(f.http.post).toHaveBeenCalledTimes(1))
  await expect(f.native.sendCode(cap.handle)).rejects.toMatchObject({code:'closure_busy'})
  release();await running
 })
})
