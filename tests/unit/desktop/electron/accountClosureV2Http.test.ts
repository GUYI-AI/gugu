import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createClosureV2Http, type ClosureV2Auth, type ClosureV2Binding } from '../../../../apps/desktop/electron/account-closure/v2-http'
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',operation='cccccccc-cccc-4ccc-8ccc-cccccccccccc',confirmation='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const token=(claims: unknown)=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature'
const anon=token({role:'anon'}),auth: ClosureV2Auth={ownerId:owner,sessionId:sid,accessToken:token({role:'authenticated',sub:owner,session_id:sid})}
const binding: ClosureV2Binding={ownerId:owner,sessionId:sid,localOperationId:'local-original',receipt:'a'.repeat(64),serverOperationId:operation,nativeGeneration:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',serverGeneration:'ffffffff-ffff-4fff-8fff-ffffffffffff',challengeGeneration:2,confirmationId:confirmation}
const wire=()=>({operation:{operation_id:operation,state:'open',revision:4,challenge_generation:2,request_id:null,can_retry:false,can_release_preparation:false,confirmation:null}})
function fixture(body: unknown=wire(),status=200){const f=vi.fn(async(url: string|URL|Request, _init?: RequestInit)=>{const r=new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r});return {f,http:createClosureV2Http({baseUrl:'https://fixture.invalid',anonKey:anon,fetch:f as typeof fetch})}}
describe('private V2 HTTP boundary',()=>{
 it('pins native target, public key and no-redirect transport without accepting renderer URL fields',async()=>{
  const {f,http}=fixture();await http.post('register',binding,{consent_version:'immediate-forfeit-v1'},auth)
  const [url,init]=f.mock.calls[0]!;expect(url).toBe('https://fixture.invalid/functions/v1/account-deletion/v2/register')
  expect(init).toMatchObject({redirect:'error',credentials:'omit',cache:'no-store'})
  await expect(http.post('register',binding,{url:'https://other.invalid'},auth)).rejects.toMatchObject({code:'invalid_scope'})
  expect(f).toHaveBeenCalledTimes(1)
 })
 it('does not send a privileged key, foreign owner, changed SID, or mismatched token claims',async()=>{
  expect(()=>createClosureV2Http({baseUrl:'https://fixture.invalid',anonKey:token({role:'service_role'})})).toThrow('closure_unavailable')
  const {f,http}=fixture()
  for(const a of [{...auth,ownerId:sid},{...auth,sessionId:owner},{...auth,accessToken:token({sub:sid,session_id:sid,role:'authenticated'})}])await expect(http.post('register',binding,{},a)).rejects.toThrow()
  expect(f).not.toHaveBeenCalled()
 })
 it('can read the original receipt result after Auth deletion without sending a bearer',async()=>{
  const {f,http}=fixture();await http.post('result',binding)
  const init=f.mock.calls[0]![1] as RequestInit;expect(init.headers).not.toHaveProperty('authorization')
  expect(JSON.parse(init.body as string)).toEqual({local_operation_id:binding.localOperationId,receipt_token:binding.receipt})
  await expect(http.post('result',binding,{}, {...auth,ownerId:sid})).rejects.toMatchObject({code:'wrong_local_owner'})
 })
 it('keeps policy dependency failure distinct from an unavailable gate',async()=>{
  const denied=fixture({policy:{protocol_version:2,available:false,deletion:'immediate',credit_treatment:'forfeit_remaining',consent_version:'immediate-forfeit-v1',device_preparation_required:true}})
  expect((await denied.http.policy(auth)).available).toBe(false)
  await expect(fixture({error:'unavailable'},503).http.policy(auth)).rejects.toMatchObject({code:'closure_unavailable'})
  await expect(fixture({error:'unauthorized'},401).http.policy(auth)).rejects.toMatchObject({code:'unauthorized'})
 })
 it('does not treat a bare or mismatched 422 as authoritative confirmation rejection',async()=>{
  await expect(fixture({error:'verification_failed'},422).http.post('confirm',binding,{},auth)).rejects.toMatchObject({code:'outcome_unknown',outcomeUnknown:true,rejection:null})
  const bad=wire();bad.operation.confirmation={confirmation_id:owner,state:'rejected',challenge_generation:2,error_code:'verification_failed'} as never
  await expect(fixture({...bad,error:'verification_failed'},422).http.post('confirm',binding,{},auth)).rejects.toMatchObject({outcomeUnknown:true,rejection:null})
 })
 it('accepts only the matching original nonce/generation as a known rejected confirmation',async()=>{
  const body=wire();body.operation.confirmation={confirmation_id:confirmation,state:'rejected',challenge_generation:2,error_code:'verification_failed'} as never
  await expect(fixture({...body,error:'verification_failed'},422).http.post('confirm',binding,{},auth)).rejects.toMatchObject({code:'verification_failed',outcomeUnknown:false,rejection:{operation:{id:operation,state:'open'}}})
 })
 it('does not derive release from missing preparation or a missing release flag',async()=>{
  const {http}=fixture();const r=await http.post('result',binding);expect(r.preparation).toBeNull();expect(r.operation.canReleasePreparation).toBe(false)
  const body=wire();delete (body.operation as Partial<typeof body.operation>).can_release_preparation
  expect((await fixture(body).http.post('result',binding)).operation.canReleasePreparation).toBeNull()
 })
 it('rejects malformed or oversized result bodies without returning their contents',async()=>{
  await expect(fixture({operation:{private:'x'.repeat(17000)}}).http.post('result',binding)).rejects.toMatchObject({code:'closure_unavailable'})
  await expect(fixture({operation:{...wire().operation,can_retry:true}}).http.post('result',binding)).rejects.toMatchObject({code:'closure_unavailable'})
 })
 it('preserves private HTTP conflict status for native cancellation recovery',async()=>{
  await expect(fixture({error:'request_active'},409).http.post('cancel',binding,{},auth)).rejects.toMatchObject({code:'request_active',status:409})
  await expect(fixture({error:'unavailable'},503).http.post('cancel',binding,{},auth)).rejects.toMatchObject({status:503,outcomeUnknown:true})
 })
 it('retains conflict status even when an error response has malformed JSON',async()=>{
  const {f,http}=fixture()
  f.mockImplementationOnce(async(url:string|URL|Request,_init?:RequestInit)=>{const response=new Response('not-json',{status:409});Object.defineProperty(response,'url',{value:String(url)});return response})
  await expect(http.post('cancel',binding,{},auth)).rejects.toMatchObject({status:409,code:'state_conflict'})
 })
 it('rejects a foreign response target',async()=>{
  const f=vi.fn(async()=>{const r=new Response(JSON.stringify(wire()));Object.defineProperty(r,'url',{value:'https://other.invalid/result'});return r})
  const h=createClosureV2Http({baseUrl:'https://fixture.invalid',anonKey:anon,fetch:f as typeof fetch})
  await expect(h.post('result',binding)).rejects.toMatchObject({code:'outcome_unknown',outcomeUnknown:true})
 })
 it('does not forward the capability across an actual HTTP redirect',async()=>{
  let leaked=0;const destination=createServer((_q,r)=>{leaked++;r.end('{}')});destination.listen(0,'127.0.0.1');await once(destination,'listening')
  const port=(destination.address() as {port:number}).port
  const source=createServer((_q,r)=>{r.writeHead(307,{location:'http://127.0.0.1:'+port+'/sink'});r.end()});source.listen(0,'127.0.0.1');await once(source,'listening')
  try{const h=createClosureV2Http({baseUrl:'http://127.0.0.1:'+(source.address() as {port:number}).port,anonKey:anon});await expect(h.post('result',binding)).rejects.toMatchObject({outcomeUnknown:true});expect(leaked).toBe(0)}
  finally{await Promise.all([new Promise<void>(resolve=>source.close(()=>resolve())),new Promise<void>(resolve=>destination.close(()=>resolve()))])}
 })
})
