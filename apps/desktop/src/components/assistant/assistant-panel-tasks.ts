import { useEffect,useMemo,useState } from 'react'
import type { AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import {assistantWorkPresence as getAgentPresenceSnapshot,subscribeAssistantWorkPresence as subscribeAgentPresence} from '../../lib/assistantWorkReadBridge'
import { OPEN_ASSISTANT_TASK_CHAT,type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantWorkTasks,assistantWorkStatus } from './assistant-work-projection'
import {AssistantWorkNotReady,assistantWorkRecords,useAssistantWorkRecords,useAssistantWorkTitles} from './assistant-work-records'

type Scope = { ownerId:string;assistantId:string }
const rows = (records:readonly AssistantWorkTask[]) => assistantWorkTasks(records).map(task => {
  const presence=task.agentId ? getAgentPresenceSnapshot(task.agentId) : null
  return { ...task,status:assistantWorkStatus(task.outcome,presence?.reading ?? null),
    harness:presence?.payload?.agentType ?? null,unseen:presence?.local?.unseen ?? false }
})
export type AssistantPanelTask = ReturnType<typeof rows>[number]
/** What opening a row asks the task window for; an App's panel (#1925, AppWorkLedgerHost) opens the very same. */
export function assistantPanelTaskChat(scope:Pick<Scope,'assistantId'>,task:Omit<AssistantPanelTask,'status'|'harness'|'unseen'>):AssistantTaskChat {
  return {workId:task.workId,title:task.title,outcome:task.outcome,assistantId:scope.assistantId,taskAgentId:task.agentId,
    task:{deviceId:task.deviceId,sessionId:task.id},assistants:task.assistants}
}
export function openAssistantPanelTask(scope:Pick<Scope,'assistantId'>,task:AssistantPanelTask) {
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:assistantPanelTaskChat(scope,task)}))
}
/** `loading` includes a list not there yet (42501); `error` with `data`: the shown list's refresh failed. */
export type AssistantWorkTasksRead = {state:'loading'} | {state:'error';error:unknown;data:AssistantPanelTask[]} | {state:'ok';data:AssistantPanelTask[]}
export function useAssistantWorkTasks(ownerId:string|null|undefined,assistantId:string):AssistantWorkTasksRead & {reload:()=>void} {
  const reading=useAssistantWorkRecords(ownerId,assistantId)
  const titled=useAssistantWorkTitles(ownerId,reading.state==='value'?reading.value:null)
  const [presenceRevision,revision]=useState(0)
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
