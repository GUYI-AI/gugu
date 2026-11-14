import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { assistantPanelTaskChat, useAssistantWorkTasks } from '../assistant/assistant-panel-tasks'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { readIdentityDirectoryBridge } from '../../lib/identityDirectoryBridge'
import { installAppHostLayerBridge, setAppWorkRows } from '../../lib/appHostLayerBridge'
import { useAuth } from '../../store/auth'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import type { PushedWorkLedger, PushedWorkRow } from '@/session/shared/extensions/work-binding'
import { ledgerStateOf, NO_LEDGER, pushedRowsOf, pushLedger, readsWork } from './appWorkLedger'

installAppHostLayerBridge()

const noop = () => () => undefined

/**
 * #1925 (API 46) The built-in assistant's 任务 list, for an App that moved it into its own page: the shell's half.
 *
 * The ledger is read the built-in list's way — the same account store and agent presence (`useAssistantWorkTasks`), the same
 * cloud read wherever the assistant lives — only while an enabled App declares `work` and the signed-in account has its
 * assistant; each new reading goes to main, which answers Apps (app-work-binding.ts), and is kept for the host page that
 * draws a task an App opened (AppHostLayerHost). Otherwise main is told there is none.
 */
export const AppWorkLedgerHost = observer(function AppWorkLedgerHost() {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const shell = readAssistantShellBridge()
  const snapshot = useSyncExternalStore(shell?.subscribe ?? noop, () => shell?.getSnapshot() ?? null)
  const assistantId = ownerId && snapshot?.ownerId === ownerId && snapshot.assistant ? snapshot.assistant.id : null
  const reading = installedExtensionsStore.manifests.some((manifest) => readsWork(manifest) && installedExtensionsStore.isEnabled(manifest.id))
  // What the window knows of the assistant beyond its id: its setup finishing changes it (where it lives, its step, its chat,
  // its rules arriving). The cloud has no list for it until then; each change reads the list again (owner 11-12: the list
  // read during setup stayed 「没读到」 after it).
  const readiness = snapshot ? JSON.stringify([snapshot.assistantState, snapshot.preparing, snapshot.rulesPending ?? false, snapshot.setup, snapshot.home, snapshot.chatId]) : ''
  return ownerId && assistantId && reading
    ? <WorkLedgerReader key={`${ownerId}\n${assistantId}`} ownerId={ownerId} assistantId={assistantId} readiness={readiness} />
    : <NoLedger />
})

function NoLedger() {
  useEffect(() => {
    setAppWorkRows(null)
    pushLedger(NO_LEDGER)
  }, [])
  return null
}

/** The account's ledger, read as the built-in list reads it, handed to main and kept for `openWork`. */
function WorkLedgerReader({ ownerId, assistantId, readiness }: { ownerId: string; assistantId: string; readiness: string }) {
  const read = useAssistantWorkTasks(ownerId, assistantId)
  const { reload } = read
  const readinessSeen = useRef(readiness)
  useEffect(() => {
    if (readinessSeen.current === readiness) return
    readinessSeen.current = readiness
    reload()
  }, [readiness, reload])
  const directory = readIdentityDirectoryBridge()
  const identities = useSyncExternalStore(directory?.subscribe ?? noop, () => directory?.getSnapshot() ?? null)
  const [now, setNow] = useState(() => Date.now())
  const tasks = read.state === 'loading' ? [] : read.data
  const { rows, namingUntil } = pushedRowsOf(tasks, (agentId) => identities?.[agentId]?.created_at ?? undefined, now)
  const state = ledgerStateOf(read)
  const latest = useRef(tasks)
  latest.current = tasks

  // The task agents' identities say when each was made: what "naming…" is measured from (`AssistantTaskName`).
  const agents = JSON.stringify([...new Set(tasks.flatMap((task) => (task.agentId ? [task.agentId] : [])))].sort())
  useEffect(() => {
    const missing = (JSON.parse(agents) as string[]).filter((id) => !directory?.getSnapshot()?.[id])
    if (missing.length > 0) directory?.ensure(missing)
  }, [agents, directory])
  // "naming…" ends by the clock, as `useShownAgentName` redraws at its deadline.
  useEffect(() => {
    if (namingUntil === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, namingUntil - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [namingUntil])

  useEffect(() => {
    setAppWorkRows({
      ownerId,
      assistantId,
      open: (workId, sessionId) => {
        const task = latest.current.find((candidate) => candidate.workId === workId && candidate.id === sessionId)
        return task ? { ...assistantPanelTaskChat({ assistantId }, task), workId: task.workId } : null
      },
    })
    return () => setAppWorkRows(null)
  }, [ownerId, assistantId])
  const key = JSON.stringify([state, rows])
  useEffect(() => {
    const [pushedState, pushedRows] = JSON.parse(key) as [PushedWorkLedger['state'], PushedWorkRow[]]
    pushLedger({ ownerId, assistantId, state: pushedState, rows: pushedRows })
  }, [ownerId, assistantId, key])
  return null
}
