import { useEffect,useMemo,useState } from 'react'
import type { AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import {assistantWorkPresence as getAgentPresenceSnapshot,subscribeAssistantWorkPresence as subscribeAgentPresence} from '../../lib/assistantWorkReadBridge'
import { OPEN_ASSISTANT_TASK_CHAT,type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantWorkTasks,assistantWorkStatus } from './assistant-work-projection'
import {AssistantWorkNotReady,assistantWorkRecords,useAssistantWorkRecords,useAssistantWorkTitles} from './assistant-work-records'

type Scope = { ownerId:string;assistantId:string;assertCurrent?:()=>void }
const rows = (records:readonly AssistantWorkTask[]) => assistantWorkTasks(records).map(task => {
  const presence=task.agentId ? getAgentPresenceSnapshot(task.agentId) : null
  return { ...task,status:assistantWorkStatus(task.outcome,presence?.reading ?? null),
    harness:presence?.payload?.agentType ?? null,unseen:presence?.local?.unseen ?? false }
})
/** Both shells share this cloud read; no home readiness or observed session directory participates. */
export async function readAssistantPanelTasks(scope:Scope) {
  scope.assertCurrent?.()
  const records=await assistantWorkRecords.fetch(scope.assistantId)
  scope.assertCurrent?.()
  return rows(records)
}
export type AssistantPanelTask = ReturnType<typeof rows>[number]
/** What opening a row asks the task window for; an App's panel (#1925, AppWorkLedgerHost) opens the very same. */
export function assistantPanelTaskChat(scope:Pick<Scope,'assistantId'>,task:Omit<AssistantPanelTask,'status'|'harness'|'unseen'>):AssistantTaskChat {
  return {workId:task.workId,title:task.title,outcome:task.outcome,assistantId:scope.assistantId,taskAgentId:task.agentId,
    task:{deviceId:task.deviceId,sessionId:task.id},assistants:task.assistants}
}
export function openAssistantPanelTask(scope:Pick<Scope,'assistantId'>,task:AssistantPanelTask) {
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:assistantPanelTaskChat(scope,task)}))
}
/**
 * `loading`: not read yet, or the list is not there yet (the assistant's setup is finishing: 42501, read again until it is).
 * `error` with `data`: the shown list, its last refresh failed (retried by itself); `error` with none: never read.
 */
export type AssistantWorkTasksRead = {state:'loading'} | {state:'error';error:unknown;data:AssistantPanelTask[]} | {state:'ok';data:AssistantPanelTask[]}
export function useAssistantWorkTasks(ownerId:string|null|undefined,assistantId:string):AssistantWorkTasksRead & {reload:()=>void} {
  const reading=useAssistantWorkRecords(ownerId,assistantId)
  const titled=useAssistantWorkTitles(ownerId,reading.state==='value'?reading.value:null)
  const [presenceRevision,revision]=useState(0)
  // The task agents whose presence draws a status (none while the list is not read).
  const agents=JSON.stringify(titled?[...new Set(titled.flatMap(work=>work.executors.flatMap(executor=>executor.agent_user_id ? [executor.agent_user_id] : [])))].sort():[])
  useEffect(()=>{
    const stops=(JSON.parse(agents) as string[]).map(agentId=>subscribeAgentPresence(agentId,()=>revision(n=>n+1)))
    return ()=>{for(const stop of stops) stop()}
  },[agents])
  const read=useMemo(():AssistantWorkTasksRead=>{
    if(reading.state==='unknown'||(reading.state==='error'&&reading.error instanceof AssistantWorkNotReady))return {state:'loading'}
    if(reading.state==='error')return {state:'error',error:reading.error,data:[]}
    const data=rows(titled!)
    return reading.error&&!(reading.error instanceof AssistantWorkNotReady)?{state:'error',error:reading.error,data}:{state:'ok',data}
  // The presence revision redraws the statuses read from the presence snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[reading,titled,presenceRevision])
  return {...read,reload:()=>{void assistantWorkRecords.refresh(assistantId)}}
}
