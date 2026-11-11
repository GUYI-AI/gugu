import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { AssistantWorkTaskWindow } from '../assistant/AssistantWorkTaskWindow'
import { assistantPanelTaskChat, useAssistantWorkTasks } from '../assistant/assistant-panel-tasks'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { readIdentityDirectoryBridge } from '../../lib/identityDirectoryBridge'
import { appWorkSlotKey, installAppWorkChatBridge, readAppWorkChatBridge, retainAppWorkChats, setAppWorkRows, type AppWorkChats } from '../../lib/appWorkChatBridge'
import { installShellSlots, readShellSlots } from '../../lib/shellSlots'
import { useAuth } from '../../store/auth'
import { events } from '@/session/renderer/lib/ipc'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'
import type { PushedWorkLedger, PushedWorkRow } from '@/session/shared/extensions/work-binding'
import { ledgerStateOf, NO_LEDGER, pushedRowsOf, pushLedger, readsWork, reportChats } from './appWorkLedger'

installShellSlots()
installAppWorkChatBridge()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()
const NONE: AppWorkChats = Object.freeze({})
const noop = () => () => undefined

/**
 * #1925 (API 46) The built-in assistant's 任务 list, for an App that moved it into its own page: the shell's half.
 *
 * - The ledger is read the built-in list's way — the same account store and agent presence (`useAssistantWorkTasks`), the same
 *   cloud read wherever the assistant lives — only while an enabled App declares `work` and the signed-in account has its
 *   assistant; each new reading goes to main, which answers Apps (app-work-binding.ts). Otherwise main is told there is none.
 * - A task main let an App open (`gugu.bindings.openWork`, through the session page's host action into the bridge) is drawn
 *   with the built-in task window itself (AssistantWorkTaskWindow) in the cell the App's panel leaves for it, its back control
 *   closing it. Only for the account it was opened for, and taken away at once when that changes: another account, leaving
 *   the session page, the App switched off, removed or no longer reading work, or main naming its grant or choice as changed.
 *   Nothing of it reaches the App.
 */
export const AppWorkLedgerHost = observer(function AppWorkLedgerHost({ visible }: {
  /** 会话页那一屏此刻摆在眼前(MainLayout 的 tab 在「任务」):离开就收起,与内置任务窗同一条判据。 */
  visible: boolean
}) {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const shell = readAssistantShellBridge()
  const snapshot = useSyncExternalStore(shell?.subscribe ?? noop, () => shell?.getSnapshot() ?? null)
  const assistantId = ownerId && snapshot?.ownerId === ownerId && snapshot.assistant ? snapshot.assistant.id : null
  const reading = installedExtensionsStore.manifests.filter((manifest) => readsWork(manifest) && installedExtensionsStore.isEnabled(manifest.id)).map((manifest) => manifest.id)
  const readingKey = reading.join('\n')
  const bridge = readAppWorkChatBridge()
  const chats = useSyncExternalStore(bridge?.subscribe ?? noop, () => bridge?.getSnapshot() ?? NONE)

  // Main named this App's grant, choice, switch or installation as changed (no App named: all of them): its task goes.
  useEffect(() => events.on(extensionsInventoryChangedChannel, (note) => {
    const changed = note?.extensionId
    retainAppWorkChats((extensionId) => changed !== undefined && extensionId !== changed)
  }), [])
  useEffect(() => {
    const still = new Set(readingKey ? readingKey.split('\n') : [])
    retainAppWorkChats((extensionId, chat) => visible && chat.ownerId === ownerId && still.has(extensionId))
  }, [visible, ownerId, readingKey, chats])
  useEffect(() => reportChats(chats), [chats])

  return (
    <>
      {ownerId && assistantId && reading.length > 0
        ? <WorkLedgerReader key={`${ownerId}\n${assistantId}`} ownerId={ownerId} assistantId={assistantId} />
        : <NoLedger />}
      <AppWorkChatPortals ownerId={ownerId} chats={chats} />
    </>
  )
})

function NoLedger() {
  useEffect(() => {
    setAppWorkRows(null)
    pushLedger(NO_LEDGER)
  }, [])
  return null
}

/** The account's ledger, read as the built-in list reads it, handed to main and kept for `openWork`. */
function WorkLedgerReader({ ownerId, assistantId }: { ownerId: string; assistantId: string }) {
  const read = useAssistantWorkTasks(ownerId, assistantId)
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

/** Each App's open task, drawn by the built-in task window into the cell its panel leaves — for the account it was opened for. */
function AppWorkChatPortals({ ownerId, chats }: { ownerId: string | null; chats: AppWorkChats }) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(slots?.subscribeSlots ?? noop, () => slots?.getSlots() ?? EMPTY)
  return (
    <>
      {Object.entries(chats).flatMap(([extensionId, chat]) => {
        const element = entries.get(appWorkSlotKey(extensionId))
        if (!element || !ownerId || chat.ownerId !== ownerId) return []
        const close = () => readAppWorkChatBridge()?.close(extensionId)
        return [createPortal(
          <AssistantWorkTaskWindow ownerId={chat.ownerId} request={chat.request} onClose={close} />,
          element,
          `${extensionId}#${chat.request.workId}#${chat.request.task.sessionId}`,
        )]
      })}
    </>
  )
}
