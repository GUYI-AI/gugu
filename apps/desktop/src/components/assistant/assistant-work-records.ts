import {useEffect,useMemo} from 'react'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
import {assistantWorkCloud,watchAssistantWork} from '../../lib/assistantWork'
import {replica,useReplica,type Reading} from '../../lib/replica'
import {rendererLogger} from '../../lib/log'
import {assistantWorkTitleOf} from '../../lib/assistantWorkTitle'
import {devicesModel} from '../../store/devicesCache'

const log=rendererLogger('assistant/work')

/**
 * The cloud answers 42501 「Assistant is not available to this account」 for the account's own assistant until its setup is
 * ready (its provision not ready / completed yet): not a list that cannot be read, a list that is not there yet — read
 * again until it is (owner 11-12: the list said 「没读到」 for good right after setup). Typed, so the list says "preparing".
 */
export const assistantWorkNotReadyYet=(error:unknown)=>String((error as {code?:unknown}|null)?.code??'')==='42501'
export class AssistantWorkNotReady extends Error {
 readonly code='42501'
 constructor(){super('The assistant\'s work list is not there yet')}
}

/**
 * A failed read is read again by itself while the list is shown, sooner first: the 「系统会自动再读」 the list says is this.
 * The failure is the reading's at once (an error, or the shown list's `error`), ❌ hidden behind silent retries.
 */
export const WORK_RETRY_MS=[2_000,5_000,15_000,30_000,60_000] as const

/**
 * The account's work ledger for one assistant (signal tier: `assistant_work_changed` on the private bus, its
 * resubscription, focus, `online`, app foreground — `watchAssistantWork`). Titles are not part of it: they are derived
 * when drawn (`useAssistantWorkTitles`), so a device's session digest never re-reads the ledger. Not kept across restarts.
 */
export const assistantWorkRecords=replica({
 name:'assistantWorkRecords',
 scope:'account',
 read:async(_owner:string,assistantId:string):Promise<AssistantWorkTask[]>=>{
  try{return await assistantWorkCloud.listAll(assistantId)}
  catch(error){
   if(assistantWorkNotReadyYet(error)){log.info({code:'not-ready'},'account task list not there yet');throw new AssistantWorkNotReady()}
   log.warn({error},'account task read failed')
   throw error
  }
 },
 // Signal tier: a change arrives as `assistant_work_changed`; a second look within a minute (another pane mounting) does not read again.
 fresh:60_000,
 refreshJoinsRead:true,
 refreshOnFocus:true,
})

/** One work and its events (`historyAll` is `get` without the work, so this one entry serves the window and the chat rows). */
export const assistantWork=replica({
 name:'assistantWork',
 scope:'account',
 read:(_owner:string,assistantId:string,workId:string)=>assistantWorkCloud.get(assistantId,workId),
 fresh:60_000,
 refreshJoinsRead:true,
 refreshOnFocus:true,
})

// Subscription ownership only (the values live in the replicas): one watch per (owner, assistant) while anything shows them.
const watches=new Map<string,{users:number;stop:()=>void}>()
export function watchAssistantWorkReplicas(owner:string,assistantId:string):()=>void {
 const id=JSON.stringify([owner,assistantId])
 let entry=watches.get(id)
 if(!entry){
  const stopSignal=watchAssistantWork(owner,assistantId,()=>{void assistantWorkRecords.refresh(assistantId);void assistantWork.refresh(assistantId)})
  const stopRetry=retryFailedReads(assistantId)
  // A ledger read while nobody watched may have moved since (no signal reached it): read again now. A work's own entry
  // is read again past `fresh` when a window opens it.
  if(assistantWorkRecords.peek(assistantId).state==='value')void assistantWorkRecords.refresh(assistantId)
  entry={users:0,stop:()=>{stopSignal();stopRetry()}}
  watches.set(id,entry)
 }
 const active=entry
 active.users++
 return()=>{if(--active.users===0&&watches.get(id)===active){active.stop();watches.delete(id)}}
}

/**
 * While watched: a failed read of the ledger or of one of its works is read again after WORK_RETRY_MS (sooner first),
 * each entry on its own; a read that lands resets it.
 */
function retryFailedReads(assistantId:string):()=>void {
 const pending=new Map<string,{failures:number;timer?:ReturnType<typeof setTimeout>}>()
 const failedOf=(reading:{state:string;error?:Error|null})=>reading.state==='error'||(reading.state==='value'&&!!reading.error)
 const check=(id:string,failed:boolean,readAgain:()=>void)=>{
  const entry=pending.get(id)??{failures:0}
  if(!failed){clearTimeout(entry.timer);pending.delete(id);return}
  if(entry.timer!==undefined)return
  const delay=WORK_RETRY_MS[Math.min(entry.failures,WORK_RETRY_MS.length-1)]!
  entry.failures+=1
  entry.timer=setTimeout(()=>{entry.timer=undefined;readAgain()},delay)
  pending.set(id,entry)
 }
 // A read that has landed (not one on its way) decides: failed → read again later; answered → the count starts over.
 const ledger=(entry:{reading:{state:string;error?:Error|null};fetching:boolean})=>{
  if(!entry.fetching)check('ledger',failedOf(entry.reading),()=>void assistantWorkRecords.refresh(assistantId))
 }
 const work=(entry:{args:[string,string];reading:{state:string;error?:Error|null};fetching:boolean})=>{
  const workId=entry.args[1]
  if(!entry.fetching)check(`work:${workId}`,failedOf(entry.reading),()=>void assistantWork.refresh(assistantId,workId))
 }
 const stops=[assistantWorkRecords.subscribe([assistantId],ledger),assistantWork.subscribe([assistantId],work)]
 for(const entry of assistantWorkRecords.entries(assistantId))ledger(entry)
 for(const entry of assistantWork.entries(assistantId))work(entry)
 return()=>{for(const stop of stops)stop();for(const entry of pending.values())clearTimeout(entry.timer)}
}

export function useAssistantWorkWatch(owner:string|null|undefined,assistantId:string|null|undefined):void {
 useEffect(()=>(owner&&assistantId?watchAssistantWorkReplicas(owner,assistantId):undefined),[owner,assistantId])
}

/** Source badges and the task panes share one account read and subscription. */
export function useAssistantWorkRecords(owner:string|null|undefined,assistant:string):Reading<AssistantWorkTask[]> {
 const reading=useReplica(assistantWorkRecords,owner&&assistant?[assistant]:null)
 useAssistantWorkWatch(owner,assistant||null)
 return reading
}

/**
 * The works as drawn: a placeholder title recovered from the devices' session digests (lib/assistantWorkTitle), derived
 * at render. `titleKnown: false` = the placeholder's evidence is not known yet (devices not read, or a row carried without
 * its digest): draw a placeholder, ❌ 「任务」 then the real title.
 */
export function useAssistantWorkTitles<W extends AssistantWorkTask>(owner:string|null|undefined,works:readonly W[]|null):Array<W&{titleKnown:boolean}>|null {
 const devices=useReplica(devicesModel,[])
 const rows:readonly Device[]|null=devices.state==='value'?devices.value:null
 return useMemo(()=>works&&works.map(work=>{
  const title=assistantWorkTitleOf(work,owner??null,rows)
  return title===null?{...work,titleKnown:false}:{...work,title,titleKnown:true}
 }),[works,rows,owner])
}
