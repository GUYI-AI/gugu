import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { openAssistantPanelTask, useAssistantWorkTasks, type AssistantPanelTask } from '@/components/assistant/assistant-panel-tasks'
import { ledgerStateOf, pushedRowsOf } from '@/components/appSlot/appWorkLedger'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { showAssistantTaskChat, useOpenedAssistantTaskChat } from '@/lib/assistantTaskChat'

const noop = () => () => undefined

/** The tasks the ledger read last, for `openWork` to find the row it was handed (only the layer's own read). */
let latest: { assistantId: string; tasks: readonly AssistantPanelTask[] } | null = null

/** What the layer does for `gugu.bindings.openWork` / `closeWork` (API 46): the built-in way a task's conversation opens. */
export const phoneWorkChats = {
  open(assistantId: string, work: { workId: string; sessionId: string } | null): void {
    if (!work) {
      showAssistantTaskChat(null)
      return
    }
    const task = latest?.assistantId === assistantId ? latest.tasks.find((row) => row.workId === work.workId && row.id === work.sessionId) : undefined
    if (task) openAssistantPanelTask({ assistantId }, task)
  },
}

/**
 * API 46 on a phone: the assistant's work list read the layer's own 任务 way (`useAssistantWorkTasks`, as PhoneTasks reads
 * it), each row as the desktop hands it to Apps (`pushedRowsOf`, the ids kept on this page), and the task whose conversation
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
    latest = { assistantId, tasks: tasksRef.current }
    const open = opened && opened.ownerId === ownerId && opened.request.assistantId === assistantId && opened.request.workId
      ? { ownerId: opened.ownerId, workId: opened.request.workId, sessionId: opened.request.task.sessionId } : null
    phoneAssistantLayer.publishWork(ownerId ? { ownerId, assistantId, state, rows } : null, open)
    // Only the key decides: the rows and the open task are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => {
    latest = null
    phoneAssistantLayer.publishWork(null, null)
  }, [])
  return null
}
