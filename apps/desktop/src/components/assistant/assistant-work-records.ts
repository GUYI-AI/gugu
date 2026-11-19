import {useMemo} from 'react'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
import {assistantWorkCloud,watchAssistantWork} from '../../lib/assistantWork'
import {replica,useReplica,type Reading} from '../../lib/replica'
import {rendererLogger} from '../../lib/log'
import {assistantWorkTitleOf} from '../../lib/assistantWorkTitle'
import {devicesModel} from '../../store/devicesCache'

const log=rendererLogger('assistant/work')

/** 42501 until the account's own assistant is set up: a list not there yet, read again (owner 11-12); the list says "preparing". */
export const assistantWorkNotReadyYet=(error:unknown)=>String((error as {code?:unknown}|null)?.code??'')==='42501'
export class AssistantWorkNotReady extends Error {
 readonly code='42501'
 constructor(){super('The assistant\'s work list is not there yet')}
}

/** The 「系统会自动再读」 the list says; the failure is the reading's at once, ❌ hidden behind silent retries. */
export const WORK_RETRY_MS=[2_000,5_000,15_000,30_000,60_000] as const

/** The account's work ledger for one assistant (signal tier). Titles are derived when drawn (`useAssistantWorkTitles`). */
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
 fresh:60_000,
 refreshJoinsRead:true,
 refreshOnFocus:true,
 watch:{group:(assistantId)=>assistantId,start:(owner,assistantId)=>watchLedger(owner,assistantId)},
})

/** One work and its events (serves the window and the chat rows). */
export const assistantWork=replica({
 name:'assistantWork',
 scope:'account',
 read:(_owner:string,assistantId:string,workId:string)=>assistantWorkCloud.get(assistantId,workId),
 fresh:60_000,
 refreshJoinsRead:true,
 refreshOnFocus:true,
 watch:{group:(assistantId)=>assistantId,start:(owner,assistantId)=>watchWorks(owner,assistantId)},
})

function watchLedger(owner:string,assistantId:string):()=>void {
 return watchWork(owner,assistantId,()=>void assistantWorkRecords.refresh(assistantId),(check)=>assistantWorkRecords.subscribe([assistantId],check),
  ()=>assistantWorkRecords.entries(assistantId),()=>void assistantWorkRecords.refresh(assistantId))
}
function watchWorks(owner:string,assistantId:string):()=>void {
 return watchWork(owner,assistantId,()=>void assistantWork.refresh(assistantId),(check)=>assistantWork.subscribe([assistantId],check),
  ()=>assistantWork.entries(assistantId),(entry)=>void assistantWork.refresh(assistantId,entry.args[1] as string))
}

type Landed={args:unknown[];reading:{state:string;error?:Error|null};fetching:boolean}

/** While shown: the signal reads the model again; a failed entry is read again after WORK_RETRY_MS, each on its own. */
function watchWork(owner:string,assistantId:string,changed:()=>void,follow:(listener:(entry:Landed)=>void)=>()=>void,
 held:()=>Landed[],readAgain:(entry:Landed)=>void):()=>void {
 const stopSignal=watchAssistantWork(owner,assistantId,changed)
 const pending=new Map<string,{failures:number;timer?:ReturnType<typeof setTimeout>}>()
 const failedOf=(reading:Landed['reading'])=>reading.state==='error'||(reading.state==='value'&&!!reading.error)
 const check=(entry:Landed)=>{
  if(entry.fetching)return
  const id=JSON.stringify(entry.args)
  const retry=pending.get(id)??{failures:0}
  if(!failedOf(entry.reading)){clearTimeout(retry.timer);pending.delete(id);return}
  if(retry.timer!==undefined)return
  const delay=WORK_RETRY_MS[Math.min(retry.failures,WORK_RETRY_MS.length-1)]!
  retry.failures+=1
  retry.timer=setTimeout(()=>{retry.timer=undefined;readAgain(entry)},delay)
  pending.set(id,retry)
 }
 const stopFollow=follow(check)
 for(const entry of held())check(entry)
 return()=>{stopSignal();stopFollow();for(const retry of pending.values())clearTimeout(retry.timer)}
}

export function useAssistantWorkRecords(owner:string|null|undefined,assistant:string):Reading<AssistantWorkTask[]> {
 return useReplica(assistantWorkRecords,owner&&assistant?[assistant]:null)
}

/** Placeholder titles from the devices' session digests; `titleKnown: false` = evidence not known yet (❌ 「任务」 then the title). */
export function useAssistantWorkTitles<W extends AssistantWorkTask>(owner:string|null|undefined,works:readonly W[]|null):Array<W&{titleKnown:boolean}>|null {
 const devices=useReplica(devicesModel,[])
 const rows:readonly Device[]|null=devices.state==='value'?devices.value:null
 return useMemo(()=>works&&works.map(work=>{
  const title=assistantWorkTitleOf(work,owner??null,rows)
  return title===null?{...work,titleKnown:false}:{...work,title,titleKnown:true}
 }),[works,rows,owner])
}
