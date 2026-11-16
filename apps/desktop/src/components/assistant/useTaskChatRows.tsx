import { useMemo, useState, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { readAssistantTaskChat, subscribeAssistantTaskChats } from '../../lib/assistantTaskChat'
import type { TaskExchange } from '../../session/shared/core/sessions/task-collaboration'
import { useReplicas } from '../../lib/replica'
import { assistantWorkExchanges } from './assistant-work-projection'
import { taskChatRows, taskChatWindow } from './taskChatRows'
import { Button } from '../ui/Button'
import { Unknown } from '../ui/Unknown'
import './assistant-task-chat.css'
import { assistantWork, useAssistantWorkRecords } from './assistant-work-records'

/**
 * The task chat's exchanges (the account's collaboration ledger), read only while the chat is shown: the work ids from the
 * ledger (`assistantWorkRecords`, or the one the task names), then each work's events (`assistantWork`, the same entry
 * the task window reads). Unknown draws a row-high placeholder; a failed read says collaboration is unavailable.
 */
export function useTaskChatRows(messages: readonly MessageItem[], ownerId: string | undefined, agentId: string | null | undefined, visible: boolean) {
  const task = useSyncExternalStore(subscribeAssistantTaskChats, () => readAssistantTaskChat(ownerId, agentId))
  const { t } = useTranslation('assistant')
  const key = task ? JSON.stringify([ownerId,task]) : ''
  const [history,setHistory] = useState({ key: '',count: 80 })
  const shown = !!task && !!ownerId && visible
  // A task without a work id: its works are the ledger's that this session executes for this coordinator.
  const ledger = useAssistantWorkRecords(shown && task && !task.workId ? ownerId : null, task?.assistantId ?? '')
  const workIds = useMemo(() => {
    if (!shown || !task) return null
    if (task.workId) return [task.workId]
    if (ledger.state !== 'value') return null
    return ledger.value.filter(work=>work.executors.some(target=>target.session_id===task.task.sessionId && target.device_id===task.task.deviceId)
      && task.assistants.some(home=>home.sessionId===work.coordinator_session_id && home.deviceId===work.coordinator_device_id)).map(work=>work.work_id)
  }, [shown, task, ledger])
  const works = useReplicas(assistantWork, task && workIds ? workIds.map(workId => [task.assistantId, workId] as [string, string]) : [])
  // null = not known yet (the ledger or a work not read); a failure is said below, the exchanges read so far stay shown.
  const exchanges = useMemo((): TaskExchange[] | null => {
    if (!task || !workIds) return null
    if (works.some(reading => reading.state === 'unknown')) return null
    // Replace, rather than merge, so deleted original sources disappear after revalidation.
    // @@@reading-default(paired) - a work whose read failed adds no exchanges; its failure is said by the collaboration-unavailable notice (`unavailable`)
    return works.flatMap((reading, index) => reading.state === 'value' ? assistantWorkExchanges(reading.value.events, workIds[index]!) : [])
  }, [task, workIds, works])
  const unavailable = ledger.state === 'error' || works.some(reading => reading.state === 'error' || (reading.state === 'value' && reading.error))
  // @@@reading-default(paired) - the chat's own messages are drawn while the exchanges are not read yet; the row-high placeholder in `notice` says more are coming
  const allRows = useMemo(() => taskChatRows(messages, exchanges ?? [], task), [messages, exchanges, task])
  const count = history.key === key ? history.count : 80
  const { rows, earlier } = useMemo(() => taskChatWindow(allRows, count), [allRows, count])
  const listedMessages = useMemo(() => rows.map((row) => row.message), [rows])
  const notice = <>{shown && task && exchanges === null && !unavailable ? <div className="task-chat-notice"><Unknown className="h-7 w-full" /></div> : null}{unavailable ? <div className="task-chat-notice" role="status">{t('tasks.collaborationUnavailable')}</div> : null}{earlier > 0 ? <div className="task-chat-notice"><Button variant="ghost" size="sm"
    onClick={() => setHistory({ key,count: count + 80 })}>{t('tasks.collaborationOlder')}</Button></div> : null}</>
  return { rows, listedMessages, notice, threeParty: task !== null }
}
