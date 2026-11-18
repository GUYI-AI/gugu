import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAssistantWorkTasks } from '@/components/assistant/assistant-panel-tasks'
import { ledgerStateOf, pushedRowsOf } from '@/components/appSlot/appWorkLedger'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { useOpenedAssistantTaskChat } from '@/lib/assistantTaskChat'
import { forgetWorkTasks, rememberWorkTasks } from './phoneWorkChats'

const noop = () => () => undefined

/**
 * API 46 on a phone: the assistant's work list read the way the desktop's 任务 reads it (`useAssistantWorkTasks`), each row as the desktop hands it to Apps (`pushedRowsOf`, the ids kept on this page), and the task whose conversation
 * the layer draws now — published for the binding host (phoneAppBindings `work`), which gives the App opaque handles only.
 */
export function PhoneAssistantWorkLedger({ ownerId, assistantId }: { ownerId: string | null; assistantId: string }) {
  const read = useAssistantWorkTasks(ownerId, assistantId)
  const directory = readIdentityDirectoryBridge()
  const identities = useSyncExternalStore(directory?.subscribe ?? noop, () => directory?.getSnapshot() ?? null)
  const [now, setNow] = useState(() => Date.now())
  const tasks = read.state === 'loading' ? [] : read.data
  const { rows, namingUntil } = pushedRowsOf(tasks, (agentId) => identities?.[agentId]?.created_at ?? undefined, now)
  const state = ledgerStateOf(read)
  const opened = useOpenedAssistantTaskChat()
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  useEffect(() => {
    if (namingUntil === null) return undefined
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, namingUntil - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [namingUntil])
  const key = JSON.stringify([ownerId, assistantId, state, rows, opened?.ownerId ?? null, opened?.request.workId ?? null, opened?.request.task.sessionId ?? null])
  useEffect(() => {
    rememberWorkTasks(assistantId, tasksRef.current)
    const open = opened && opened.ownerId === ownerId && opened.request.assistantId === assistantId && opened.request.workId
      ? { ownerId: opened.ownerId, workId: opened.request.workId, sessionId: opened.request.task.sessionId } : null
    phoneAssistantLayer.publishWork(ownerId ? { ownerId, assistantId, state, rows } : null, open)
    // Only the key decides: the rows and the open task are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => {
    forgetWorkTasks()
    phoneAssistantLayer.publishWork(null, null)
  }, [])
  return null
}
