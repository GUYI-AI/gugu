import {useMemo,useSyncExternalStore} from 'react'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import {assistantWorkCloud,watchAssistantWork} from '../../lib/assistantWork'
import {assistantWorkRefresh} from './assistant-work-refresh'
import {rendererLogger} from '../../lib/log'

type Value={records:AssistantWorkTask[];error?:unknown}|null

/**
 * The cloud answers 42501 「Assistant is not available to this account」 for the account's own assistant until its setup is
 * ready (its provision not ready / completed yet): not a list that cannot be read, a list that is not there yet — empty, read
 * again until it is (owner 11-12: the list said 「没读到」 for good right after setup).
 */
export const assistantWorkNotReadyYet=(error:unknown)=>String((error as {code?:unknown}|null)?.code??'')==='42501'

/** A failed read is read again by itself while anything shows the list: the 「系统会自动再读」 the list says is this. */
export const WORK_RETRY_MS=[2_000,5_000,15_000,30_000,60_000] as const

function createRecords(owner:string,assistant:string){
 let value:Value=null,stop:(()=>void)|undefined,pending:ReturnType<typeof assistantWorkRefresh>|undefined,generation=0
 let retry:ReturnType<typeof setTimeout>|undefined,failures=0
 const listeners=new Set<()=>void>()
 const notify=()=>{for(const listener of [...listeners])listener()}
 const clearRetry=()=>{if(retry!==undefined){clearTimeout(retry);retry=undefined}}
 const again=(current:number)=>{
  clearRetry()
  const delay=WORK_RETRY_MS[Math.min(failures,WORK_RETRY_MS.length-1)]
  failures+=1
  retry=setTimeout(()=>{retry=undefined;if(current===generation)void pending?.refresh()},delay)
 }
 return {
  read:()=>value,
  refresh:()=>{void pending?.refresh()},
  subscribe:(listener:()=>void)=>{
   listeners.add(listener)
   if(listeners.size===1){
    const current=++generation
    failures=0
    pending=assistantWorkRefresh(async()=>{
     try{
      const records=await assistantWorkCloud.listAll(assistant)
      if(current===generation){failures=0;clearRetry();value={records};notify()}
     }catch(error){
      if(current!==generation)return
      if(assistantWorkNotReadyYet(error)){
       rendererLogger('assistant/work').info({code:'not-ready'},'account task list not there yet')
       value={records:value?.records??[]}
      }else{
       rendererLogger('assistant/work').warn({error},'account task read failed')
       value={records:value?.records??[],error}
      }
      notify()
      again(current)
     }
    })
    stop=watchAssistantWork(owner,assistant,()=>void pending?.refresh())
    void pending.refresh()
   }
   return()=>{
    listeners.delete(listener)
    if(!listeners.size){generation++;clearRetry();pending?.close();pending=undefined;stop?.();stop=undefined}
   }
  },
 }
}
const records=new Map<string,ReturnType<typeof createRecords>>()
const absent=()=>null,noop=()=>()=>{}

/** Source badges and both task panes share one account read and subscription. */
export function useAssistantWorkRecords(owner:string|null|undefined,assistant:string){
 const store=useMemo(()=>{
  if(!owner)return null
  const key=JSON.stringify([owner,assistant])
  let store=records.get(key)
  if(!store){store=createRecords(owner,assistant);records.set(key,store)}
  return store
 },[owner,assistant])
 const value=useSyncExternalStore(store?.subscribe??noop,store?.read??absent)
 return {value,reload:store?.refresh??(()=>{})}
}

/** Tests only: every account's list read afresh. */
export function forgetAssistantWorkRecordsForTest():void{records.clear()}
